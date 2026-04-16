// Copyright 2026 Hall Boys, Inc.
// SPDX-License-Identifier: Apache-2.0

import type { IKeyValueStore } from "./kv-store";

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
  } catch {
    // KV read failure — fall through to env var
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

/** All configurable settings with their KV keys and env var names. */
export const CONFIG_KEYS = [
  { key: "redact_patterns", envVar: "REDACT_PATTERNS", label: "Redact Patterns", description: "Comma-separated additional field name patterns to redact" },
  { key: "redact_skip", envVar: "REDACT_SKIP", label: "Redact Skip", description: "Comma-separated field name patterns to whitelist from redaction" },
  { key: "acumatica_max_records", envVar: "ACUMATICA_MAX_RECORDS", label: "Max Records Per Query", description: "Maximum number of records returned per API query (default: 1000)" },
] as const;
