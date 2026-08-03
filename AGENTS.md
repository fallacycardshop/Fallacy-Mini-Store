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

## 5. Prefer computing over storing

Anything derivable from `ministore-inventory.csv` at request time (price,
condition, set, rarity, base stock, featured flag, display order) must be
computed, not cached in Redis. Redis holds only what genuinely changes at
runtime:

- `sold:<CardID>::<Condition>` — permanent sale counters
- `reservation:<id>` — in-progress checkouts, TTL-expiring

## 6. Stock key format is load-bearing

Group keys are `` `${CardID}::${Condition}` ``. Sold counters in Redis are
keyed off this exact string. **Changing a CardID or Condition value in the
CSV orphans that listing's sold counter**, and the card silently returns to
full stock. If those columns change, the corresponding `sold:` keys must be
migrated to match.

---

## Before shipping a change to `api/`

- [ ] Count the Redis commands per request. Does it scale with catalogue size?
- [ ] Are multi-key reads batched into `MGET`?
- [ ] Does a Redis failure error out rather than defaulting to optimistic stock?
- [ ] Did any CSV `CardID` or `Condition` value change? If so, migrate `sold:` keys.
- [ ] Check the Upstash console command count after deploying.
