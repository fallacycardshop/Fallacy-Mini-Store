import { Redis } from "@upstash/redis";
import {
  CUSTOMER_ADJUST_KEY,
  spendLogKey,
  sumSpendLog,
  parseAdjustEntries,
  sumAdjust,
  windowStartMs,
  badgeForSpend,
  nextBadge,
} from "./_inventory.js";

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
  "stock_conflict_resolved",
  "telegram_prefill",
  "view_social_proof",
  "cart_nudge_shown",
  "reservation_rescued",
  "order_total_mismatch",
  "join_channel_click",
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

// Shown by the "How badges work" button / /howbadges. Placeholder wording drawn
// from the loyalty programme — replace with the final copy when ready.
const HOW_BADGES_TEXT = `🎖 <b>How Badges Work</b>

Every order you pay for adds to your spend, and as it grows you unlock badges — each one earns a one-time discount voucher.

• Your badge reflects what you've spent over the last 6 months.
• Each badge gives a voucher: a percentage off, up to a set cap, to use once within 60 days.
• Climb the ladder from Boulder all the way to Champion — every step is a new reward.

Tap <b>My Badges</b> any time to see your current badge and how close you are to the next.`;

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

// Persistent reply keyboard shown above the text box — two loyalty buttons that
// send their label as text, handled in handleTelegram. The store opens from the
// built-in menu button beside the message box, so there's no Shop button here.
// Slash commands still work as a fallback, and setMyCommands lists them.
const mainKeyboard = {
  keyboard: [
    [{ text: "🎖 My Badges" }, { text: "ℹ️ How badges work" }],
  ],
  resize_keyboard: true,
  is_persistent: true,
};

const BOT_COMMANDS = [
  { command: "start", description: "Start" },
  { command: "mytier", description: "My badges & spend" },
  { command: "howbadges", description: "How badges work" },
];

// Launch gate. The badge features stay hidden from customers until the whole
// programme (badges + vouchers + launch message) is ready: set env var
// LOYALTY_BOT_LIVE=1 to reveal them to everyone. Until then, only the Telegram
// IDs in LOYALTY_TEST_IDS (comma-separated) see badges, so the shop owner can
// test on the live bot privately without exposing half a programme.
// When loyalty isn't live for this user, the bot shows NO reply keyboard — the
// built-in menu button beside the message box already opens the store.
const noKeyboard = { remove_keyboard: true };
const BOT_COMMANDS_BASE = [
  { command: "start", description: "Start" },
];
function loyaltyLive() {
  return ["1", "true", "yes", "on"].includes(String(process.env.LOYALTY_BOT_LIVE || "").toLowerCase());
}
function loyaltyTestIds() {
  return new Set(String(process.env.LOYALTY_TEST_IDS || "").split(/[\s,;]+/).map(s => s.trim()).filter(Boolean));
}

function money(n) { return "$" + (Number(n) || 0).toFixed(2); }

// Read-only loyalty status for a Telegram numeric user id — the permanent
// identity carried on every Telegram message. One HGETALL of the customer's
// short spend log plus one HGET of their adjustments: O(1) Redis, no scan of the
// orders list. Figures use the same window + badge helpers the admin panel does,
// so the two agree.
async function badgeStatusText(userId) {
  const key = String(userId || "");
  const windowStart = windowStartMs();
  const log = key ? (await redis.hgetall(spendLogKey(key))) || {} : {};
  const s = sumSpendLog(log, windowStart);
  const adj = sumAdjust(parseAdjustEntries(key ? await redis.hget(CUSTOMER_ADJUST_KEY, key) : null), windowStart);
  const windowSpend = s.window + adj.window;
  const badge = badgeForSpend(windowSpend);
  const next = nextBadge(windowSpend);

  let msg = "🎖 <b>Your Badges</b>\n\n";
  msg += badge
    ? `Current badge: <b>${badge.name}</b> (Badge Tier ${badge.n})\n`
    : "You haven't earned a badge yet.\n";
  msg += `Spend in the last 6 months: <b>${money(windowSpend)}</b>\n`;
  if (next && next.badge) {
    const tier = next.badge.n ? ` (Badge Tier ${next.badge.n})` : "";
    msg += `\n${money(next.needed)} more to reach <b>${next.badge.name}</b>${tier}.`;
  }
  msg += "\n\n<i>Vouchers will appear here once rewards launch.</i>";
  return msg;
}

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
  // Loyalty identity is the sender's numeric user id (permanent, uneditable);
  // in a private chat it equals chat.id, but from.id is the correct field.
  const fromId = message && message.from ? message.from.id : chatId;

  // Always 200, promptly — Telegram retries anything else.
  if (!chatId) return res.status(200).json({ ok: true });

  // Gate: badges are visible to everyone once live, or only to the owner's test
  // ID(s) beforehand. The keyboard, menu and replies all follow this.
  const live = loyaltyLive();
  const canSeeBadges = live || loyaltyTestIds().has(String(fromId));
  const kb = canSeeBadges ? mainKeyboard : noKeyboard;
  const comingSoon = "Our loyalty badges are launching soon — stay tuned! 🎴";

  // "How badges work" is checked before "My Badges" since its text also
  // contains the word "badges".
  if (text.includes("how badges") || text.startsWith("/howbadges") || text.startsWith("/faq")) {
    await telegramCall("sendMessage", {
      chat_id: chatId,
      text: canSeeBadges ? HOW_BADGES_TEXT : comingSoon,
      parse_mode: "HTML",
      disable_web_page_preview: true,
      reply_markup: kb,
    });
  } else if (text.includes("badge") || text.startsWith("/mytier") || text.startsWith("/mybadges")) {
    await telegramCall("sendMessage", {
      chat_id: chatId,
      text: canSeeBadges ? await badgeStatusText(fromId) : comingSoon,
      parse_mode: "HTML",
      reply_markup: kb,
    });
  } else if (text.startsWith("/start") || text.startsWith("/shop") || text.startsWith("/store")) {
    // Populate the menu-button command list to match what's live (idempotent).
    await telegramCall("setMyCommands", { commands: live ? BOT_COMMANDS : BOT_COMMANDS_BASE });
    await telegramCall("sendMessage", {
      chat_id: chatId,
      text:
        "Welcome to <b>Fallacy's Mini Store</b> 🎴\n\n" +
        (canSeeBadges
          ? "Check your loyalty badges with the buttons below, or open the store from the menu button beside the message box."
          : "Tap the store button beside the message box to browse our Pokémon singles."),
      parse_mode: "HTML",
      reply_markup: kb,
    });
  } else {
    await telegramCall("sendMessage", {
      chat_id: chatId,
      text: canSeeBadges
        ? "Tap My Badges or How badges work below, or open the store from the menu button."
        : "Tap the store button beside the message box to browse.",
      reply_markup: kb,
    });
  }

  return res.status(200).json({ ok: true });
}

async function handleFunnel(req, res) {
  const { event, key, action, revenue } = req.body || {};

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
      days.push(row);
    }

    const totals = { revenue: 0 };
    ALLOWED_EVENTS.forEach(name => (totals[name] = 0));
    days.forEach(d => {
      totals.revenue += d.revenue;
      ALLOWED_EVENTS.forEach(name => (totals[name] += d[name]));
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
