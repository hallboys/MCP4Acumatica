// Copyright 2026 Hall Boys, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Probes every Acumatica touch-point the worker needs, plus the OAuth
 * error-code mapping used by `/callback` to render a targeted failure
 * page. Every check converts errors to `fail` results so callers can
 * render without try/catch.
 */

export type PreflightStatus = "pass" | "fail" | "warn" | "skip";

export interface PreflightCheck {
  name: string;
  status: PreflightStatus;
  detail: string;
  remediation?: string;
}

export interface PreflightInput {
  acumaticaUrl?: string;
  acumaticaTenant?: string;
  acumaticaEndpointVersion?: string;
  acumaticaEndpointName?: string;
  acumaticaClientId?: string;
  acumaticaClientSecret?: string;
  adminSecret?: string;
  cookieEncryptionKey?: string;
  expectedCallbackUrl: string;
}

const CHECK_TIMEOUT_MS = 5000;

function timeoutSignal(ms: number): AbortSignal {
  return AbortSignal.timeout(ms);
}

function required(name: string, value: string | undefined): PreflightCheck {
  if (value && value.trim().length > 0) {
    return { name, status: "pass", detail: "Set." };
  }
  return {
    name,
    status: "fail",
    detail: "Not set.",
    remediation: `Set ${name} via wrangler.jsonc \`vars\` (non-sensitive) or \`wrangler secret put ${name}\` (sensitive).`,
  };
}

export function checkSecretsPresent(input: PreflightInput): PreflightCheck[] {
  return [
    required("ACUMATICA_URL", input.acumaticaUrl),
    required("ACUMATICA_TENANT", input.acumaticaTenant),
    required("ACUMATICA_ENDPOINT_VERSION", input.acumaticaEndpointVersion),
    required("ACUMATICA_CLIENT_ID", input.acumaticaClientId),
    required("ACUMATICA_CLIENT_SECRET", input.acumaticaClientSecret),
    required("COOKIE_ENCRYPTION_KEY", input.cookieEncryptionKey),
    required("ADMIN_SECRET", input.adminSecret),
  ];
}

async function safeFetch(url: string, init?: RequestInit): Promise<Response | { error: string }> {
  try {
    return await fetch(url, { ...init, signal: timeoutSignal(CHECK_TIMEOUT_MS) });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { error: msg };
  }
}

export async function checkReachable(url: string | undefined): Promise<PreflightCheck> {
  const name = "Acumatica URL reachable";
  if (!url) {
    return { name, status: "skip", detail: "ACUMATICA_URL not set." };
  }
  // HEAD so we don't pull the marketing HTML.
  const res = await safeFetch(url, { method: "HEAD", redirect: "manual" });
  if ("error" in res) {
    return {
      name,
      status: "fail",
      detail: `Network error: ${res.error}`,
      remediation: `Verify ACUMATICA_URL (${url}) is correct and reachable from Cloudflare. Check DNS, TLS, and that the instance is running.`,
    };
  }
  return { name, status: "pass", detail: `HTTP ${res.status} (any HTTP response means DNS + TLS are OK).` };
}

export async function checkOidcDiscovery(url: string | undefined): Promise<PreflightCheck> {
  const name = "Acumatica OIDC discovery";
  if (!url) {
    return { name, status: "skip", detail: "ACUMATICA_URL not set." };
  }
  const discoveryUrl = `${url}/identity/.well-known/openid-configuration`;
  const res = await safeFetch(discoveryUrl);
  if ("error" in res) {
    return {
      name,
      status: "fail",
      detail: `Network error: ${res.error}`,
      remediation: `Could not reach ${discoveryUrl}. Verify the Acumatica IdentityServer is enabled on the instance.`,
    };
  }
  if (res.status === 200) {
    try {
      const body = (await res.json()) as { token_endpoint?: string };
      if (body.token_endpoint) {
        return { name, status: "pass", detail: `token_endpoint: ${body.token_endpoint}` };
      }
      return {
        name,
        status: "warn",
        detail: "Discovery returned 200 but no token_endpoint.",
        remediation: "Acumatica identity server may be misconfigured. Check the tenant's OAuth settings.",
      };
    } catch {
      return {
        name,
        status: "fail",
        detail: "Discovery returned 200 but body was not JSON.",
      };
    }
  }
  return {
    name,
    status: "fail",
    detail: `HTTP ${res.status} at ${discoveryUrl}.`,
    remediation: `OIDC discovery endpoint should return 200. Verify ACUMATICA_URL points at the instance root (not a tenant path).`,
  };
}

/**
 * Validate the Connected App client_id / client_secret without needing a
 * user. We POST a `client_credentials` grant — Acumatica's IdentityServer
 * distinguishes "client is valid, grant type disabled" (`unsupported_grant_type`)
 * from "client creds rejected" (`invalid_client`). Either of the former
 * means the ID + secret themselves are correct; the latter means they aren't.
 */
export async function checkClientCredentials(input: PreflightInput): Promise<PreflightCheck> {
  const name = "Acumatica Connected App credentials";
  if (!input.acumaticaUrl) {
    return { name, status: "skip", detail: "ACUMATICA_URL not set." };
  }
  if (!input.acumaticaClientId || !input.acumaticaClientSecret) {
    return { name, status: "skip", detail: "Client ID or secret not set." };
  }
  const tokenUrl = `${input.acumaticaUrl}/identity/connect/token`;
  const res = await safeFetch(tokenUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      client_id: input.acumaticaClientId,
      client_secret: input.acumaticaClientSecret,
      scope: "api",
    }),
  });
  if ("error" in res) {
    return { name, status: "fail", detail: `Network error: ${res.error}` };
  }
  // Parse only the `error` field — IdentityServer error responses can
  // include the full echoed form (with client_secret) in other fields.
  let errorCode: string | undefined;
  try {
    const body = (await res.json()) as { error?: string };
    errorCode = body.error;
  } catch {
    // No JSON body — treat as opaque
  }
  if (res.status === 200) {
    return { name, status: "pass", detail: "Connected App credentials accepted (client_credentials grant succeeded)." };
  }
  if (errorCode === "unsupported_grant_type" || errorCode === "unauthorized_client") {
    // These OAuth errors specifically mean "the client is recognized, but
    // this grant isn't enabled for it". Not what we'd prefer, but it
    // proves the client_id + client_secret themselves are correct.
    return {
      name,
      status: "pass",
      detail: `Connected App credentials accepted (grant '${errorCode}' — expected when client_credentials is not enabled).`,
    };
  }
  if (errorCode === "invalid_client" || res.status === 401) {
    return {
      name,
      status: "fail",
      detail: `Acumatica rejected the client ID + secret (${errorCode ?? `HTTP ${res.status}`}).`,
      remediation: "Verify ACUMATICA_CLIENT_ID and ACUMATICA_CLIENT_SECRET against the Connected Applications screen (SM303010). Note the client_id typically includes an '@tenant' suffix.",
    };
  }
  return {
    name,
    status: "warn",
    detail: `Unexpected response: HTTP ${res.status}${errorCode ? ` (${errorCode})` : ""}.`,
    remediation: "Could not definitively validate credentials. Try a real login flow to confirm.",
  };
}

/**
 * The OData GI endpoint is tenant-scoped: `/t/{tenant}/api/odata/gi/`.
 * Probes the bare gi/ service root (no `$metadata` — that endpoint can
 * serialize the full GI catalog and time out on real instances). Wrong
 * tenant returns 404; a live tenant returns 401 because we don't send a
 * bearer token.
 */
export async function checkTenantPath(
  url: string | undefined,
  tenant: string | undefined
): Promise<PreflightCheck> {
  const name = "Acumatica tenant (OData path)";
  if (!url || !tenant) {
    return { name, status: "skip", detail: "ACUMATICA_URL or ACUMATICA_TENANT not set." };
  }
  const probeUrl = `${url}/t/${encodeURIComponent(tenant)}/api/odata/gi/`;
  const res = await safeFetch(probeUrl);
  if ("error" in res) {
    return {
      name,
      status: "fail",
      detail: `Network error: ${res.error}`,
      remediation: `Could not reach ${probeUrl} within ${CHECK_TIMEOUT_MS}ms. If Acumatica itself is slow, the tenant is likely fine — re-run the preflight or try a real login to confirm.`,
    };
  }
  if (res.status === 401 || res.status === 403) {
    // NOT a pass. Acumatica SaaS authenticates before routing, so an
    // unauthenticated request returns 401 for EVERY path — verified live on
    // 25R2: /t/NotARealTenant/api/odata/gi/ also returns 401. A 401 therefore
    // says nothing about whether this tenant exists, and reporting it as a pass
    // meant a typo'd ACUMATICA_TENANT sailed through preflight.
    return {
      name,
      status: "warn",
      detail: `Reachable, but unverifiable without a token (HTTP ${res.status}). Acumatica returns 401 for every path when unauthenticated — including a tenant that does not exist — so this cannot confirm ACUMATICA_TENANT ("${tenant}").`,
      remediation: `Use the "Authenticated checks" form below to verify the tenant with a real user's token, or simply complete a login — the access gate queries this tenant, so a successful sign-in confirms it.`,
    };
  }
  if (res.status === 404) {
    return {
      name,
      status: "fail",
      detail: `Tenant path returned 404.`,
      remediation: `Verify ACUMATICA_TENANT ("${tenant}") matches the tenant/login company name exactly (case-sensitive).`,
    };
  }
  if (res.status === 200) {
    return { name, status: "pass", detail: `Tenant path returned 200.` };
  }
  return {
    name,
    status: "warn",
    detail: `Unexpected HTTP ${res.status} at ${probeUrl}.`,
  };
}

/**
 * Verdict for one authenticated check. These exist because the unauthenticated
 * checks cannot decide: Acumatica 401s every path, so a bogus tenant and a
 * bogus endpoint version both return 401 and were reported as `pass`. With a
 * real token a 404 finally means "does not exist".
 */
export interface AuthedVerdict {
  status: PreflightStatus;
  /** One-line verdict for the admin console. */
  headline: string;
  /** What it means, including the next step where relevant. */
  detail: string;
}

/** One row of the authenticated check set. */
export interface AuthedCheckResult extends AuthedVerdict {
  name: string;
}

/**
 * Verdict for the authenticated tenant check.
 *
 * With a bearer token the 401-before-routing problem goes away, so 404 finally
 * means what `checkTenantPath` always claimed it meant: the tenant path does
 * not exist. This is the check that actually catches a typo'd ACUMATICA_TENANT.
 */
export function interpretTenantAuthed(status: number, tenant: string): AuthedVerdict {
  if (status === 200) {
    return {
      status: "pass",
      headline: `Tenant "${tenant}" confirmed.`,
      detail: "The tenant-scoped OData path returned 200 with a real token, so ACUMATICA_TENANT is correct and OData is enabled on the tenant.",
    };
  }
  if (status === 404) {
    return {
      status: "fail",
      headline: `Tenant "${tenant}" does not exist.`,
      detail: `An authenticated request to the tenant's OData path returned 404. ACUMATICA_TENANT must match the tenant/login company name exactly — it is case-sensitive. This is the failure the unauthenticated check cannot see, because Acumatica 401s a bad tenant rather than 404ing it.`,
    };
  }
  if (status === 401) {
    return {
      status: "warn",
      headline: "Token rejected — tenant unverified.",
      detail: "The token was refused (401), most likely expired: access tokens live about an hour. Have the user make one tool call through Claude to refresh, then re-run.",
    };
  }
  if (status === 403) {
    return {
      status: "warn",
      headline: `Tenant "${tenant}" exists, but this user cannot read the OData root.`,
      detail: "403 means authenticated-but-forbidden, so the tenant is real. The user simply lacks rights on the OData service root; that does not indicate a configuration problem.",
    };
  }
  return {
    status: "warn",
    headline: `Unexpected HTTP ${status} verifying the tenant.`,
    detail: "Inconclusive. Re-run, or check the instance's health.",
  };
}

/** Verdict for the authenticated contract-API endpoint/version check. */
export function interpretEndpointAuthed(
  status: number,
  endpointName: string,
  version: string
): AuthedVerdict {
  const label = `${endpointName}/${version}`;
  if (status === 200) {
    return {
      status: "pass",
      headline: `Contract endpoint "${label}" confirmed.`,
      detail: "The endpoint returned 200 with a real token, so ACUMATICA_ENDPOINT_NAME and ACUMATICA_ENDPOINT_VERSION both match a published Web Service endpoint.",
    };
  }
  if (status === 404) {
    return {
      status: "fail",
      headline: `Contract endpoint "${label}" does not exist.`,
      detail: `An authenticated request returned 404. Check ACUMATICA_ENDPOINT_VERSION and ACUMATICA_ENDPOINT_NAME against the published endpoints in Acumatica (SM207060) — the stock endpoint is "Default" and the 25R2 version is "25.200.001". This is the failure the unauthenticated check cannot see, since Acumatica 401s a bogus version rather than 404ing it.`,
    };
  }
  if (status === 401) {
    return {
      status: "warn",
      headline: "Token rejected — endpoint unverified.",
      detail: "The token was refused (401), most likely expired. Refresh it with one tool call through Claude and re-run.",
    };
  }
  return {
    status: "warn",
    headline: `Unexpected HTTP ${status} verifying "${label}".`,
    detail: "Inconclusive — the endpoint may exist but responded unusually to a bare GET. A successful entity tool call is the definitive confirmation.",
  };
}

/**
 * Run the checks that need a real user's bearer token — the two an
 * unauthenticated probe cannot decide, because Acumatica 401s every path
 * whether or not it exists: the tenant, and the contract endpoint version.
 */
export async function runAuthenticatedChecks(
  url: string,
  tenant: string,
  endpointVersion: string | undefined,
  endpointName: string | undefined,
  accessToken: string
): Promise<AuthedCheckResult[]> {
  const auth = { Authorization: `Bearer ${accessToken}` };
  const epName = endpointName || "Default";
  const results: AuthedCheckResult[] = [];

  const tenantRes = await safeFetch(`${url}/t/${encodeURIComponent(tenant)}/api/odata/gi/`, { headers: auth });
  if ("error" in tenantRes) {
    results.push({
      name: "Tenant (authenticated)",
      status: "warn",
      headline: "Could not reach Acumatica.",
      detail: `Network error: ${tenantRes.error}`,
    });
  } else {
    tenantRes.body?.cancel();
    results.push({ name: "Tenant (authenticated)", ...interpretTenantAuthed(tenantRes.status, tenant) });
  }

  if (endpointVersion) {
    const epRes = await safeFetch(
      `${url}/entity/${encodeURIComponent(epName)}/${encodeURIComponent(endpointVersion)}`,
      { headers: auth }
    );
    if ("error" in epRes) {
      results.push({
        name: "Contract endpoint (authenticated)",
        status: "warn",
        headline: "Could not reach Acumatica.",
        detail: `Network error: ${epRes.error}`,
      });
    } else {
      epRes.body?.cancel();
      results.push({
        name: "Contract endpoint (authenticated)",
        ...interpretEndpointAuthed(epRes.status, epName, endpointVersion),
      });
    }
  }

  return results;
}

/**
 * Contract API versioning. `/entity/{name}/{version}` exists per version.
 * 401 = version path exists (auth required); 404 = wrong version or name.
 */
export async function checkEndpointVersion(
  url: string | undefined,
  version: string | undefined,
  endpointName?: string
): Promise<PreflightCheck> {
  const name = "Acumatica contract API endpoint version";
  if (!url || !version) {
    return { name, status: "skip", detail: "ACUMATICA_URL or ACUMATICA_ENDPOINT_VERSION not set." };
  }
  const epName = endpointName || "Default";
  const probeUrl = `${url}/entity/${encodeURIComponent(epName)}/${encodeURIComponent(version)}`;
  const res = await safeFetch(probeUrl);
  if ("error" in res) {
    return { name, status: "fail", detail: `Network error: ${res.error}` };
  }
  if (res.status === 200) {
    return { name, status: "pass", detail: `Endpoint "${epName}/${version}" exists (HTTP 200).` };
  }
  if (res.status === 401 || res.status === 403) {
    // Same trap as checkTenantPath: verified live on 25R2 that
    // /entity/Default/99.999.999 also returns 401 unauthenticated, so a 401
    // cannot distinguish a real version from a bogus one.
    return {
      name,
      status: "warn",
      detail: `Reachable, but unverifiable without a token (HTTP ${res.status}). Acumatica returns 401 for every path when unauthenticated — including a version that does not exist — so this cannot confirm "${epName}/${version}".`,
      remediation: `Use the "Authenticated checks" form below to verify with a real user's token. Any successful entity tool call also confirms it.`,
    };
  }
  if (res.status === 404) {
    return {
      name,
      status: "fail",
      detail: `Endpoint "${epName}/${version}" returned 404.`,
      remediation: `Verify ACUMATICA_ENDPOINT_VERSION ("${version}") and ACUMATICA_ENDPOINT_NAME ("${epName}") match a published Web Service endpoint in Acumatica (SM207060). The stock endpoint is "Default" and the default version for 25R2 is "25.200.001".`,
    };
  }
  return { name, status: "warn", detail: `Unexpected HTTP ${res.status}.` };
}

export function checkCallbackUrl(expectedCallbackUrl: string): PreflightCheck {
  return {
    name: "Connected App redirect URI",
    status: "skip",
    detail: "Cannot be verified server-side.",
    remediation: `In Acumatica Connected Applications (SM303010), the OAuth 2.0 redirect URI for this MCP server must include exactly:  ${expectedCallbackUrl}`,
  };
}

export async function runPreflight(input: PreflightInput): Promise<PreflightCheck[]> {
  const secrets = checkSecretsPresent(input);
  // Independent probes against the same host — run in parallel so a broken
  // instance doesn't multiply its timeout by the number of checks.
  const [reachable, oidc, creds, tenant, endpoint] = await Promise.all([
    checkReachable(input.acumaticaUrl),
    checkOidcDiscovery(input.acumaticaUrl),
    checkClientCredentials(input),
    checkTenantPath(input.acumaticaUrl, input.acumaticaTenant),
    checkEndpointVersion(input.acumaticaUrl, input.acumaticaEndpointVersion, input.acumaticaEndpointName),
  ]);
  return [
    ...secrets,
    reachable,
    oidc,
    creds,
    tenant,
    endpoint,
    // Reports something that cannot be verified server-side, so it makes no
    // request and is grouped after the real probes.
    checkCallbackUrl(input.expectedCallbackUrl),
  ];
}

/**
 * Map a token-exchange error from `/identity/connect/token` to human-readable
 * text. Used by `/callback` when the code-for-tokens swap fails, so the user
 * sees "your client_secret is wrong" instead of "HTTP 400".
 *
 * Only reads the `error` field of the OAuth error body — other fields (like
 * `error_description`) can, in some IdentityServer configurations, echo the
 * submitted form which includes the client_secret.
 */
export function interpretTokenError(
  status: number,
  errorCode: string | undefined
): { title: string; detail: string; remediation: string } {
  switch (errorCode) {
    case "invalid_client":
      return {
        title: "Connected App credentials rejected",
        detail: "Acumatica returned `invalid_client` during the token exchange.",
        remediation:
          "The ACUMATICA_CLIENT_ID or ACUMATICA_CLIENT_SECRET is wrong. In Acumatica, open Connected Applications (SM303010), find the MCP app, and verify both values match. The client_id usually ends with '@<tenant>'.",
      };
    case "invalid_grant":
      return {
        title: "Authorization code rejected",
        detail: "Acumatica returned `invalid_grant` during the token exchange.",
        remediation:
          "Most likely the redirect URI in the Connected App does not match the one this server sends. In Acumatica Connected Applications (SM303010), confirm the OAuth 2.0 redirect URI is exactly the /callback URL of this deployment.",
      };
    case "unauthorized_client":
      return {
        title: "Grant type not enabled for this client",
        detail: "Acumatica returned `unauthorized_client`.",
        remediation:
          "The Connected App in Acumatica must have the `authorization_code` flow enabled. Edit the app in SM303010 and enable it.",
      };
    case "invalid_request":
      return {
        title: "Malformed token request",
        detail: "Acumatica returned `invalid_request`.",
        remediation:
          "This usually means a server-side bug in MCP4Acumatica (missing or duplicate parameters). Check logs and open an issue.",
      };
    default:
      return {
        title: "Acumatica authentication failed",
        detail: `Token exchange returned HTTP ${status}${errorCode ? ` (${errorCode})` : ""}.`,
        remediation:
          "Run the preflight check at /docs/admin/preflight to diagnose. Common causes: wrong ACUMATICA_URL, IdentityServer disabled, or Connected App not published.",
      };
  }
}
