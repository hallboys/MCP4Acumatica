// Copyright 2026 Hall Boys, Inc.
// SPDX-License-Identifier: Apache-2.0

import type { AppEnv } from "../types/acumatica";

/** Write-side TTL for the per-user token record (30 days). Shared so the
 *  callback seed, KV write-through, and DO storage all agree. */
export const USER_TOKEN_TTL_SECONDS = 30 * 24 * 60 * 60;

/**
 * Thrown when the user's Acumatica authorization is permanently gone and the
 * only recovery is a fresh login: no stored token, no refresh token, or a 4xx
 * from IdentityServer (rotated/expired/revoked refresh token). The DO catches
 * this in `callTool` and revokes the user's MCP grant so the next `/mcp`
 * request 401s and the client silently re-runs OAuth.
 *
 * A transient refresh failure (network error, IdentityServer 5xx/429) is NOT
 * this error — those throw a plain Error so we don't evict the user over a blip.
 */
export class ReauthRequiredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReauthRequiredError";
  }
}

/** Minimal connection config the refresh call needs. */
export interface AcumaticaTokenConfig {
  url: string;
  clientId: string;
  clientSecret: string;
}

/** Outcome of a single refresh_token grant POST to IdentityServer. */
export type RefreshOutcome =
  | { status: "ok"; access_token: string; refresh_token: string; expires_in: number }
  | { status: "reauth" }
  | { status: "transient"; detail: string };

/**
 * Exchange a refresh token for a fresh access+refresh token pair.
 *
 * This is the ONLY place the refresh HTTP call and its transient-vs-permanent
 * classification live. It does no storage — the caller (the per-user
 * TokenManager DO, or a self-hosted lock holder) owns persistence and
 * serialization. Returns a discriminated outcome instead of throwing so the
 * result survives a DO RPC boundary.
 *
 * Classification keys off HTTP status, NOT the OAuth error string: Acumatica
 * returns a 400 whose body doesn't reliably parse to `invalid_grant`, so
 * matching that string let dead tokens fall through to the transient branch
 * and the model looped forever on "try again shortly". 5xx/429 are the only
 * genuinely retryable failures; every 4xx means the refresh token is dead.
 */
export async function refreshAcumaticaToken(
  config: AcumaticaTokenConfig,
  refreshToken: string,
  acumaticaUsername: string
): Promise<RefreshOutcome> {
  const tokenUrl = `${config.url}/identity/connect/token`;

  let response: Response;
  try {
    response = await fetch(tokenUrl, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        client_id: config.clientId,
        client_secret: config.clientSecret,
        refresh_token: refreshToken,
      }),
    });
  } catch (e) {
    // Network-level failure — transient by definition.
    return { status: "transient", detail: e instanceof Error ? e.message : "network error" };
  }

  if (!response.ok) {
    // Read ONLY the `error` field for diagnostics — IdentityServer error
    // bodies can echo the submitted form, which includes client_secret. It is
    // NOT used for the transient-vs-permanent decision (see doc comment).
    let oauthError: string | undefined;
    try {
      const body = (await response.json()) as { error?: unknown };
      if (typeof body.error === "string") oauthError = body.error;
    } catch {
      // non-JSON / empty body — leave undefined
    }

    console.log(
      JSON.stringify({
        level: "warn",
        type: "token_refresh_failed",
        timestamp: new Date().toISOString(),
        acumaticaUsername,
        status: response.status,
        oauthError: oauthError ?? null,
      })
    );

    if (response.status >= 500 || response.status === 429) {
      return { status: "transient", detail: `IdentityServer ${response.status}` };
    }
    return { status: "reauth" };
  }

  const tokens = (await response.json()) as {
    access_token: string;
    refresh_token: string;
    expires_in: number;
  };
  return { status: "ok", ...tokens };
}

/**
 * Get an Acumatica access token for a specific user. Delegates to the
 * platform's token provider (CF: per-user TokenManager DO), which serializes
 * refresh across all of the user's concurrent sessions so they can't race on
 * IdentityServer's rotate-on-use refresh tokens.
 *
 * The provider returns a discriminated result; we map it back to a token or
 * the appropriate error so existing callers (AcumaticaClient → callTool) are
 * unchanged: `reauth` → `ReauthRequiredError` (grant gets revoked), transient
 * → plain Error (user is not evicted).
 */
export async function getAcumaticaTokenForUser(
  env: AppEnv,
  acumaticaUsername: string
): Promise<string> {
  const result = await env.tokenProvider.getAccessToken(acumaticaUsername);
  switch (result.status) {
    case "ok":
      return result.accessToken;
    case "reauth":
      throw new ReauthRequiredError(result.message);
    case "transient":
      throw new Error(result.message);
  }
}
