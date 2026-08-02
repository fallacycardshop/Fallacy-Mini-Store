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

    if (groups.has(groupKey)) {
      groups.get(groupKey).baseStock += stockValue;
    } else {
      const featuredRaw = (row.Featured || "").trim().toLowerCase();
      groups.set(groupKey, {
        cardId,
        name: row.Name || "",
        price: Number(row.Price || 0),
        photo: row.Photo || "",
        description: row.Description || row.Condition || "",
        category: row.Category || row.Rarity || "Uncategorized",
        set: row.Set || "",
        featured: ["y", "yes", "true", "1"].includes(featuredRaw),
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

  const values = await Promise.all(keys.map(k => redis.get(k)));
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
