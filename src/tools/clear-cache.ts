// Copyright 2026 Hall Boys, Inc.
// SPDX-License-Identifier: Apache-2.0

import type { AppEnv } from "../types/acumatica";

const CACHE_PREFIX = "cache:";

// Recognized top-level targets for bulk clearing. Anything else must be a
// specific key of the form `<namespace>:<name>` (e.g. `schema:Customer`,
// `gi_schema:MyInquiry`) — we reject bare typos like `gi_schemas` so users
// don't get a silent no-op that looks like success.
const BULK_TARGETS = new Set(["schemas", "gi"]);

export async function handleClearCache(
  env: AppEnv,
  target?: string
): Promise<unknown> {
  const kv = env.store;

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

      if (!target) {
        // No target — clear everything
        keysToDelete.push(key.name);
      } else if (target === "schemas" && shortKey.startsWith("schema:")) {
        keysToDelete.push(key.name);
      } else if (
        target === "gi" &&
        (shortKey === "gi_list" || shortKey === "gi_metadata" || shortKey === "gi_registry")
      ) {
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
