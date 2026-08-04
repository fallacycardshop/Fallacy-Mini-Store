import { Redis } from "@upstash/redis";
import {
  loadInventoryGroups,
  getDripState,
  saveDripState,
  buildDripSchedule,
  parseLocalDateTime,
  isListingReleased,
  isListingNew,
  getEffectiveStock,
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
    const { key, action, config, groupKeys, startAt } = req.body || {};
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

    // Optional one-off override for the FIRST release moment, e.g. "start this
    // batch at 18:00 today" when the usual 12:00 slot has already passed.
    // Ignored if it isn't in the future — a past start would publish instantly.
    const requestedStart = startAt ? parseLocalDateTime(startAt, state.config) : null;
    const firstSlotAt = requestedStart !== null && requestedStart > now ? requestedStart : null;
    const startRejected = Boolean(startAt) && firstSlotAt === null;

    const describe = groupKey => {
      const group = groups.get(groupKey);
      return {
        groupKey,
        name: group ? group.name : groupKey,
        set: group ? group.set || "" : "",
        condition: group ? group.description || "" : "",
        stock: group ? group.baseStock : 0,
        publishedStock: group ? getEffectiveStock(state, groupKey, group.baseStock, now) : 0,
      };
    };

    // Housekeeping: fold any restock whose moment has passed into the published
    // figure, so `pending` only ever holds genuinely future increases. Done here
    // (an admin write path) rather than on the storefront read path.
    let consolidated = false;
    Object.entries(state.levels).forEach(([groupKey, entry]) => {
      if (entry.pendingAt !== null && entry.pendingAt <= now && entry.pendingStock !== null) {
        entry.published = entry.pendingStock;
        entry.pendingStock = null;
        entry.pendingAt = null;
        consolidated = true;
      }
    });

    // Self-healing: any already-released listing with no level entry (state
    // written before restock tracking existed) starts tracking at its current
    // CSV stock, so nothing is retroactively hidden.
    let healed = false;
    if (state.initialized) {
      Array.from(groups.entries()).forEach(([groupKey, group]) => {
        if (state.releases[groupKey] !== undefined && !state.levels[groupKey]) {
          state.levels[groupKey] = {
            published: group.baseStock,
            pendingStock: null,
            pendingAt: null,
          };
          healed = true;
        }
      });
    }
    if (consolidated || healed) await saveDripState(redis, state);

    // Freshly uploaded rows: no release time yet.
    const unscheduledNew = Array.from(groups.keys()).filter(
      groupKey => state.releases[groupKey] === undefined
    );

    // Restocks: CSV stock now exceeds what's published, with no increase
    // already queued. Adding a duplicate CSV row and bumping the Stock column
    // both land here, because loadInventoryGroups merges them into one total.
    const unscheduledRestocks = Array.from(groups.entries())
      .filter(([groupKey, group]) => {
        if (state.releases[groupKey] === undefined) return false; // brand new, handled above
        const entry = state.levels[groupKey];
        if (!entry) return false;
        if (entry.pendingAt !== null && entry.pendingAt > now) return false; // already queued
        return group.baseStock > entry.published;
      })
      .map(([groupKey, group]) => ({
        groupKey,
        from: state.levels[groupKey].published,
        to: group.baseStock,
      }));

    // Scheduling treats both kinds as one queue in CSV order.
    // Queue order follows the CSV, using each listing's LAST row rather than its
    // first. A restock row appended at the bottom therefore releases last, in
    // the order it was added, instead of jumping the queue because the original
    // row for that card sits near the top of the file.
    const rowIndexOf = groupKey => {
      const group = groups.get(groupKey);
      if (!group) return Number.MAX_SAFE_INTEGER;
      return group.lastRowIndex !== undefined ? group.lastRowIndex : 0;
    };

    const unscheduled = [
      ...unscheduledNew,
      ...unscheduledRestocks.map(r => r.groupKey),
    ].sort((a, b) => rowIndexOf(a) - rowIndexOf(b));

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

      const pendingRestocks = Object.entries(state.levels)
        .filter(([, e]) => e.pendingAt !== null && e.pendingAt > now)
        .sort((a, b) => a[1].pendingAt - b[1].pendingAt)
        .map(([groupKey, e]) => ({
          ...describe(groupKey),
          releaseAt: e.pendingAt,
          from: e.published,
          to: e.pendingStock,
          isRestock: true,
        }));

      return {
        initialized: state.initialized,
        config: state.config,
        totalListings: groups.size,
        liveCount,
        pendingCount: pending.length + pendingRestocks.length,
        unscheduledCount: unscheduled.length,
        pending: [...pending, ...pendingRestocks].sort((a, b) => a.releaseAt - b.releaseAt),
        newlyIn,
        unscheduled: [
          ...unscheduledNew.map(describe),
          ...unscheduledRestocks.map(r => ({
            ...describe(r.groupKey),
            isRestock: true,
            from: r.from,
            to: r.to,
          })),
        ],
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
      Array.from(groups.entries()).forEach(([groupKey, group]) => {
        if (releases[groupKey] === undefined) {
          // Backdated well past the new-window so nothing shows as "new".
          releases[groupKey] = now - 365 * 86400000;
        }
        // Current CSV stock becomes the published baseline, so only later
        // increases count as restocks.
        state.levels[groupKey] = {
          published: group.baseStock,
          pendingStock: null,
          pendingAt: null,
        };
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
      const proposed = buildDripSchedule(unscheduled, state.config, now, firstSlotAt).map(entry => ({
        ...describe(entry.groupKey),
        releaseAt: entry.releaseAt,
      }));
      return res.status(200).json({
        ok: true,
        proposed,
        perDay: state.config.perDay,
        days: Math.ceil(proposed.length / Math.max(state.config.perDay, 1)),
        firstSlotAt,
        startRejected,
      });
    }

    // ------------------------------------------------------------ schedule --
    if (action === "schedule") {
      if (unscheduled.length === 0) {
        return res.status(200).json({ ok: true, scheduled: 0, status: buildStatus() });
      }
      const restockKeys = new Set(unscheduledRestocks.map(r => r.groupKey));
      buildDripSchedule(unscheduled, state.config, now, firstSlotAt).forEach(entry => {
        const group = groups.get(entry.groupKey);
        if (restockKeys.has(entry.groupKey)) {
          // Existing listing: queue the stock increase, leave it visible at its
          // current published level until then.
          state.levels[entry.groupKey].pendingStock = group.baseStock;
          state.levels[entry.groupKey].pendingAt = entry.releaseAt;
        } else {
          // Brand-new listing: hidden entirely until its moment.
          state.releases[entry.groupKey] = entry.releaseAt;
          state.levels[entry.groupKey] = {
            published: group.baseStock,
            pendingStock: null,
            pendingAt: null,
          };
        }
      });
      state.initialized = true;
      await saveDripState(redis, state);
      return res.status(200).json({
        ok: true,
        scheduled: unscheduled.length,
        firstSlotAt,
        startRejected,
        status: buildStatus(),
      });
    }

    // ---------------------------------------------------------- reschedule --
    // Re-spreads everything still pending using the current settings, so
    // changing cards/day or the release time takes effect on the queue.
    if (action === "reschedule") {
      const pendingKeys = [
        ...Object.entries(state.releases).filter(([, at]) => at > now).map(([k, at]) => [k, at]),
        ...Object.entries(state.levels)
          .filter(([, e]) => e.pendingAt !== null && e.pendingAt > now)
          .map(([k, e]) => [k, e.pendingAt]),
      ]
        .sort((a, b) => a[1] - b[1])
        .map(([groupKey]) => groupKey);

      buildDripSchedule(pendingKeys, state.config, now, firstSlotAt).forEach(entry => {
        if (state.releases[entry.groupKey] !== undefined && state.releases[entry.groupKey] > now) {
          state.releases[entry.groupKey] = entry.releaseAt;
        }
        const level = state.levels[entry.groupKey];
        if (level && level.pendingAt !== null && level.pendingAt > now) {
          level.pendingAt = entry.releaseAt;
        }
      });
      await saveDripState(redis, state);
      return res.status(200).json({
        ok: true,
        rescheduled: pendingKeys.length,
        firstSlotAt,
        startRejected,
        status: buildStatus(),
      });
    }

    // ---------------------------------------------------------- releaseNow --
    if (action === "releaseNow") {
      const targets =
        Array.isArray(groupKeys) && groupKeys.length > 0
          ? groupKeys
          : [
              ...Object.entries(state.releases).filter(([, at]) => at > now).map(([k]) => k),
              ...Object.entries(state.levels)
                .filter(([, e]) => e.pendingAt !== null && e.pendingAt > now)
                .map(([k]) => k),
            ];

      targets.forEach(groupKey => {
        if (state.releases[groupKey] !== undefined && state.releases[groupKey] > now) {
          state.releases[groupKey] = now;
        }
        const level = state.levels[groupKey];
        if (level && level.pendingAt !== null && level.pendingAt > now) {
          level.published = level.pendingStock;
          level.pendingStock = null;
          level.pendingAt = null;
          // Counts as new from this moment.
          state.releases[groupKey] = now;
        }
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
