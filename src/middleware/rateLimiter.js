import { logger } from "../config/logger.js";

// In-memory store: { jid: { count, resetAt } }
const store = new Map();

const WINDOW_MS = 60_000; // 1 minute
const MAX_MESSAGES = 10;   // max messages per contact per window

export function isRateLimited(jid) {
  const now = Date.now();
  const entry = store.get(jid);

  if (!entry || now > entry.resetAt) {
    store.set(jid, { count: 1, resetAt: now + WINDOW_MS });
    return false;
  }

  if (entry.count >= MAX_MESSAGES) {
    logger.warn({ jid }, "[RateLimit] Contact throttled");
    return true;
  }

  entry.count++;
  return false;
}

// Clean up expired entries every 5 minutes to avoid memory leaks
setInterval(() => {
  const now = Date.now();
  for (const [jid, entry] of store.entries()) {
    if (now > entry.resetAt) store.delete(jid);
  }
}, 5 * 60_000);
