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
- `orders` — capped list: authoritative order backups

Note that each multi-item feature uses **one** key holding a JSON object, not
one key per item. That is deliberate: one key per hidden card or per scheduled
release would mean a lookup per listing on every page load.

## 8. Stock key format is load-bearing

Group keys are `` `${CardID}::${Condition}` ``. Sold counters in Redis are
keyed off this exact string. **Changing a CardID or Condition value in the
CSV orphans that listing's sold counter**, and the card silently returns to
full stock. If those columns change, the corresponding `sold:` keys must be
migrated to match.

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

## Before shipping a change to `api/`

- [ ] Count the Redis commands per request. Does it scale with catalogue size?
- [ ] Are multi-key reads batched into `MGET`?
- [ ] Does a Redis failure error out rather than defaulting to optimistic stock?
- [ ] Did any CSV `CardID` or `Condition` value change? If so, migrate `sold:` keys.
- [ ] Check the Upstash console command count after deploying.
- [ ] Is the function registered in `vercel.json`, with `includeFiles` if it reads the CSV?
- [ ] Did you patch the current `main` version rather than an older copy?
