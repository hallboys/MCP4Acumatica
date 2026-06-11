// Copyright 2026 Hall Boys, Inc.
// SPDX-License-Identifier: Apache-2.0

import type { IBlobStore } from "../lib/blob-store";

/**
 * CloudflareR2BlobStore — IBlobStore backed by an R2 bucket binding.
 * Used for the schema-knowledge indexes (see src/lib/index-store.ts).
 */
export class CloudflareR2BlobStore implements IBlobStore {
  constructor(private bucket: R2Bucket) {}

  async get(key: string): Promise<string | null> {
    const obj = await this.bucket.get(key);
    return obj ? await obj.text() : null;
  }

  async has(key: string): Promise<boolean> {
    const head = await this.bucket.head(key);
    return head !== null;
  }
}
