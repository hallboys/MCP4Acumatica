// Copyright 2026 Hall Boys, Inc.
// SPDX-License-Identifier: Apache-2.0

// Covers the configurable rate limits and the limit-reached behavior:
// config resolution precedence (KV → env → built-in), the bounded wait for a
// concurrency slot, per-minute bucket enforcement, the "a rejected request
// doesn't spend a minute token" ordering guarantee, and the structured
// envelope handed to the model.
//
// Run with:  node --test --experimental-strip-types test/rate-limiter.test.ts

import { test } from "node:test";
import assert from "node:assert";
import {
  withRateLimit,
  rateLimitEnvelope,
  RateLimitError,
  DEFAULT_MAX_CONCURRENT,
  DEFAULT_MAX_PER_MINUTE,
  DEFAULT_QUEUE_WAIT_MS,
  type RateLimitConfig,
} from "../src/lib/rate-limiter.ts";
import { resolveRateLimits } from "../src/lib/config.ts";
import type { IKeyValueStore } from "../src/lib/kv-store.ts";

/** Minimal in-memory IKeyValueStore with call counters. */
function makeStore(seed: Record<string, string> = {}) {
  const data = new Map<string, string>(Object.entries(seed));
  const puts: Array<[string, string]> = [];
  const store: IKeyValueStore = {
    async get(key) {
      return data.get(key) ?? null;
    },
    async put(key, value) {
      puts.push([key, value]);
      data.set(key, value);
    },
    async delete(key) {
      data.delete(key);
    },
    async list(opts) {
      const prefix = opts?.prefix ?? "";
      return { keys: [...data.keys()].filter((k) => k.startsWith(prefix)).map((name) => ({ name })) };
    },
  };
  return { store, data, puts };
}

const limits = (over: Partial<RateLimitConfig> = {}): RateLimitConfig => ({
  maxConcurrent: 3,
  maxPerMinute: 40,
  queueWaitMs: 0,
  ...over,
});

/** Unique per test so the module-level per-user slot map never leaks across tests. */
let seq = 0;
const user = () => `user-${++seq}`;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ── resolveRateLimits: precedence ────────────────────────────────

test("resolveRateLimits: built-in defaults when nothing is set", async () => {
  const { store } = makeStore();
  const cfg = await resolveRateLimits(store, {});
  assert.deepEqual(cfg, {
    maxConcurrent: DEFAULT_MAX_CONCURRENT,
    maxPerMinute: DEFAULT_MAX_PER_MINUTE,
    queueWaitMs: DEFAULT_QUEUE_WAIT_MS,
  });
});

test("resolveRateLimits: env vars override built-ins", async () => {
  const { store } = makeStore();
  const cfg = await resolveRateLimits(store, {
    ACUMATICA_MAX_CONCURRENT: "7",
    ACUMATICA_MAX_PER_MINUTE: "120",
    ACUMATICA_RATE_LIMIT_QUEUE_WAIT_MS: "500",
  });
  assert.deepEqual(cfg, { maxConcurrent: 7, maxPerMinute: 120, queueWaitMs: 500 });
});

test("resolveRateLimits: KV overrides env", async () => {
  const { store } = makeStore({
    "config:rate_limit_max_concurrent": "9",
    "config:rate_limit_max_per_minute": "200",
    "config:rate_limit_queue_wait_ms": "1500",
  });
  const cfg = await resolveRateLimits(store, {
    ACUMATICA_MAX_CONCURRENT: "7",
    ACUMATICA_MAX_PER_MINUTE: "120",
    ACUMATICA_RATE_LIMIT_QUEUE_WAIT_MS: "500",
  });
  assert.deepEqual(cfg, { maxConcurrent: 9, maxPerMinute: 200, queueWaitMs: 1500 });
});

test("resolveRateLimits: queue wait honors an explicit 0 (reject immediately)", async () => {
  const { store } = makeStore({ "config:rate_limit_queue_wait_ms": "0" });
  const cfg = await resolveRateLimits(store, {});
  assert.equal(cfg.queueWaitMs, 0);
});

test("resolveRateLimits: a zero/garbage cap falls back rather than locking everyone out", async () => {
  const { store } = makeStore({
    "config:rate_limit_max_concurrent": "0",
    "config:rate_limit_max_per_minute": "not-a-number",
  });
  const cfg = await resolveRateLimits(store, {});
  assert.equal(cfg.maxConcurrent, DEFAULT_MAX_CONCURRENT);
  assert.equal(cfg.maxPerMinute, DEFAULT_MAX_PER_MINUTE);
});

// ── Concurrency ──────────────────────────────────────────────────

test("concurrency: allows up to maxConcurrent in flight", async () => {
  const { store } = makeStore();
  const u = user();
  let peak = 0;
  let active = 0;

  await Promise.all(
    Array.from({ length: 3 }, () =>
      withRateLimit(
        store,
        u,
        async () => {
          peak = Math.max(peak, ++active);
          await sleep(20);
          active--;
        },
        limits({ maxConcurrent: 3 })
      )
    )
  );

  assert.equal(peak, 3);
});

test("concurrency: rejects the overflow request when queueWaitMs is 0", async () => {
  const { store } = makeStore();
  const u = user();
  const cfg = limits({ maxConcurrent: 2, queueWaitMs: 0 });

  const results = await Promise.allSettled(
    Array.from({ length: 3 }, () => withRateLimit(store, u, () => sleep(30), cfg))
  );

  const rejected = results.filter((r) => r.status === "rejected");
  assert.equal(rejected.length, 1);
  const err = (rejected[0] as PromiseRejectedResult).reason;
  assert.ok(err instanceof RateLimitError);
  assert.equal(err.limit, "concurrent");
  assert.equal(err.limitValue, 2);
});

test("concurrency: a bounded wait admits an overflow request once a slot frees", async () => {
  const { store } = makeStore();
  const u = user();
  // Two slots, three callers, each call ~30ms — the third should get in on the
  // wait rather than being rejected outright. This is the case that used to
  // fail for a model firing several tool calls at once.
  const cfg = limits({ maxConcurrent: 2, queueWaitMs: 2_000 });

  const results = await Promise.allSettled(
    Array.from({ length: 3 }, () => withRateLimit(store, u, () => sleep(30), cfg))
  );

  assert.equal(results.filter((r) => r.status === "fulfilled").length, 3);
});

test("concurrency: the wait is bounded — still rejects if no slot frees in time", async () => {
  const { store } = makeStore();
  const u = user();
  const cfg = limits({ maxConcurrent: 1, queueWaitMs: 60 });

  const held = withRateLimit(store, u, () => sleep(400), cfg);
  await sleep(10);

  await assert.rejects(
    () => withRateLimit(store, u, async () => "second", cfg),
    (err: unknown) => {
      assert.ok(err instanceof RateLimitError);
      assert.equal(err.limit, "concurrent");
      assert.equal(err.waitedMs, 60);
      return true;
    }
  );

  await held;
});

test("concurrency: slots are released when the wrapped call throws", async () => {
  const { store } = makeStore();
  const u = user();
  const cfg = limits({ maxConcurrent: 1 });

  await assert.rejects(() =>
    withRateLimit(store, u, async () => {
      throw new Error("acumatica 500");
    }, cfg)
  );

  // The slot must be free again, otherwise one failure permanently costs capacity.
  assert.equal(await withRateLimit(store, u, async () => "ok", cfg), "ok");
});

test("concurrency: limits are scoped per user", async () => {
  const { store } = makeStore();
  const a = user();
  const b = user();
  const cfg = limits({ maxConcurrent: 1, queueWaitMs: 0 });

  const held = withRateLimit(store, a, () => sleep(60), cfg);
  await sleep(10);
  // A different user must not be blocked by user A saturating their own slots.
  assert.equal(await withRateLimit(store, b, async () => "ok", cfg), "ok");
  await held;
});

// ── Per-minute bucket ────────────────────────────────────────────

test("per-minute: increments the bucket key for the current minute", async () => {
  const { store, puts } = makeStore();
  const u = user();
  await withRateLimit(store, u, async () => "ok", limits());

  assert.equal(puts.length, 1);
  const minute = Math.floor(Date.now() / 60_000);
  assert.equal(puts[0][0], `ratelimit:${u}:${minute}`);
  assert.equal(puts[0][1], "1");
});

test("per-minute: rejects once the bucket is full, with a retry-after inside the minute", async () => {
  const u = user();
  const minute = Math.floor(Date.now() / 60_000);
  const { store } = makeStore({ [`ratelimit:${u}:${minute}`]: "40" });

  await assert.rejects(
    () => withRateLimit(store, u, async () => "ok", limits({ maxPerMinute: 40 })),
    (err: unknown) => {
      assert.ok(err instanceof RateLimitError);
      assert.equal(err.limit, "per_minute");
      assert.equal(err.limitValue, 40);
      // Bucket keys roll over on the minute boundary, so the wait is never >60s.
      assert.ok(err.retryAfterSeconds >= 1 && err.retryAfterSeconds <= 60);
      return true;
    }
  );
});

test("per-minute: a KV read failure fails open rather than blocking the user", async () => {
  const { store } = makeStore();
  store.get = async () => {
    throw new Error("KV down");
  };
  assert.equal(await withRateLimit(store, user(), async () => "ok", limits()), "ok");
});

test("a concurrency rejection does not spend a per-minute token", async () => {
  const { store, puts } = makeStore();
  const u = user();
  const cfg = limits({ maxConcurrent: 1, queueWaitMs: 0 });

  const held = withRateLimit(store, u, () => sleep(60), cfg);
  await sleep(10);
  await assert.rejects(() => withRateLimit(store, u, async () => "second", cfg));
  await held;

  // Only the call that actually ran should have been counted.
  assert.equal(puts.length, 1);
});

// ── Envelope handed to the model ─────────────────────────────────

test("envelope: per-minute rejection tells the model to wait and not to reword", () => {
  const env = rateLimitEnvelope(
    new RateLimitError("Per-minute request limit reached (40).", "per_minute", 40, 17)
  );

  assert.equal(env.error, "rate_limited");
  assert.equal(env.limit, "per_minute");
  assert.equal(env.limitValue, 40);
  assert.equal(env.retryAfterSeconds, 17);
  // The three things the model gets wrong without explicit instruction.
  assert.match(String(env.actionRequired), /17 second/);
  assert.match(String(env.actionRequired), /[Dd]o not retry immediately/);
  assert.match(String(env.actionRequired), /different tool/);
  // Must not be mistaken for an ERP/network outage.
  assert.match(String(env.cause), /guardrail in the MCP server/);
  assert.match(String(env.cause), /Acumatica was not contacted/);
});

test("envelope: concurrency rejection is labelled as such", () => {
  const env = rateLimitEnvelope(
    new RateLimitError("Concurrent request limit reached (3).", "concurrent", 3, 2, 2_000)
  );
  assert.equal(env.limit, "concurrent");
  assert.equal(env.limitValue, 3);
  assert.match(String(env.cause), /simultaneous Acumatica requests/);
  assert.match(String(env.actionRequired), /concurrency\s+cap/);
});
