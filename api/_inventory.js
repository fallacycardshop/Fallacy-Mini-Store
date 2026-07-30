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
      groups.set(groupKey, {
        cardId,
        name: row.Name || "",
        price: Number(row.Price || 0),
        photo: row.Photo || "",
        description: row.Description || row.Condition || "",
        category: row.Category || row.Rarity || "Uncategorized",
        baseStock: stockValue,
      });
    }
  });

  return groups;
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
