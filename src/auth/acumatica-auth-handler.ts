// Copyright 2026 Hall Boys, Inc.
// SPDX-License-Identifier: Apache-2.0

import { Hono } from "hono";
import type { Env } from "../types/acumatica";

type AuthEnv = Env & {
  COOKIE_ENCRYPTION_KEY: string;
  OAUTH_PROVIDER: {
    parseAuthRequest(request: Request): Promise<OAuthReqInfo>;
    completeAuthorization(opts: {
      request: OAuthReqInfo;
      userId: string;
      metadata: { label: string };
      scope: string[];
      props: Record<string, unknown>;
    }): Promise<{ redirectTo: string }>;
  };
  OAUTH_KV: KVNamespace;
};

interface OAuthReqInfo {
  clientId: string;
  redirectUri: string;
  scope: string[];
  state: string;
  codeChallenge?: string;
  codeChallengeMethod?: string;
  [key: string]: unknown;
}

const app = new Hono<{ Bindings: AuthEnv }>();

// ──────────────────────────────────────────────────────────────
// Step 1: /authorize — Claude initiates the MCP OAuth flow.
// Stash the MCP request, redirect straight to Acumatica login.
// ──────────────────────────────────────────────────────────────
app.get("/authorize", async (c) => {
  const oauthReqInfo = await c.env.OAUTH_PROVIDER.parseAuthRequest(c.req.raw);
  if (!oauthReqInfo) {
    return c.text("Invalid OAuth request", 400);
  }

  const state = crypto.randomUUID();

  await c.env.OAUTH_KV.put(
    `acumatica_state:${state}`,
    JSON.stringify(oauthReqInfo),
    { expirationTtl: 600 }
  );

  const origin = new URL(c.req.url).origin;
  const acumaticaAuthorizeUrl = new URL(
    `${c.env.ACUMATICA_URL}/identity/connect/authorize`
  );
  acumaticaAuthorizeUrl.searchParams.set("response_type", "code");
  acumaticaAuthorizeUrl.searchParams.set("client_id", c.env.ACUMATICA_CLIENT_ID);
  acumaticaAuthorizeUrl.searchParams.set(
    "redirect_uri",
    `${origin}/callback`
  );
  acumaticaAuthorizeUrl.searchParams.set("scope", "api");
  acumaticaAuthorizeUrl.searchParams.set("state", state);

  return c.redirect(acumaticaAuthorizeUrl.toString());
});

// ──────────────────────────────────────────────────────────────
// Step 2: /callback — Acumatica redirects here after login.
// Exchange code for tokens, look up the user, store the token,
// then complete the MCP OAuth flow.
// ──────────────────────────────────────────────────────────────
app.get("/callback", async (c) => {
  const code = c.req.query("code");
  const state = c.req.query("state");
  const error = c.req.query("error");

  if (error) {
    return c.text(
      `Acumatica error: ${error} — ${c.req.query("error_description") || ""}`,
      400
    );
  }

  if (!code || !state) {
    return c.text("Missing code or state in callback", 400);
  }

  // Retrieve the original MCP OAuth request
  const stored = await c.env.OAUTH_KV.get(`acumatica_state:${state}`);
  if (!stored) {
    return c.text("Invalid or expired state. Please try connecting again.", 400);
  }
  const oauthReqInfo: OAuthReqInfo = JSON.parse(stored);
  await c.env.OAUTH_KV.delete(`acumatica_state:${state}`);

  // Exchange Acumatica code for tokens
  const origin = new URL(c.req.url).origin;
  const tokenResponse = await fetch(
    `${c.env.ACUMATICA_URL}/identity/connect/token`,
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        client_id: c.env.ACUMATICA_CLIENT_ID,
        client_secret: c.env.ACUMATICA_CLIENT_SECRET,
        redirect_uri: `${origin}/callback`,
      }),
    }
  );

  if (!tokenResponse.ok) {
    const body = await tokenResponse.text();
    console.error("Acumatica token exchange failed:", body);
    return c.text("Acumatica authentication failed. Please try again.", 502);
  }

  const acumaticaTokens = (await tokenResponse.json()) as {
    access_token: string;
    refresh_token: string;
    expires_in: number;
  };

  // Fetch current Acumatica user identity
  let acumaticaUsername = "unknown";
  let acumaticaDisplayName = "Unknown User";

  try {
    const userInfoUrl = `${c.env.ACUMATICA_URL}/entity/auth/25.200.001/UserSecurityInfo`;
    const userInfoResp = await fetch(userInfoUrl, {
      headers: { Authorization: `Bearer ${acumaticaTokens.access_token}` },
    });
    if (userInfoResp.ok) {
      const userInfo = (await userInfoResp.json()) as {
        Username?: { value: string };
        DisplayName?: { value: string };
        Email?: { value: string };
      };
      acumaticaUsername = userInfo.Username?.value || "unknown";
      acumaticaDisplayName =
        userInfo.DisplayName?.value || userInfo.Username?.value || "Unknown User";
    }
  } catch (e) {
    // If we can't get user info, fall back to a hash of the access token
    // to ensure unique key per user
    console.error("Failed to fetch Acumatica user info:", e);
    acumaticaUsername = `user_${state.slice(0, 8)}`;
  }

  // Store the per-user token in KV
  const userTokenKey = `user_token:${acumaticaUsername}`;
  await c.env.TOKEN_STORE.put(
    userTokenKey,
    JSON.stringify({
      access_token: acumaticaTokens.access_token,
      refresh_token: acumaticaTokens.refresh_token,
      expires_at: Date.now() + acumaticaTokens.expires_in * 1000,
    })
  );

  // Complete the MCP OAuth flow
  const { redirectTo } = await c.env.OAUTH_PROVIDER.completeAuthorization({
    request: oauthReqInfo,
    userId: acumaticaUsername,
    metadata: { label: acumaticaDisplayName },
    scope: oauthReqInfo.scope,
    props: {
      acumaticaUsername,
      acumaticaDisplayName,
    },
  });

  return c.redirect(redirectTo);
});

// Health check
app.get("/", (c) => c.json({ status: "ok", service: "acumatica-mcp-server" }));
app.get("/health", (c) => c.json({ status: "ok", service: "acumatica-mcp-server" }));

export { app as AcumaticaAuthHandler };
