import XLSX from "xlsx";
import path from "path";
import { readFileSync } from "fs";

export default function handler(req, res) {
  try {
    // Build absolute path to the Excel file in the repo
    const filePath = path.join(process.cwd(), "Ministore inventory.xlsx");

    // Read file from disk
    const fileBuffer = readFileSync(filePath);

    // Parse workbook
    const workbook = XLSX.read(fileBuffer, { type: "buffer" });

    const sheetName = "Ministore inventory";
    const sheet = workbook.Sheets[sheetName];

    if (!sheet) {
      return res.status(400).json({
        error: `Sheet "${sheetName}" not found in Excel file.`,
      });
    }

    const rows = XLSX.utils.sheet_to_json(sheet);

    // Map rows to product objects
    const products = rows.map((row, index) => ({
      id: index + 1,
      name: row.Name || "",
      price: Number(row.Price || 0),
      photo: row.Photo || "",
      description: row.Description || "",
      stock: Number(row.Stock || 0),
      category: row.Category || "Uncategorized",
    }));

    res.status(200).json(products);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to load inventory." });
  }
}
