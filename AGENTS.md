# Engineering constraints — Fallacy Mini Store

Read this before changing anything in `api/` or the stock-handling parts of
`index.html`.

These rules exist because of a real production incident: the store began
showing sold-out cards as available, then started failing to load
intermittently. The cause was not a bug in the stock logic — it was Redis
command volume. `api/products.js` was issuing one `redis.get()` per listing
(~190 per page load), and `index.html` refreshed every 20 seconds in every
open tab, including background ones. Partial failures made some sold-out
cards look available; total failures showed "failed to load".

---

## 1. Redis command count must be O(1) per request, not O(catalogue)

A load of `/api/products` costs ~3 Redis commands today, and must stay flat
as the catalogue grows. If a change would make command count scale with the
number of listings, cart lines, or concurrent visitors, it needs a rethink.

Rough budget:

| Endpoint | Commands | Notes |
|---|---|---|
| `GET /api/products` | ~3 | SCAN reservations, MGET reservations, MGET sold counters |
| `POST /api/reserve` | ~3 | SCAN + MGET + one SET, regardless of cart size |
| `POST /api/confirm-order` | 2 + lines | one INCRBY per line, plus GET and DEL |

## 2. Batch reads — never loop

Many keys means one `MGET`, or a pipeline. Never a `for` loop of awaited
`get()`s, and never `Promise.all(keys.map(k => redis.get(k)))` — that is the
exact pattern that caused the incident. It looks concurrent and harmless, but
it is one network request per key.

```js
// NO
const values = await Promise.all(keys.map(k => redis.get(k)));

// YES
const values = await redis.mget(...keys);
```

## 3. Fail closed, never open

If a Redis read fails, the request must error. It must **never** fall back to
`sold = 0` or any other optimistic default.

Treating a failed read as "nothing sold" makes every sold-out card look
available and lets buyers purchase stock that does not physically exist. A
500 and a retry is a minor annoyance; overselling single-copy cards means
refunding a customer and losing their trust. Do not add a `try/catch` around
a stock read that lets execution continue with a default value.

## 4. No unconditional polling

Any background refresh must:

- check `currentScreen` so it only runs when the shop is actually open;
- check `!document.hidden` so background tabs do not poll;
- use an interval measured in minutes (currently 60s), not seconds;
- pair with a `visibilitychange` listener so returning to the tab refreshes
  immediately, keeping data fresh without frequent polling.

## 5. New per-request state joins the existing MGET

`/api/products` fetches hidden cards, store settings and the drip schedule in a
single `MGET` via `getStoreState()`. Anything new the storefront needs goes into
that same call, not a separate round trip. Adding the editable headings and the
whole drip-release system cost **zero** extra commands per page load because of
this.

## 6. Orders are recorded server-side before anything else can fail

The full order record is posted with the confirmation request and written to the
`orders` Redis list in the same call that decrements stock. The FormSubmit email
is a convenience layer on top.

This exists because of a real incident: the email was sent fire-and-forget after
confirmation, and the success modal immediately navigated to Telegram — tearing
down the page and killing the in-flight request. Stock moved, no email arrived,
and the order was unrecoverable. Never make the email the sole record of a sale.

## 7. Prefer computing over storing

Anything derivable from `ministore-inventory.csv` at request time (price,
condition, set, rarity, base stock, featured flag, display order) must be
computed, not cached in Redis. Redis holds only what genuinely changes at
runtime:

- `sold:<CardID>::<Condition>` — permanent sale counters
- `reservation:<id>` — in-progress checkouts, TTL-expiring
- `hidden:cards` — one JSON object: all auction-hidden CardIDs + expiry
- `store:settings` — one JSON object: editable row headings
- `drip:schedule` — one JSON object: drip config + groupKey → releaseAt
- `recent_sales` — capped list for the footer ticker
- `orders` — capped list: authoritative order backups (300)
- `funnel:counts` — hash: per-day funnel events and blocked-checkout reasons
- `stats:lifetime` — hash: hand-entered shopfront proof figures
- `restock:counts` — hash: how many times each listing has been restocked
- `audit:adjustments` — hash: manual audit corrections, with a reason
- `customer:aliases` — hash: secondary customer key → canonical primary, so the
  same person's two identities (numeric Telegram id + browser `@handle`) fold
  into one badge/spend/voucher row. Resolve every customer key through
  `resolveCustomerKey` before reading/writing spend.

Note that each multi-item feature uses **one** key holding a JSON object, not
one key per item. That is deliberate: one key per hidden card or per scheduled
release would mean a lookup per listing on every page load.

## 8. Stock key format is load-bearing

Group keys are `` `${CardID}::${Condition}` ``. Sold counters in Redis are
keyed off this exact string. **Changing a CardID or Condition value in the
CSV orphans that listing's sold counter**, and the card silently returns to
full stock. If those columns change, the corresponding `sold:` keys must be
migrated to match.

## 9. Twelve serverless functions is a hard ceiling

The Vercel Hobby plan allows **12 serverless functions and `vercel.json`
registers exactly 12**. There is no room for a thirteenth. A new endpoint means
folding it into an existing function as another method or `action` branch.

This is why `api/recent-sales.js` already does triple duty:

- `GET` — the recent-sales ticker
- `POST` — funnel analytics counters, and the shopfront proof figures
- Telegram bot webhook (`/start`, `/faq`)

Before adding a function, say out loud that this ceiling exists and propose
which existing file it should join. `api/orders.js` is currently read-only and
is a reasonable host for order-related writes.

## 10. Derive a number in ONE place

The most common bug in this codebase is **two screens disagreeing about the
same number**, and it has recurred with:

- stock counts — the audit and the drip badge used different formulas
- release quantities — `describe()` computed one figure, then a caller
  overwrote it with a stale one
- order totals — `currentSubtotal` is only recalculated inside `renderCart()`,
  so any path that changed the cart without re-rendering left it stale and
  charged the wrong amount

Each time, the fix was to compute the value once and have every caller read it.
If you find yourself writing the same arithmetic in a second place, that is the
bug forming. In particular: after spreading a helper's output, do not reassign
one of its fields from a different source.

## 11. Displayed stock has three parts, not two

`sold + on sale + off sale` must equal the CSV stock. "Off sale" covers stock
that exists but cannot be bought:

- held back by the drip, not yet released
- hidden for an auction

Omitting either makes real stock look like it has gone missing. Also note that
`available` from the drip report is **not** hiding-aware, so a hidden card must
have its on-sale figure forced to zero or its stock is counted twice.

Counters can exceed stock. If `sold` is greater than `published` — from an
over-counted sale, or stock lowered after sales — then `csvStock - published`
double-counts the sold copies. Measure withheld stock against what is already
accounted for.

---

## vercel.json uses legacy explicit `builds`

Every new function MUST be registered in `vercel.json` or it will not deploy.
The catch-all route then returns storefront HTML and callers fail with a
confusing JSON parse error rather than a clean 404 — this has caused several
false debugging trails. Any function that reads the CSV also needs
`"config": { "includeFiles": "ministore-inventory.csv" }`.

## Work from the deployed version, not from memory

Changes have been made from more than one machine. Before editing a file, fetch
the current version from GitHub `main` and patch that. Re-uploading an older
copy has silently destroyed a feature before.

## Vercel Preview shares production Redis unless the env vars are split

Preview deployments inherit whatever `UPSTASH_REDIS_REST_URL` /
`UPSTASH_REDIS_REST_TOKEN` a project has, so by default **a preview reads and
writes the same Upstash database as production** — completing a checkout on a
preview really does decrement live stock, write a real order, and fire the real
email. This bit us once (stock had to be reinstated by hand).

The store is now configured with a **separate Upstash database for the Preview
environment** (Vercel → Storage): the production DB is connected to the project
for **Production only**, and a second DB (`fallacy-preview`) for **Preview**
only. Same variable names, different values per environment — no prefix, because
the code reads the fixed names via `Redis.fromEnv()`.

Keep it that way. If you ever reconnect a store to "all environments" or add a
custom prefix, previews will either fall back onto production data or fail to
find Redis entirely. A preview DB starting "empty" (every card at full stock, no
orders) is the *expected, healthy* sign that isolation is working — not a bug.

## Front-end traps that have bitten more than once

**Apostrophes in filenames.** Card images include names like
`Sabrina'sHintSRSM9109.jpg`. An inline `onerror="...this.src='${photo}'"`
handler breaks out of its single-quoted string on that apostrophe and the rest
of the filename is parsed as JavaScript — a `SyntaxError` and a blank image.
Escape the URL for both the JS string and the HTML attribute.

**Never rebuild a control from inside its own event handler.** Redrawing a
checklist's markup from a checkbox's `onchange` destroys that checkbox
mid-event; the click registers and nothing happens. Update counts and styling
in place, and re-render only the content below.

**Keys read from a DOM dataset are strings.** `Order_ID` is stored as a number,
so a `Set` holding numbers will never match `dataset.orderId`. Normalise
through one helper.

**Thumbnails.** Product images are served at ~92px but the originals are
~270KB. `images/thumbs/` holds ~320px copies (~38KB) and the storefront uses
them with a fallback to the full-size original, so a missing thumbnail degrades
rather than breaks. Replacing an image does **not** update its thumbnail — the
only reliable check is to regenerate and compare byte-for-byte, since the file
still exists and an existence check passes.

**`raw.githubusercontent.com` is not a CDN.** It rate-limits, and the store
depends on it for every card image. This is a known ceiling, not a bug to
debug when images stop loading.

## Before shipping a change to `api/`

- [ ] Count the Redis commands per request. Does it scale with catalogue size?
- [ ] Are multi-key reads batched into `MGET`?
- [ ] Does a Redis failure error out rather than defaulting to optimistic stock?
- [ ] Did any CSV `CardID` or `Condition` value change? If so, migrate `sold:` keys.
- [ ] Check the Upstash console command count after deploying.
- [ ] Is the function registered in `vercel.json`, with `includeFiles` if it reads the CSV?
- [ ] Did you patch the current `main` version rather than an older copy?
- [ ] Still 12 functions?
- [ ] Is any number you added computed in exactly one place, or did you
      duplicate arithmetic that already exists elsewhere?
- [ ] If it touches stock display, does `sold + on sale + off sale` still
      reconcile against the CSV for a hidden card and a drip-scheduled one?

## Verification is by reading, not running

There is no test suite and no local Redis, so the functions cannot run locally.
`node --check` proves a file parses — it does **not** prove anything still
works, and it will happily pass a file from which whole functions have been
deleted. After removing a block, grep for the identifiers it defined and
confirm nothing else references them.

Say plainly what was *not* verified. Real verification happens on the Vercel
preview deploy.
