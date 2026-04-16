// Copyright 2026 Hall Boys, Inc.
// SPDX-License-Identifier: Apache-2.0

import type { IKeyValueStore } from "./kv-store";

const MAX_CONCURRENT = 3;
const MAX_PER_MINUTE = 40;
// Longest a single Acumatica call should plausibly take. Any active-slot
// record older than this is treated as leaked (see `pruneStale`). Chosen
// larger than any real Acumatica round-trip so we never evict a live call.
const STALE_SLOT_MS = 60_000;

// Per-username in-isolate concurrency tracking. We store each active call
// as `{id -> startedAt}` rather than a bare counter so any slot that
// escapes the try/finally (a bug, an uncaught rejection, an isolate that
// freezes mid-call) self-heals once the entry ages past STALE_SLOT_MS —
// previously a leak would permanently eat one of the user's three slots.
// Scoping by username (rather than process-global) also prevents users
// on the same isolate from contaminating each other's limits.
const activeSlots = new Map<string, Map<string, number>>();

function pruneStale(slots: Map<string, number>): void {
  const cutoff = Date.now() - STALE_SLOT_MS;
  for (const [id, startedAt] of slots) {
    if (startedAt < cutoff) slots.delete(id);
  }
}

export class RateLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RateLimitError";
  }
}

/**
 * Enforce concurrency + per-minute rate limits scoped to a user key.
 *
 * - Concurrency: in-isolate per-user slot map with self-healing stale-slot
 *   pruning. Bounded per user, not per-process.
 * - Per-minute: KV-backed sliding bucket keyed by `ratelimit:{userKey}:{minute}`
 *   with a short TTL. Approximate (KV is eventually consistent and the
 *   get/put isn't atomic) but that's fine for rate limiting — it catches
 *   runaway clients without needing strong consistency, and crucially it
 *   survives DO/isolate recycling so clients can't bypass by reconnecting.
 */
export async function withRateLimit<T>(
  store: IKeyValueStore,
  userKey: string,
  fn: () => Promise<T>
): Promise<T> {
  let slots = activeSlots.get(userKey);
  if (!slots) {
    slots = new Map();
    activeSlots.set(userKey, slots);
  }
  pruneStale(slots);

  if (slots.size >= MAX_CONCURRENT) {
    throw new RateLimitError(
      `Concurrent request limit reached (${MAX_CONCURRENT}). Please retry shortly.`
    );
  }

  const minute = Math.floor(Date.now() / 60_000);
  const counterKey = `ratelimit:${userKey}:${minute}`;
  const currentStr = await store.get(counterKey).catch(() => null);
  const current = currentStr ? parseInt(currentStr, 10) : 0;
  if (current >= MAX_PER_MINUTE) {
    throw new RateLimitError(
      `Per-minute request limit reached (${MAX_PER_MINUTE}). Please retry shortly.`
    );
  }
  // TTL of 120s lets the bucket cover the full minute plus spillover; KV
  // TTL minimum is 60s on Cloudflare.
  await store
    .put(counterKey, String(current + 1), { expirationTtl: 120 })
    .catch(() => {});

  const id = crypto.randomUUID();
  slots.set(id, Date.now());
  try {
    return await fn();
  } finally {
    slots.delete(id);
    if (slots.size === 0) activeSlots.delete(userKey);
  }
}
