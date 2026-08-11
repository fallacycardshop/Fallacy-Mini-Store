@AGENTS.md

# Fallacy Mini Store — project context

`AGENTS.md` (imported above) holds the hard engineering constraints and the
pre-ship checklist. **Those rules win over anything below.** This file covers
the layout, the deployment limits, and the conventions that aren't obvious from
reading the code.

## What this is

A Telegram-linked card shop for Fallacy Card Shop. Static `index.html`
storefront + `admin.html` + Vercel serverless functions in `api/`, with Upstash
Redis for runtime state and `ministore-inventory.csv` as the catalogue.

**No build step, no framework, no test suite, no linter.** `index.html` and
`admin.html` are single self-contained files with inline CSS and JS. Do not
introduce a bundler, a framework, or a `node_modules`-dependent front end
without being asked.

- Live: https://vercel.com/fallacy/fallacycardshop
- Repo: https://github.com/fallacycardshop/Fallacy-Mini-Store

## Repo map

| Path | What it is |
|---|---|
| `index.html` | The entire storefront (~100KB, inline CSS + JS) |
| `admin.html` | The entire admin panel (~145KB, inline CSS + JS) |
| `api/_inventory.js` | Shared helpers: CSV parsing, group keys, `getStoreState()`, drip logic. Not a route — not in `vercel.json`. |
| `api/*.js` | One serverless function per route |
| `ministore-inventory.csv` | The catalogue. Columns: `CardID,Name,Set,Rarity,Price,Condition,Stock,Photo,Featured` |
| `images/` | ~200MB of card photos, served raw from GitHub `main` via the `Photo` column |
| `index.js`, `force-node.js` | Trivial health-check handlers; leave them alone |
| `discount-codes.csv` | Vestigial, header only. Real codes live in the `DISCOUNT_CODES` env var — see below. |

## Two ceilings that will bite you

**1. Vercel Hobby allows a maximum of 12 serverless functions. `vercel.json`
currently registers exactly 12.** There is no room for a 13th. A new endpoint
means folding it into an existing function as another method or `action`
branch, which is why `api/recent-sales.js` already does triple duty:

- `GET` — recent-sales ticker
- `POST` — funnel analytics counters (`funnel:counts` hash, one `HINCRBY`)
- Telegram bot webhook

Before adding a function, say out loud that this ceiling exists and propose
which existing file it should join.

**2. This repo is public** — it has to be, so the product photos in `images/`
load from raw GitHub URLs. **Never commit a secret, key, token, discount code,
customer name, email or order record.** Anything sensitive goes in a Vercel
environment variable.

## Environment variables (Vercel → Settings → Environment Variables)

| Var | Used by |
|---|---|
| `UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN` | every function, via `Redis.fromEnv()` |
| `ADMIN_RESET_KEY` | every admin action — the single shared admin password |
| `DISCOUNT_CODES` | `api/validate-discount.js`; format `CODE:type:value[:expiry];...`, expiry in SGT as `YYYY-MM-DD` or `YYYY-MM-DDTHH:MM` |
| `TELEGRAM_BOT_TOKEN`, `TELEGRAM_WEBHOOK_SECRET` | `api/recent-sales.js` webhook half |

There is no local `.env`. Without these, functions cannot run locally — see
"How to verify a change" below.

## Features and where they live

- **Cart stepper** — product cards swap to `− qty +` once an item is in the
  cart, sized to exactly match "Add to cart" (`.product-actions` is a fixed
  116px column). Cards update in place via `refreshProductCards()`; never
  re-render the whole grid on a cart change.
- **Auction hiding** (`api/hide-card.js`) — batch-hide CardIDs for N hours,
  auto-expiring. Hidden cards are dropped from the catalogue and cannot be
  reserved. Hides *all* conditions of a CardID.
- **Slow release / drip** (`api/drip.js`) — schedules new CSV rows for gradual
  release, default 5/day at a configurable local time (SGT/UTC+8). Released
  cards appear in a "Newly in stock!" row above featured for a configurable
  window, then fall into Featured or All Cards automatically. Requires a
  one-time "set current inventory as baseline" action before first use.
- **Editable headings** (`api/store-settings.js`) — featured and newly-in row
  titles, plus promo text.
- **Discount codes** (`api/validate-discount.js`) — percent or fixed, optional
  SGT expiry, minimum spend $10.
- **Orders** (`api/orders.js`) — reads back the server-side order backup.
- **Recent sales ticker** — footer, left of the cart button; shows card name and
  set. Set name is captured at sale time in `confirm-order.js`.
- **Section rendering** — `renderSection(headingText, matches, { soldOutVisible })`.
  Featured and Newly-in pass `0` (sold-out fully collapsed); All Cards shows 5.

## Storefront conventions

- Product cards show condition and set with **no** "Condition:"/"Set:" label
  prefix. Rarity keeps its label.
- The results counter excludes sold-out listings.
- Order email paste blocks emit **one row per physical card**, not per cart
  line, matching the Excel sheet's per-card format.
- Display order: featured first, then a daily deterministic shuffle
  (`seededShuffle` + `getTodaySeed`) — not random per request.
- Vercel Web Analytics snippet sits immediately before `</body>`.

## Admin conventions

- Every admin action authenticates with the single `ADMIN_RESET_KEY`.
- Panels are independent cards stacked vertically. `body` is
  `flex-direction: column` — **do not revert it to row**, the panels overlap.
- Admin fetches read the response as text first and parse manually, so an
  unregistered endpoint reports the real cause instead of "network error".

## How to verify a change

There is no test suite and no local Redis, so verification is by reading, not
running. Before saying a change is done:

1. Re-read the diff in full — these are single 100KB+ files and a careless
   replacement silently drops unrelated code.
2. Walk the `AGENTS.md` pre-ship checklist for anything touching `api/`.
3. If a function was added or renamed, confirm it is in `vercel.json` **and**
   that the total is still ≤ 12, with `includeFiles` if it reads the CSV.
4. `node --check <file>` on any changed `.js` catches syntax errors.
5. Say plainly what was *not* verified. Real verification happens on the Vercel
   preview deploy.

## Working agreement

- Commit to a branch and open a PR so Vercel builds a preview URL. Do not push
  straight to `main` unless asked — `main` is production.
- Prefer small, surgical edits over rewriting a whole file.
- If something in the repo looks unfamiliar or contradicts this file, **preserve
  it and ask.** Work has come from more than one machine; this file may be
  behind the code.

## Known gaps

- Drip cannot stage a **restock** of an existing CardID+Condition — bumping the
  `Stock` column publishes immediately.
- Auction hiding is per CardID, not per condition.
- The recent-sales ticker was left to fill naturally; historical sales were not
  backfilled (sold counters carry no timestamps).
- `discount-codes.csv` is a dead file kept only to avoid breaking anything that
  might still reference it.
