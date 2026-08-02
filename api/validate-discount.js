const MINIMUM_DISCOUNT_SPEND = 10;

// Codes live in the DISCOUNT_CODES environment variable (Vercel Settings →
// Environment Variables), NOT in the repo — this repo is public (needed for
// product photos to load), so anything in it can be read by anyone. Format:
//   CODE:type:value;CODE2:type:value
// e.g.  MINILAUNCH10:percent:10;WELCOME5:fixed:5
function parseDiscountCodes(raw) {
  if (!raw) return [];
  return raw
    .split(";")
    .map(entry => entry.trim())
    .filter(Boolean)
    .map(entry => {
      const [code, type, value] = entry.split(":");
      return {
        code: (code || "").trim().toUpperCase(),
        type: (type || "").trim().toLowerCase(),
        value: Number(value || 0),
      };
    });
}

export default function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ valid: false, error: "Method not allowed" });
  }

  try {
    const { code, subtotal } = req.body || {};
    if (!code || !code.trim()) {
      return res.status(200).json({ valid: false });
    }

    const codes = parseDiscountCodes(process.env.DISCOUNT_CODES);
    const match = codes.find(c => c.code === code.trim().toUpperCase());

    if (!match) {
      return res.status(200).json({ valid: false });
    }

    if (Number(subtotal || 0) < MINIMUM_DISCOUNT_SPEND) {
      return res.status(200).json({
        valid: false,
        reason: "minimum_not_met",
        minimumRequired: MINIMUM_DISCOUNT_SPEND,
      });
    }

    res.status(200).json({
      valid: true,
      type: match.type, // "percent" or "fixed"
      value: match.value,
    });
  } catch (err) {
    console.error("validate-discount error:", err);
    res.status(500).json({ valid: false, error: "Failed to validate code." });
  }
}
