// Copyright 2026 Hall Boys, Inc.
// SPDX-License-Identifier: Apache-2.0

import type { AppEnv, StoredToken } from "../types/acumatica";
import { decryptString, encryptString } from "../lib/crypto";

const USER_TOKEN_TTL_SECONDS = 30 * 24 * 60 * 60; // 30 days — matches write-side TTL

/**
 * Thrown when the user's Acumatica authorization is permanently gone and the
 * only recovery is a fresh login: no stored token, no refresh token, or a
 * refresh that came back `invalid_grant` (rotated/expired/revoked refresh
 * token). The DO catches this in `callTool` and revokes the user's MCP grant
 * so the next `/mcp` request 401s and the client silently re-runs OAuth.
 *
 * A transient refresh failure (network error, IdentityServer 5xx) is NOT this
 * error — those throw a plain Error so we don't evict the user over a blip.
 */
export class ReauthRequiredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReauthRequiredError";
  }
}

// Coalesce concurrent refresh-token lookups for the same user. Without this,
// parallel tool calls that hit an expired access token each send the *same*
// refresh_token to Acumatica; IdentityServer rotates refresh tokens on use,
// so the second call gets `invalid_grant` and the user is evicted from the
// session. The map is per-isolate, which is sufficient because DOs pin a
// user to one instance; unpinned access from another isolate would at worst
// reproduce the original race for one extra call, and all correctness
// invariants still hold (token gets stored, next caller sees it).
const inflightLookups = new Map<string, Promise<string>>();

/**
 * Get an Acumatica access token for a specific user.
 * Tokens are stored per-user in the platform key-value store, keyed by their Acumatica username.
 * Automatically refreshes expired tokens. The stored `refresh_token` is
 * AES-GCM-encrypted at rest; legacy plaintext records are read transparently
 * and re-encrypted on the next refresh.
 */
export async function getAcumaticaTokenForUser(
  env: AppEnv,
  acumaticaUsername: string
): Promise<string> {
  const existing = inflightLookups.get(acumaticaUsername);
  if (existing) return existing;

  const lookup = (async () => {
    const tokenKey = `user_token:${acumaticaUsername}`;
    const raw = await env.store.get(tokenKey);

    if (!raw) {
      throw new ReauthRequiredError(
        "No Acumatica token found for your account. Please reconnect to re-authorize with Acumatica."
      );
    }

    const stored: StoredToken = JSON.parse(raw);

    // Return existing token if it has at least 60s of life left
    if (stored.expires_at > Date.now() + 60_000) {
      return stored.access_token;
    }

    // Refresh required — but some legacy records (created before we stored
    // refresh_token) don't have one. Force re-auth rather than crashing.
    if (!stored.refresh_token) {
      throw new ReauthRequiredError(
        "Your Acumatica session has expired and no refresh token is available. Please reconnect to re-authorize."
      );
    }

    // Decrypt the refresh token (falls through unchanged for legacy plaintext records)
    const refreshToken = await decryptString(stored.refresh_token, env.COOKIE_ENCRYPTION_KEY);
    return refreshUserToken(env, acumaticaUsername, refreshToken);
  })();

  inflightLookups.set(acumaticaUsername, lookup);
  try {
    return await lookup;
  } finally {
    inflightLookups.delete(acumaticaUsername);
  }
}

async function refreshUserToken(
  env: AppEnv,
  acumaticaUsername: string,
  refreshToken: string
): Promise<string> {
  const tokenUrl = `${env.ACUMATICA_URL}/identity/connect/token`;

  const response = await fetch(tokenUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      client_id: env.ACUMATICA_CLIENT_ID,
      client_secret: env.ACUMATICA_CLIENT_SECRET,
      refresh_token: refreshToken,
    }),
  });

  if (!response.ok) {
    // Read ONLY the `error` field — IdentityServer error bodies can echo the
    // submitted form, which includes client_secret. We use it for diagnostics,
    // NOT for the transient-vs-permanent decision: classify by HTTP status
    // instead. Matching the exact string `invalid_grant` was too brittle —
    // Acumatica returned a 400 with a body that didn't parse to that exact
    // code, so dead refresh tokens fell through to the "transient" branch and
    // the model looped forever on "please try again shortly" instead of
    // re-authenticating.
    let oauthError: string | undefined;
    try {
      const body = (await response.json()) as { error?: unknown };
      if (typeof body.error === "string") oauthError = body.error;
    } catch {
      // non-JSON / empty body — leave oauthError undefined
    }

    // Status + error CODE only (never the description/body, which can echo the
    // client_secret) so refresh failures are diagnosable from `wrangler tail`.
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

    // 5xx / 429 are the only genuinely transient failures — IdentityServer is
    // up but momentarily unhappy, and the SAME refresh token may succeed on
    // retry. Throw a plain Error so the DO does NOT evict the user over a blip.
    if (response.status >= 500 || response.status === 429) {
      throw new Error(
        `Acumatica token refresh failed (${response.status}). Please try again shortly.`
      );
    }

    // Any 4xx (invalid_grant, invalid_request, invalid_client, …) means this
    // refresh token will not start working again on retry — the grant is dead.
    // Signal a re-auth so the DO revokes the MCP grant and the client silently
    // re-runs OAuth.
    throw new ReauthRequiredError(
      "Your Acumatica session has expired. Re-authorizing — reconnect the MCP server if you are not prompted automatically."
    );
  }

  const tokens = (await response.json()) as {
    access_token: string;
    refresh_token: string;
    expires_in: number;
  };

  const encryptedRefresh = await encryptString(tokens.refresh_token, env.COOKIE_ENCRYPTION_KEY);
  const stored: StoredToken = {
    access_token: tokens.access_token,
    refresh_token: encryptedRefresh,
    expires_at: Date.now() + tokens.expires_in * 1000,
  };

  const tokenKey = `user_token:${acumaticaUsername}`;
  await env.store.put(tokenKey, JSON.stringify(stored), { expirationTtl: USER_TOKEN_TTL_SECONDS });

  return tokens.access_token;
}
