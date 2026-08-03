import { Redis } from "@upstash/redis";
import {
  loadInventoryGroups,
  getDripState,
  saveDripState,
  buildDripSchedule,
  isListingReleased,
  isListingNew,
  DEFAULT_DRIP_CONFIG,
} from "./_inventory.js";

const redis = Redis.fromEnv();

// Actions:
//   status     — config + what's live, new, and pending
//   initialize — mark everything currently in the CSV as already released
//                (the baseline; must be run once before drip-releasing)
//   config     — update cards/day, release time, new-window, toggles
//   preview    — propose a schedule for unscheduled listings (no write)
//   schedule   — commit that schedule
//   reschedule — recompute pending releases with the current config
//   releaseNow — release pending listings immediately (all, or specific keys)
//
// Redis cost per action: 1 GET + at most 1 SET. Nothing scales with catalogue
// size, and the storefront pays nothing extra — /api/products already fetches
// the schedule in the same MGET as hidden cards and settings.
export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const { key, action, config, groupKeys } = req.body || {};
    const adminKey = process.env.ADMIN_RESET_KEY;

    if (!adminKey) {
      console.error("ADMIN_RESET_KEY is not set in Vercel env vars");
      return res.status(500).json({ error: "Admin actions are not configured yet." });
    }
    if (!key || key !== adminKey) {
      return res.status(401).json({ error: "Incorrect passphrase." });
    }

    const state = await getDripState(redis);
    const groups = loadInventoryGroups();
    const now = Date.now();

    const describe = groupKey => {
      const group = groups.get(groupKey);
      return {
        groupKey,
        name: group ? group.name : groupKey,
        set: group ? group.set || "" : "",
        condition: group ? group.description || "" : "",
        stock: group ? group.baseStock : 0,
      };
    };

    // Listings in the CSV with no release time yet — i.e. freshly uploaded rows.
    const unscheduled = Array.from(groups.keys()).filter(
      groupKey => state.releases[groupKey] === undefined
    );

    const buildStatus = () => {
      const pending = Object.entries(state.releases)
        .filter(([, at]) => at > now)
        .sort((a, b) => a[1] - b[1])
        .map(([groupKey, at]) => ({ ...describe(groupKey), releaseAt: at }));

      const newlyIn = Object.keys(state.releases)
        .filter(groupKey => isListingNew(state, groupKey, now))
        .map(groupKey => ({ ...describe(groupKey), releaseAt: state.releases[groupKey] }))
        .sort((a, b) => b.releaseAt - a.releaseAt);

      const liveCount = Array.from(groups.keys()).filter(groupKey =>
        isListingReleased(state, groupKey, now)
      ).length;

      return {
        initialized: state.initialized,
        config: state.config,
        totalListings: groups.size,
        liveCount,
        pendingCount: pending.length,
        unscheduledCount: unscheduled.length,
        pending,
        newlyIn,
        unscheduled: unscheduled.map(describe),
      };
    };

    // -------------------------------------------------------------- status --
    if (action === "status") {
      return res.status(200).json({ ok: true, status: buildStatus() });
    }

    // ---------------------------------------------------------- initialize --
    // Baseline: everything currently in the CSV counts as already released, so
    // only rows added later get drip-scheduled. Without this the very first
    // scan would treat your entire existing catalogue as new stock.
    if (action === "initialize") {
      const releases = { ...state.releases };
      Array.from(groups.keys()).forEach(groupKey => {
        if (releases[groupKey] === undefined) {
          // Backdated well past the new-window so nothing shows as "new".
          releases[groupKey] = now - 365 * 86400000;
        }
      });
      state.releases = releases;
      state.initialized = true;
      await saveDripState(redis, state);
      return res.status(200).json({
        ok: true,
        initialized: true,
        baselineCount: groups.size,
        status: buildStatus(),
      });
    }

    // -------------------------------------------------------------- config --
    if (action === "config") {
      const incoming = config || {};
      const next = { ...state.config };

      const num = (value, min, max, fallback) => {
        const n = Number(value);
        if (!Number.isFinite(n)) return fallback;
        return Math.min(Math.max(n, min), max);
      };

      if (incoming.perDay !== undefined) next.perDay = num(incoming.perDay, 1, 200, next.perDay);
      if (incoming.releaseHour !== undefined) next.releaseHour = num(incoming.releaseHour, 0, 23, next.releaseHour);
      if (incoming.releaseMinute !== undefined) next.releaseMinute = num(incoming.releaseMinute, 0, 59, next.releaseMinute);
      if (incoming.newWindowHours !== undefined) next.newWindowHours = num(incoming.newWindowHours, 1, 720, next.newWindowHours);
      if (incoming.tzOffsetMinutes !== undefined) next.tzOffsetMinutes = num(incoming.tzOffsetMinutes, -720, 840, next.tzOffsetMinutes);
      if (incoming.enabled !== undefined) next.enabled = Boolean(incoming.enabled);
      if (incoming.holdNewListings !== undefined) next.holdNewListings = Boolean(incoming.holdNewListings);

      state.config = next;
      await saveDripState(redis, state);
      return res.status(200).json({ ok: true, config: next, status: buildStatus() });
    }

    // ------------------------------------------------------------- preview --
    if (action === "preview") {
      const proposed = buildDripSchedule(unscheduled, state.config, now).map(entry => ({
        ...describe(entry.groupKey),
        releaseAt: entry.releaseAt,
      }));
      return res.status(200).json({
        ok: true,
        proposed,
        perDay: state.config.perDay,
        days: Math.ceil(proposed.length / Math.max(state.config.perDay, 1)),
      });
    }

    // ------------------------------------------------------------ schedule --
    if (action === "schedule") {
      if (unscheduled.length === 0) {
        return res.status(200).json({ ok: true, scheduled: 0, status: buildStatus() });
      }
      buildDripSchedule(unscheduled, state.config, now).forEach(entry => {
        state.releases[entry.groupKey] = entry.releaseAt;
      });
      state.initialized = true;
      await saveDripState(redis, state);
      return res.status(200).json({
        ok: true,
        scheduled: unscheduled.length,
        status: buildStatus(),
      });
    }

    // ---------------------------------------------------------- reschedule --
    // Re-spreads everything still pending using the current settings, so
    // changing cards/day or the release time takes effect on the queue.
    if (action === "reschedule") {
      const pendingKeys = Object.entries(state.releases)
        .filter(([, at]) => at > now)
        .sort((a, b) => a[1] - b[1])
        .map(([groupKey]) => groupKey);

      buildDripSchedule(pendingKeys, state.config, now).forEach(entry => {
        state.releases[entry.groupKey] = entry.releaseAt;
      });
      await saveDripState(redis, state);
      return res.status(200).json({
        ok: true,
        rescheduled: pendingKeys.length,
        status: buildStatus(),
      });
    }

    // ---------------------------------------------------------- releaseNow --
    if (action === "releaseNow") {
      const targets =
        Array.isArray(groupKeys) && groupKeys.length > 0
          ? groupKeys
          : Object.entries(state.releases)
              .filter(([, at]) => at > now)
              .map(([groupKey]) => groupKey);

      targets.forEach(groupKey => {
        state.releases[groupKey] = now;
      });
      await saveDripState(redis, state);
      return res.status(200).json({
        ok: true,
        released: targets.length,
        status: buildStatus(),
      });
    }

    return res.status(400).json({ error: "Unknown action." });
  } catch (err) {
    console.error("drip error:", err);
    res.status(500).json({ error: "Failed to update the release schedule." });
  }
}
