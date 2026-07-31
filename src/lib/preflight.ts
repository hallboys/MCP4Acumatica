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
    return { name, status: "pass", detail: `Tenant path exists (HTTP ${res.status} without auth — as expected).` };
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
 * Capability probe (NOT a requirement) for the DAC-based OData endpoint,
 * `/t/{tenant}/api/odata/dac/` — Acumatica 2025 R1+ exposes data access classes
 * directly over OData 4.0, no Generic Inquiry needed. This server does not use
 * it today (reads are contract REST; GI OData serves search + the login gate),
 * but it is the strongest candidate fix for the contract-API `$filter` failure
 * family (see docs/odata-filtering.md) — those failures come from the contract
 * API's filter binder, not from OData.
 *
 * WHY THIS DOESN'T PROBE. Acumatica SaaS applies authentication *before* routing:
 * an unauthenticated request returns 401 for every path under the instance,
 * including a nonexistent tenant, a bogus endpoint version, and outright
 * nonsense segments. Verified live against a 25R2 SaaS instance:
 *
 *   /t/{tenant}/api/odata/dac/       -> 401
 *   /t/{tenant}/api/odata/gi/        -> 401
 *   /t/{tenant}/api/odata/nonsense/  -> 401
 *   /t/NotARealTenant/api/odata/gi/  -> 401
 *   /entity/Default/99.999.999       -> 401
 *
 * So an anonymous 401 carries **no information** about whether this endpoint
 * exists, and a check that reported "401 = available" would be manufacturing a
 * green row out of noise. Determining availability requires a real bearer
 * token, and preflight has none: it deliberately runs without a user, and this
 * deployment's Connected App has `client_credentials` disabled (see
 * checkClientCredentials), so no service token exists either.
 *
 * This row is therefore an honest `skip` — same shape as checkCallbackUrl,
 * which also reports something that cannot be verified server-side. It carries
 * the authenticated command that answers both open questions at once:
 * does the endpoint exist, and does a normal user's role suffice (community
 * reports claim an elevated "OData v4 User" role is needed; the official docs
 * neither confirm nor deny, and if true it is unusable under this server's
 * per-user access model).
 */
export async function checkDacODataEndpoint(
  url: string | undefined,
  tenant: string | undefined
): Promise<PreflightCheck> {
  const name = "DAC-based OData endpoint (informational)";
  if (!url || !tenant) {
    return { name, status: "skip", detail: "ACUMATICA_URL or ACUMATICA_TENANT not set." };
  }
  const probeUrl = `${url}/t/${encodeURIComponent(tenant)}/api/odata/dac`;
  return {
    name,
    status: "skip",
    detail:
      "Not verifiable server-side. Acumatica returns 401 for every path when unauthenticated — including nonexistent ones — so an anonymous probe cannot tell whether this endpoint exists. Acumatica 2025 R1+ exposes DACs directly over OData 4.0 here; this server does not use it (reads are contract REST, search rides Generic Inquiries), so nothing depends on the answer today.",
    remediation:
      `To settle it, use the "DAC-based OData probe (authenticated)" form below — it borrows a connected user's stored token and reports a real verdict. Equivalent by hand:  curl -i -H "Authorization: Bearer <user-token>" "${probeUrl}/${DAC_PROBE_ENTITY}?$top=1"`,
  };
}

// ── Authenticated DAC-OData probe ────────────────────────────────
//
// The unauthenticated row above can't answer anything (Acumatica 401s every
// path). These two functions do the real check with a user's bearer token,
// driven from the admin console. Split so the interpretation is pure and
// unit-testable while the I/O stays trivial.

/** Entity used for the read test — the class name is confirmed by Acumatica's own docs. */
export const DAC_PROBE_ENTITY = "PX.Objects.SO.SOOrder";

export interface DacProbeResult {
  status: PreflightStatus;
  /** One-line verdict for the admin console. */
  headline: string;
  /** What it means for this server, including the next step where relevant. */
  detail: string;
}

/**
 * Turn the two probe responses into a verdict.
 *
 * Two requests rather than one, because a single entity GET can't distinguish
 * "the DAC endpoint doesn't exist" from "the endpoint exists but I guessed the
 * entity name wrong" — both are 404. So we check the service root first
 * (existence + reachability), and only then read an entity (does data actually
 * come back for this user).
 *
 * `entityStatus` is null when the root check already settled the question.
 */
export function interpretDacProbe(
  rootStatus: number,
  entityStatus: number | null
): DacProbeResult {
  if (rootStatus === 404) {
    return {
      status: "skip",
      headline: "Not available on this instance.",
      detail:
        "The DAC-based OData endpoint returned 404 with a valid token, so it is not present — the instance predates Acumatica 2025 R1 or has the endpoint disabled. Nothing is broken; this server does not use it. Search reads continue to require a Generic Inquiry.",
    };
  }
  if (rootStatus === 403) {
    return {
      status: "warn",
      headline: "Exists, but this user's role is not permitted.",
      detail:
        "The endpoint responded 403 to an authenticated request, which confirms the reported requirement for an elevated role (\"OData v4 User\"). That makes it unusable here: this server's access model is each user's own Acumatica role, and granting every AI user an elevated role would defeat it. Keep search on Generic Inquiries.",
    };
  }
  if (rootStatus === 401) {
    return {
      status: "warn",
      headline: "Token rejected — inconclusive.",
      detail:
        "The token was refused (401). Most likely it had expired: access tokens live about an hour. Have the user make one tool call through Claude to force a refresh, then re-run this probe. A persistent 401 with a fresh token would suggest the endpoint does not accept OAuth bearer tokens the way the GI endpoint does.",
    };
  }
  if (rootStatus !== 200) {
    return {
      status: "warn",
      headline: `Unexpected HTTP ${rootStatus} from the service root.`,
      detail: "Could not determine availability. Re-run, or check the instance's health.",
    };
  }

  // Root is reachable — the endpoint exists and this user can talk to it.
  if (entityStatus === 200) {
    return {
      status: "pass",
      headline: "Available, and a normal user role suffices.",
      detail:
        `Both the service root and a read of ${DAC_PROBE_ENTITY} succeeded with an ordinary user's token. The DAC endpoint is a viable read surface on this instance, which makes it a real candidate for fixing the contract-API $filter limitations (child-collection filters, the silent-[] family). Before using it: re-validate src/lib/redact.ts field-name patterns against physical DAC field names, since redaction matches on names and DAC names differ from contract-entity names.`,
    };
  }
  if (entityStatus === 403) {
    return {
      status: "warn",
      headline: "Endpoint reachable, but this DAC is not readable.",
      detail:
        `The service root succeeded while ${DAC_PROBE_ENTITY} returned 403. Per-DAC access rights are being enforced — which is the desired behavior, but it means usability depends on what each user's role grants. Try another entity the user can read in the UI before drawing conclusions.`,
    };
  }
  if (entityStatus === 404) {
    return {
      status: "warn",
      headline: "Endpoint exists, but the entity name form differs.",
      detail:
        `The service root succeeded while ${DAC_PROBE_ENTITY} returned 404, so entity naming on this instance isn't the class name we assumed. Fetch the service document or $metadata with the same token to see the real entity-set names. The endpoint itself is available.`,
    };
  }
  return {
    status: "warn",
    headline: `Endpoint reachable; entity read returned HTTP ${entityStatus}.`,
    detail: `The service root succeeded, so the endpoint exists, but reading ${DAC_PROBE_ENTITY} gave an unexpected status. Inconclusive on usability.`,
  };
}

/**
 * Run the authenticated DAC probe with a real user's bearer token.
 *
 * Deliberately does NOT read either response body: the DAC service document
 * enumerates every data access class on the instance and can be megabytes.
 * Only the status codes matter, so bodies are cancelled.
 */
export async function probeDacAuthenticated(
  url: string,
  tenant: string,
  accessToken: string
): Promise<DacProbeResult> {
  const base = `${url}/t/${encodeURIComponent(tenant)}/api/odata/dac`;
  const auth = { Authorization: `Bearer ${accessToken}` };

  const root = await safeFetch(`${base}/`, { headers: auth });
  if ("error" in root) {
    return {
      status: "warn",
      headline: "Probe failed to reach Acumatica.",
      detail: `Network error contacting the service root: ${root.error}`,
    };
  }
  root.body?.cancel();

  if (root.status !== 200) {
    return interpretDacProbe(root.status, null);
  }

  const entity = await safeFetch(`${base}/${DAC_PROBE_ENTITY}?$top=1`, { headers: auth });
  if ("error" in entity) {
    return {
      status: "warn",
      headline: "Service root reachable; entity read failed.",
      detail: `Network error reading ${DAC_PROBE_ENTITY}: ${entity.error}`,
    };
  }
  entity.body?.cancel();

  return interpretDacProbe(root.status, entity.status);
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
  if (res.status === 401 || res.status === 403 || res.status === 200) {
    return { name, status: "pass", detail: `Endpoint "${epName}/${version}" exists (HTTP ${res.status}).` };
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
    // Trailing rows report things that cannot be verified server-side, so they
    // make no request and are grouped after the real probes.
    checkCallbackUrl(input.expectedCallbackUrl),
    await checkDacODataEndpoint(input.acumaticaUrl, input.acumaticaTenant),
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
