// Copyright 2026 Hall Boys, Inc.
// SPDX-License-Identifier: Apache-2.0

import type { AppEnv } from "../types/acumatica";
import { resetGiRegistryMemo } from "../lib/gi-registry-build";
import { BULK_TARGETS, matchesClearTarget } from "./clear-cache-match";

const CACHE_PREFIX = "cache:";

export async function handleClearCache(
  env: AppEnv,
  target?: string
): Promise<unknown> {
  const kv = env.store;

  // The GI registry is memoized per isolate, and getGiRegistry() short-circuits
  // on that memo *before* it reads KV. Deleting the KV key alone therefore does
  // nothing for the life of the isolate: the tool reports "cleared" and keeps
  // serving the stale registry, which reads as "my Acumatica edit didn't take".
  // Reset the memo whenever this clear could plausibly cover the registry.
  if (!target || target === "gi" || target === "gi_registry") resetGiRegistryMemo();

  if (target && !BULK_TARGETS.has(target)) {
    if (!target.includes(":")) {
      return {
        cleared: [],
        error:
          `Unknown target '${target}'. Use 'schemas' or 'gi' for bulk clears, ` +
          `or a specific key like 'schema:EntityName' or 'gi_schema:InquiryName'. Omit the argument to clear everything.`,
      };
    }
    // Single specific key: "schema:Customer", "gi_schema:SomeName"
    const key = `${CACHE_PREFIX}${target}`;
    await kv.delete(key);
    return { cleared: [target] };
  }

  // List all cache keys to find what to delete
  const keysToDelete: string[] = [];
  let cursor: string | undefined;

  do {
    const list = await kv.list({ prefix: CACHE_PREFIX, cursor });
    for (const key of list.keys) {
      const shortKey = key.name.slice(CACHE_PREFIX.length);
      if (matchesClearTarget(shortKey, target)) {
        keysToDelete.push(key.name);
      }
    }
    cursor = list.list_complete ? undefined : list.cursor;
  } while (cursor);

  await Promise.all(keysToDelete.map((key) => kv.delete(key)));

  const cleared = keysToDelete.map((k) => k.slice(CACHE_PREFIX.length));

  if (cleared.length === 0) {
    return { cleared: [], note: "No cached entries found matching the target." };
  }

  return { cleared };
}
