import { Redis } from "@upstash/redis";
import {
  loadInventoryGroups,
  getActiveReservedMap,
  getHiddenCardsMap,
  saveHiddenCardsMap,
  indexGroupsByCardId,
  parseCardIdList,
} from "./_inventory.js";

const redis = Redis.fromEnv();

const DEFAULT_HIDE_HOURS = 24;
const MAX_HIDE_HOURS = 168; // one week — a safety ceiling so nothing hides forever
const MAX_BATCH_SIZE = 200; // guards against a runaway paste

// Actions (all accept one Card ID or a whole batch):
//   lookup — report every listing for each ID and whether it's hidden
//   hide   — hide the batch for N hours (default 24)
//   unhide — bring the batch back immediately
//   list   — show everything currently hidden
//
// Redis cost is flat and independent of batch size:
//   lookup       = 1 GET + 1 SCAN + 1 MGET (reservations) + 1 MGET (sold counts)
//   hide/unhide  = 1 GET + 1 SET
// Hiding 1 card and hiding 200 cards cost exactly the same, because every
// hidden ID lives inside a single Redis key.
export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const { key, action, cardId, cardIds, hours } = req.body || {};
    const adminKey = process.env.ADMIN_RESET_KEY;

    if (!adminKey) {
      console.error("ADMIN_RESET_KEY is not set in Vercel env vars");
      return res.status(500).json({ error: "Admin actions are not configured yet." });
    }

    if (!key || key !== adminKey) {
      return res.status(401).json({ error: "Incorrect passphrase." });
    }

    const hiddenMap = await getHiddenCardsMap(redis);

    // ---------------------------------------------------------------- list --
    if (action === "list") {
      const groups = loadInventoryGroups();
      const index = indexGroupsByCardId(groups);
      const hidden = Object.entries(hiddenMap).map(([id, entry]) => {
        const matches = index.get(id) || [];
        return {
          cardId: id,
          name: entry.label || (matches[0] ? matches[0].group.name : id),
          listingCount: matches.length,
          expiresAt: entry.expiresAt,
        };
      });
      hidden.sort((a, b) => a.expiresAt - b.expiresAt);
      return res.status(200).json({ ok: true, hidden });
    }

    // Accepts either a single `cardId` or a batch via `cardIds` (array, or a
    // pasted blob separated by commas / newlines / spaces).
    const requestedIds = parseCardIdList(
      cardIds !== undefined && cardIds !== null ? cardIds : cardId
    );

    if (requestedIds.length === 0) {
      return res.status(400).json({ error: "Please enter at least one Card ID." });
    }
    if (requestedIds.length > MAX_BATCH_SIZE) {
      return res.status(400).json({
        error: `Too many Card IDs at once (${requestedIds.length}). Maximum is ${MAX_BATCH_SIZE}.`,
      });
    }

    const groups = loadInventoryGroups();
    const index = indexGroupsByCardId(groups);

    // -------------------------------------------------------------- lookup --
    // The "don't make me check the store first" step: paste any number of Card
    // IDs and get back what actually exists, in what conditions, how many are
    // genuinely available, and whether each is already hidden.
    if (action === "lookup") {
      const reservedMap = await getActiveReservedMap(redis);

      // Flatten every matched listing across the whole batch, then fetch all
      // sold counters in ONE MGET rather than per card.
      const allMatches = [];
      requestedIds.forEach(id => {
        (index.get(id) || []).forEach(match => {
          allMatches.push({ cardId: id, ...match });
        });
      });

      const soldByGroupKey = {};
      if (allMatches.length > 0) {
        const soldValues = await redis.mget(
          ...allMatches.map(m => `sold:${m.groupKey}`)
        );
        allMatches.forEach((m, i) => {
          soldByGroupKey[m.groupKey] = Number(soldValues[i]) || 0;
        });
      }

      const results = requestedIds.map(id => {
        const matches = index.get(id) || [];
        const hiddenUntil = hiddenMap[id] ? hiddenMap[id].expiresAt : null;

        if (matches.length === 0) {
          return { cardId: id, found: false, hiddenUntil };
        }

        const listings = matches.map(m => {
          const sold = soldByGroupKey[m.groupKey] || 0;
          const reserved = reservedMap[m.groupKey] || 0;
          return {
            groupKey: m.groupKey,
            name: m.group.name,
            condition: m.group.description || "",
            set: m.group.set || "",
            // Display-only extras for the admin lookup panel. Without these the
            // panel showed "no image" for every card, because it was reading
            // fields this endpoint never sent.
            rarity: m.group.category || "",
            price: Number(m.group.price || 0),
            hasImage: Boolean(m.group.photo),
            featured: Boolean(m.group.featured),
            baseStock: m.group.baseStock,
            sold,
            reserved,
            available: Math.max(m.group.baseStock - sold - reserved, 0),
            trueStock: Math.max(m.group.baseStock - sold, 0),
          };
        });

        return {
          cardId: id,
          found: true,
          name: listings[0].name,
          listings,
          totalAvailable: listings.reduce((sum, l) => sum + l.available, 0),
          onStore: listings.some(l => l.released && l.trueStock > 0),
          scheduled: listings.some(l => !l.released),
          // True only when NOTHING is released yet. "scheduled" as a card-level
          // status should mean "not on the store at all" — a released but
          // sold-out card was wrongly reported as scheduled because onStore
          // also requires available stock.
          allScheduled: listings.every(l => !l.released),
          anyReleased: listings.some(l => l.released),
          nextReleaseAt: listings.reduce((soonest, l) => {
            if (!l.pendingReleaseAt) return soonest;
            return soonest === null ? l.pendingReleaseAt : Math.min(soonest, l.pendingReleaseAt);
          }, null),
          hiddenUntil,
        };
      });

      return res.status(200).json({
        ok: true,
        results,
        summary: {
          requested: requestedIds.length,
          found: results.filter(r => r.found).length,
          notFound: results.filter(r => !r.found).map(r => r.cardId),
          alreadyHidden: results.filter(r => r.hiddenUntil).map(r => r.cardId),
        },
      });
    }

    // ---------------------------------------------------------------- hide --
    if (action === "hide") {
      const requestedHours = Number(hours) > 0 ? Number(hours) : DEFAULT_HIDE_HOURS;
      const cappedHours = Math.min(requestedHours, MAX_HIDE_HOURS);
      const expiresAt = Date.now() + cappedHours * 60 * 60 * 1000;

      const hidden = [];
      const notFound = [];

      requestedIds.forEach(id => {
        const matches = index.get(id) || [];
        if (matches.length === 0) {
          // Unknown IDs are reported back rather than silently ignored, but
          // they don't block the rest of the batch from being hidden.
          notFound.push(id);
          return;
        }
        hiddenMap[id] = { expiresAt, label: matches[0].group.name };
        hidden.push({
          cardId: id,
          name: matches[0].group.name,
          listingCount: matches.length,
        });
      });

      if (hidden.length > 0) {
        await saveHiddenCardsMap(redis, hiddenMap);
      }

      return res.status(200).json({
        ok: true,
        hidden,
        notFound,
        hours: cappedHours,
        expiresAt,
      });
    }

    // -------------------------------------------------------------- unhide --
    if (action === "unhide") {
      const restored = [];
      const alreadyVisible = [];

      requestedIds.forEach(id => {
        if (!hiddenMap[id]) {
          alreadyVisible.push(id);
          return;
        }
        const matches = index.get(id) || [];
        restored.push({
          cardId: id,
          name: hiddenMap[id].label || (matches[0] ? matches[0].group.name : id),
        });
        delete hiddenMap[id];
      });

      if (restored.length > 0) {
        await saveHiddenCardsMap(redis, hiddenMap);
      }

      return res.status(200).json({ ok: true, restored, alreadyVisible });
    }

    return res.status(400).json({ error: "Unknown action." });
  } catch (err) {
    console.error("hide-card error:", err);
    res.status(500).json({ error: "Failed to update hidden cards." });
  }
}
