import axios from "axios";
import XLSX from "xlsx";

export default async function handler(req, res) {
  try {
    const ONEDRIVE_URL =
      "https://1drv.ms/x/c/a0dcee2a1ab55924/IQDgKWisXa2hRK6XFzUX0bZiAVo_IdfUEpqFMcJ37kjZDtU?e=mpIe9W";

    // Convert OneDrive link → direct download link
    const directLink = ONEDRIVE_URL
      .replace("1drv.ms", "api.onedrive.com/v1.0/shares/u!")
      .replace(/\/[^/]+$/, "/root/content");

    // Download Excel file
    const response = await axios.get(directLink, {
      responseType: "arraybuffer",
    });

    // Parse workbook
    const workbook = XLSX.read(response.data, { type: "buffer" });

    const sheetName = "Ministore inventory";
    const sheet = workbook.Sheets[sheetName];

    if (!sheet) {
      return res.status(400).json({
        error: `Sheet "${sheetName}" not found in Excel file.`,
      });
    }

    const rows = XLSX.utils.sheet_to_json(sheet);

    // Convert rows → product objects
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
