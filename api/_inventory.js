import path from "path";
import { readFileSync } from "fs";

// Minimal CSV parser (handles quoted fields with commas, if you ever need them)
function parseCSV(text) {
  const rows = [];
  let row = [];
  let field = "";
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    const next = text[i + 1];

    if (inQuotes) {
      if (char === '"' && next === '"') {
        field += '"';
        i++;
      } else if (char === '"') {
        inQuotes = false;
      } else {
        field += char;
      }
    } else {
      if (char === '"') {
        inQuotes = true;
      } else if (char === ",") {
        row.push(field);
        field = "";
      } else if (char === "\n" || char === "\r") {
        if (field !== "" || row.length > 0) {
          row.push(field);
          rows.push(row);
          row = [];
          field = "";
        }
        if (char === "\r" && next === "\n") i++;
      } else {
        field += char;
      }
    }
  }
  if (field !== "" || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

// Returns a Map<groupKey, { cardId, name, price, photo, description, category, baseStock }>
// Rows sharing the same CardID + Condition are merged (their Stock values summed).
export function loadInventoryGroups() {
  const filePath = path.join(process.cwd(), "ministore-inventory.csv");
  const fileText = readFileSync(filePath, "utf-8");

  const rows = parseCSV(fileText);
  const headers = rows[0];
  const dataRows = rows.slice(1).filter(r => r.some(cell => cell.trim() !== ""));

  const groups = new Map();

  dataRows.forEach((rowArr, index) => {
    const row = {};
    headers.forEach((h, i) => (row[h] = rowArr[i]));

    const cardId = row.CardID || "";
    const condition = row.Condition || "";
    const groupKey = `${cardId || row.Name || `row${index}`}::${condition}`;
    const stockValue = Number(row.Stock || 0);

    const featuredRaw = (row.Featured || "").trim().toLowerCase();
    const rowIsFeatured = ["y", "yes", "true", "1"].includes(featuredRaw);

    if (groups.has(groupKey)) {
      const existing = groups.get(groupKey);
      existing.baseStock += stockValue;
      // If ANY duplicate row for this card+condition is marked Featured,
      // the whole merged listing is featured — regardless of row order.
      if (rowIsFeatured) existing.featured = true;
      // Track the LAST row this listing appeared on. Drip scheduling orders by
      // this, so a restock row appended to the bottom of the CSV is queued at
      // the bottom — where you put it — rather than inheriting the position of
      // the original row higher up the file.
      existing.lastRowIndex = index;

      // LATEST ROW WINS for the descriptive fields. Re-listing a card at a new
      // price means the newer row is the current one, so a later row overrides
      // the earlier values rather than being ignored. Stock is the exception —
      // that accumulates, because duplicate rows are additional copies.
      const latestPrice = Number(row.Price || 0);
      if (row.Price !== undefined && row.Price !== "" && latestPrice > 0) {
        existing.price = latestPrice;
      }
      if (row.Photo) existing.photo = row.Photo;
      if (row.Name) existing.name = row.Name;
      if (row.Set) existing.set = row.Set;
      if (row.Category || row.Rarity) {
        existing.category = row.Category || row.Rarity;
      }
    } else {
      groups.set(groupKey, {
        cardId,
        firstRowIndex: index,
        lastRowIndex: index,
        name: row.Name || "",
        price: Number(row.Price || 0),
        photo: row.Photo || "",
        description: row.Description || row.Condition || "",
        category: row.Category || row.Rarity || "Uncategorized",
        set: row.Set || "",
        featured: rowIsFeatured,
        baseStock: stockValue,
      });
    }
  });

  return groups;
}

// Simple deterministic hash of a string into a 32-bit integer, used to seed the shuffle.
function hashStringToSeed(str) {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = (hash << 5) - hash + str.charCodeAt(i);
    hash |= 0;
  }
  return hash >>> 0;
}

// Seeded pseudo-random number generator (mulberry32) — same seed always
// produces the same sequence, which is what makes the shuffle "stable for
// the day" rather than different on every request.
function mulberry32(seed) {
  return function () {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Returns a string that's the same all day (UTC) and different the next day.
export function getTodaySeed() {
  const d = new Date();
  return `${d.getUTCFullYear()}-${d.getUTCMonth() + 1}-${d.getUTCDate()}`;
}

// Fisher-Yates shuffle driven by a seeded RNG — deterministic for a given seedStr.
export function seededShuffle(array, seedStr) {
  const rng = mulberry32(hashStringToSeed(seedStr));
  const result = array.slice();
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}

// Scans all keys matching a pattern (paginated via cursor, safe for small keyspaces like this store's).
export async function scanKeys(redis, pattern) {
  let cursor = "0";
  const allKeys = [];
  do {
    const [nextCursor, keys] = await redis.scan(cursor, { match: pattern, count: 100 });
    allKeys.push(...keys);
    cursor = nextCursor;
  } while (cursor !== "0");
  return allKeys;
}

// Sums up quantities from all active (non-expired) reservations for each product key.
export async function getActiveReservedMap(redis) {
  const keys = await scanKeys(redis, "reservation:*");
  const map = {};
  if (keys.length === 0) return map;

  // Single MGET rather than one GET per reservation key — same result, one request.
  const values = await redis.mget(...keys);
  values.forEach(raw => {
    if (!raw) return;
    let data;
    try {
      data = typeof raw === "string" ? JSON.parse(raw) : raw;
    } catch (e) {
      return;
    }
    (data.items || []).forEach(item => {
      map[item.key] = (map[item.key] || 0) + Number(item.quantity || 0);
    });
  });

  return map;
}

// ---------------------------------------------------------------------------
// Temporarily hidden cards (used when a card goes up for auction and we don't
// want the store listing competing with it).
//
// IMPORTANT: every hidden card lives inside ONE Redis key holding a small JSON
// object, so checking "is anything hidden?" costs exactly one GET no matter how
// many cards are hidden. One key per hidden card would mean a lookup per
// listing on every page load, which is the pattern that took the store down.
//
// Shape: { "<cardId>": { expiresAt: <epoch ms>, label: "<card name>" } }
// Entries are pruned lazily on read, so expiry is automatic — nothing needs to
// run on a schedule to bring a card back.
// ---------------------------------------------------------------------------

export const HIDDEN_CARDS_KEY = "hidden:cards";
export const STORE_SETTINGS_KEY = "store:settings";

// Editable copy shown above the featured row. Falls back to this if unset.
export const DEFAULT_FEATURED_TITLE = "\u{1F525} Popular this week";

// Promo strip above the product grid. Empty string = hidden.
export const DEFAULT_PROMO_TEXT = "";

// The promo banner is a free-text field, but it usually advertises a discount
// code. So the banner doesn't outlive the code, we blank it once the advertised
// code has expired. Expiry parsing mirrors api/validate-discount.js — the two
// must agree on how a code's end time is computed (SGT, UTC+8).
const PROMO_TZ_OFFSET_MINUTES = 480;
function parsePromoExpiry(raw) {
  const text = (raw || "").trim();
  if (!text) return null;
  const m = text.match(/^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}))?$/);
  if (!m) return null;
  const [, y, mo, d, h, mi] = m;
  const hours = h === undefined ? 23 : Number(h);
  const minutes = mi === undefined ? 59 : Number(mi);
  const asUtc = Date.UTC(Number(y), Number(mo) - 1, Number(d), hours, minutes, 59, 999);
  return asUtc - PROMO_TZ_OFFSET_MINUTES * 60000;
}
// Returns the banner text, or "" if it advertises a code that has ended. On any
// parse trouble it leaves the banner untouched (the banner is cosmetic, so we
// fail toward showing rather than hiding a still-valid promo).
export function promoTextIfActive(promoText, rawCodes = process.env.DISCOUNT_CODES) {
  const text = String(promoText || "");
  if (!text) return "";
  try {
    const codes = String(rawCodes || "")
      .split(";")
      .map(e => e.trim())
      .filter(Boolean)
      .map(e => {
        const [code, , , ...expiry] = e.split(":");
        return {
          code: (code || "").trim().toUpperCase(),
          expiresAt: parsePromoExpiry(expiry.join(":")),
        };
      });
    // Same ALL-CAPS code shape the storefront highlights in the banner.
    const tokens = text.match(/\b[A-Z][A-Z0-9]{4,19}\b/g) || [];
    for (const tok of tokens) {
      const match = codes.find(c => c.code === tok.toUpperCase());
      if (match && match.expiresAt !== null && Date.now() > match.expiresAt) {
        return "";
      }
    }
  } catch (e) {
    // leave the banner as-is
  }
  return text;
}

// ---------------------------------------------------------------------------
// Welcome reward — a one-time perk open to EVERY customer (new and existing): a
// FLAT dollar discount once the order meets a minimum spend. Each customer can
// claim it once. Mini App only (needs a numeric Telegram id). Config + eligibility
// live in Redis so the perk can be switched on/off and tuned without a deploy.
//
//   welcome:config  — JSON { enabled, minSpend, amount }  (amount = flat $ off)
//   welcome:granted — set of Telegram ids that have CLAIMED the reward. A customer
//                     stays eligible until they're in this set.
// ---------------------------------------------------------------------------
export const WELCOME_CONFIG_KEY = "welcome:config";
export const WELCOME_GRANTED_KEY = "welcome:granted";
export const DEFAULT_WELCOME_CONFIG = { enabled: false, minSpend: 30, amount: 3 };

export function parseWelcomeConfig(raw) {
  const c = { ...DEFAULT_WELCOME_CONFIG };
  if (!raw) return c;
  let d;
  try { d = typeof raw === "string" ? JSON.parse(raw) : raw; } catch (e) { return c; }
  if (!d || typeof d !== "object") return c;
  c.enabled = Boolean(d.enabled);
  if (Number.isFinite(Number(d.minSpend))) c.minSpend = Math.max(0, Number(d.minSpend));
  // Accept `amount` (new flat-discount field); fall back to the old `maxOff` name
  // if that's what's stored, so an existing config keeps working after the rename.
  const amt = d.amount !== undefined ? d.amount : d.maxOff;
  if (Number.isFinite(Number(amt))) c.amount = Math.max(0, Number(amt));
  return c;
}

// CardIDs are compared case-insensitively and trimmed, so "abc123 " typed into
// the admin box still matches "ABC123" in the CSV.
export function normaliseCardId(id) {
  return String(id || "").trim().toLowerCase();
}

// Returns { <normalisedCardId>: { expiresAt, label } } for cards still hidden.
export async function getHiddenCardsMap(redis) {
  return parseHiddenCards(await redis.get(HIDDEN_CARDS_KEY));
}

// Pure parsing, split out so it can be reused by the batched MGET path below
// without triggering a second Redis round trip.
export function parseHiddenCards(raw) {
  if (!raw) return {};

  let data;
  try {
    data = typeof raw === "string" ? JSON.parse(raw) : raw;
  } catch (e) {
    console.error("Corrupted hidden-cards data:", e);
    return {};
  }
  if (!data || typeof data !== "object") return {};

  const now = Date.now();
  const active = {};
  Object.entries(data).forEach(([cardId, entry]) => {
    const expiresAt = Number(entry && entry.expiresAt);
    if (Number.isFinite(expiresAt) && expiresAt > now) {
      active[normaliseCardId(cardId)] = {
        expiresAt,
        label: (entry && entry.label) || "",
      };
    }
  });
  return active;
}

// Convenience wrapper for the common "just tell me which ids to skip" case.
export async function getHiddenCardIds(redis) {
  const map = await getHiddenCardsMap(redis);
  return new Set(Object.keys(map));
}

// Writes the map back, pruned. TTL is set past the last expiry so the key
// tidies itself up if the store is never touched again.
export async function saveHiddenCardsMap(redis, map) {
  const entries = Object.entries(map || {});
  if (entries.length === 0) {
    await redis.del(HIDDEN_CARDS_KEY);
    return;
  }
  const latest = Math.max(...entries.map(([, e]) => Number(e.expiresAt) || 0));
  const ttlSeconds = Math.max(Math.ceil((latest - Date.now()) / 1000) + 60, 60);
  await redis.set(HIDDEN_CARDS_KEY, JSON.stringify(map), { ex: ttlSeconds });
}

// Finds every listing (all conditions) sharing a CardID. Pure CSV work, no
// Redis, so this is free.
export function findGroupsByCardId(groups, cardId) {
  const target = normaliseCardId(cardId);
  if (!target) return [];
  return Array.from(groups.entries())
    .filter(([, group]) => normaliseCardId(group.cardId) === target)
    .map(([groupKey, group]) => ({ groupKey, group }));
}

// Accepts a pasted blob or an array of Card IDs and returns a clean, de-duped,
// normalised list. Splits on commas, semicolons, newlines, tabs or spaces, so
// pasting a column straight out of a spreadsheet works.
export function parseCardIdList(input) {
  const raw = Array.isArray(input) ? input.join("\n") : String(input || "");
  const seen = new Set();
  const ids = [];
  raw
    .split(/[\s,;]+/)
    .map(normaliseCardId)
    .filter(Boolean)
    .forEach(id => {
      if (!seen.has(id)) {
        seen.add(id);
        ids.push(id);
      }
    });
  return ids;
}

// Groups every listing in the catalogue by normalised CardID, so a batch
// lookup is one pass over the CSV instead of one pass per requested ID.
export function indexGroupsByCardId(groups) {
  const index = new Map();
  groups.forEach((group, groupKey) => {
    const id = normaliseCardId(group.cardId);
    if (!id) return;
    if (!index.has(id)) index.set(id, []);
    index.get(id).push({ groupKey, group });
  });
  return index;
}

// ---------------------------------------------------------------------------
// Store settings (currently just the featured-row heading).
//
// Deliberately a single JSON key so future settings cost nothing extra, and
// deliberately fetched in the SAME MGET as the hidden-card list — reading both
// costs one Redis command, so the editable heading adds zero overhead to a
// page load.
// ---------------------------------------------------------------------------

export function parseStoreSettings(raw) {
  const settings = {
    featuredTitle: DEFAULT_FEATURED_TITLE,
    newTitle: DEFAULT_NEW_TITLE,
    promoText: DEFAULT_PROMO_TEXT,
  };
  if (!raw) return settings;

  let data;
  try {
    data = typeof raw === "string" ? JSON.parse(raw) : raw;
  } catch (e) {
    console.error("Corrupted store settings:", e);
    return settings;
  }
  if (!data || typeof data !== "object") return settings;

  if (typeof data.featuredTitle === "string" && data.featuredTitle.trim()) {
    settings.featuredTitle = data.featuredTitle.trim();
  }
  if (typeof data.newTitle === "string" && data.newTitle.trim()) {
    settings.newTitle = data.newTitle.trim();
  }
  // Promo text is allowed to be blank — that's how the banner is switched off.
  if (typeof data.promoText === "string") {
    settings.promoText = data.promoText.trim();
  }
  return settings;
}

export async function getStoreSettings(redis) {
  return parseStoreSettings(await redis.get(STORE_SETTINGS_KEY));
}

export async function saveStoreSettings(redis, settings) {
  await redis.set(STORE_SETTINGS_KEY, JSON.stringify(settings || {}));
}

// One MGET returns everything the storefront needs beyond the CSV:
// hidden cards, editable headings, and the drip-release schedule.
// Three keys, one Redis command.
export async function getStoreState(redis) {
  const [hiddenRaw, settingsRaw, dripRaw] = await redis.mget(
    HIDDEN_CARDS_KEY,
    STORE_SETTINGS_KEY,
    DRIP_STATE_KEY
  );
  return {
    hiddenCardIds: new Set(Object.keys(parseHiddenCards(hiddenRaw))),
    settings: parseStoreSettings(settingsRaw),
    drip: parseDripState(dripRaw),
  };
}

// ---------------------------------------------------------------------------
// Slow-release ("drip") scheduling.
//
// The whole schedule lives in ONE Redis key: a config object plus a map of
// groupKey -> releaseAt (epoch ms). A listing whose releaseAt is in the future
// is hidden from the store entirely; one released within the "new window" is
// flagged isNew so it renders in the Newly In Stock row. After that window it
// simply stops being flagged and falls into the normal sections — no second
// job, no cleanup, nothing to run on a schedule.
// ---------------------------------------------------------------------------

export const DRIP_STATE_KEY = "drip:schedule";

export const DEFAULT_NEW_TITLE = "\u{2728} Newly in stock!";

export const DEFAULT_DRIP_CONFIG = {
  enabled: true,
  perDay: 5,              // listings released per day
  releaseHour: 10,        // local time of day for each release
  releaseMinute: 0,
  tzOffsetMinutes: 480,   // SGT (UTC+8)
  newWindowHours: 24,     // how long a released card stays in Newly In Stock
  holdNewListings: true,  // unscheduled new CSV rows stay hidden until scheduled
};

export function parseDripState(raw) {
  const state = {
    initialized: false,
    config: { ...DEFAULT_DRIP_CONFIG },
    releases: {}, // groupKey -> releaseAt (epoch ms)
    levels: {},   // groupKey -> { published, pendingStock, pendingAt }
  };
  if (!raw) return state;

  let data;
  try {
    data = typeof raw === "string" ? JSON.parse(raw) : raw;
  } catch (e) {
    console.error("Corrupted drip state:", e);
    return state;
  }
  if (!data || typeof data !== "object") return state;

  state.initialized = Boolean(data.initialized);
  state.config = { ...DEFAULT_DRIP_CONFIG, ...(data.config || {}) };
  if (data.releases && typeof data.releases === "object") {
    Object.entries(data.releases).forEach(([groupKey, at]) => {
      const ts = Number(at);
      if (Number.isFinite(ts)) state.releases[groupKey] = ts;
    });
  }
  if (data.levels && typeof data.levels === "object") {
    Object.entries(data.levels).forEach(([groupKey, entry]) => {
      if (!entry || typeof entry !== "object") return;
      const num = v => (v === undefined || v === null || !Number.isFinite(Number(v)) ? null : Number(v));
      state.levels[groupKey] = {
        published: Number(entry.published) || 0,
        pendingStock: num(entry.pendingStock),
        pendingAt: num(entry.pendingAt),
      };
    });
  }
  return state;
}

// How much of a listing's CSV stock is actually published right now.
//
// Restocks are drip-scheduled the same way new listings are: the CSV holds the
// true total, while `published` holds how much of it shoppers can currently
// see. A scheduled increase sits in pendingStock/pendingAt and takes effect on
// its own once that moment passes — no write needed to activate it.
//
// A listing with no level entry isn't tracked (it predates this feature, or the
// baseline hasn't been set), so its full CSV stock is published as before.
export function getEffectiveStock(state, groupKey, csvStock, now = Date.now()) {
  const entry = state.levels[groupKey];
  if (!entry) return csvStock;

  let effective = entry.published;
  if (entry.pendingAt !== null && entry.pendingAt <= now && entry.pendingStock !== null) {
    effective = entry.pendingStock;
  }
  // Never publish more than the CSV says — lowering the CSV figure still works.
  return Math.max(Math.min(effective, csvStock), 0);
}

// The most recent moment this listing gained stock: either its first release or
// a restock that has since landed. Drives the Newly In Stock flag, so a restock
// puts an existing card back in that row.
export function getLastReleaseMoment(state, groupKey, now = Date.now()) {
  const first = state.releases[groupKey];
  let last = first === undefined ? null : first;

  const entry = state.levels[groupKey];
  if (entry && entry.pendingAt !== null && entry.pendingAt <= now) {
    last = last === null ? entry.pendingAt : Math.max(last, entry.pendingAt);
  }
  return last;
}

export async function getDripState(redis) {
  return parseDripState(await redis.get(DRIP_STATE_KEY));
}

export async function saveDripState(redis, state) {
  await redis.set(DRIP_STATE_KEY, JSON.stringify(state || {}));
}

// Is this listing visible on the store right now?
//
// No entry means the listing predates the schedule. It stays visible unless
// holdNewListings is on AND the schedule has been initialised — that guard
// matters, because without it an empty schedule would hide the whole store.
export function isListingReleased(state, groupKey, now = Date.now()) {
  const releaseAt = state.releases[groupKey];
  if (releaseAt === undefined) {
    return !(state.initialized && state.config.holdNewListings);
  }
  return releaseAt <= now;
}

export function isListingNew(state, groupKey, now = Date.now()) {
  const releaseAt = getLastReleaseMoment(state, groupKey, now);
  if (releaseAt === null || releaseAt > now) return false;
  const windowMs = Math.max(Number(state.config.newWindowHours) || 0, 0) * 3600000;
  if (windowMs <= 0) return false;
  return now - releaseAt < windowMs;
}

// The next release moment strictly in the future, in the configured local
// timezone. dayOffset walks forward whole days from there.
export function releaseSlotAt(config, dayOffset, now = Date.now()) {
  const tz = Number(config.tzOffsetMinutes) || 0;
  const localNow = now + tz * 60000;
  const localMidnight = Math.floor(localNow / 86400000) * 86400000;
  const timeOfDay =
    ((Number(config.releaseHour) || 0) * 60 + (Number(config.releaseMinute) || 0)) * 60000;

  let localSlot = localMidnight + timeOfDay;
  if (localSlot <= localNow) localSlot += 86400000; // today's slot has passed

  localSlot += Math.max(dayOffset, 0) * 86400000;
  return localSlot - tz * 60000; // back to UTC epoch ms
}

// Parses "YYYY-MM-DDTHH:MM" as a wall-clock time in the configured timezone
// (SGT by default) and returns epoch ms. Returns null if unparseable.
export function parseLocalDateTime(text, config) {
  const match = String(text || "").trim().match(
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/
  );
  if (!match) return null;
  const [, y, mo, d, h, mi] = match;
  const tz = Number(config.tzOffsetMinutes) || 0;
  return Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), 0, 0) - tz * 60000;
}

// Assigns release times to the given groupKeys, perDay at a time.
//
// firstSlotAt optionally overrides the FIRST day's moment — used to start a
// drip later today when the daily slot has already passed, or to delay the
// start to a chosen date. Subsequent days revert to the configured daily time,
// counted forward from that first slot.
//
// Pure function — the caller decides whether to persist it.
// dailyCounts optionally overrides the uniform perDay: [3, 5, 2] releases three
// on the first day, five on the second, two on the third, then falls back to
// perDay for any remaining listings. Lets a big drop be front- or back-loaded
// without changing the default setting.
export function buildDripSchedule(
  groupKeys,
  config,
  now = Date.now(),
  firstSlotAt = null,
  dailyCounts = null
) {
  const perDay = Math.max(Number(config.perDay) || 1, 1);

  // Expand the plan into a per-listing day index up front, so the slot maths
  // below stays a simple lookup.
  const dayForIndex = [];
  if (Array.isArray(dailyCounts) && dailyCounts.length > 0) {
    let day = 0;
    dailyCounts.forEach(count => {
      const n = Math.max(Math.floor(Number(count) || 0), 0);
      // A 0 releases nothing that day but still advances the calendar — that's
      // how you build in a rest day, e.g. "5,0,5" skips the middle day.
      for (let i = 0; i < n; i++) dayForIndex.push(day);
      day += 1;
    });
    // Anything beyond the plan continues at the default rate.
    let overflow = 0;
    while (dayForIndex.length < groupKeys.length) {
      dayForIndex.push(day + Math.floor(overflow / perDay));
      overflow += 1;
    }
  }
  const validFirst = Number.isFinite(Number(firstSlotAt)) && Number(firstSlotAt) > now
    ? Number(firstSlotAt)
    : null;

  return groupKeys.map((groupKey, i) => {
    const day = dayForIndex.length > 0 ? dayForIndex[i] : Math.floor(i / perDay);
    let releaseAt;
    if (validFirst !== null) {
      releaseAt = day === 0
        ? validFirst
        : releaseSlotAt(config, day - 1, validFirst);
    } else {
      releaseAt = releaseSlotAt(config, day, now);
    }
    return { groupKey, releaseAt };
  });
}

// ===========================================================================
// Loyalty / lifetime-spend helpers
// ===========================================================================
// These are the SINGLE place that turns a stored order record into a customer
// identity and a dollar amount. Both the admin Spend panel and the spend
// backfill derive their figures through here, so the two can never disagree —
// which is the single most common bug in this codebase (two screens computing
// the same number slightly differently). Do not re-parse Total or re-derive the
// customer key anywhere else; call these.

// Redis keys used by the payment/spend feature (see api/orders.js).
export const ORDER_PAID_KEY = "order:paid";        // hash: Order_ID -> "1" | "0"
export const CUSTOMER_SPEND_KEY = "customer:spend"; // hash: customerKey -> dollars (float), organic paid spend
export const CUSTOMER_COUNT_KEY = "customer:orders";// hash: customerKey -> paid order count
// Manual lifetime corrections live apart from organic spend so the organic
// figure stays verifiable against the orders window (see spendReport), while the
// displayed lifetime total is organic + adjustment. Every adjustment is logged
// with a reason for auditability.
export const CUSTOMER_ADJUST_KEY = "customer:spend:adjust"; // hash: customerKey -> JSON array of dated adjustments
export const CUSTOMER_ADJUST_LOG = "customer:spend:log";    // capped list: { at, key, delta, date, reason }

// Per-customer dated spend log: one small hash per customer, field = Order_ID,
// value = "<epochMs>:<amount>". Lets the bot compute one customer's rolling
// window in O(1) Redis calls (a single HGETALL of a short hash) without reading
// the whole orders list. Maintained incrementally by markPaid and rebuilt by
// the backfill; the admin panel stays authoritative by recomputing from orders.
export const SPEND_LOG_PREFIX = "spend:";
export function spendLogKey(custKey) { return SPEND_LOG_PREFIX + custKey; }

// Last badge tier we notified a customer about (hash: customerKey -> badge n, 0
// = no badge). The loyalty cron compares each customer's live window badge to
// this and DMs only when it has DROPPED, then updates the snapshot — so a lapse
// notice fires once, not every day.
export const BADGE_SNAPSHOT_KEY = "loyalty:badgeSnapshot";

// Sum a spend-log hash into cumulative + rolling-window figures.
export function sumSpendLog(logHash, windowStart) {
  let cumulative = 0, window = 0, orders = 0, windowOrders = 0, lastOrder = 0;
  for (const v of Object.values(logHash || {})) {
    const idx = String(v).indexOf(":");
    const when = Number(String(v).slice(0, idx)) || 0;
    const amt = Number(String(v).slice(idx + 1)) || 0;
    cumulative += amt; orders += 1;
    if (when >= windowStart) { window += amt; windowOrders += 1; }
    if (when > lastOrder) lastOrder = when;
  }
  return { cumulative, window, orders, windowOrders, lastOrder };
}
// Orders with neither a Telegram id nor any username land here rather than being
// silently dropped, so the shop owner can still see the money and chase it up.
export const UNATTRIBUTED_KEY = "(no telegram)";

// Customer key for the spend hashes. Telegram_User_ID (numeric, from the Mini
// App) is preferred; it is EMPTY when the shop was opened in a normal browser,
// so we fall back to the normalised @username. A Telegram id is all digits and
// a username must start with a letter, so the two identifier spaces cannot
// collide in one hash — the "@" prefix on usernames just makes a key readable.
export function customerKey(record) {
  if (!record || typeof record !== "object") return UNATTRIBUTED_KEY;
  const id = String(record.Telegram_User_ID || "").trim();
  if (id) return id;
  const uname = String(record.Telegram_Username || record.Buyer_Entered_Telegram_Username || "")
    .trim().replace(/^@+/, "").toLowerCase();
  return uname ? "@" + uname : UNATTRIBUTED_KEY;
}

// Human-readable handle for display, taken from the most recent order for a key.
export function orderHandle(record) {
  if (!record || typeof record !== "object") return UNATTRIBUTED_KEY;
  const uname = String(record.Telegram_Username || record.Buyer_Entered_Telegram_Username || "").trim();
  if (uname) return uname.startsWith("@") ? uname : "@" + uname;
  const id = String(record.Telegram_User_ID || "").trim();
  return id ? "TG:" + id : UNATTRIBUTED_KEY;
}

// ---------------------------------------------------------------------------
// Manual identity merge. The SAME person can hold two customer keys — the
// numeric Telegram id (Mini App) and the "@username" (browser) — so their
// orders, badge and vouchers split across two rows. This one hash aliases a
// secondary key to its canonical primary; every place a customer key is derived
// for spend/badge/vouchers resolves through it, folding the two into one
// identity. One key, one HGETALL — O(1), no per-order lookup.
//
// The mutable data (spend log, adjustments, voucher sets) is physically moved
// onto the primary at merge time; the alias is what folds the IMMUTABLE order
// history and routes any future orders from the secondary identity to the
// primary's log. Both are needed — see api/orders.js `mergeCustomers`.
export const CUSTOMER_ALIAS_KEY = "customer:aliases"; // hash: secondaryKey -> primaryKey

// Follow the alias chain to the canonical key. Guards against a cycle (returns
// where it started looping) and a self-alias, so a malformed map can never spin.
export function resolveCustomerKey(aliasMap, key) {
  const map = aliasMap || {};
  let k = String(key);
  const seen = new Set();
  while (map[k] !== undefined && map[k] !== null && map[k] !== "" && String(map[k]) !== k && !seen.has(k)) {
    seen.add(k);
    k = String(map[k]);
  }
  return k;
}

// Total is a display string like "$50.67" (occasionally with a thousands comma).
// Parse to a number; a blank or unparseable value yields 0 so it can never
// NaN-poison a running sum.
export function orderAmount(record) {
  const n = Number(String((record && record.Total) || "").replace(/[^0-9.]/g, ""));
  return Number.isFinite(n) ? n : 0;
}

// Sum per-customer spend/count/last-order/handle over the orders currently in
// the (capped) orders list. This is the WINDOW view — bounded by the list — not
// the lifetime figure. Lifetime spend is the permanent customer:spend hash,
// credited incrementally as orders are marked paid; this window recompute is
// used only to supply the display handle and last-order date, and as a
// one-directional reconciliation check (lifetime organic spend must be >= the
// paid orders still visible in the window, or an order was paid but not
// credited). It also identifies pre-feature historical orders — those with NO
// order:paid entry — returning them in `seededPaid` so the backfill can credit
// each exactly once and write the explicit "1". New orders carry an explicit
// "0" from confirm time, so "no entry" unambiguously means "historical".
export function aggregateSpend(orderEntries, paidMap, windowStart = 0, aliasMap = null) {
  const map = paidMap || {};
  const byCustomer = new Map();
  const seededPaid = {};
  for (const entry of orderEntries || []) {
    const record = entry && entry.record ? entry.record : entry;
    if (!record || typeof record !== "object") continue;
    const id = String(record.Order_ID || "");
    let paid;
    if (id && Object.prototype.hasOwnProperty.call(map, id)) {
      paid = String(map[id]) === "1";
    } else {
      paid = true;                       // historical order = paid
      if (id) seededPaid[id] = "1";
    }
    if (!paid) continue;
    // Fold a merged secondary identity onto its canonical primary, so both
    // sets of orders roll up into one badge/spend row.
    const key = resolveCustomerKey(aliasMap, customerKey(record));
    const amt = orderAmount(record);
    const when = Number(entry && entry.savedAt) || Number(record.Order_ID) || 0;
    const cur = byCustomer.get(key) ||
      { key, spend: 0, orders: 0, windowSpend: 0, windowOrders: 0, lastOrder: 0, handle: key };
    // Cumulative (all-time) figures...
    cur.spend += amt;
    cur.orders += 1;
    // ...and the rolling-window figures that drive badge STATUS. windowStart of
    // 0 means "no window" and every order counts (cumulative == window).
    if (when >= windowStart) { cur.windowSpend += amt; cur.windowOrders += 1; }
    if (when >= cur.lastOrder) { cur.lastOrder = when; cur.handle = orderHandle(record); }
    byCustomer.set(key, cur);
  }
  return { byCustomer, seededPaid };
}

// ===========================================================================
// Loyalty badges — ONE source of truth (loyalty-programme.md §2). Every screen
// (admin panel, bot, voucher issuance) reads badge status through the helpers
// below so they can never disagree, and thresholds/rewards can be tuned here
// without hunting through logic.
// ===========================================================================
// Each badge carries a distinct display colour, kept here so every screen
// (admin panel, bot, storefront) tints it identically. The icon that pairs with
// each is an original themed pictogram (rock, drop, bolt, …) — not the game's
// trademarked badge art — defined where they're rendered.
// Boulder is the ENTRY tier — any purchase (>= 1 cent) enrols the customer, with
// NO voucher (pct 0). Every other tier keeps the reward that has always sat at
// its dollar threshold; only the NAMES shifted down one rung and Boulder was
// added below, so the first voucher is now Cascade at $80. Names (n1..n8) keep
// their icon + colour, so the art mapping is unchanged.
export const BADGES = [
  { n: 1, name: "Boulder", spend: 0.01, pct: 0,  cap: 0,  color: "#6b7280" }, // entry — no voucher
  { n: 2, name: "Cascade", spend: 80,   pct: 5,  cap: 8,  color: "#2f7fd1" },
  { n: 3, name: "Thunder", spend: 200,  pct: 8,  cap: 16, color: "#e0a417" },
  { n: 4, name: "Rainbow", spend: 400,  pct: 10, cap: 20, color: "#a23fb8" },
  { n: 5, name: "Soul",    spend: 600,  pct: 10, cap: 20, color: "#d94f70" },
  { n: 6, name: "Marsh",   spend: 800,  pct: 10, cap: 25, color: "#3f9d63" },
  { n: 7, name: "Volcano", spend: 1000, pct: 10, cap: 25, color: "#e2622e" },
  { n: 8, name: "Earth",   spend: 1200, pct: 12, cap: 30, color: "#9a6a3c" },
];
// Beyond Earth: a fresh Champion badge every +$250, without limit.
export const CHAMPION = { step: 250, pct: 12, cap: 30, color: "#caa63a" };

// Emoji that stands in for each badge inside a Telegram message (a bot message
// is plain text — a custom image can't sit inline, so these are the inline mark
// that pairs with the name). Chosen to match the painted badge art: rock, drop,
// bolt, rainbow, heart, gold disc, flame, leaf; crown for every Champion tier.
export const BADGE_EMOJI = { 1: "🪨", 2: "💧", 3: "⚡", 4: "🌈", 5: "💗", 6: "🟡", 7: "🔥", 8: "🍃" };
export function badgeEmoji(n) {
  const k = Number(n);
  if (k >= 9) return "👑"; // Champion and beyond
  return BADGE_EMOJI[k] || "🎖";
}

// The painted badge art, committed under images/badges/ and served the same way
// as the card photos (raw GitHub). Every Champion tier shares the one medal.
export const BADGE_SLUGS = { 1: "boulder", 2: "cascade", 3: "thunder", 4: "rainbow", 5: "soul", 6: "marsh", 7: "volcano", 8: "earth" };
export const BADGE_IMAGE_BASE = "https://raw.githubusercontent.com/fallacycardshop/Fallacy-Mini-Store/main/images/badges/";
// Telegram caches a photo by its URL forever once fetched, and raw GitHub caches
// too — so re-rendering the art at the SAME path keeps serving the stale image.
// This version tag is appended to every badge URL; bump it whenever the art is
// regenerated so clients fetch the new file. (raw GitHub ignores the query and
// serves the file; the changed URL is what busts the cache.)
export const BADGE_ASSET_VERSION = "8";
const BADGE_V = "?v=" + BADGE_ASSET_VERSION;
export function badgeSlug(n) {
  const k = Number(n);
  if (k >= 9) return "champion";
  return BADGE_SLUGS[k] || "";
}
export function badgeImageUrl(n) {
  const s = badgeSlug(n);
  return s ? BADGE_IMAGE_BASE + s + ".png" + BADGE_V : "";
}
// The EARN banner ("NEW BADGE EARNED!") — sent in the earn-moment DM when a
// badge is first unlocked. The bare badgeImageUrl icon is kept for admin chips.
export function badgeBannerUrl(n) {
  const s = badgeSlug(n);
  return s ? BADGE_IMAGE_BASE + "banner_" + s + ".png" + BADGE_V : "";
}
// The STATUS banner ("BADGE UNLOCKED" + a progress bar toward the next badge) —
// the bot's My Badges photo. The bar can't be drawn at request time, so it is
// pre-rendered at 10% steps and the closest bucket is chosen from live progress.
export function badgeStatusBannerUrl(n, progressPercent) {
  const s = badgeSlug(n);
  if (!s) return "";
  const bucket = Math.max(0, Math.min(100, Math.round((Number(progressPercent) || 0) / 10) * 10));
  return BADGE_IMAGE_BASE + "status/" + s + "_p" + bucket + ".png" + BADGE_V;
}
// The "trophy case" grid card for the bot's My Collection photo. Because badge
// thresholds are monotonic, a collection is always the first k badges, so there
// are just 10 pre-rendered states (0..9 collected).
export function badgeCollectionUrl(collectedCount) {
  const k = Math.max(0, Math.min(9, Math.round(Number(collectedCount) || 0)));
  return BADGE_IMAGE_BASE + "collection/collection_" + k + ".png" + BADGE_V;
}

// The badge a spend qualifies for: null below Boulder (i.e. no purchase yet), the
// entry Boulder tier for any spend >= 1 cent, one of BADGES, or a Champion tier
// ($1,450, $1,700, …). Champion tier k is badge number 8+k.
export function badgeForSpend(spend) {
  const s = Number(spend) || 0;
  const earth = BADGES[BADGES.length - 1]; // Earth, $1,200
  if (s >= earth.spend + CHAMPION.step) {
    const tier = Math.floor((s - earth.spend) / CHAMPION.step); // 1, 2, 3, …
    return {
      n: earth.n + tier,
      name: tier === 1 ? "Champion" : `Champion ×${tier}`,
      spend: earth.spend + tier * CHAMPION.step,
      pct: CHAMPION.pct, cap: CHAMPION.cap, color: CHAMPION.color, champion: true, tier,
    };
  }
  let earned = null;
  for (const b of BADGES) { if (s >= b.spend) earned = b; }
  return earned; // Boulder..Earth, or null below Boulder
}

// The next badge up and the spend still needed for it — for "progress to next"
// on the bot and lapse messages. Champion always has a next (never maxed out).
export function nextBadge(spend) {
  const s = Number(spend) || 0;
  const earth = BADGES[BADGES.length - 1];
  for (const b of BADGES) { if (s < b.spend) return { badge: b, needed: Number((b.spend - s).toFixed(2)) }; }
  // At/above Earth: next Champion tier.
  const nextAt = earth.spend + (Math.floor((s - earth.spend) / CHAMPION.step) + 1) * CHAMPION.step;
  return { badge: { name: "Champion", spend: nextAt, pct: CHAMPION.pct, cap: CHAMPION.cap, champion: true }, needed: Number((nextAt - s).toFixed(2)) };
}

// Badges are LIFETIME: all spend counts toward a customer's tier, and tiers never
// drop as time passes. Returning 0 (the epoch) makes every "window" figure equal
// the cumulative all-time figure, so the same helpers keep working. (Kept as a
// function so callers are unchanged; flip this back to a rolling cutoff to
// re-enable a time window.)
export function windowStartMs(/* now, tzOffsetMin */) {
  return 0;
}

// Parse "YYYY-MM-DD" as midnight SGT (UTC+8) -> epoch ms; null if malformed.
// The date of a manual adjustment decides whether it falls inside the rolling
// window, so it must be interpreted the same way order timestamps are.
export function parseSgtDate(str, tzOffsetMin = 480) {
  const m = String(str || "").trim().match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  return Date.UTC(+m[1], +m[2] - 1, +m[3], 0, 0, 0, 0) - tzOffsetMin * 60000;
}

// Manual adjustments are stored per customer as a JSON array of dated entries
// { date, amount, reason, at }. Legacy values were a bare number (one undated
// correction) — parse those as a single undated (date 0) entry so they keep
// counting toward the all-time total but never the window.
export function parseAdjustEntries(raw) {
  if (raw === null || raw === undefined) return [];
  if (typeof raw === "number") return [{ date: 0, amount: raw }];
  if (Array.isArray(raw)) return raw;
  const s = String(raw);
  try {
    const v = JSON.parse(s);
    if (Array.isArray(v)) return v;
    if (typeof v === "number") return [{ date: 0, amount: v }];
  } catch (e) { /* not JSON — fall through */ }
  const n = Number(s);
  return Number.isFinite(n) ? [{ date: 0, amount: n }] : [];
}

// Sum a customer's adjustments into cumulative (all) and window (dated on/after
// windowStart) dollar figures — so a dated correction can move the badge.
export function sumAdjust(entries, windowStart) {
  let cumulative = 0, window = 0;
  for (const e of entries || []) {
    const amt = Number(e && e.amount) || 0;
    cumulative += amt;
    if ((Number(e && e.date) || 0) >= windowStart) window += amt;
  }
  return { cumulative, window };
}

// ===========================================================================
// Vouchers (loyalty-programme.md §4). Each earned badge issues one single-use
// voucher, ever. All voucher data lives in ONE hash so the admin panel and the
// storefront redemption read the same source; per-customer index sets keep the
// bot's "my vouchers" and the once-per-badge check O(1).
// ===========================================================================
export const VOUCHERS_KEY = "vouchers";                 // hash: CODE -> JSON voucher record
export const VOUCHER_DAYS = 60;                         // 60-day expiry (§4)
export function customerVouchersKey(k) { return "customer:vouchers:" + k; } // set of CODEs per customer
export function issuedBadgesKey(k) { return "customer:badges:" + k; }        // set of badge numbers ever issued

// All VOUCHER badges a spend has earned (threshold met), Cascade..Earth plus each
// Champion tier. Issuance walks this and skips any already in the issued set, so
// one order crossing several badges pays out one voucher per badge. The entry
// tier (Boulder, pct 0) is excluded here — it's a status tier with no voucher.
export function earnedBadges(spend) {
  const s = Number(spend) || 0;
  const out = [];
  for (const b of BADGES) { if (s >= b.spend && b.pct > 0) out.push({ n: b.n, name: b.name, pct: b.pct, cap: b.cap }); }
  const earth = BADGES[BADGES.length - 1];
  if (s >= earth.spend + CHAMPION.step) {
    const tiers = Math.floor((s - earth.spend) / CHAMPION.step);
    for (let t = 1; t <= tiers; t++) {
      out.push({ n: earth.n + t, name: t === 1 ? "Champion" : `Champion ×${t}`, pct: CHAMPION.pct, cap: CHAMPION.cap });
    }
  }
  return out;
}

// Unambiguous alphabet (no O/0/I/1) for readable, unguessable codes.
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
export function voucherCode(badgeName) {
  // Short prefix: the badge name's first 3 letters (e.g. Cascade -> CAS-XXXXX).
  const prefix = (String(badgeName || "FCS").toUpperCase().replace(/[^A-Z]/g, "").slice(0, 3)) || "FCS";
  let suffix = "";
  for (let i = 0; i < 5; i++) suffix += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)];
  return `${prefix}-${suffix}`;
}

// Live status of a voucher: used > expired > active. Expiry is COMPUTED from
// the date, so nothing has to run to "expire" a voucher.
export function voucherStatus(v, now = Date.now()) {
  if (!v) return "unknown";
  if (v.status === "used" || v.usedAt) return "used";
  if (Number(v.expiresAt) && now > Number(v.expiresAt)) return "expired";
  return "active";
}

// Resolve a single order's paid state with the same "no entry = paid" rule the
// aggregate uses, so the admin toggle and the totals never disagree.
export function isOrderPaid(paidMap, orderId) {
  const map = paidMap || {};
  const id = String(orderId || "");
  if (id && Object.prototype.hasOwnProperty.call(map, id)) return String(map[id]) === "1";
  return true;
}
