// Copyright 2026 Hall Boys, Inc.
// SPDX-License-Identifier: Apache-2.0

// NOTE: keep this module free of *runtime* imports (type-only is fine). It is
// unit-tested via `node --test`, which loads TypeScript in strip-only mode and
// cannot resolve the extensionless specifiers used elsewhere in src/. Config
// resolution therefore lives in config.ts (`resolveRateLimits`), not here.
import type { IKeyValueStore } from "./kv-store";

/**
 * Resolved per-user rate-limit settings. Runtime-configurable from the admin
 * console (`config:rate_limit_*` in KV) — see CONFIG_KEYS in config.ts. The
 * DO resolves these once in `init()` and hands them to AcumaticaClient via
 * `AppEnv.rateLimits`, so there's no extra KV read on the hot path.
 */
export interface RateLimitConfig {
  /** Max simultaneous in-flight Acumatica calls per user (per isolate). */
  maxConcurrent: number;
  /** Max Acumatica calls per user per calendar minute (KV-backed). */
  maxPerMinute: number;
  /**
   * How long to wait for a busy concurrency slot to free up before rejecting.
   * A model that fires several tool calls at once is the normal case, not
   * abuse, and a typical Acumatica round-trip is well under a second — so a
   * short wait converts most concurrency rejections into a small delay.
   * 0 disables waiting (reject immediately, the pre-0.41.0 behavior).
   */
  queueWaitMs: number;
}

export const DEFAULT_MAX_CONCURRENT = 3;
export const DEFAULT_MAX_PER_MINUTE = 40;
export const DEFAULT_QUEUE_WAIT_MS = 2_000;

/** Used when no resolved config is supplied (self-host adapters, tests). */
export const DEFAULT_RATE_LIMITS: RateLimitConfig = {
  maxConcurrent: DEFAULT_MAX_CONCURRENT,
  maxPerMinute: DEFAULT_MAX_PER_MINUTE,
  queueWaitMs: DEFAULT_QUEUE_WAIT_MS,
};

/** Raw env-var fallbacks for the rate-limit settings (a subset of AppEnv). */
export interface RateLimitEnv {
  ACUMATICA_MAX_CONCURRENT?: string;
  ACUMATICA_MAX_PER_MINUTE?: string;
  ACUMATICA_RATE_LIMIT_QUEUE_WAIT_MS?: string;
}

// Longest a single Acumatica call should plausibly take. Any active-slot
// record older than this is treated as leaked (see `pruneStale`). Chosen
// larger than any real Acumatica round-trip so we never evict a live call.
const STALE_SLOT_MS = 60_000;

// How often a queued caller re-checks for a free concurrency slot.
const SLOT_POLL_MS = 50;

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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Seconds until the current per-minute bucket key rolls over. */
function secondsUntilNextMinute(): number {
  return Math.max(1, Math.ceil((60_000 - (Date.now() % 60_000)) / 1000));
}

export type RateLimitKind = "concurrent" | "per_minute";

/**
 * Thrown when a user exceeds a rate limit. Carries structured fields so the
 * caller can render an actionable envelope for the model (and log the hit)
 * rather than surfacing an opaque error string — see `rateLimitEnvelope`.
 */
export class RateLimitError extends Error {
  // Declared as explicit fields rather than constructor parameter properties:
  // the `node --test` harness runs TypeScript in strip-only mode, which
  // rejects parameter properties, and this class is unit-tested.
  readonly limit: RateLimitKind;
  readonly limitValue: number;
  readonly retryAfterSeconds: number;
  /** ms spent queued for a slot before giving up (concurrency limit only). */
  readonly waitedMs?: number;

  constructor(
    message: string,
    limit: RateLimitKind,
    limitValue: number,
    retryAfterSeconds: number,
    waitedMs?: number
  ) {
    super(message);
    this.name = "RateLimitError";
    this.limit = limit;
    this.limitValue = limitValue;
    this.retryAfterSeconds = retryAfterSeconds;
    this.waitedMs = waitedMs;
  }
}

/**
 * Render a rate-limit rejection as a structured payload for the model.
 *
 * The model's default reaction to a bare "limit reached, retry shortly" is to
 * retry immediately, reword the request, or try a different tool — all wrong,
 * and the last two waste the remaining budget. So the envelope states three
 * things explicitly: this is a server-side guardrail (not an Acumatica
 * outage), exactly how long to wait, and that the request itself is fine.
 * Same shape/intent as the pagination-refusal envelope in entity-list.ts.
 */
export function rateLimitEnvelope(error: RateLimitError): Record<string, unknown> {
  const scope =
    error.limit === "per_minute"
      ? `${error.limitValue} Acumatica requests per minute`
      : `${error.limitValue} simultaneous Acumatica requests`;

  return {
    error: "rate_limited",
    limit: error.limit,
    limitValue: error.limitValue,
    retryAfterSeconds: error.retryAfterSeconds,
    cause:
      `This MCP server caps each user at ${scope} to protect the Acumatica ` +
      `instance. This is a guardrail in the MCP server — Acumatica was not ` +
      `contacted, nothing was queried, and there is no problem with the ERP, ` +
      `the network, or your request.`,
    actionRequired:
      `Wait ${error.retryAfterSeconds} second(s), then retry the SAME request ` +
      `unchanged. Do not retry immediately. Do not reword the request, narrow ` +
      `the filter, or substitute a different tool — the cap is on request ` +
      `volume per user, not on this request. If this interrupted a multi-step ` +
      `task, tell the user you hit the ${error.limit === "per_minute" ? "per-minute" : "concurrency"} ` +
      `cap and ask whether to continue after the pause rather than silently retrying in a loop.`,
  };
}

/**
 * Claim a concurrency slot, optionally waiting up to `queueWaitMs` for one to
 * free up. Returns null if none became available in time.
 *
 * The check-then-set is deliberately synchronous (no `await` between reading
 * `slots.size` and inserting): JS runs each wakeup to completion, so waiters
 * can't both observe the same free slot and over-admit.
 */
async function acquireSlot(
  slots: Map<string, number>,
  maxConcurrent: number,
  queueWaitMs: number
): Promise<{ id: string; waitedMs: number } | null> {
  const started = Date.now();
  const deadline = started + Math.max(0, queueWaitMs);

  for (;;) {
    pruneStale(slots);
    if (slots.size < maxConcurrent) {
      const id = crypto.randomUUID();
      slots.set(id, Date.now());
      return { id, waitedMs: Date.now() - started };
    }

    const remaining = deadline - Date.now();
    if (remaining <= 0) return null;
    await sleep(Math.min(SLOT_POLL_MS, remaining));
  }
}

/**
 * Enforce concurrency + per-minute rate limits scoped to a user key.
 *
 * - Concurrency: in-isolate per-user slot map with self-healing stale-slot
 *   pruning and a bounded wait for a free slot. Bounded per user, not
 *   per-process.
 * - Per-minute: KV-backed sliding bucket keyed by `ratelimit:{userKey}:{minute}`
 *   with a short TTL. Approximate (KV is eventually consistent and the
 *   get/put isn't atomic) but that's fine for rate limiting — it catches
 *   runaway clients without needing strong consistency, and crucially it
 *   survives DO/isolate recycling so clients can't bypass by reconnecting.
 *
 * Ordering is slot-first, then the minute bucket: a request rejected on
 * concurrency never consumes a per-minute token, so a burst that gets turned
 * away doesn't also eat the user's minute budget. The token IS consumed for a
 * call that reaches Acumatica and then fails (a 500, a network error) — that's
 * intentional, since limiting retry storms is exactly what the cap is for.
 */
export async function withRateLimit<T>(
  store: IKeyValueStore,
  userKey: string,
  fn: () => Promise<T>,
  limits: RateLimitConfig = DEFAULT_RATE_LIMITS
): Promise<T> {
  let slots = activeSlots.get(userKey);
  if (!slots) {
    slots = new Map();
    activeSlots.set(userKey, slots);
  }

  const slot = await acquireSlot(slots, limits.maxConcurrent, limits.queueWaitMs);
  if (!slot) {
    throw new RateLimitError(
      `Concurrent request limit reached (${limits.maxConcurrent}).`,
      "concurrent",
      limits.maxConcurrent,
      2,
      Math.max(0, limits.queueWaitMs)
    );
  }

  try {
    const minute = Math.floor(Date.now() / 60_000);
    const counterKey = `ratelimit:${userKey}:${minute}`;
    const currentStr = await store.get(counterKey).catch(() => null);
    const current = currentStr ? parseInt(currentStr, 10) : 0;
    if (current >= limits.maxPerMinute) {
      throw new RateLimitError(
        `Per-minute request limit reached (${limits.maxPerMinute}).`,
        "per_minute",
        limits.maxPerMinute,
        secondsUntilNextMinute()
      );
    }
    // TTL of 120s lets the bucket cover the full minute plus spillover; KV
    // TTL minimum is 60s on Cloudflare.
    await store
      .put(counterKey, String(current + 1), { expirationTtl: 120 })
      .catch(() => {});

    return await fn();
  } finally {
    slots.delete(slot.id);
    if (slots.size === 0) activeSlots.delete(userKey);
  }
}
