// Copyright 2026 Hall Boys, Inc.
// SPDX-License-Identifier: Apache-2.0

import type { AppEnv } from "../types/acumatica";

/**
 * Loader for the schema-knowledge indexes (schema / DAC / GI) backed by
 * `AppEnv.indexStore` (CF: R2). Indexes are immutable for the lifetime of a
 * deploy, so a parsed copy is memoized per isolate — the first tool call in an
 * isolate pays the R2 fetch + JSON.parse, subsequent calls are free.
 *
 * Returns `null` when no blob store is bound or the named index is absent,
 * which the tool layer turns into a "build the index" hint and which drives
 * conditional registration of the DAC / GI tools.
 */

// Per-isolate parse cache. Keyed by index name. `null` is a real cached value
// meaning "checked, not present" so we don't re-hit R2 on every miss.
const cache = new Map<string, unknown>();

export async function loadIndex<T>(env: AppEnv, name: string): Promise<T | null> {
  if (cache.has(name)) return cache.get(name) as T | null;
  let parsed: T | null = null;
  if (env.indexStore) {
    try {
      const raw = await env.indexStore.get(name);
      if (raw !== null) parsed = JSON.parse(raw) as T;
    } catch {
      parsed = null; // unreadable / malformed index → treat as absent
    }
  }
  cache.set(name, parsed);
  return parsed;
}

/** Cheap existence probe used at init() for conditional tool registration. */
export async function indexExists(env: AppEnv, name: string): Promise<boolean> {
  if (cache.get(name) != null) return true;
  if (!env.indexStore) return false;
  try {
    return await env.indexStore.has(name);
  } catch {
    return false;
  }
}

export const INDEX_KEYS = {
  schema: "schema-index.json",
  dac: "dac-index.json",
  giExamples: "gi-examples-index.json",
} as const;

// The GI registry is deliberately absent from INDEX_KEYS: unlike these
// immutable, offline-built R2 indexes it's a KV-cached artifact
// (cache:gi_registry) rebuilt lazily on demand from the feed GIs with the
// requesting user's token. Its cache-key constant lives in gi-registry-build.ts
// (REGISTRY_CACHE_KEY); the pure gate logic in gi-registry.ts stays a
// runtime-leaf module (type-only imports) so it's unit-testable under node --test.
