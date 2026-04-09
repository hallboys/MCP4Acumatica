// Copyright 2026 Hall Boys, Inc.
// SPDX-License-Identifier: Apache-2.0

import type { IKeyValueStore } from "../lib/kv-store";

/**
 * Cloudflare Workers adapter — wraps a KVNamespace binding as an IKeyValueStore.
 * This is a thin passthrough; every method maps 1:1 to the KVNamespace API.
 */
export class CloudflareKVStore implements IKeyValueStore {
  constructor(private kv: KVNamespace) {}

  get(key: string): Promise<string | null> {
    return this.kv.get(key, "text");
  }

  put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void> {
    return this.kv.put(key, value, options);
  }

  delete(key: string): Promise<void> {
    return this.kv.delete(key);
  }

  async list(options: { prefix: string; cursor?: string }): Promise<{
    keys: Array<{ name: string }>;
    list_complete: boolean;
    cursor?: string;
  }> {
    const result = await this.kv.list({ prefix: options.prefix, cursor: options.cursor });
    return {
      keys: result.keys.map((k) => ({ name: k.name })),
      list_complete: result.list_complete,
      cursor: result.list_complete ? undefined : result.cursor,
    };
  }
}
