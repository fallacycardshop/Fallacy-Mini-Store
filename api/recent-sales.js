import { Redis } from "@upstash/redis";

const redis = Redis.fromEnv();

// ---------------------------------------------------------------------------
// This endpoint does double duty: GET returns the recent-sales ticker, POST
// records/reads sales-funnel counters.
//
// They're merged into one file purely because the Vercel Hobby plan allows a
// maximum of 12 serverless functions, and the store was already at the limit.
// Both halves are cheap: recording is one HINCRBY, the whole report is one
// HGETALL.
// ---------------------------------------------------------------------------

const FUNNEL_KEY = "funnel:counts";

// Only these names are accepted, so a stray or malicious POST can't bloat the
// hash with arbitrary fields.
const ALLOWED_EVENTS = new Set([
  "page_view",
  "add_to_cart",
  "view_cart",
  "begin_checkout",
  "payment_shown",
  "purchase",
  "checkout_failed",
  "checkout_blocked",
  "telegram_prefill",
  "view_social_proof",
  "cart_nudge_shown",
  "reservation_rescued",
  "order_total_mismatch",
  "join_channel_click",
]);

// Blocked checkouts record WHY as well as how many, so the funnel's biggest
// drop-off can be attributed rather than guessed at. Allowlisted like the event
// names, so the hash can't be filled with arbitrary fields.
const ALLOWED_REASONS = new Set([
  "missing_telegram",
  "missing_details",
  "stock_gone",
  "reserve_failed",
  "network",
]);

const REPORT_DAYS = 14;
const TZ_OFFSET_MINUTES = 480; // SGT, so days line up with your trading day

function localDateKey(ts) {
  return new Date(ts + TZ_OFFSET_MINUTES * 60000).toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------
// Telegram bot webhook.
//
// Folded into this file because the Vercel Hobby plan caps the project at 12
// serverless functions and the store is at the limit. Telegram updates are
// told apart from funnel posts by the presence of update_id.
//
// Setup, once:
//   1. Add TELEGRAM_BOT_TOKEN (from BotFather) to Vercel env vars.
//   2. Add TELEGRAM_WEBHOOK_SECRET — any random string you choose.
//   3. Point Telegram at this endpoint:
//      https://api.telegram.org/bot<TOKEN>/setWebhook
//        ?url=https://fallacy-mini-store.vercel.app/api/recent-sales
//        &secret_token=<YOUR_SECRET>
//   4. Register the commands with BotFather /setcommands:
//        start - Open the Mini Store
//        faq - Frequently asked questions
// ---------------------------------------------------------------------------

const STORE_URL = "https://fallacy-mini-store.vercel.app/";

// Edit freely — this is what /faq replies with. Telegram HTML formatting.
const FAQ_TEXT = `<b>Frequently Asked Questions</b>

<b>How do I order?</b>
Tap the button below to open the Mini Store, add cards to your cart and check out. Payment is by PayNow.

<b>How long do I have to pay?</b>
Your cards are reserved for 5 minutes once the PayNow QR appears. If the timer runs out, the cards go back on sale.

<b>How do I send proof of payment?</b>
Send your payment screenshot to @fallacytcg after checking out.

<b>Can I hold my cards and mail them later?</b>
Yes — choose "Hold my package" at checkout. The mailing fee is paid upfront and we'll hold your cards until you're ready.

<b>Are the photos the actual card?</b>
Photos are for reference only. The condition stated on each listing is what you'll receive.

<b>When does new stock drop?</b>
New cards are released daily. Check the "Newly in stock!" row at the top of the store.

Still stuck? Message @fallacytcg and we'll help.`;

async function telegramCall(method, payload) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) {
    console.error("TELEGRAM_BOT_TOKEN is not set");
    return;
  }
  await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
}

// Opens the store as a Mini App rather than a browser tab, so the buyer's
// Telegram identity is available and the username field prefills.
const openStoreKeyboard = {
  inline_keyboard: [[{ text: "🛒 Open the Mini Store", web_app: { url: STORE_URL } }]],
};

async function handleTelegram(req, res) {
  // Telegram echoes the secret back on every call; anything else is not from
  // Telegram and is ignored.
  const secret = process.env.TELEGRAM_WEBHOOK_SECRET;
  if (secret && req.headers["x-telegram-bot-api-secret-token"] !== secret) {
    return res.status(401).json({ ok: false });
  }

  const message = req.body.message || req.body.edited_message;
  const text = message && message.text ? message.text.trim().toLowerCase() : "";
  const chatId = message && message.chat ? message.chat.id : null;

  // Always 200, promptly — Telegram retries anything else.
  if (!chatId) return res.status(200).json({ ok: true });

  if (text.startsWith("/faq")) {
    await telegramCall("sendMessage", {
      chat_id: chatId,
      text: FAQ_TEXT,
      parse_mode: "HTML",
      disable_web_page_preview: true,
      reply_markup: openStoreKeyboard,
    });
  } else if (text.startsWith("/start") || text.startsWith("/shop") || text.startsWith("/store")) {
    await telegramCall("sendMessage", {
      chat_id: chatId,
      text:
        "Welcome to <b>Fallacy's Mini Store</b> 🎴\n\n" +
        "Tap below to browse our Pokémon singles. Use /faq if you have questions.",
      parse_mode: "HTML",
      reply_markup: openStoreKeyboard,
    });
  } else {
    await telegramCall("sendMessage", {
      chat_id: chatId,
      text: "Try /faq for common questions, or tap below to open the store.",
      reply_markup: openStoreKeyboard,
    });
  }

  return res.status(200).json({ ok: true });
}

async function handleFunnel(req, res) {
  const { event, key, action, revenue, reason } = req.body || {};

  // ------------------------------------------------------------ set stats --
  // Headline figures for the shopfront's social-proof panel. Entered by hand
  // because they span the whole business — the auction channel as well as this
  // store — and nothing here can measure that.
  //
  // baseCards is a floor, not a total: confirmed store orders keep adding to it
  // automatically, so the number stays current without being re-entered.
  if (action === "setStats") {
    const adminKey = process.env.ADMIN_RESET_KEY;
    if (!adminKey || key !== adminKey) {
      return res.status(401).json({ error: "Incorrect passphrase." });
    }

    const { baseCards, baseCustomers, sinceLabel } = req.body || {};
    const update = {};
    if (baseCards !== undefined) {
      update.baseCards = Math.max(Number(baseCards) || 0, 0);
      // Zero the auto-added store counter whenever the base is re-entered.
      //
      // Without this, entering a fresh true total would double-count: the
      // figure you type already includes the store sales that this counter has
      // been adding on top. Resetting makes the number you enter exactly what
      // shoppers see, and it climbs from there.
      update.cards = 0;
    }
    if (baseCustomers !== undefined) update.baseCustomers = Math.max(Number(baseCustomers) || 0, 0);
    if (sinceLabel !== undefined) update.sinceLabel = String(sinceLabel || "").slice(0, 40);

    if (Object.keys(update).length > 0) await redis.hset("stats:lifetime", update);

    const saved = (await redis.hgetall("stats:lifetime")) || {};
    return res.status(200).json({ ok: true, stats: saved });
  }

  // --------------------------------------------------------------- report --
  if (action === "report") {
    const adminKey = process.env.ADMIN_RESET_KEY;
    if (!adminKey) {
      return res.status(500).json({ error: "Admin actions are not configured yet." });
    }
    if (!key || key !== adminKey) {
      return res.status(401).json({ error: "Incorrect passphrase." });
    }

    const raw = (await redis.hgetall(FUNNEL_KEY)) || {};

    const days = [];
    for (let i = 0; i < REPORT_DAYS; i++) {
      const date = localDateKey(Date.now() - i * 86400000);
      const row = { date, revenue: Number(raw[`${date}|revenue`]) || 0 };
      ALLOWED_EVENTS.forEach(name => {
        row[name] = Number(raw[`${date}|${name}`]) || 0;
      });
      ALLOWED_REASONS.forEach(name => {
        row[`blocked:${name}`] = Number(raw[`${date}|blocked:${name}`]) || 0;
      });
      days.push(row);
    }

    const totals = { revenue: 0 };
    ALLOWED_EVENTS.forEach(name => (totals[name] = 0));
    ALLOWED_REASONS.forEach(name => (totals[`blocked:${name}`] = 0));
    days.forEach(d => {
      totals.revenue += d.revenue;
      ALLOWED_EVENTS.forEach(name => (totals[name] += d[name]));
      ALLOWED_REASONS.forEach(name => (totals[`blocked:${name}`] += d[`blocked:${name}`]));
    });

    return res.status(200).json({ ok: true, days, totals, reportDays: REPORT_DAYS });
  }

  // --------------------------------------------------------------- record --
  // Public by necessity (shoppers fire it), but harmless: it can only increment
  // counters whose names are on the allowlist.
  if (!event || !ALLOWED_EVENTS.has(event)) {
    return res.status(400).json({ error: "Unknown event." });
  }

  const date = localDateKey(Date.now());
  await redis.hincrby(FUNNEL_KEY, `${date}|${event}`, 1);

  if (event === "checkout_blocked" && ALLOWED_REASONS.has(reason)) {
    await redis.hincrby(FUNNEL_KEY, `${date}|blocked:${reason}`, 1);
  }

  if (event === "purchase" && Number(revenue) > 0) {
    await redis.hincrbyfloat(FUNNEL_KEY, `${date}|revenue`, Number(revenue));
  }

  return res.status(200).json({ ok: true });
}

// Show up to 20 (matches MAX_RECENT_SALES in confirm-order.js), and never show
// anything older than 2 days.
// Always the last 20 sales, however old. No age cutoff: on a quiet week an
// empty banner says less about the shop than a slightly older sale does.
const MAX_SHOWN = 20;
const MAX_PANEL = 20;        // expanded panel shows the same last 20

export default async function handler(req, res) {
  try {
    // POST = a Telegram update or funnel tracking; GET = the sales ticker.
    if (req.method === "POST") {
      if (req.body && req.body.update_id !== undefined) {
        return await handleTelegram(req, res);
      }
      return await handleFunnel(req, res);
    }

    // ?full=1 adds the lifetime totals for the expanded panel. Both views show
    // the same last 20 sales; the ticker stays a single LRANGE.
    const wantFull = req.query && (req.query.full === "1" || req.query.full === "true");
    const limit = wantFull ? MAX_PANEL - 1 : MAX_SHOWN - 1;

    const raw = await redis.lrange("recent_sales", 0, limit);


    const sales = (raw || [])
      .map(entry => {
        try {
          return typeof entry === "string" ? JSON.parse(entry) : entry;
        } catch (e) {
          return null;
        }
      })
      // No age filtering — ltrim caps the list at 20 on write, so it
      // self-limits without ever emptying during a quiet spell.
      .filter(Boolean);

    if (!wantFull) {
      // Unchanged shape for the ticker, so nothing else needs updating.
      return res.status(200).json(sales);
    }

    const stats = (await redis.hgetall("stats:lifetime")) || {};
    return res.status(200).json({
      sales,
      stats: {
        // baseCards / baseCustomers are set by hand in the admin panel: they
        // cover the whole business (auction channel included), which this store
        // can't see. Store sales are added on top as they happen.
        cards: (Number(stats.baseCards) || 0) + (Number(stats.cards) || 0),
        customers: Number(stats.baseCustomers) || 0,
        sinceLabel: stats.sinceLabel || "",
      },
    });
  } catch (err) {
    console.error("recent-sales error:", err);
    // Fail quietly either way — a tracking or ticker failure must never be
    // visible to a shopper mid-purchase.
    if (req.method === "POST") return res.status(200).json({ ok: false });
    res.status(200).json([]);
  }
}
