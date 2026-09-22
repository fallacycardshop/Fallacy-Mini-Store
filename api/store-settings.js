import { Redis } from "@upstash/redis";
import {
  getStoreSettings,
  saveStoreSettings,
  DEFAULT_FEATURED_TITLE,
  DEFAULT_NEW_TITLE,
  loadInventoryGroups,
  getPriceOverrides,
  savePriceOverrides,
  effectivePrice,
  PRICE_OVERRIDES_KEY,
} from "./_inventory.js";

const redis = Redis.fromEnv();

const MAX_TITLE_LENGTH = 60;
const MAX_PROMO_LENGTH = 300;
const MAX_PRICE = 100000; // sanity ceiling so a typo can't set an absurd price

// Actions:
//   get   — read current settings (1 Redis command)
//   set   — update the featured-row heading (1 Redis command)
//   reset — restore the default heading (1 Redis command)
//
// The storefront never calls this endpoint. It reads the heading from
// /api/products, which already fetches it in the same MGET as the hidden-card
// list, so an editable heading costs nothing on a page load.
export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const { key, action, featuredTitle, newTitle, promoText } = req.body || {};
    const adminKey = process.env.ADMIN_RESET_KEY;

    if (!adminKey) {
      console.error("ADMIN_RESET_KEY is not set in Vercel env vars");
      return res.status(500).json({ error: "Admin actions are not configured yet." });
    }

    if (!key || key !== adminKey) {
      return res.status(401).json({ error: "Incorrect passphrase." });
    }

    if (action === "get") {
      const settings = await getStoreSettings(redis);
      return res.status(200).json({
        ok: true,
        settings,
        defaultFeaturedTitle: DEFAULT_FEATURED_TITLE,
        defaultNewTitle: DEFAULT_NEW_TITLE,
      });
    }

    if (action === "reset") {
      const settings = {
        featuredTitle: DEFAULT_FEATURED_TITLE,
        newTitle: DEFAULT_NEW_TITLE,
        promoText: "",
      };
      await saveStoreSettings(redis, settings);
      return res.status(200).json({ ok: true, settings, reset: true });
    }

    if (action === "set") {
      const current = await getStoreSettings(redis);
      const settings = { ...current };

      // Each heading is optional — only the ones supplied get changed.
      for (const [field, value] of [
        ["featuredTitle", featuredTitle],
        ["newTitle", newTitle],
      ]) {
        if (value === undefined || value === null) continue;
        const title = String(value).trim();
        if (!title) {
          return res.status(400).json({ error: "Headings can't be blank." });
        }
        if (title.length > MAX_TITLE_LENGTH) {
          return res.status(400).json({
            error: `Heading is too long (${title.length}). Maximum is ${MAX_TITLE_LENGTH} characters.`,
          });
        }
        settings[field] = title;
      }

      // Promo text is handled separately from the headings because blank is a
      // legitimate value — it's how the banner gets switched off.
      if (promoText !== undefined && promoText !== null) {
        const promo = String(promoText).trim();
        if (promo.length > MAX_PROMO_LENGTH) {
          return res.status(400).json({
            error: `Promo text is too long (${promo.length}). Maximum is ${MAX_PROMO_LENGTH} characters.`,
          });
        }
        settings.promoText = promo;
      }

      await saveStoreSettings(redis, settings);
      return res.status(200).json({ ok: true, settings });
    }

    // ------------------------------------------------------------- prices ---
    // Quick price editing without a CSV commit + rebuild. Overrides live in one
    // JSON key (price:overrides) applied on top of the CSV price at request time.

    // List every UNSOLD (in-stock) listing with its CSV price and any override.
    // Two Redis commands: one MGET of the sold counters, one GET of the overrides.
    if (action === "getPrices") {
      const groups = loadInventoryGroups();
      const overrides = await getPriceOverrides(redis);
      const entries = Array.from(groups.entries());

      // Batch every sold counter into a single MGET (never a loop of gets).
      const soldValues = entries.length
        ? await redis.mget(...entries.map(([groupKey]) => `sold:${groupKey}`))
        : [];

      const prices = [];
      entries.forEach(([groupKey, group], i) => {
        const sold = Number(soldValues[i]) || 0;
        const available = Math.max((Number(group.baseStock) || 0) - sold, 0);
        if (available <= 0) return; // only cards still in stock (unsold)
        const csvPrice = Number(group.price) || 0;
        const override = overrides[groupKey];
        const overridden = Number.isFinite(Number(override)) && Number(override) > 0;
        prices.push({
          groupKey,
          cardId: group.cardId,
          name: group.name,
          set: group.set,
          condition: group.condition || "",
          csvPrice,
          price: effectivePrice(overrides, groupKey, csvPrice),
          overridden,
          stock: available,
        });
      });
      prices.sort(
        (a, b) =>
          (a.name || "").localeCompare(b.name || "") ||
          (a.condition || "").localeCompare(b.condition || "")
      );
      return res.status(200).json({
        ok: true,
        prices,
        overrideCount: Object.keys(overrides).length,
      });
    }

    // Set (or update) the override for one listing.
    if (action === "setPrice") {
      const groupKey = String((req.body && req.body.groupKey) || "");
      const price = Number(req.body && req.body.price);
      if (!groupKey) return res.status(400).json({ error: "Missing listing." });
      if (!Number.isFinite(price) || price <= 0) {
        return res.status(400).json({ error: "Enter a price greater than 0." });
      }
      if (price > MAX_PRICE) {
        return res.status(400).json({ error: "That price looks too high." });
      }
      // Reject overrides for listings that no longer exist, so the map can't
      // collect orphans. Pure CSV read, no Redis.
      if (!loadInventoryGroups().has(groupKey)) {
        return res.status(400).json({ error: "That listing no longer exists." });
      }
      const rounded = Math.round(price * 100) / 100;
      const overrides = await getPriceOverrides(redis);
      overrides[groupKey] = rounded;
      await savePriceOverrides(redis, overrides);
      return res.status(200).json({ ok: true, groupKey, price: rounded });
    }

    // Remove one override — the listing reverts to its CSV price.
    if (action === "resetPrice") {
      const groupKey = String((req.body && req.body.groupKey) || "");
      if (!groupKey) return res.status(400).json({ error: "Missing listing." });
      const overrides = await getPriceOverrides(redis);
      if (Object.prototype.hasOwnProperty.call(overrides, groupKey)) {
        delete overrides[groupKey];
        await savePriceOverrides(redis, overrides);
      }
      return res.status(200).json({ ok: true, groupKey, reset: true });
    }

    // Drop every override at once — the whole store reverts to CSV prices.
    if (action === "clearPrices") {
      await redis.del(PRICE_OVERRIDES_KEY);
      return res.status(200).json({ ok: true, cleared: true });
    }

    return res.status(400).json({ error: "Unknown action." });
  } catch (err) {
    console.error("store-settings error:", err);
    res.status(500).json({ error: "Failed to update store settings." });
  }
}
