// Copyright 2026 Hall Boys, Inc.
// SPDX-License-Identifier: Apache-2.0

import type { IKeyValueStore } from "./kv-store";

/**
 * Lightweight KV-backed cache for Acumatica metadata (entity schemas, GI lists).
 * All keys are prefixed with "cache:" to avoid collisions in the shared TOKEN_STORE namespace.
 */

const KEY_PREFIX = "cache:";

/**
 * Retrieve a cached value from KV. Returns null on miss or parse error.
 */
export async function getCached<T>(kv: IKeyValueStore, key: string): Promise<T | null> {
  try {
    const raw = await kv.get(`${KEY_PREFIX}${key}`);
    if (raw === null) return null;
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

/**
 * Store a value in KV with an expiration TTL (in seconds).
 */
export async function setCached(kv: IKeyValueStore, key: string, data: unknown, ttlSeconds: number): Promise<void> {
  try {
    await kv.put(`${KEY_PREFIX}${key}`, JSON.stringify(data), { expirationTtl: ttlSeconds });
  } catch {
    // Cache write failure is non-fatal — the next call will just miss again
  }
}
