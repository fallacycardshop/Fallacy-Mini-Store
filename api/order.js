import crypto from "crypto";

// Validates Telegram Mini App initData against your bot token.
// Returns true if valid, false if invalid or missing/unconfigured.
function validateTelegramInitData(initData, botToken) {
  if (!initData || !botToken) return false;

  try {
    const params = new URLSearchParams(initData);
    const hash = params.get("hash");
    params.delete("hash");

    const dataCheckArr = [];
    for (const [key, value] of params.entries()) {
      dataCheckArr.push(`${key}=${value}`);
    }
    dataCheckArr.sort();
    const dataCheckString = dataCheckArr.join("\n");

    const secretKey = crypto
      .createHmac("sha256", "WebAppData")
      .update(botToken)
      .digest();

    const computedHash = crypto
      .createHmac("sha256", secretKey)
      .update(dataCheckString)
      .digest("hex");

    return computedHash === hash;
  } catch (err) {
    console.error("initData validation error:", err);
    return false;
  }
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const { order, telegramUser, initData } = req.body || {};

    if (!order || !order.cart || !order.name || !order.phone || !order.address) {
      return res.status(400).json({ error: "Missing required order fields" });
    }

    // Optional but recommended: validate the Telegram data actually came from
    // Telegram, not a spoofed client. Set TELEGRAM_BOT_TOKEN in Vercel env vars
    // to enable this. If unset, we skip validation and mark the user as unverified.
    const botToken = process.env.TELEGRAM_BOT_TOKEN;
    const isVerified = botToken
      ? validateTelegramInitData(initData, botToken)
      : false;

    // Flatten cart object { id: { product, quantity } } into a line-item array.
    const items = Object.values(order.cart).map(({ product, quantity }) => ({
      name: product.name,
      category: product.category || "",
      quantity,
      unitPrice: Number(product.price || 0),
      lineTotal: Number(product.price || 0) * quantity,
    }));

    const telegramUsernameDisplay =
      telegramUser && isVerified ? telegramUser.username || "(no username set)" : "unverified";
    const telegramUserIdDisplay = telegramUser && isVerified ? telegramUser.id || "" : "";

    const itemsSummary = items
      .map(
        (item) =>
          `${item.name} (${item.category}) x${item.quantity} @ $${item.unitPrice.toFixed(2)} = $${item.lineTotal.toFixed(2)}`
      )
      .join("\n");

    // FormSubmit.co needs no API key or account setup — it just needs the
    // destination email address in the URL itself. We reuse RESEND_TO_EMAIL
    // here since it's already set correctly in Vercel.
    const toEmail = process.env.RESEND_TO_EMAIL;

    if (!toEmail) {
      console.error("RESEND_TO_EMAIL is not set in Vercel env vars");
      return res.status(500).json({ error: "Order notifications are not configured yet." });
    }

    const emailRes = await fetch(`https://formsubmit.co/ajax/${encodeURIComponent(toEmail)}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({
        _subject: `New order #${order.id} — ${order.name} — ${order.total || ""}`,
        _template: "table",
        Order_ID: order.id,
        Buyer_Name: order.name,
        Phone: order.phone,
        Address: order.address,
        Telegram_Username: telegramUsernameDisplay,
        Telegram_User_ID: telegramUserIdDisplay,
        Subtotal: order.subtotal || "",
        Shipping: order.shipping || "",
        Total: order.total || "",
        Items: itemsSummary,
      }),
    });

    if (!emailRes.ok) {
      const text = await emailRes.text();
      console.error("FormSubmit request failed:", emailRes.status, text);
      return res.status(502).json({ error: "Failed to send order notification email." });
    }

    res.status(200).json({ ok: true });
  } catch (err) {
    console.error("Order handler error:", err);
    res.status(500).json({ error: "Unexpected server error." });
  }
}
