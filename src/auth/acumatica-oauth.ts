// Copyright 2026 Hall Boys, Inc.
// SPDX-License-Identifier: Apache-2.0

import type { Env, StoredToken } from "../types/acumatica";

/**
 * Get an Acumatica access token for a specific user.
 * Tokens are stored per-user in KV, keyed by their Acumatica username.
 * Automatically refreshes expired tokens.
 */
export async function getAcumaticaTokenForUser(
  env: Env,
  acumaticaUsername: string
): Promise<string> {
  const tokenKey = `user_token:${acumaticaUsername}`;
  const raw = await env.TOKEN_STORE.get(tokenKey, "text");

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

  // Attempt refresh
  return refreshUserToken(env, acumaticaUsername, stored.refresh_token);
}

async function refreshUserToken(
  env: Env,
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
    const body = await response.text();
    throw new Error(
      `Acumatica token refresh failed (${response.status}): ${body}. Please reconnect to re-authorize.`
    );
  }

  const tokens = (await response.json()) as {
    access_token: string;
    refresh_token: string;
    expires_in: number;
  };

  const stored: StoredToken = {
    access_token: tokens.access_token,
    refresh_token: tokens.refresh_token,
    expires_at: Date.now() + tokens.expires_in * 1000,
  };

  const tokenKey = `user_token:${acumaticaUsername}`;
  await env.TOKEN_STORE.put(tokenKey, JSON.stringify(stored));

  return tokens.access_token;
}
