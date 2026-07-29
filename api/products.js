import fs from "fs";
import path from "path";
import { readFileSync } from "fs";
import XLSX from "xlsx";

export default function handler(req, res) {
  try {
    // Build absolute path to the Excel file in the repo
    const filePath = path.join(process.cwd(), "Ministore inventory.xlsx");

    // Read file from disk
    const fileBuffer = readFileSync(filePath);

    // Parse workbook
    const workbook = XLSX.read(fileBuffer, { type: "buffer" });

    // Use the first sheet in the workbook, whatever it's named,
    // instead of a hardcoded name that can silently break on renames/typos.
    const firstSheetName = workbook.SheetNames[0];
    const sheet = workbook.Sheets[firstSheetName];

    if (!sheet) {
      return res.status(400).json({
        error: `No sheet found in Excel file.`,
      });
    }

    const rows = XLSX.utils.sheet_to_json(sheet);

    // Map rows to product objects.
    // Your current spreadsheet columns are: Name, Rarity, Price, Condition, Stock, Photo
    // (no "Description" or "Category" columns yet) — this maps those in,
    // but still falls back to Description/Category if you add them later.
    const products = rows.map((row, index) => ({
      id: index + 1,
      name: row.Name || "",
      price: Number(row.Price || 0),
      photo: row.Photo || "",
      description: row.Description || row.Condition || "",
      stock: Number(row.Stock || 0),
      category: row.Category || row.Rarity || "Uncategorized",
    }));

    res.status(200).json(products);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to load inventory." });
  }
}
