// Copyright 2026 Hall Boys, Inc.
// SPDX-License-Identifier: Apache-2.0

import { Hono } from "hono";
import type { Env } from "../types/acumatica";
import { docsApp } from "../docs/docs-handler";
import { logAuthEvent } from "../lib/logger";
import { encryptString, parseCookies } from "../lib/crypto";

// OAuth state cookie — binds the `state` parameter to the browser that
// started the flow, preventing login-CSRF / session-fixation on /callback.
// SameSite=Lax is required because Acumatica's redirect is a cross-origin
// top-level navigation; Strict would block the cookie.
const OAUTH_STATE_COOKIE = "acu_oauth_state";
const OAUTH_STATE_TTL_SECONDS = 600;

// KV TTL for per-user Acumatica tokens. Long enough that normal users
// don't have to re-auth mid-day, short enough to bound the blast radius
// of a stolen refresh token.
const USER_TOKEN_TTL_SECONDS = 30 * 24 * 60 * 60; // 30 days

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

/** Data stored in KV while waiting for consent acknowledgment */
interface PendingConsent {
  oauthReqInfo: OAuthReqInfo;
  acumaticaUsername: string;
  acumaticaDisplayName: string;
  acumaticaTokens: {
    access_token: string;
    refresh_token: string;
    expires_in: number;
  };
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

  await c.env.TOKEN_STORE.put(
    `acumatica_state:${state}`,
    JSON.stringify(oauthReqInfo),
    { expirationTtl: OAUTH_STATE_TTL_SECONDS }
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
  acumaticaAuthorizeUrl.searchParams.set("scope", "api openid profile email");
  acumaticaAuthorizeUrl.searchParams.set("state", state);

  // Bind the state to this browser via an HttpOnly cookie. /callback
  // will require cookie.state === query.state before exchanging the code.
  c.header(
    "Set-Cookie",
    `${OAUTH_STATE_COOKIE}=${state}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${OAUTH_STATE_TTL_SECONDS}`
  );

  return c.redirect(acumaticaAuthorizeUrl.toString());
});

// ──────────────────────────────────────────────────────────────
// Step 2: /callback — Acumatica redirects here after login.
// Exchange code for tokens, look up the user, check role,
// then redirect to consent page.
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

  // Verify the state cookie set at /authorize — this is what protects
  // /callback from login-CSRF. Without the cookie, an attacker who
  // captures a valid (code, state) pair cannot complete the flow in a
  // victim's browser because the cookie was never set there.
  const cookies = parseCookies(c.req.header("cookie"));
  const cookieState = cookies[OAUTH_STATE_COOKIE];
  if (!cookieState || cookieState !== state) {
    logAuthEvent("callback_state_mismatch", "unknown", {
      hasCookie: Boolean(cookieState),
    });
    return c.text(
      "OAuth state mismatch. Please close this tab and try connecting again.",
      400
    );
  }

  // Retrieve the original MCP OAuth request
  const stored = await c.env.TOKEN_STORE.get(`acumatica_state:${state}`);
  if (!stored) {
    return c.text("Invalid or expired state. Please try connecting again.", 400);
  }
  const oauthReqInfo: OAuthReqInfo = JSON.parse(stored);
  await c.env.TOKEN_STORE.delete(`acumatica_state:${state}`);

  // Clear the state cookie — it has served its purpose.
  c.header(
    "Set-Cookie",
    `${OAUTH_STATE_COOKIE}=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0`
  );

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
    // Do NOT log the response body — some IdentityServer error responses
    // echo back the submitted form which includes client_secret and code.
    console.error(`Acumatica token exchange failed: HTTP ${tokenResponse.status}`);
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

  // Try multiple endpoints to identify the user:
  // 1. OIDC userinfo (standard, most reliable)
  // 2. auth contract UserSecurityInfo (may not exist on all instances)
  // 3. Fall back to UUID-based key
  try {
    // Attempt 1: OIDC userinfo endpoint
    const oidcUrl = `${c.env.ACUMATICA_URL}/identity/connect/userinfo`;
    console.log(`User info: trying OIDC ${oidcUrl}`);
    const oidcResp = await fetch(oidcUrl, {
      headers: {
        Authorization: `Bearer ${acumaticaTokens.access_token}`,
        Accept: "application/json",
      },
    });
    if (oidcResp.ok) {
      const oidcInfo = (await oidcResp.json()) as {
        sub?: string;
        name?: string;
        preferred_username?: string;
        email?: string;
      };
      console.log(`User info (OIDC): sub=${oidcInfo.sub}, name=${oidcInfo.name}, preferred_username=${oidcInfo.preferred_username}`);
      acumaticaUsername = oidcInfo.preferred_username || oidcInfo.sub || "unknown";
      acumaticaDisplayName = oidcInfo.name || acumaticaUsername;
    } else {
      console.log(`User info (OIDC): HTTP ${oidcResp.status}, trying auth contract...`);
      // Attempt 2: auth contract
      const authUrl = `${c.env.ACUMATICA_URL}/entity/auth/25.200.001/UserSecurityInfo`;
      const authResp = await fetch(authUrl, {
        headers: {
          Authorization: `Bearer ${acumaticaTokens.access_token}`,
          Accept: "application/json",
        },
      });
      if (authResp.ok) {
        const userInfo = (await authResp.json()) as {
          Username?: { value: string };
          DisplayName?: { value: string };
        };
        console.log(`User info (auth): Username=${userInfo.Username?.value}`);
        acumaticaUsername = userInfo.Username?.value || "unknown";
        acumaticaDisplayName =
          userInfo.DisplayName?.value || acumaticaUsername;
      } else {
        // Body omitted — may contain auth error payloads from Acumatica.
        console.error(`User info (auth): HTTP ${authResp.status}`);
      }
    }
  } catch (e) {
    console.error("Failed to fetch Acumatica user info:", e);
    acumaticaUsername = `user_${state.slice(0, 8)}`;
  }

  // ── Role gate: check for required MCP role ──────────────────
  // Try multiple approaches to check if the user has the required role.
  // Acumatica instances vary in which entities/endpoints are available.
  const requiredRole = c.env.ACUMATICA_MCP_ROLE || "MCP Access";
  const hasRole = await checkUserRole(
    c.env.ACUMATICA_URL,
    c.env.ACUMATICA_TENANT,
    acumaticaTokens.access_token,
    acumaticaUsername,
    requiredRole
  );

  if (!hasRole) {
    logAuthEvent("login_denied", acumaticaUsername, {
      reason: "missing_role",
      requiredRole,
    });
    return c.html(renderAccessDeniedPage(acumaticaDisplayName, requiredRole), 403);
  }

  // ── Store pending consent in KV and redirect ────────────────
  const consentId = crypto.randomUUID();
  const pendingConsent: PendingConsent = {
    oauthReqInfo,
    acumaticaUsername,
    acumaticaDisplayName,
    acumaticaTokens,
  };

  await c.env.TOKEN_STORE.put(
    `consent:${consentId}`,
    JSON.stringify(pendingConsent),
    { expirationTtl: 300 } // 5 minutes
  );

  return c.redirect(`/consent?id=${consentId}`);
});

// ──────────────────────────────────────────────────────────────
// Step 3: /consent — Show consent interstitial before completing
// the MCP OAuth flow.
// ──────────────────────────────────────────────────────────────
app.get("/consent", async (c) => {
  const consentId = c.req.query("id");
  if (!consentId) {
    return c.text("Missing consent ID", 400);
  }

  const stored = await c.env.TOKEN_STORE.get(`consent:${consentId}`);
  if (!stored) {
    return c.text("Consent request expired. Please try connecting again.", 400);
  }

  const pending: PendingConsent = JSON.parse(stored);
  return c.html(renderConsentPage(consentId, pending.acumaticaDisplayName));
});

app.post("/consent", async (c) => {
  const body = await c.req.parseBody();
  const consentId = body["consent_id"] as string;

  if (!consentId) {
    return c.text("Missing consent ID", 400);
  }

  const stored = await c.env.TOKEN_STORE.get(`consent:${consentId}`);
  if (!stored) {
    return c.text("Consent request expired. Please try connecting again.", 400);
  }

  const pending: PendingConsent = JSON.parse(stored);
  await c.env.TOKEN_STORE.delete(`consent:${consentId}`);

  // Store the per-user token in KV. The refresh_token is encrypted at
  // rest with COOKIE_ENCRYPTION_KEY (AES-256-GCM) — access_token lives
  // in plaintext because it's short-lived and worthless after expiry.
  // The record also carries a TTL so a leaked refresh token can't be
  // used forever after the user stops logging in.
  const userTokenKey = `user_token:${pending.acumaticaUsername}`;
  const encryptedRefresh = await encryptString(
    pending.acumaticaTokens.refresh_token,
    c.env.COOKIE_ENCRYPTION_KEY
  );
  await c.env.TOKEN_STORE.put(
    userTokenKey,
    JSON.stringify({
      access_token: pending.acumaticaTokens.access_token,
      refresh_token: encryptedRefresh,
      expires_at: Date.now() + pending.acumaticaTokens.expires_in * 1000,
    }),
    { expirationTtl: USER_TOKEN_TTL_SECONDS }
  );

  logAuthEvent("consent_accepted", pending.acumaticaUsername);

  // Complete the MCP OAuth flow
  const { redirectTo } = await c.env.OAUTH_PROVIDER.completeAuthorization({
    request: pending.oauthReqInfo,
    userId: pending.acumaticaUsername,
    metadata: { label: pending.acumaticaDisplayName },
    scope: pending.oauthReqInfo.scope,
    props: {
      acumaticaUsername: pending.acumaticaUsername,
      acumaticaDisplayName: pending.acumaticaDisplayName,
    },
  });

  logAuthEvent("login_success", pending.acumaticaUsername);

  return c.redirect(redirectTo);
});

// OpenID Connect discovery — some MCP clients (e.g. ChatGPT) also check this
// endpoint. Proxy to the OAuth authorization server metadata so CIMD support
// is advertised consistently across both discovery paths.
app.get("/.well-known/openid-configuration", async (c) => {
  const origin = new URL(c.req.url).origin;
  const resp = await fetch(`${origin}/.well-known/oauth-authorization-server`);
  return new Response(resp.body, {
    status: resp.status,
    headers: { "content-type": "application/json" },
  });
});

// Health check
app.get("/health", (c) => c.json({ status: "ok", service: "mcp4acumatica" }));

// Documentation site
app.route("/docs", docsApp);
app.get("/", (c) => c.redirect("/docs"));

export { app as AcumaticaAuthHandler };

// ──────────────────────────────────────────────────────────────
// Role check — tries multiple Acumatica API approaches
// ──────────────────────────────────────────────────────────────

async function checkUserRole(
  acumaticaUrl: string,
  tenant: string,
  accessToken: string,
  username: string,
  requiredRole: string
): Promise<boolean> {
  const headers = {
    Authorization: `Bearer ${accessToken}`,
    Accept: "application/json",
  };

  // Canary GI approach: a dummy GI (e.g., "MCPAccess") is assigned only to the
  // required role. If the user can query it via OData, they have the role.
  // If they get 403/404, they don't.
  const giName = "MCPAccess";
  try {
    const giUrl = `${acumaticaUrl}/t/${tenant}/api/odata/gi/${giName}?$top=1`;
    console.log(`Role check (canary GI): querying ${giUrl} for user ${username}`);

    const resp = await fetch(giUrl, { headers });
    console.log(`Role check (canary GI): HTTP ${resp.status}`);

    if (resp.ok) {
      return true;
    }

    // 403 = user doesn't have role, 404 = GI doesn't exist
    if (resp.status === 403) {
      console.log(`Role check (canary GI): user ${username} does not have access to ${giName} GI`);
    } else {
      // Body omitted — may contain auth / tenant info we don't want in long-term logs.
      console.error(`Role check (canary GI): HTTP ${resp.status}`);
    }
  } catch (e) {
    console.error(`Role check (canary GI): failed: ${e instanceof Error ? e.message : String(e)}`);
  }

  return false;
}

// ──────────────────────────────────────────────────────────────
// HTML templates
// ──────────────────────────────────────────────────────────────

function renderAccessDeniedPage(displayName: string, roleName: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Access Denied — Acumatica MCP</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; max-width: 600px; margin: 80px auto; padding: 0 20px; color: #333; }
    .card { background: #fff; border: 1px solid #e0e0e0; border-radius: 8px; padding: 32px; box-shadow: 0 2px 8px rgba(0,0,0,0.08); }
    h1 { color: #c0392b; font-size: 1.5rem; margin-top: 0; }
    .role-name { background: #f5f5f5; padding: 2px 8px; border-radius: 4px; font-family: monospace; }
    .action { margin-top: 24px; padding: 16px; background: #f8f9fa; border-radius: 6px; }
    .action h3 { margin-top: 0; font-size: 0.9rem; text-transform: uppercase; color: #666; }
  </style>
</head>
<body>
  <div class="card">
    <h1>Access Denied</h1>
    <p>Hello, <strong>${escapeHtml(displayName)}</strong>. Your Acumatica account does not have the <span class="role-name">${escapeHtml(roleName)}</span> role required to use this AI assistant.</p>
    <div class="action">
      <h3>What to do</h3>
      <p>Ask your Acumatica administrator to assign the <span class="role-name">${escapeHtml(roleName)}</span> role to your user account, then try connecting again.</p>
    </div>
  </div>
</body>
</html>`;
}

function renderConsentPage(consentId: string, displayName: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Connect to AI Assistant — Acumatica MCP</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; max-width: 600px; margin: 80px auto; padding: 0 20px; color: #333; background: #f5f5f5; }
    .card { background: #fff; border: 1px solid #e0e0e0; border-radius: 8px; padding: 32px; box-shadow: 0 2px 8px rgba(0,0,0,0.08); }
    h1 { font-size: 1.5rem; margin-top: 0; }
    ul { padding-left: 20px; }
    li { margin-bottom: 8px; line-height: 1.5; }
    .warning-banner { background: #dc3545; color: #fff; border-radius: 8px; padding: 20px 24px; margin-bottom: 24px; display: flex; align-items: flex-start; gap: 16px; }
    .warning-icon { font-size: 2.5rem; line-height: 1; flex-shrink: 0; }
    .warning-banner h2 { margin: 0 0 4px 0; font-size: 1.1rem; }
    .warning-banner p { margin: 0; font-size: 0.95rem; opacity: 0.95; }
    .info-box { background: #f8f9fa; border: 1px solid #dee2e6; border-radius: 6px; padding: 16px 20px; margin: 20px 0; font-size: 0.9rem; }
    .info-box strong { display: block; margin-bottom: 4px; }
    button { background: #2563eb; color: #fff; border: none; padding: 12px 32px; border-radius: 6px; font-size: 1rem; cursor: pointer; margin-top: 16px; }
    button:hover { background: #1d4ed8; }
  </style>
</head>
<body>
  <div class="warning-banner">
    <span class="warning-icon">&#9888;</span>
    <div>
      <h2>AI Data Access Warning</h2>
      <p>You are connecting your Acumatica account to an AI assistant. ERP data will be shared with an external AI model. Do not proceed unless you understand the implications.</p>
    </div>
  </div>
  <div class="card">
    <h1>Hello, ${escapeHtml(displayName)}</h1>
    <p>By continuing, you acknowledge that:</p>
    <ul>
      <li>Acumatica data you access through the AI assistant will be <strong>sent to an external AI model</strong> for processing</li>
      <li>All data access is <strong>logged for audit purposes</strong></li>
      <li>Sensitive fields (SSN, bank accounts, salary, etc.) are <strong>automatically redacted</strong> before leaving the server</li>
      <li>AI responses may contain errors or misinterpretations — always <strong>verify critical information directly in Acumatica</strong></li>
    </ul>
    <div class="info-box">
      <strong>Do not rely on AI output for:</strong>
      Financial decisions, compliance reporting, audit evidence, or any action where accuracy is critical. The AI assistant is a convenience tool, not a source of truth.
    </div>
    <form method="POST" action="/consent">
      <input type="hidden" name="consent_id" value="${escapeHtml(consentId)}">
      <button type="submit">I Understand — Continue</button>
    </form>
  </div>
</body>
</html>`;
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
