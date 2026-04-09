// Copyright 2026 Hall Boys, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Platform-agnostic key-value store interface.
 *
 * Cloudflare Workers: implemented by CloudflareKVStore (wraps KVNamespace).
 * Node.js self-hosted: implement with Redis, SQLite, or an in-memory Map.
 *
 * This interface covers the subset of KV operations used by the MCP server:
 * token storage, config overrides, metadata caching, and cache clearing.
 */
export interface IKeyValueStore {
  /** Retrieve a value by key. Returns null if not found. */
  get(key: string): Promise<string | null>;

  /** Store a value. Optional expirationTtl (in seconds) for auto-expiry. */
  put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>;

  /** Delete a key. */
  delete(key: string): Promise<void>;

  /**
   * List keys matching a prefix, with cursor-based pagination.
   * Used by the cache-clearing tool to enumerate cached entries.
   */
  list(options: { prefix: string; cursor?: string }): Promise<{
    keys: Array<{ name: string }>;
    list_complete: boolean;
    cursor?: string;
  }>;
}
