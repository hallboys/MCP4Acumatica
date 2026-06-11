// Copyright 2026 Hall Boys, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Platform-agnostic read interface for large, immutable blobs (the schema /
 * DAC / GI knowledge indexes). Mirrors the IKeyValueStore / ITokenProvider
 * abstractions so a self-hosted adapter (filesystem, S3, etc.) can back the
 * schema-knowledge tools without touching the tool handlers.
 *
 * Read-only on purpose: indexes are produced offline by the ingestion scripts
 * in `scripts/` and uploaded out-of-band (CF: `wrangler r2 object put`). The
 * worker only ever reads them.
 */
export interface IBlobStore {
  /** Return the blob body as text, or null if the key does not exist. */
  get(key: string): Promise<string | null>;
  /** Cheap existence check (no body transfer) — drives conditional tool registration. */
  has(key: string): Promise<boolean>;
}
