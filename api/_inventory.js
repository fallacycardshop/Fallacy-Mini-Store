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
