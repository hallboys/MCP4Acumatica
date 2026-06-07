// Copyright 2026 Hall Boys, Inc.
// SPDX-License-Identifier: Apache-2.0

import type { ITokenProvider, TokenResult } from "../lib/token-provider";
import type { TokenManager } from "../token-manager";

/**
 * Cloudflare ITokenProvider — forwards token resolution to the per-user
 * TokenManager Durable Object. Keying the DO by username means all of a user's
 * concurrent sessions share one token owner, so refreshes serialize globally.
 */
export class DOTokenProvider implements ITokenProvider {
  constructor(private readonly namespace: DurableObjectNamespace<TokenManager>) {}

  getAccessToken(username: string): Promise<TokenResult> {
    const id = this.namespace.idFromName(username);
    const stub = this.namespace.get(id);
    return stub.getAccessToken(username);
  }
}
