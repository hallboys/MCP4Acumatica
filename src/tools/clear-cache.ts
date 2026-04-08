// Copyright 2026 Hall Boys, Inc.
// SPDX-License-Identifier: Apache-2.0

import type { Env } from "../types/acumatica";

const CACHE_PREFIX = "cache:";

export async function handleClearCache(
  env: Env,
  target?: string
): Promise<unknown> {
  const kv = env.TOKEN_STORE;

  // Single specific key: "schema:Customer", "gi_schema:SomeName"
  if (target && target !== "schemas" && target !== "gi") {
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

      if (!target) {
        // No target — clear everything
        keysToDelete.push(key.name);
      } else if (target === "schemas" && shortKey.startsWith("schema:")) {
        keysToDelete.push(key.name);
      } else if (target === "gi" && (shortKey === "gi_list" || shortKey === "gi_metadata")) {
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
