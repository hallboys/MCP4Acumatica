// Copyright 2026 Hall Boys, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Result of resolving an Acumatica access token for a user.
 *
 * Returned as a discriminated value rather than thrown so it survives a
 * Durable Object RPC boundary intact (a custom Error class would be flattened
 * to a generic Error when serialized across the RPC, losing the
 * transient-vs-permanent distinction). `getAcumaticaTokenForUser()` maps this
 * back into a return value / `ReauthRequiredError` / plain `Error`.
 */
export type TokenResult =
  | { status: "ok"; accessToken: string }
  /** Refresh token is permanently dead (no token, no refresh token, or a 4xx
   *  from IdentityServer). The caller revokes the MCP grant and re-auths. */
  | { status: "reauth"; message: string }
  /** Transient failure (5xx/429/network) — the same refresh token may work on
   *  retry, so the caller surfaces an error WITHOUT evicting the user. */
  | { status: "transient"; message: string };

/**
 * Serializes Acumatica token retrieval/refresh per user so concurrent MCP
 * sessions never race on IdentityServer's rotate-on-use refresh tokens.
 *
 * Cloudflare implementation routes through a per-user Durable Object
 * (`TokenManager`), which is the single, globally-consistent owner of a user's
 * token. A self-hosted adapter would implement this with a distributed lock
 * (e.g. Redis SETNX) around the same resolve logic.
 */
export interface ITokenProvider {
  /** Return a valid access token for the user, refreshing if necessary. */
  getAccessToken(username: string): Promise<TokenResult>;
}
