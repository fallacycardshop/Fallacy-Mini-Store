import path from "path";
import { readFileSync } from "fs";
import { kv } from "@vercel/kv";

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

    const products = await Promise.all(
      dataRows.map(async (rowArr, index) => {
        const row = {};
        headers.forEach((h, i) => (row[h] = rowArr[i]));

        const cardId = row.CardID || "";
        // Sold counts are tracked by CardID (stable) rather than row position,
        // since row position shifts whenever the CSV is reordered/edited.
        const soldKey = cardId || row.Name || `row${index}`;
        const baseStock = Number(row.Stock || 0);

        let sold = 0;
        try {
          sold = Number(await kv.get(`sold:${soldKey}`)) || 0;
        } catch (kvErr) {
          console.error("KV read failed for", soldKey, kvErr);
        }

        return {
          id: index + 1,
          name: row.Name || "",
          price: Number(row.Price || 0),
          photo: row.Photo || "",
          description: row.Description || row.Condition || "",
          stock: Math.max(baseStock - sold, 0),
          category: row.Category || row.Rarity || "Uncategorized",
          cardId,
        };
      })
    );

    res.status(200).json(products);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to load inventory." });
  }
}
