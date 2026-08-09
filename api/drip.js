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
  normaliseCardId,
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
    const { key, action, config, groupKeys, startAt, cardId, keepNew, alignToBatch, dailyCounts } =
      req.body || {};
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
    // Optional per-day plan, e.g. "3,5,2". Blank falls back to the uniform
    // cards-per-day setting.
    const plan = Array.isArray(dailyCounts)
      ? dailyCounts
      : String(dailyCounts || "")
          .split(/[\s,;]+/)
          .map(n => Number(n))
          // Zeros are kept: they mean "release nothing that day", which is how
          // a rest day is expressed.
          .filter(n => Number.isFinite(n) && n >= 0);

    // Scheduling actions honour whatever settings were sent with the request, so
    // what's on screen is what gets used. Previously perDay and newWindowHours
    // came only from saved config while the plan and start time came from the
    // form — the same panel behaving two different ways.
    if (config && typeof config === "object" && action !== "config") {
      const num = (v, min, max, fallback) => {
        const n = Number(v);
        return Number.isFinite(n) ? Math.min(Math.max(n, min), max) : fallback;
      };
      if (config.perDay !== undefined) {
        state.config.perDay = num(config.perDay, 1, 200, state.config.perDay);
      }
      if (config.releaseHour !== undefined) {
        state.config.releaseHour = num(config.releaseHour, 0, 23, state.config.releaseHour);
      }
      if (config.releaseMinute !== undefined) {
        state.config.releaseMinute = num(config.releaseMinute, 0, 59, state.config.releaseMinute);
      }
      if (config.newWindowHours !== undefined) {
        state.config.newWindowHours = num(config.newWindowHours, 1, 720, state.config.newWindowHours);
      }
    }

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
        const landedAt = entry.pendingAt;
        entry.published = entry.pendingStock;
        entry.pendingStock = null;
        entry.pendingAt = null;

        // CRITICAL: carry the restock's moment onto the listing's release time.
        // getLastReleaseMoment() reads pendingAt to know when stock landed, so
        // clearing it without this made the card fall back to its ORIGINAL
        // release date — instantly ejecting a just-restocked card from the
        // Newly In Stock row the moment any admin action ran.
        if (!state.releases[groupKey] || state.releases[groupKey] < landedAt) {
          state.releases[groupKey] = landedAt;
        }
        consolidated = true;
      }
    });

    // Self-healing: any already-released listing with no level entry (state
    // written before restock tracking existed) starts tracking at its current
    // CSV stock, so nothing is retroactively hidden.
    // Self-healing for listings released before stock levels were tracked.
    //
    // Adopts the current CSV stock, which is correct for the overwhelming
    // majority: an untracked listing that's live with its full stock must keep
    // showing that stock. Healing to anything lower would make live cards
    // disappear as sold out until they were scheduled.
    //
    // The trade-off: if a listing's FIRST heal happens in the same pass as a
    // restock, that increase is absorbed into the baseline and never detected
    // (this is what happened to one card in a 72-row upload). There's no way to
    // tell the two apart after the fact — the pre-restock figure isn't recorded
    // anywhere. So instead of guessing, newly-tracked listings are REPORTED, and
    // you can publish any that should have been treated as restocks.
    let healed = false;
    const newlyTracked = [];
    if (state.initialized) {
      Array.from(groups.entries()).forEach(([groupKey, group]) => {
        if (state.releases[groupKey] !== undefined && !state.levels[groupKey]) {
          state.levels[groupKey] = {
            published: group.baseStock,
            pendingStock: null,
            pendingAt: null,
          };
          newlyTracked.push(groupKey);
          healed = true;
        }
      });
    }

    if (consolidated || healed) await saveDripState(redis, state);

    // Computed as a FUNCTION, not a one-off snapshot: actions below mutate the
    // state, and buildStatus() must reflect the result rather than the list as
    // it stood when the request arrived. (A snapshot here previously left the
    // "awaiting a schedule" list showing items that had just been scheduled.)
    const computeUnscheduled = () => {
      // Freshly uploaded rows: no release time yet.
      const freshListings = Array.from(groups.keys()).filter(
        groupKey => state.releases[groupKey] === undefined
      );

      // Restocks: CSV stock now exceeds what's published, with no increase
      // already queued. Adding a duplicate CSV row and bumping the Stock column
      // both land here, because loadInventoryGroups merges them into one total.
      const restocks = Array.from(groups.entries())
        .filter(([groupKey, group]) => {
          if (state.releases[groupKey] === undefined) return false; // brand new
          const entry = state.levels[groupKey];
          if (!entry) return false;
          if (entry.pendingAt !== null && entry.pendingAt > now) return false; // queued
          return group.baseStock > entry.published;
        })
        .map(([groupKey, group]) => ({
          groupKey,
          from: state.levels[groupKey].published,
          to: group.baseStock,
        }));

      return { freshListings, restocks };
    };

    const { freshListings: unscheduledNew, restocks: unscheduledRestocks } = computeUnscheduled();

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
      // Recomputed here so the numbers reflect any mutation this request made.
      const { freshListings, restocks } = computeUnscheduled();
      const currentUnscheduledCount = freshListings.length + restocks.length;

      // Every listing in one day's batch shares an identical releaseAt, so
      // sorting by time alone leaves ties resolved by Redis key order. CSV
      // position is the tie-breaker, matching the order they'll actually be
      // presented in.
      const byTimeThenCsv = (a, b) =>
        a.releaseAt - b.releaseAt || rowIndexOf(a.groupKey) - rowIndexOf(b.groupKey);

      const pending = Object.entries(state.releases)
        .filter(([, at]) => at > now)
        .map(([groupKey, at]) => ({ ...describe(groupKey), releaseAt: at }))
        .sort(byTimeThenCsv);

      const newlyIn = Object.keys(state.releases)
        .filter(groupKey => isListingNew(state, groupKey, now))
        .map(groupKey => ({ ...describe(groupKey), releaseAt: state.releases[groupKey] }))
        // Matches the storefront: CSV order, not release order.
        .sort((a, b) => rowIndexOf(a.groupKey) - rowIndexOf(b.groupKey));

      const liveCount = Array.from(groups.keys()).filter(groupKey =>
        isListingReleased(state, groupKey, now)
      ).length;

      const pendingRestocks = Object.entries(state.levels)
        .filter(([, e]) => e.pendingAt !== null && e.pendingAt > now)
        .map(([groupKey, e]) => ({
          ...describe(groupKey),
          releaseAt: e.pendingAt,
          from: e.published,
          to: e.pendingStock,
          isRestock: true,
        }))
        .sort(byTimeThenCsv);

      return {
        initialized: state.initialized,
        config: state.config,
        totalListings: groups.size,
        liveCount,
        pendingCount: pending.length + pendingRestocks.length,
        unscheduledCount: currentUnscheduledCount,
        pending: [...pending, ...pendingRestocks].sort(byTimeThenCsv),
        newlyIn,
        // Listings that gained a stock record on this request. If any were
        // restocked in the same upload, that increase was absorbed — publish
        // them manually if they should have been treated as new stock.
        newlyTracked: newlyTracked.map(describe),
        unscheduled: [
          ...freshListings.map(describe),
          ...restocks.map(r => ({
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
      const proposed = buildDripSchedule(unscheduled, state.config, now, firstSlotAt, plan).map(entry => ({
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
      buildDripSchedule(unscheduled, state.config, now, firstSlotAt, plan).forEach(entry => {
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
      // Re-sorted by CSV position, NOT by the existing release times. Sorting by
      // the current times would just preserve whatever order was applied when
      // they were first scheduled, which makes it impossible to correct an
      // order after the fact. Re-spread now genuinely re-reads the CSV.
      const pendingKeys = [
        ...Object.keys(state.releases).filter(k => state.releases[k] > now),
        ...Object.keys(state.levels).filter(
          k => state.levels[k].pendingAt !== null && state.levels[k].pendingAt > now
        ),
      ]
        .filter((k, i, arr) => arr.indexOf(k) === i) // a key can be in both lists
        .sort((a, b) => rowIndexOf(a) - rowIndexOf(b));

      buildDripSchedule(pendingKeys, state.config, now, firstSlotAt, plan).forEach(entry => {
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

    // ------------------------------------------------------- alignNewWindow --
    // Normalises every card currently in the Newly In Stock row onto ONE
    // release timestamp, so they all expire together.
    //
    // Defaults to the EARLIEST timestamp in the row: aligning to the latest
    // would extend cards that were due to expire, quietly keeping stale stock
    // in a row that's meant to mean "just landed". Pass mode: "latest" to
    // extend instead.
    if (action === "alignNewWindow") {
      const inRow = Array.from(groups.keys()).filter(groupKey =>
        isListingNew(state, groupKey, now)
      );

      if (inRow.length === 0) {
        return res.status(200).json({
          ok: true,
          aligned: 0,
          message: "Nothing is in the Newly in stock row right now.",
          status: buildStatus(),
        });
      }

      const stamps = inRow.map(groupKey => state.releases[groupKey] || 0).filter(Boolean);
      const target =
        req.body && req.body.mode === "latest"
          ? Math.max(...stamps)
          : Math.min(...stamps);

      const changed = [];
      inRow.forEach(groupKey => {
        const before = state.releases[groupKey] || 0;
        if (before !== target) {
          state.releases[groupKey] = target;
          changed.push({ ...describe(groupKey), from: before, to: target });
        }
      });

      if (changed.length > 0) await saveDripState(redis, state);

      const windowMs = Math.max(Number(state.config.newWindowHours) || 0, 0) * 3600000;
      return res.status(200).json({
        ok: true,
        aligned: changed.length,
        totalInRow: inRow.length,
        releaseAt: target,
        expiresAt: target + windowMs,
        changed,
        status: buildStatus(),
      });
    }

    // ---------------------------------------------------------- publishNow --
    // Manual override: push a listing's CURRENT CSV stock live immediately,
    // skipping the drip queue entirely. For correcting a number after a card
    // has already dripped out, or listing extra copies straight away.
    //
    // keepNew (default true) also stamps the release moment as now, so the card
    // returns to the Newly In Stock row. Pass false to top up stock quietly
    // without pushing it back to the top of the shop.
    if (action === "publishNow") {
      const wantedId = normaliseCardId(cardId);
      const targets = [];

      if (Array.isArray(groupKeys) && groupKeys.length > 0) {
        groupKeys.forEach(k => { if (groups.has(k)) targets.push(k); });
      } else if (wantedId) {
        // A Card ID covers every condition of that card.
        Array.from(groups.entries()).forEach(([groupKey, group]) => {
          if (normaliseCardId(group.cardId) === wantedId) targets.push(groupKey);
        });
      }

      if (targets.length === 0) {
        return res.status(404).json({
          error: "No listing found for that Card ID.",
        });
      }

      // Timestamp shared by everything published in this action. When
      // alignToBatch is on (the default) it matches the newest release already
      // sitting in the Newly In Stock row, so the reinstated card joins that
      // batch instead of jumping ahead of it. Identical timestamps mean the row
      // falls back to its CSV tie-breaker, giving true CSV order.
      let publishAt = now;
      if (keepNew !== false && alignToBatch !== false) {
        let newestInRow = 0;
        Array.from(groups.keys()).forEach(groupKey => {
          if (isListingNew(state, groupKey, now)) {
            const at = state.releases[groupKey] || 0;
            if (at > newestInRow) newestInRow = at;
          }
        });
        if (newestInRow > 0) publishAt = newestInRow;
      }

      const updated = targets.map(groupKey => {
        const group = groups.get(groupKey);
        const before = state.levels[groupKey] ? state.levels[groupKey].published : null;

        state.levels[groupKey] = {
          published: group.baseStock,
          pendingStock: null,
          pendingAt: null,
        };

        // Make sure it's actually released — this doubles as "publish a card
        // that's still sitting in the queue".
        if (state.releases[groupKey] === undefined || state.releases[groupKey] > now) {
          state.releases[groupKey] = publishAt;
        } else if (keepNew !== false) {
          state.releases[groupKey] = publishAt;
        }

        return {
          ...describe(groupKey),
          from: before,
          to: group.baseStock,
        };
      });

      state.initialized = true;
      await saveDripState(redis, state);

      return res.status(200).json({
        ok: true,
        updated,
        keptNew: keepNew !== false,
        publishAt,
        alignedToBatch: keepNew !== false && alignToBatch !== false && publishAt !== now,
        status: buildStatus(),
      });
    }

    // ---------------------------------------------------------- dropFromNew --
    // Takes a card out of the Newly In Stock row without unpublishing it: the
    // release timestamp is backdated past the window, so isNew goes false and
    // the card falls into Featured or All Cards on the next fetch.
    if (action === "dropFromNew" || action === "previewDropFromNew") {
      const wantedId = normaliseCardId(cardId);
      const windowMs = Math.max(Number(state.config.newWindowHours) || 0, 0) * 3600000;
      const backdated = now - windowMs - 60000;

      let targets = [];
      if (Array.isArray(groupKeys) && groupKeys.length > 0) {
        targets = groupKeys.filter(k => groups.has(k));
      } else if (wantedId) {
        Array.from(groups.entries()).forEach(([groupKey, group]) => {
          if (normaliseCardId(group.cardId) === wantedId) targets.push(groupKey);
        });
      } else {
        // No card given — clear the whole row.
        targets = Array.from(groups.keys()).filter(k => isListingNew(state, k, now));
      }

      const affected = targets.filter(groupKey => isListingNew(state, groupKey, now));

      // Preview: report what WOULD be removed, change nothing.
      if (action === "previewDropFromNew") {
        return res.status(200).json({
          ok: true,
          preview: true,
          dropped: affected.map(describe),
        });
      }

      const dropped = affected.map(groupKey => {
        state.releases[groupKey] = backdated;
        return describe(groupKey);
      });

      if (dropped.length > 0) await saveDripState(redis, state);

      return res.status(200).json({ ok: true, dropped, status: buildStatus() });
    }

    return res.status(400).json({ error: "Unknown action." });
  } catch (err) {
    console.error("drip error:", err);
    res.status(500).json({ error: "Failed to update the release schedule." });
  }
}
