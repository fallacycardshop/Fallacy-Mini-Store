// Shared request helpers for the public endpoints. Not a route — not in
// vercel.json (like _inventory.js).

// The caller's IP as Vercel reports it. Vercel sets these headers itself at the
// edge, so a client can't spoof them by sending its own. Returns "" when no
// address is available, in which case rate limiting is skipped rather than
// lumping every unknown caller into one shared bucket.
export function clientIp(req) {
  const h = (req && req.headers) || {};
  const raw = h["x-vercel-forwarded-for"] || h["x-real-ip"] || h["x-forwarded-for"] || "";
  return String(Array.isArray(raw) ? raw[0] : raw).split(",")[0].trim();
}

// ---------------------------------------------------------------------------
// Rate limiting.
//
// ONE rolling hash per 10-minute window (`rl:<window>`), field `<bucket>|<id>`,
// so the limiter adds a fixed one or two keys to the keyspace no matter how many
// visitors there are — a key per visitor would make the reservation SCAN on
// every page load dearer (see AGENTS.md). Cost: one HINCRBY per call, plus one
// EXPIRE on an identity's first hit in a window.
//
// Limits are deliberately generous: Singapore mobile networks put many
// customers behind one shared address, so this is sized to stop a script, not
// to throttle a busy drop.
//
// Fails OPEN. This is not a stock read: if the counter can't be read, letting
// the request through costs nothing, while refusing it would block a real
// buyer. (Stock reads still fail closed — that rule is unchanged.)
// ---------------------------------------------------------------------------
const WINDOW_MS = 10 * 60 * 1000;
const WINDOW_KEY_TTL_SECONDS = 15 * 60;

export async function rateLimit(redis, bucket, id, limit) {
  if (!id) return { ok: true, count: 0 };
  try {
    const key = `rl:${Math.floor(Date.now() / WINDOW_MS)}`;
    const count = Number(await redis.hincrby(key, `${bucket}|${id}`, 1)) || 0;
    if (count === 1) await redis.expire(key, WINDOW_KEY_TTL_SECONDS);
    return { ok: count <= limit, count };
  } catch (e) {
    console.error("rate limit check failed:", e);
    return { ok: true, count: 0 };
  }
}
