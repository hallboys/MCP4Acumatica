// Copyright 2026 Hall Boys, Inc.
// SPDX-License-Identifier: Apache-2.0

import type { AppEnv, StoredToken } from "../types/acumatica";
import { decryptString, encryptString } from "../lib/crypto";

const USER_TOKEN_TTL_SECONDS = 30 * 24 * 60 * 60; // 30 days — matches write-side TTL

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
  const tokenKey = `user_token:${acumaticaUsername}`;
  const raw = await env.store.get(tokenKey);

  if (!raw) {
    throw new Error(
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
    throw new Error(
      "Your Acumatica session has expired and no refresh token is available. Please reconnect to re-authorize."
    );
  }

  // Decrypt the refresh token (falls through unchanged for legacy plaintext records)
  const refreshToken = await decryptString(stored.refresh_token, env.COOKIE_ENCRYPTION_KEY);
  return refreshUserToken(env, acumaticaUsername, refreshToken);
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
    // Do not include the body — IdentityServer may echo the submitted form (with client_secret).
    throw new Error(
      `Acumatica token refresh failed (${response.status}). Please reconnect to re-authorize.`
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
