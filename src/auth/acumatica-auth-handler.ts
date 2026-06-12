// Copyright 2026 Hall Boys, Inc.
// SPDX-License-Identifier: Apache-2.0

import { Hono } from "hono";
import type { Env } from "../types/acumatica";
import { docsApp } from "../docs/docs-handler";
import { logAuthEvent } from "../lib/logger";
import { encryptString, parseCookies } from "../lib/crypto";
import { interpretTokenError } from "../lib/preflight";
import installScript from "../../install.sh";

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
  // `offline_access` is REQUIRED for Acumatica/IdentityServer to issue a
  // refresh token. Without it the token response has no refresh_token, the
  // stored token can never be refreshed, and every session dies the moment
  // its ~1h access token expires. (The Connected App in SM303010 must also
  // permit the offline_access scope.)
  acumaticaAuthorizeUrl.searchParams.set("scope", "api openid profile email offline_access");
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
    // Burn the KV state record so a subsequent replay with the same
    // `state` query parameter cannot succeed even if the attacker later
    // manages to plant the matching cookie. State records are
    // single-use by design; mismatch is abandonment.
    await c.env.TOKEN_STORE.delete(`acumatica_state:${state}`).catch(() => {});
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
    // Do NOT log or echo the full response body — some IdentityServer
    // error responses contain the submitted form (client_secret, code).
    // Safe to extract only the OAuth `error` code from the JSON body
    // and render a targeted page keyed on it; interpretTokenError maps
    // the known codes to admin-facing remediation text.
    let errorCode: string | undefined;
    try {
      const body = (await tokenResponse.json()) as { error?: string };
      errorCode = body.error;
    } catch {
      // Body wasn't JSON — leave errorCode undefined
    }
    console.error(
      `Acumatica token exchange failed: HTTP ${tokenResponse.status}${errorCode ? ` (${errorCode})` : ""}`
    );
    logAuthEvent("login_denied", "unknown", {
      reason: "token_exchange_failed",
      status: tokenResponse.status,
      errorCode,
    });
    const info = interpretTokenError(tokenResponse.status, errorCode);
    return c.html(renderTokenExchangeErrorPage(info), 502);
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
      // Don't echo `sub`, `name`, or `email` to logs — these are IdP
      // identity attributes that don't need long-term retention and end
      // up in Logpush / R2. The chosen username already appears in the
      // downstream `auth_event` log for the successful login.
      acumaticaUsername = oidcInfo.preferred_username || oidcInfo.sub || "unknown";
      acumaticaDisplayName = oidcInfo.name || acumaticaUsername;
      console.log(`User info (OIDC): resolved username`);
    } else {
      console.log(`User info (OIDC): HTTP ${oidcResp.status}, trying auth contract...`);
      // Attempt 2: auth contract
      const authUrl = `${c.env.ACUMATICA_URL}/entity/auth/${c.env.ACUMATICA_ENDPOINT_VERSION}/UserSecurityInfo`;
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
        acumaticaUsername = userInfo.Username?.value || "unknown";
        acumaticaDisplayName =
          userInfo.DisplayName?.value || acumaticaUsername;
        console.log(`User info (auth): resolved username`);
      } else {
        // Body omitted — may contain auth error payloads from Acumatica.
        console.error(`User info (auth): HTTP ${authResp.status}`);
      }
    }
  } catch (e) {
    console.error("Failed to fetch Acumatica user info:", e);
    // Use the full state UUID rather than an 8-char slice. 8 hex chars is
    // only 32 bits of entropy — on a busy instance, two simultaneous failed
    // lookups could collide and cause users to share a token key.
    acumaticaUsername = `user_${state}`;
  }

  // ── Role gate: check for required MCP role ──────────────────
  // Try multiple approaches to check if the user has the required role.
  // Acumatica instances vary in which entities/endpoints are available.
  const requiredRole = c.env.ACUMATICA_MCP_ROLE || "MCP Access";
  const roleResult = await checkUserRole(
    c.env.ACUMATICA_URL,
    c.env.ACUMATICA_TENANT,
    acumaticaTokens.access_token,
    acumaticaUsername,
    requiredRole
  );

  if (roleResult.kind === "denied") {
    logAuthEvent("login_denied", acumaticaUsername, {
      reason: "missing_role",
      requiredRole,
    });
    return c.html(renderAccessDeniedPage(acumaticaDisplayName, requiredRole), 403);
  }

  if (roleResult.kind === "misconfigured") {
    logAuthEvent("login_denied", acumaticaUsername, {
      reason: "role_check_misconfigured",
      requiredRole,
      status: roleResult.status,
      detail: roleResult.reason,
    });
    return c.html(renderRoleCheckErrorPage(requiredRole, roleResult.reason), 503);
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
  const storedToken = {
    access_token: pending.acumaticaTokens.access_token,
    refresh_token: encryptedRefresh,
    expires_at: Date.now() + pending.acumaticaTokens.expires_in * 1000,
  };
  await c.env.TOKEN_STORE.put(userTokenKey, JSON.stringify(storedToken), {
    expirationTtl: USER_TOKEN_TTL_SECONDS,
  });

  // Seed the per-user TokenManager DO directly so its authoritative copy is
  // fresh immediately — otherwise the DO might read a stale (expired) KV
  // record in the eventual-consistency window right after re-auth and try to
  // refresh a dead token. (The DO also adopts from KV on cold read, but
  // seeding removes the race entirely.)
  try {
    const tmId = c.env.TOKEN_MANAGER.idFromName(pending.acumaticaUsername);
    await c.env.TOKEN_MANAGER.get(tmId).setToken(storedToken);
  } catch (e) {
    // Non-fatal: the DO will adopt the token from KV on its first read.
    console.warn("TokenManager seed failed (will adopt from KV):", e instanceof Error ? e.message : e);
  }

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
// endpoint. 302 to the OAuth authorization server metadata so CIMD support
// is advertised consistently without re-entering the worker over HTTP
// (the previous implementation did a same-origin fetch back to
// /.well-known/oauth-authorization-server, which burned an extra round trip
// and a subrequest on every discovery probe).
app.get("/.well-known/openid-configuration", (c) => {
  return c.redirect("/.well-known/oauth-authorization-server", 302);
});

// Health check. Open CORS so external uptime monitors / dashboards can
// poll cross-origin. OAuthProvider already adds CORS headers to the
// OAuth/MCP endpoints it handles (`/mcp`, `/token`, `/register`,
// `/.well-known/oauth-authorization-server`); the documentation site is
// HTML served same-origin and doesn't need them.
app.get("/health", (c) => {
  c.header("Access-Control-Allow-Origin", "*");
  c.header("Access-Control-Allow-Methods", "GET, OPTIONS");
  return c.json({ status: "ok", service: "mcp4acumatica" });
});
app.options("/health", (c) => {
  return new Response(null, {
    status: 204,
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Access-Control-Max-Age": "86400",
    },
  });
});

// One-line installer served at /install.sh. Meant to be piped into bash:
//   curl -fsSL https://<this-worker>/install.sh | bash
// The script clones the repo, installs deps, and runs setup.sh. Keeping
// the script at the same origin as the worker means users don't need to
// trust a separate hosting domain.
app.get("/install.sh", (c) => {
  c.header("Content-Type", "text/x-shellscript; charset=utf-8");
  c.header("Cache-Control", "public, max-age=300");
  return c.body(installScript);
});

// Documentation site
app.route("/docs", docsApp);
app.get("/", (c) => c.redirect("/docs"));

export { app as AcumaticaAuthHandler };

// ──────────────────────────────────────────────────────────────
// Role check — tries multiple Acumatica API approaches
// ──────────────────────────────────────────────────────────────

type RoleCheckResult =
  | { kind: "granted" }
  | { kind: "denied" }
  | { kind: "misconfigured"; reason: string; status?: number };

/**
 * Check whether the authenticated user has the required MCP role by
 * querying the canary GI (`MCPAccess`) via OData. Returns a discriminated
 * result so the caller can render a meaningful error:
 *
 *   - 200 → `granted` (user has the role)
 *   - 403 → `denied` (user is missing the role)
 *   - 404 → `misconfigured` (canary GI is missing or not exposed via OData)
 *   - 5xx / network errors → `misconfigured` (Acumatica or tenant misconfig)
 *
 * Previously every non-200 was collapsed into "denied", which meant a
 * tenant typo or a missing GI looked identical to "no role" and admins
 * only found out via support tickets.
 */
async function checkUserRole(
  acumaticaUrl: string,
  tenant: string,
  accessToken: string,
  username: string,
  _requiredRole: string
): Promise<RoleCheckResult> {
  const headers = {
    Authorization: `Bearer ${accessToken}`,
    Accept: "application/json",
  };

  const giName = "MCPAccess";
  const giUrl = `${acumaticaUrl}/t/${tenant}/api/odata/gi/${giName}?$top=1`;
  console.log(`Role check (canary GI): querying ${giUrl} for user ${username}`);

  let resp: Response;
  try {
    resp = await fetch(giUrl, { headers });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`Role check (canary GI): network failure: ${msg}`);
    return { kind: "misconfigured", reason: `Unable to reach Acumatica: ${msg}` };
  }

  console.log(`Role check (canary GI): HTTP ${resp.status}`);

  if (resp.ok) return { kind: "granted" };
  if (resp.status === 403) return { kind: "denied" };
  if (resp.status === 404) {
    return {
      kind: "misconfigured",
      status: 404,
      reason: `Canary Generic Inquiry '${giName}' is missing or not exposed via OData on tenant '${tenant}'. Create it (SM208000) and assign it to the required role.`,
    };
  }
  // 401 here would mean the just-minted access token is already rejected —
  // treat as misconfig so the user gets a useful message rather than "denied".
  return {
    kind: "misconfigured",
    status: resp.status,
    reason: `Acumatica returned HTTP ${resp.status} when checking role. Verify ACUMATICA_TENANT, the '${giName}' GI is exposed via OData, and the instance is reachable.`,
  };
}

// ──────────────────────────────────────────────────────────────
// HTML templates
// ──────────────────────────────────────────────────────────────

function renderTokenExchangeErrorPage(info: {
  title: string;
  detail: string;
  remediation: string;
}): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Configuration Error — Acumatica MCP</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; max-width: 640px; margin: 80px auto; padding: 0 20px; color: #333; }
    .card { background: #fff; border: 1px solid #e0e0e0; border-radius: 8px; padding: 32px; box-shadow: 0 2px 8px rgba(0,0,0,0.08); }
    h1 { color: #b45309; font-size: 1.5rem; margin-top: 0; }
    .detail { margin-top: 16px; padding: 12px 16px; background: #fffbeb; border: 1px solid #fde68a; border-radius: 6px; font-size: 0.9rem; }
    .action { margin-top: 20px; padding: 16px; background: #f8f9fa; border-radius: 6px; }
    .action h3 { margin-top: 0; font-size: 0.9rem; text-transform: uppercase; color: #666; }
    .hint { margin-top: 16px; font-size: 0.85rem; color: #666; }
    code { background: #f1f5f9; padding: 2px 6px; border-radius: 4px; font-size: 0.85em; }
  </style>
</head>
<body>
  <div class="card">
    <h1>${escapeHtml(info.title)}</h1>
    <p>The Acumatica MCP server could not complete the login because the Acumatica identity server rejected our request.</p>
    <div class="detail">${escapeHtml(info.detail)}</div>
    <div class="action">
      <h3>What to fix</h3>
      <p>${escapeHtml(info.remediation)}</p>
    </div>
    <p class="hint">Your Acumatica administrator can run the preflight check at <code>/docs/admin/preflight</code> to confirm every configured value before reconnecting.</p>
  </div>
</body>
</html>`;
}

function renderRoleCheckErrorPage(roleName: string, detail: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Configuration Error — Acumatica MCP</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; max-width: 600px; margin: 80px auto; padding: 0 20px; color: #333; }
    .card { background: #fff; border: 1px solid #e0e0e0; border-radius: 8px; padding: 32px; box-shadow: 0 2px 8px rgba(0,0,0,0.08); }
    h1 { color: #b45309; font-size: 1.5rem; margin-top: 0; }
    .role-name { background: #f5f5f5; padding: 2px 8px; border-radius: 4px; font-family: monospace; }
    .detail { margin-top: 20px; padding: 16px; background: #fffbeb; border: 1px solid #fde68a; border-radius: 6px; font-family: "SF Mono", Menlo, monospace; font-size: 0.85rem; white-space: pre-wrap; }
    .action { margin-top: 24px; padding: 16px; background: #f8f9fa; border-radius: 6px; }
    .action h3 { margin-top: 0; font-size: 0.9rem; text-transform: uppercase; color: #666; }
  </style>
</head>
<body>
  <div class="card">
    <h1>Configuration Error</h1>
    <p>The AI assistant cannot verify your access to the <span class="role-name">${escapeHtml(roleName)}</span> role because Acumatica did not respond as expected.</p>
    <div class="detail">${escapeHtml(detail)}</div>
    <div class="action">
      <h3>What to do</h3>
      <p>This is a server-side configuration problem, not a permissions issue with your account. Ask your Acumatica administrator to check the MCP instance configuration — specifically the tenant name, the canary Generic Inquiry, and OData exposure.</p>
    </div>
  </div>
</body>
</html>`;
}

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
