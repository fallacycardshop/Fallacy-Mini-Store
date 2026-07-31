import path from "path";
import { readFileSync } from "fs";

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

export default function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ valid: false, error: "Method not allowed" });
  }

  try {
    const { code } = req.body || {};
    if (!code || !code.trim()) {
      return res.status(200).json({ valid: false });
    }

    const filePath = path.join(process.cwd(), "discount-codes.csv");
    let fileText;
    try {
      fileText = readFileSync(filePath, "utf-8");
    } catch (e) {
      // No discount-codes.csv in the repo yet — treat every code as invalid.
      return res.status(200).json({ valid: false });
    }

    const rows = parseCSV(fileText);
    const headers = rows[0];
    const dataRows = rows.slice(1).filter(r => r.some(cell => cell.trim() !== ""));

    const matchArr = dataRows.find(rowArr => {
      const row = {};
      headers.forEach((h, i) => (row[h] = rowArr[i]));
      return (row.Code || "").trim().toUpperCase() === code.trim().toUpperCase();
    });

    if (!matchArr) {
      return res.status(200).json({ valid: false });
    }

    const row = {};
    headers.forEach((h, i) => (row[h] = matchArr[i]));

    res.status(200).json({
      valid: true,
      type: (row.Type || "").trim().toLowerCase(), // "percent" or "fixed"
      value: Number(row.Value || 0),
    });
  } catch (err) {
    console.error("validate-discount error:", err);
    res.status(500).json({ valid: false, error: "Failed to validate code." });
  }
}
