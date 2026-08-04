import { Redis } from "@upstash/redis";
import {
  getStoreSettings,
  saveStoreSettings,
  DEFAULT_FEATURED_TITLE,
  DEFAULT_NEW_TITLE,
} from "./_inventory.js";

const redis = Redis.fromEnv();

const MAX_TITLE_LENGTH = 60;
const MAX_PROMO_LENGTH = 300;

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

    return res.status(400).json({ error: "Unknown action." });
  } catch (err) {
    console.error("store-settings error:", err);
    res.status(500).json({ error: "Failed to update store settings." });
  }
}
