import path from "path";
import { readFileSync } from "fs";
import { Redis } from "@upstash/redis";

const redis = Redis.fromEnv();

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

export default async function handler(req, res) {
  try {
    const filePath = path.join(process.cwd(), "ministore-inventory.csv");
    const fileText = readFileSync(filePath, "utf-8");

    const rows = parseCSV(fileText);
    const headers = rows[0];
    const dataRows = rows.slice(1).filter(r => r.some(cell => cell.trim() !== ""));

    // Group rows by CardID (falling back to Name if a row has no CardID),
    // summing their Stock values together. This means pasting an extra row
    // with the same CardID to restock a card just adds to its total —
    // it won't create a duplicate/second listing.
    const groups = new Map();

    dataRows.forEach((rowArr, index) => {
      const row = {};
      headers.forEach((h, i) => (row[h] = rowArr[i]));

      const cardId = row.CardID || "";
      const groupKey = cardId || row.Name || `row${index}`;
      const stockValue = Number(row.Stock || 0);

      if (groups.has(groupKey)) {
        // Only the stock quantity is combined — other fields (price, photo,
        // condition, etc.) are taken from the first row seen for this
        // CardID, so keep those consistent across duplicate rows.
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

    const groupEntries = Array.from(groups.entries());

    const products = await Promise.all(
      groupEntries.map(async ([groupKey, group], index) => {
        let sold = 0;
        try {
          sold = Number(await redis.get(`sold:${groupKey}`)) || 0;
        } catch (kvErr) {
          console.error("Redis read failed for", groupKey, kvErr);
        }

        return {
          id: index + 1,
          name: group.name,
          price: group.price,
          photo: group.photo,
          description: group.description,
          stock: Math.max(group.baseStock - sold, 0),
          category: group.category,
          cardId: group.cardId,
        };
      })
    );

    res.status(200).json(products);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to load inventory." });
  }
}
