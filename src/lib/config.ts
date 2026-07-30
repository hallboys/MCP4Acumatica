// Copyright 2026 Hall Boys, Inc.
// SPDX-License-Identifier: Apache-2.0

import type { IKeyValueStore } from "./kv-store";
import {
  DEFAULT_MAX_CONCURRENT,
  DEFAULT_MAX_PER_MINUTE,
  DEFAULT_QUEUE_WAIT_MS,
  type RateLimitConfig,
  type RateLimitEnv,
  // Explicit `.ts` so this module stays loadable by `node --test` (strip-only
  // mode can't resolve extensionless specifiers). See tsconfig.json.
} from "./rate-limiter.ts";

/**
 * KV-backed runtime config with env var fallback.
 * Keys are stored with a `config:` prefix in KV to avoid collisions.
 */

/** Read a config value — KV override takes precedence over env var. */
export async function getConfig(
  kv: IKeyValueStore,
  key: string,
  envFallback: string | undefined
): Promise<string | undefined> {
  try {
    const kvValue = await kv.get(`config:${key}`);
    if (kvValue !== null) return kvValue;
  } catch (err) {
    // Don't let a KV read failure break the tool, but don't silently hide
    // it either: an admin who just set a runtime override would otherwise
    // see the old env value with no signal as to why.
    console.error(JSON.stringify({
      level: "error",
      type: "config_read_error",
      timestamp: new Date().toISOString(),
      key,
      error: err instanceof Error ? err.message : String(err),
    }));
  }
  return envFallback;
}

/** Write a config override to KV. */
export async function setConfig(
  kv: IKeyValueStore,
  key: string,
  value: string
): Promise<void> {
  await kv.put(`config:${key}`, value);
}

/** Delete a config override from KV (reverts to env var default). */
export async function deleteConfig(
  kv: IKeyValueStore,
  key: string
): Promise<void> {
  await kv.delete(`config:${key}`);
}

export interface ConfigKeyDef {
  key: string;
  envVar: string;
  label: string;
  description: string;
  /**
   * The built-in default that applies when neither KV nor the env var is set.
   * Rendered as the input's placeholder so the admin console shows what is
   * actually in effect instead of an empty box. Display only — the value the
   * code falls back to lives at the point of use.
   */
  defaultValue?: string;
  /** Validate a proposed value. Return null to accept, or an error message. */
  validate?: (value: string) => string | null;
}

function validatePositiveInt(max: number) {
  return (value: string): string | null => {
    const trimmed = value.trim();
    if (!/^\d+$/.test(trimmed)) return "Must be a whole number (no sign, no decimals).";
    const n = parseInt(trimmed, 10);
    if (!Number.isFinite(n) || n <= 0) return "Must be a positive integer greater than 0.";
    if (n > max) return `Must be ${max} or less.`;
    return null;
  };
}

/** Like validatePositiveInt but accepts 0 (used for "disabled" semantics). */
function validateNonNegativeInt(max: number) {
  return (value: string): string | null => {
    const trimmed = value.trim();
    if (!/^\d+$/.test(trimmed)) return "Must be a whole number (no sign, no decimals).";
    const n = parseInt(trimmed, 10);
    if (!Number.isFinite(n) || n < 0) return "Must be 0 or a positive integer.";
    if (n > max) return `Must be ${max} or less.`;
    return null;
  };
}

/** All configurable settings with their KV keys and env var names. */
export const CONFIG_KEYS: readonly ConfigKeyDef[] = [
  { key: "redact_patterns", envVar: "REDACT_PATTERNS", label: "Redact Patterns", description: "Comma-separated additional field name patterns to redact" },
  { key: "redact_skip", envVar: "REDACT_SKIP", label: "Redact Skip", description: "Comma-separated field name patterns to whitelist from redaction" },
  {
    key: "acumatica_max_records",
    envVar: "ACUMATICA_MAX_RECORDS",
    label: "Max Records Per Query",
    description: "Maximum number of records returned per API query (default: 1000)",
    defaultValue: "1000",
    validate: validatePositiveInt(10_000),
  },
  {
    key: "rate_limit_max_concurrent",
    envVar: "ACUMATICA_MAX_CONCURRENT",
    label: "Max Concurrent Requests Per User",
    description:
      "Simultaneous in-flight Acumatica calls allowed per user (default: 3). Counted per Worker isolate, so a user with sessions on several isolates can exceed this in aggregate. Raising it increases parallel load on the Acumatica instance.",
    defaultValue: "3",
    validate: validatePositiveInt(20),
  },
  {
    key: "rate_limit_max_per_minute",
    envVar: "ACUMATICA_MAX_PER_MINUTE",
    label: "Max Requests Per Minute Per User",
    description:
      "Acumatica calls allowed per user per calendar minute (default: 40). Counted in KV, so it survives reconnects. Note this counts HTTP calls to Acumatica, not tool invocations — one tool call can make several.",
    defaultValue: "40",
    validate: validatePositiveInt(1_000),
  },
  {
    key: "rate_limit_queue_wait_ms",
    envVar: "ACUMATICA_RATE_LIMIT_QUEUE_WAIT_MS",
    label: "Concurrency Queue Wait (ms)",
    description:
      "How long a request waits for a busy concurrency slot before being rejected (default: 2000). A model firing several tool calls at once is normal, and most Acumatica round-trips finish well under a second, so a short wait turns most concurrency rejections into a brief delay. Set 0 to reject immediately.",
    defaultValue: "2000",
    validate: validateNonNegativeInt(10_000),
  },
  {
    key: "writes_enabled",
    envVar: "ACUMATICA_WRITES_ENABLED",
    label: "Enable Write Tools",
    description: "Set to 'true' to enable mutating tools (Customer create/update). Off by default. Changes take effect when the next DO instance starts.",
    defaultValue: "false",
    validate: (value: string) => {
      const v = value.trim().toLowerCase();
      if (v === "true" || v === "false") return null;
      return "Must be 'true' or 'false'.";
    },
  },
] as const;

/** Validate a config value against its key's rules. Returns null on success or an error message. */
export function validateConfigValue(key: string, value: string): string | null {
  const def = CONFIG_KEYS.find((cfg) => cfg.key === key);
  if (!def) return "Unknown config key";
  if (def.validate) return def.validate(value);
  return null;
}

/**
 * Validate that a user-supplied string argument is within length bounds.
 * MCP tool parameter schemas avoid Zod `.max()` chains (see CLAUDE.md
 * "Zod schema constraint"), so we enforce limits at the handler boundary
 * instead. Returns a short error string on violation, null on success.
 *
 * The caller is responsible for surfacing the error in the tool response
 * (typically `return { error: ... }`).
 */
export function validateStringArg(
  value: string | undefined,
  argName: string,
  max: number
): string | null {
  if (value === undefined) return null;
  if (typeof value !== "string") return `${argName} must be a string.`;
  if (value.length > max) return `${argName} is too long (${value.length} chars, max ${max}).`;
  return null;
}

/**
 * Parse a positive integer config string, falling back to `fallback` on any
 * invalid value (non-numeric, zero, negative, fractional, overflow). Callers
 * should use this instead of `parseInt(x) || fallback`, which silently
 * accepts negatives and treats "0" as "use default".
 */
export function parsePositiveIntConfig(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const trimmed = value.trim();
  if (!/^\d+$/.test(trimmed)) return fallback;
  const n = parseInt(trimmed, 10);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return n;
}

/**
 * Like `parsePositiveIntConfig` but treats "0" as a real value rather than
 * "use the default" — for settings where zero means "disabled" (e.g. the
 * concurrency queue wait). Anything non-numeric or negative still falls back.
 */
/**
 * Resolve the per-user rate limits for a session: KV override → env var →
 * built-in default, per setting. Called once when the MCP session starts (the
 * DO's `init()`); the result is stashed on `AppEnv.rateLimits` so the
 * per-request path needs no KV read. Consequence — same as every other runtime
 * setting — a change applies to the next DO instance, not to live sessions.
 *
 * Lives here rather than in rate-limiter.ts so that module stays free of
 * runtime imports and therefore unit-testable under `node --test`.
 */
export async function resolveRateLimits(
  store: IKeyValueStore,
  env: RateLimitEnv
): Promise<RateLimitConfig> {
  const [concurrent, perMinute, queueWait] = await Promise.all([
    getConfig(store, "rate_limit_max_concurrent", env.ACUMATICA_MAX_CONCURRENT),
    getConfig(store, "rate_limit_max_per_minute", env.ACUMATICA_MAX_PER_MINUTE),
    getConfig(store, "rate_limit_queue_wait_ms", env.ACUMATICA_RATE_LIMIT_QUEUE_WAIT_MS),
  ]);

  return {
    // A zero/garbage cap must not lock every user out, so both caps fall back
    // to the built-in default rather than being taken literally.
    maxConcurrent: parsePositiveIntConfig(concurrent, DEFAULT_MAX_CONCURRENT),
    maxPerMinute: parsePositiveIntConfig(perMinute, DEFAULT_MAX_PER_MINUTE),
    // Non-negative: 0 is a meaningful value here (reject immediately).
    queueWaitMs: parseNonNegativeIntConfig(queueWait, DEFAULT_QUEUE_WAIT_MS),
  };
}

export function parseNonNegativeIntConfig(value: string | undefined, fallback: number): number {
  if (value === undefined || value === null || value.trim() === "") return fallback;
  const trimmed = value.trim();
  if (!/^\d+$/.test(trimmed)) return fallback;
  const n = parseInt(trimmed, 10);
  if (!Number.isFinite(n) || n < 0) return fallback;
  return n;
}
