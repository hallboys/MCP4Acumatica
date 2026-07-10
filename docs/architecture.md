# MCP4Acumatica -- Architecture

Detailed architecture documentation for the MCP4Acumatica.

## Overview

The MCP4Acumatica is a remote [Model Context Protocol](https://modelcontextprotocol.io) (MCP) server that runs on [Cloudflare Workers](https://workers.cloudflare.com). It connects AI assistants (Claude, or any MCP-compatible client) to an [Acumatica ERP](https://www.acumatica.com) 2025 R2 instance via the contract-based REST API.

```
┌─────────────────────┐
│  Claude / MCP Client│
│  (claude.ai, CLI,   │
│   Desktop, API)     │
└─────────┬───────────┘
          │ MCP over streamable-http
          │ (Bearer token auth)
          ▼
┌───────────────────────────────────────────────────────────┐
│  Cloudflare Worker                                          │
│                                                             │
│  ┌────────────────────────────────┐                        │
│  │  OAuthProvider                 │  OAuth 2.1 AS for the   │
│  │  (@cloudflare/workers-oauth-   │  MCP client.            │
│  │   provider)                    │  /authorize /callback   │
│  │  CIMD (preferred) + DCR        │  /token /register       │
│  └────────────────────────────────┘                        │
│                                                             │
│  ┌────────────────────────────────┐  ┌──────────────────┐  │
│  │  Hono App (defaultHandler)     │  │  Docs / Admin     │  │
│  │  AcumaticaAuthHandler          │  │  /docs            │  │
│  │  /authorize → Acumatica login  │  │  /docs/admin      │  │
│  │  /callback  → token exchange   │  │  (log viewer,     │  │
│  │              + access gate     │  │   settings,       │  │
│  │  /consent   → AI data consent  │  │   preflight)      │  │
│  │  /health  /  (landing)         │  └──────────────────┘  │
│  └────────────────────────────────┘                        │
│                                                             │
│  ┌────────────────────────────────┐                        │
│  │  McpAgent Durable Object       │  apiHandler.           │
│  │  AcumaticaMcpServer            │  One instance          │
│  │  (binding MCP_OBJECT)          │  per MCP session.      │
│  │  /mcp  /sse                    │  48 tools reg'd in     │
│  │                                │  init(); alarm-based   │
│  │                                │  log buffer → R2.      │
│  └───┬───────────────────────┬────┘                        │
│      │ token get/refresh      │                            │
│      ▼                        │                            │
│  ┌────────────────────────┐   │                            │
│  │  TokenManager DO       │   │  One instance per USER     │
│  │  (binding TOKEN_MANAGER)│  │  (idFromName(username)).   │
│  │  serializes per-user   │   │  Authoritative token copy; │
│  │  refresh-token rotation│   │  KV = write-through backup.│
│  └───────────┬────────────┘   │                            │
│              │                 │                           │
│  ┌───────────┴─────────────────┴──────────────┐            │
│  │  KV (TOKEN_STORE / OAUTH_KV — one namespace)│            │
│  │  user tokens · OAuth state · cache · config │            │
│  ├─────────────────────────────────────────────┤           │
│  │  R2                                         │            │
│  │  mcp4acumatica_logs  (audit logs / Logpush) │            │
│  │  INDEX_STORE         (schema-knowledge idx) │            │
│  └─────────────────────────────────────────────┘           │
└───────────────┬─────────────────────────┬───────────────────┘
                │ Contract REST            │ OData
                │ (Bearer token)           │ (access gate +
                ▼                          ▼  GI tools)
┌─────────────────────────────────────────────────────────────┐
│  Acumatica 25R2 SaaS Instance                                │
│  Contract-Based REST API   /entity/{endpoint}/{version}/...  │
│    (endpoint defaults to Default; version = 25.200.001)      │
│  OData GI endpoint         /t/{tenant}/api/odata/gi/...       │
│                                                              │
│  Per-user access based on the user's Acumatica role          │
└──────────────────────────────────────────────────────────────┘
```

## Components

### 1. OAuthProvider

The `@cloudflare/workers-oauth-provider` package wraps the entire Cloudflare Worker. It acts as an **OAuth 2.1 Authorization Server** for MCP clients (Claude), providing:

- **Dynamic Client Registration (DCR)** at `/register` -- MCP clients register automatically
- **Token issuance** at `/token` -- issues Bearer tokens for MCP sessions
- **Authorization** at `/authorize` -- redirects to the Acumatica login

This layer is transparent to the MCP tools. By the time a request reaches the McpAgent, it already has a valid, authenticated session.

### 2. AcumaticaAuthHandler (Hono App)

A [Hono](https://hono.dev) application that handles the Acumatica OAuth 2.0 authorization code flow:

1. **`/authorize`** -- Builds the Acumatica OAuth authorization URL with `scope=api openid profile email offline_access` and redirects the user to Acumatica's login page
2. **`/callback`** -- Receives the authorization code from Acumatica, exchanges it for access + refresh tokens, identifies the user via OIDC userinfo, performs the **access gate check** (see below), and redirects to the consent page
3. **`/consent`** (GET) -- Displays the **consent interstitial** page explaining AI data processing, audit logging, and field redaction
4. **`/consent`** (POST) -- User acknowledges the consent; tokens are stored in KV and the MCP OAuth flow completes
5. **`/health`** -- Returns server status
6. **`/`** -- Landing page

### 3. McpAgent Durable Object (AcumaticaMcpServer)

A [Durable Object](https://developers.cloudflare.com/durable-objects/) that extends `McpAgent` from the `agents` SDK. Each MCP session gets its own DO instance with:

- **`init()`** -- Registers all 48 tools with the MCP server
- **`callTool()`** -- Wrapper that catches errors and returns MCP-formatted responses
- **`this.props.acumaticaUsername`** -- The authenticated user's Acumatica username, set during the OAuth callback

The DO binding must be named `MCP_OBJECT` (required by the `agents` SDK's `McpAgent.serve()`).

A second Durable Object, **`TokenManager`** (binding `TOKEN_MANAGER`), owns each user's Acumatica token. It is keyed by `idFromName(username)`, so there is exactly one instance per user globally and all of a user's concurrent sessions share it. This serializes token refresh: IdentityServer rotates the refresh token on every use, and without a single owner two sessions could POST the same refresh token concurrently — one wins, the other gets a `4xx` and is wrongly treated as dead. Routing all refreshes through the per-user DO makes that race impossible. The DO's storage is the authoritative token copy; KV is a write-through backup.

### 4. AcumaticaClient

HTTP client for the Acumatica contract-based REST API. Features:

- **Per-user tokens** -- Fetches the user's token from the platform store (`AppEnv.store`) on each request
- **Automatic retry on 401** -- If a token expires mid-request, fetches a fresh token and retries once
- **Rate limiting** -- Enforced via `withRateLimit()` wrapper (3 concurrent, 40/min)
- **Audit logging** -- Every API call is logged with tool name, endpoint, status code, and duration
- **Friendly error messages** -- HTTP errors are translated to human-readable messages

### 5. KV Namespaces

> **Note:** Tool handlers and shared libraries access storage through the `IKeyValueStore` abstraction (`AppEnv.store`), not raw `KVNamespace`. On Cloudflare, this is backed by KV via `CloudflareKVStore`. The raw KV bindings below are used directly only by the auth handler and admin handler (which are Cloudflare-specific infrastructure).

Both bindings point to the same physical KV namespace (one namespace, two bindings).

| Binding | Purpose | Key Pattern | TTL |
|---------|---------|-------------|-----|
| `TOKEN_STORE` | Per-user Acumatica OAuth tokens | `user_token:{username}` | None (refreshed on expiry) |
| `TOKEN_STORE` | Temporary OAuth state during login flow | `acumatica_state:{state}` | 10 minutes |
| `TOKEN_STORE` | Pending consent data during login flow | `consent:{id}` | 5 minutes |
| `TOKEN_STORE` | Cached metadata (entity schemas, GI lists) | `cache:{key}` | 1–24 hours |
| `OAUTH_KV` | Used internally by `@cloudflare/workers-oauth-provider` for client registrations and authorization codes | Managed by library | Managed by library |

---

## OAuth Flow

```
MCP Client (Claude)                Worker                      Acumatica
       │                             │                             │
       │  1. Connect to /mcp         │                             │
       │──────────────────────────>  │                             │
       │                             │                             │
       │  2. 401 Unauthorized        │                             │
       │  <──────────────────────────│                             │
       │                             │                             │
       │  3. POST /register (DCR)    │                             │
       │──────────────────────────>  │                             │
       │  <── client_id, secret  ────│                             │
       │                             │                             │
       │  4. GET /authorize          │                             │
       │──────────────────────────>  │                             │
       │                             │  5. Redirect to Acumatica   │
       │  <──────── 302 ────────────────────────────────────────>  │
       │                             │                             │
       │                             │        User logs in         │
       │                             │                             │
       │                             │  6. Redirect to /callback   │
       │  <──────── 302 ──────────────────────────────────────── │
       │                             │                             │
       │                             │  7. Exchange code for token │
       │                             │──────────────────────────>  │
       │                             │  <── access + refresh token │
       │                             │                             │
       │                             │  8. OIDC userinfo lookup    │
       │                             │──────────────────────────>  │
       │                             │  <── username, display name │
       │                             │                             │
       │                             │  9. Access gate: query      │
       │                             │     MCPAccess canary GI     │
       │                             │──────────────────────────>  │
       │                             │  <── 200 (can read) or      │
       │                             │      403 (denied)           │
       │                             │                             │
       │                             │  10. If denied → 403 page   │
       │                             │  11. If allowed → /consent  │
       │  <── Consent interstitial ──│                             │
       │                             │                             │
       │     User acknowledges       │                             │
       │──────────────────────────>  │                             │
       │                             │  12. Store token in KV      │
       │                             │  13. Complete OAuth flow    │
       │  <── MCP session active ────│                             │
       │                             │                             │
       │  14. Tool calls via /mcp    │                             │
       │──────────────────────────>  │  15. API call with token    │
       │                             │──────────────────────────>  │
       │                             │  <── JSON response ─────── │
       │  <── MCP tool result ───────│                             │
```

### Key Points

- **Single login.** Users authenticate once with Acumatica (or their configured SSO).
- **No stored passwords.** Only OAuth tokens are stored.
- **Token refresh.** When an access token expires, the server uses the refresh token to get a new one automatically. If the refresh token itself is dead (expired/rotated/revoked), the server revokes the MCP grant so the client transparently re-authenticates rather than failing permanently.
- **API-user seats.** Each active user consumes one Acumatica API-user seat (via the plain `api` scope), auto-released ~1 hour after their last token issuance. See [Acumatica Session & License Model](#acumatica-session--license-model) for how this interacts with the instance's license limits.
- **Acumatica is the sole identity provider.** No separate identity layer.
- **Access gate before access.** After login, a canary GI check verifies the user may use MCP (see Access Control below).
- **Consent required.** Users must acknowledge an AI data processing consent page before the MCP session activates.

---

## Security Model

### Authentication

1. **MCP clients** authenticate via OAuth 2.1 (DCR + authorization code flow)
2. **The Worker** authenticates with Acumatica via per-user OAuth tokens
3. **Users** log in with their Acumatica credentials (or SSO configured on the Acumatica instance)

### Authorization & Access Control

Acumatica's role-based access control governs what data each user can access -- if a user can't see a record in Acumatica's UI, they can't access it through the MCP server. On top of that, the MCP server adds its own access control layer:

#### Access Gate (Canary GI)

Before a user can access the MCP server, the `/callback` handler runs an **access gate**. It never inspects Acumatica role membership — it uses a **canary Generic Inquiry (GI)** approach, asking only "can this user's token read one designated GI?":

1. A trivial GI named `MCPAccess` is created in Acumatica (SM208000). Its content is irrelevant -- it can be any single column.
2. Read access to the `MCPAccess` GI is restricted to the users who should have AI access. Assigning it only to a marker `MCP Access` role is the recommended way, but any mechanism that controls OData read access to the GI works.
3. The GI is enabled for **OData** exposure.
4. During login, the server queries the GI via OData: `GET /t/{tenant}/api/odata/gi/MCPAccess?$top=1`
5. If the response is **200**, the user can read the GI and may proceed.
6. If the response is **403**, the user has no access and sees an access denied page directing them to contact their Acumatica administrator.

This approach avoids exposing user/role membership data -- the GI content itself is never used, and the server issues no query against the User/Role tables (which are not available over the API on SaaS instances anyway). Because the check is purely GI-readability, you are free to gate the GI with whatever access-control mechanism your security team already uses.

The canary GI name defaults to `MCPAccess` and is configurable via the `ACUMATICA_CANARY_GI` environment variable.

If the canary GI query returns 404 or a 5xx error (rather than 200 or 403), the server treats it as a **misconfiguration** -- not a permission denial. The user sees a "Configuration Error" page pointing at the likely cause (missing GI, wrong tenant, unreachable instance, OData not enabled on the GI). The event is logged as `login_denied` with `reason: access_check_misconfigured` so an admin sees why. Previously all non-200 responses looked identical to "user has no access", which hid real outages behind an access-denied screen.

**Acumatica setup required:**
- **Generic Inquiry:** Create `MCPAccess` in Acumatica (SM208000) with any trivial query. Enable **Expose via OData**.
- **Restrict who can read it (recommended: a marker role):** Create `MCP Access` in Acumatica (SM201005) with no screen permissions, assign the `MCPAccess` GI only to that role, and assign the role to each user who should have AI assistant access.

#### Consent Interstitial

Users who pass the access gate are shown a consent page before the MCP session activates. The page explains that:

- Acumatica data will be sent to an external AI model for processing
- All data access is logged for audit purposes
- Sensitive fields are automatically redacted
- AI responses should be verified directly in Acumatica

The user must click "I Understand -- Continue" to proceed. Consent acknowledgment is logged as an audit event.

### Data Protection

- **Read-only** -- All 38 entity tools are read-only `GET` requests. No data is created, modified, or deleted.
- **Per-user isolation** -- Each user's token is stored separately. Users cannot access other users' tokens.
- **No credential storage** -- The server never stores passwords. Only OAuth tokens (access + refresh) are stored in KV.
- **Token encryption** -- OAuth state is encrypted with `COOKIE_ENCRYPTION_KEY`
- **Sensitive field redaction** -- Tool responses are automatically scanned for sensitive field names before data is returned to the AI model. See Sensitive Field Redaction below.

### Sensitive Field Redaction

The `redactFields()` utility (`src/lib/redact.ts`) recursively walks every Acumatica API response and replaces values of fields whose names match sensitive patterns with `[REDACTED]`.

**Built-in patterns** (case-insensitive, matched as substrings of field names):
`SSN`, `SocialSecurity`, `TaxRegistrationID`, `TaxID`, `BankAccount`, `RoutingNumber`, `IBAN`, `SWIFT`, `CreditCard`, `CardNumber`, `Password`, `Secret`, `Salary`, `PayRate`, `HourlyRate`, `AnnualRate`, `BirthDate`, `DateOfBirth`, `DOB`

**Configuration:**
- `REDACT_PATTERNS` (env var) -- comma-separated additional field name patterns to redact (e.g., `CustomSSN,EmployeeNotes`)
- `REDACT_SKIP` (env var) -- comma-separated field name patterns to whitelist from redaction (e.g., `BirthDate`)

When fields are redacted, a structured log entry is emitted with the tool name, username, and list of redacted field paths.

### OData `$filter` Pass-Through

The list/query tools (`acumatica_list_entities`, `acumatica_run_inquiry`) accept a `filterExpression` parameter that is passed to Acumatica **verbatim** as `$filter=...`. The server does not parse, rewrite, or sanitize the expression. This is intentional and safe because:

1. **Record access is governed by the per-user Acumatica role**, not by this server. Whatever a filter can find, the user could already find via the same API or the Acumatica UI.
2. **Entity exposure is denylisted** (`src/tools/entity-list.ts`). The generic lister refuses a fixed set of auth/credential entities (`User`, `UserRole`, etc.) regardless of filter.
3. **Nested `$expand` paths are rejected**. A caller cannot traverse more than one navigation-property level, so sensitive sub-records are not reachable via a cleverly chained filter.
4. **Sensitive fields are redacted on the way out** (see previous section), so even a successful filter cannot return SSNs, bank accounts, salary, etc.

One consequence operators should be aware of: a filter can be used as a blind-enumeration oracle for data the user is already permitted to read (e.g. `substringof('needle', SomeField)` to probe values). This is within the user's role and is logged via `tool_invocation` with the filter expression captured for audit. If that exposure is unacceptable for a particular deployment, disable the lister and use only the per-entity `acumatica_get_*` tools.

### Audit Logging

All tool invocations and security events are logged as structured JSON via `console.log` (viewable with `npx wrangler tail`). Three log types are emitted:

| Log Type | Events | Key Fields |
|----------|--------|------------|
| `tool_invocation` | Every MCP tool call | tool, username, endpoint, status, duration |
| `auth_event` | `login_success`, `login_denied`, `consent_accepted` | eventType, username, reason (if denied) |
| `field_redaction` | When sensitive fields are redacted from a response | tool, username, redactedFields, redactedCount |

### Rate Limiting

Multiple safeguards protect the Acumatica instance:

| Limit | Value | Scope |
|-------|-------|-------|
| Concurrent requests | 3 | Per user |
| Requests per minute | 40 | Per user |
| Max records per query (`$top`) | 1000 (configurable) | Per request |

When a rate limit is exceeded, the tool returns a friendly error message asking the user to wait.

### Pagination Refusal Semantics

The list/query tools (`acumatica_list_entities`, `acumatica_run_inquiry`, `acumatica_list_generic_inquiries`) do not support pagination. When a response hits the `ACUMATICA_MAX_RECORDS` cap, the tool returns a structured envelope instead of a bare array:

```json
{
  "results": [...],
  "truncated": true,
  "recordsReturned": 1000,
  "recordLimit": 1000,
  "paginationSupported": false,
  "actionRequired": "Results were truncated at 1000 records and this tool does NOT support pagination. Do NOT call this tool again... Instead, stop and ask the user to narrow their request by providing a more specific filterExpression..."
}
```

This turns the "don't paginate" rule into a semantic contract the model can read and act on — it is instructed to surface a clarifying request to the user rather than issue more tool calls. No server-side cooldown is enforced; the contract is the mechanism.

### Admin Console

A web-based admin interface at `/docs/admin` for managing the MCP server without the wrangler CLI.

- **Authentication:** `ADMIN_SECRET` env var (set via `wrangler secret put`). HMAC-signed session cookie (24h expiry), signed with `COOKIE_ENCRYPTION_KEY`. No KV session storage needed.
- **Settings page** (`/docs/admin/settings`): View and edit runtime config (redaction patterns, max records). Values stored in KV with `config:` prefix. KV overrides take precedence over env vars. Changes take effect when the next DO instance starts.
- **Log viewer** (`/docs/admin/logs`): Browse logs from R2 (Logpush). Filter by date range, log type, username, and tool name. Expandable rows show full JSON payload.

### Long-Term Log Retention (R2 + Logpush)

Cloudflare Logpush captures Workers Trace Events and writes NDJSON files to an R2 bucket for permanent retention.

- **Setup:** `logpush: true` in `wrangler.jsonc` + Logpush job configured in Cloudflare dashboard
- **R2 bucket:** `mcp4acumatica-logs` (binding: `mcp4acumatica_logs`)
- **Format:** Gzipped NDJSON. Our structured `console.log()` output is nested inside Logpush's `Logs[].Message[]` array.
- **Querying:** The admin log viewer lists R2 objects by upload date, reads and decompresses them, extracts our structured log entries, and applies filters.

### Runtime Config (KV-Backed)

Settings can be changed without redeploying via the admin console or direct KV writes.

- Config keys stored in KV with `config:` prefix (e.g., `config:acumatica_max_records`)
- `getConfig(store, key, envFallback)` reads KV first, falls back to env var
- The DO reads config in `init()` and stores resolved values as instance properties
- Changes take effect when the DO instance recycles (idle eviction, typically within minutes)

---

## Acumatica Session & License Model

Acumatica's license enforces **two independent limits** on API usage. Both are shared across *every* API integration on the instance (eCommerce connectors, Velixo, StarShip, Celigo, etc.) — the MCP server is one more consumer of the same pool, not an isolated one.

| Limit | What it caps | Exceeded → |
|-------|--------------|-----------|
| **Max Web Services API Users** | Concurrent server-side *sessions* (logins) | New sign-in rejected — HTTP 429 |
| **Concurrent Web Services API Requests** + requests/minute | In-flight request *throughput* | Requests queued, then delayed; declined only if the queue exceeds 20 or a request waits > 10 min |

The actual numbers are license-tier-based — check the instance's **License Monitoring Console** and the *Number of Web Services API Users* / *Number of Concurrent Web Services API Requests* boxes on the license screen.

### The `api` scope is load-bearing

`/authorize` requests the plain **`api`** scope (`src/auth/acumatica-auth-handler.ts`), **not** `api:concurrent_access`. This is a hard requirement, not an incidental choice:

- **Under `api`:** Acumatica treats each access token as a **single** server-side session and **closes it automatically when the access token expires** (~1 hour). Explicit sign-out is not required.
- **Under `api:concurrent_access`:** every request that doesn't replay the `ASP.NET_SessionId` cookie is counted as a *new* session, so a stateless client exhausts the API-user seats in seconds unless it maintains a cookie jar and calls `/entity/auth/logout` for each one.

`AcumaticaClient.doFetch()` (`src/lib/acumatica-client.ts`) is deliberately stateless — it sends only the `Authorization: Bearer` header, never captures or replays the session cookie, and never calls logout. That is safe **only** because of the `api` scope. Switching the scope without also rewriting the client to manage cookies + logout would be a license bomb.

### When a seat is released

A seat is bound to the access token and freed when that token expires — **default 1 hour** (`expires_in: 3600`). The server relies on this auto-close rather than proactive logout: it can't cheaply log out a session whose cookie it never captured, and an interactive MCP session has no natural "done" boundary — per-call logout would churn sessions for no benefit.

Consequences:

- **Concurrent seats consumed ≈ distinct users active within any rolling ~1-hour window** — *not* per request, and *not* all-time enrolled users. An idle user's seat is reclaimed within ~1 hour of their last token issuance.
- **Token refresh** (the access token rotates roughly hourly, serialized per user by the `TokenManager` DO) issues a *new* access token and therefore a new session; the prior token's session auto-closes at its own expiry, so a user may briefly hold two seats around the refresh boundary.
- A separate **UI idle-session timeout** (default 60 min; configurable on the Security Preferences form in 2023 R1+, via `web.config` or a SaaS support ticket otherwise) also exists, but for `api`-scope OAuth the **access-token lifetime is the governing clock**.

### Throughput vs. the per-user rate limiter

The per-user rate limiter (see **Rate Limiting** above) caps **3 concurrent / 40-per-minute per user** — it is *not* aware of the instance-wide ceiling. Several simultaneously-active users aggregate past a small-tier throttle (e.g. 6 concurrent / 50-per-minute); Acumatica then queues and delays (rarely declines), which surfaces to the model as the `429` "rate limit exceeded" friendly error. If `429`s show up in `do-logs`, the gap to close is an instance-wide shared counter (mirroring the existing per-minute KV bucket) so the server backs off *before* Acumatica starts queuing — deferred until the logs show it's needed, since coordinating it across isolates adds complexity.

---

## Tool Architecture

### Tool Registration

All 48 tools are registered in the `init()` method of `AcumaticaMcpServer`. Each tool has:

1. **Name** -- e.g., `acumatica_get_customer`
2. **Description** -- Human-readable description for the MCP client
3. **Zod schema** -- Parameter validation (MUST use simple types only)
4. **Handler** -- Async function that calls the Acumatica API

### Tool Execution Flow

```
MCP Client sends tool call
       │
       ▼
AcumaticaMcpServer.init() registered handler
       │
       ▼
callTool() wrapper
       │
       ├── Error handling + field redaction
       │
       ▼
Tool handler (e.g., handleGetCustomer)
       │
       ▼
AcumaticaClient.get()
       │
       ├── withRateLimit() check
       ├── getAcumaticaTokenForUser() from store
       ├── fetch() to Acumatica API
       ├── Retry on 401
       ├── logToolInvocation() audit log
       └── Return JSON
       │
       ▼
unwrapFields() strips {value: X} wrappers
       │
       ▼
MCP response: { content: [{ type: "text", text: JSON }] }
```

### Tool Categories

| Category | Count | Description |
|----------|-------|-------------|
| Utility/Discovery | 6 | Schema discovery, entity listing, generic inquiries, GI discovery, cache management |
| Read-Only Lookups | 38 | Single-record lookups by key across 10 modules |

### Zod Schema Constraint

MCP tool parameter schemas **must** use only simple Zod types:

- `z.string()` -- required string
- `z.string().optional()` -- optional string
- `z.string().default("value")` -- string with default

Complex types (`z.record()`, `z.unknown()`, `z.number()`) cause MCP SDK JSON Schema serialization failures and tools won't appear in client discovery. For numeric parameters, use `z.string()` with `parseInt()` in the handler.

---

## File Structure

```
src/
├── index.ts                       # Entry point: OAuthProvider + McpAgent DO; re-exports TokenManager
├── token-manager.ts               # TokenManager DO — per-user token-refresh serializer
├── admin/
│   └── admin-handler.ts           # Admin console: auth, settings, log viewer, preflight
├── auth/
│   ├── acumatica-auth-handler.ts  # Hono app: OAuth flow, access gate, health, landing
│   └── acumatica-oauth.ts         # Token getter shim (→ AppEnv.tokenProvider) + refresh helper
├── docs/
│   └── docs-handler.ts            # Hono sub-app: renders markdown docs, mounts admin
├── lib/
│   ├── acumatica-client.ts        # HTTP client, unwrapFields()
│   ├── odata-filter.ts            # normalizeODataFilter()
│   ├── gi-registry.ts             # GI gate + curated-schema assembly (pure leaf)
│   ├── gi-registry-build.ts       # getGiRegistry() — lazy registry build + KV cache
│   ├── gi-rows.ts                 # cleanGiRow/cleanGiRows
│   ├── complex-entities.ts        # complex-entity list + getFilterErrorKind()
│   ├── config.ts                  # KV-backed runtime config (via IKeyValueStore)
│   ├── kv-store.ts                # IKeyValueStore interface
│   ├── token-provider.ts          # ITokenProvider interface + TokenResult
│   ├── metadata-cache.ts          # KV-backed cache (via IKeyValueStore)
│   ├── blob-store.ts / index-store.ts / schema-search.ts  # schema-knowledge index access
│   ├── rate-limiter.ts            # Concurrent + per-minute rate limits
│   ├── preflight.ts               # Config diagnostics (admin page + /callback mapping)
│   ├── logger.ts                  # Structured JSON audit logging
│   └── redact.ts                  # Pattern-based sensitive-field redaction
├── platform/
│   ├── cloudflare-kv-store.ts     # CF adapter for IKeyValueStore
│   ├── cloudflare-r2-blob-store.ts # CF adapter for IBlobStore (index bucket)
│   └── do-token-provider.ts       # DOTokenProvider — ITokenProvider over TokenManager
├── tools/                         # Registry-driven getters + utility + schema-knowledge handlers
│   ├── getter-registry.ts         # 38 per-entity acumatica_get_* tools as data + runGetter
│   ├── getter-errors.ts           # endpointAware404Message()
│   ├── entity-list.ts             # acumatica_list_entities
│   ├── entity-schema.ts           # acumatica_describe_entity
│   ├── generic-inquiries.ts       # acumatica_run_inquiry
│   ├── generic-inquiry-discovery.ts # acumatica_list_generic_inquiries, _describe_inquiry
│   ├── clear-cache.ts             # acumatica_clear_cache
│   ├── schema-discovery.ts        # acumatica_search_schema, _get_schema_entity, _list_schema_entities
│   └── gi-explain.ts              # acumatica_explain_gi_xml
└── types/
    └── acumatica.ts               # TypeScript types, AppEnv, Env, AuthProps
docs/                              # Markdown docs served at /docs (tool-reference, example-prompts,
                                   # odata-filtering, generic-inquiries, schema-discovery,
                                   # self-hosting-guide, upgrading-acumatica, architecture — this file)
```

---

## Deployment

### Infrastructure

| Component | Service |
|-----------|---------|
| Compute | Cloudflare Workers |
| State | Durable Objects — `MCP_OBJECT` (per session) + `TOKEN_MANAGER` (per user) |
| Storage | Cloudflare KV (tokens, OAuth state, cache, config) + R2 (audit logs, schema index) |
| DNS/TLS | Cloudflare (automatic) |

### Configuration

| Type | Location | Example |
|------|----------|---------|
| Environment variables | `wrangler.jsonc` `vars` | `ACUMATICA_URL`, `ACUMATICA_ENDPOINT_VERSION` |
| Secrets | `wrangler secret put` | `ACUMATICA_CLIENT_ID`, `ACUMATICA_CLIENT_SECRET`, `COOKIE_ENCRYPTION_KEY` |
| KV bindings | `wrangler.jsonc` `kv_namespaces` | `TOKEN_STORE`, `OAUTH_KV` (same namespace) |
| DO bindings | `wrangler.jsonc` `durable_objects` | `MCP_OBJECT` (must be this name), `TOKEN_MANAGER` |

### Deploy Command

```bash
npx wrangler deploy
```

---

## Storage Abstraction Layer

The MCP server uses a platform-agnostic storage interface to decouple tool handlers from Cloudflare-specific APIs, enabling future self-hosted deployments on Node.js or other platforms.

### IKeyValueStore Interface

Defined in `src/lib/kv-store.ts`, this interface provides four operations:

| Method | Signature | Used By |
|--------|-----------|---------|
| `get` | `(key: string) => Promise<string \| null>` | Token retrieval, config read, cache lookup |
| `put` | `(key: string, value: string, options?: { expirationTtl?: number }) => Promise<void>` | Token storage, config write, cache write |
| `delete` | `(key: string) => Promise<void>` | Config delete, cache invalidation |
| `list` | `(options: { prefix: string; cursor?: string }) => Promise<{ keys, list_complete, cursor }>` | Cache clearing (enumerate + bulk delete) |

### AppEnv vs Env

| Type | Purpose | Used By |
|------|---------|---------|
| `AppEnv` | Portable: Acumatica config strings + `store: IKeyValueStore` | All tool handlers, `AcumaticaClient`, `config.ts`, `metadata-cache.ts`, `acumatica-oauth.ts` |
| `Env` | CF-specific: the CF bindings (`TOKEN_STORE`, `OAUTH_KV`, `MCP_OBJECT`, `TOKEN_MANAGER`, `INDEX_STORE`, `OAUTH_PROVIDER`, R2) plus the Acumatica connection strings from `wrangler.jsonc` | `index.ts`, `acumatica-auth-handler.ts`, `admin-handler.ts` |

`Env` does **not** extend `AppEnv`. In `AcumaticaMcpServer.init()` the entry point constructs a fresh `AppEnv` object from the CF bindings (see the Cloudflare Adapter below) and passes *that* to tool handlers — it never hot-patches a `store` onto `this.env`, because the CF runtime may share that env reference across requests in the same isolate.

### Cloudflare Adapter

`CloudflareKVStore` (`src/platform/cloudflare-kv-store.ts`) wraps a `KVNamespace` binding as an `IKeyValueStore`. It is a thin passthrough -- every method maps 1:1 to the KV API. It is wired into the fresh `AppEnv` built in `AcumaticaMcpServer.init()` (alongside the `DOTokenProvider` and, when the index bucket is bound, `CloudflareR2BlobStore`):

```typescript
this.appEnv = {
  ACUMATICA_URL: this.env.ACUMATICA_URL,
  // ...other config strings...
  store: new CloudflareKVStore(this.env.TOKEN_STORE),
  tokenProvider: new DOTokenProvider(this.env.TOKEN_MANAGER),
  indexStore: this.env.INDEX_STORE ? new CloudflareR2BlobStore(this.env.INDEX_STORE) : undefined,
};
```

### Self-Hosting

For self-hosted deployments, implement `IKeyValueStore` with Redis, SQLite, or an in-memory store, construct an `AppEnv` from environment variables, and wire up `@modelcontextprotocol/sdk` directly. See [Self-Hosting Guide](self-hosting-guide.md) for details.

---

## Design Decisions

### Why Acumatica as sole identity provider?

The initial design used Microsoft Entra ID as a separate identity layer, chained to Acumatica OAuth. This was removed because:

1. **Redundant.** Every user must authenticate with Acumatica anyway to get role-based API permissions.
2. **Acumatica supports Entra SSO natively.** If configured, users get the Microsoft login experience through Acumatica's own login page.
3. **Simpler.** One login, one callback, no Entra secrets to manage.

### Why read-only first?

Write operations require careful validation, conflict handling, and business rule enforcement. Starting read-only allows:

1. Safe exploration and analysis without risk of data corruption
2. Building trust with Acumatica admins who may be cautious about AI access
3. Understanding usage patterns before adding write capabilities

### Why Durable Objects?

The honest answer: **remote MCP is a stateful, session-scoped protocol, and a Durable Object is Cloudflare's only stateful, consistently-addressable compute primitive — so the `agents` SDK's `McpAgent` *is* a Durable Object.** Putting the MCP server in a DO is not an à-la-carte choice; it's how `McpAgent.serve("/mcp")` is built (which is also why the binding must be named `MCP_OBJECT`). The reason the SDK is built that way:

1. **The transport is stateful.** An MCP connection over streamable-http/SSE is a *session*: an `initialize` handshake, then a long-lived SSE stream plus follow-up POSTs that must be correlated to that same stream. Plain Workers are stateless and ephemeral — consecutive requests can land on different, short-lived isolates. A DO has a **stable address** (its ID), so every message in one logical session reaches the same instance.
2. **There's live per-session state to hold.** `init()` registers all 48 tools once, and the instance carries the authenticated user (`this.props.acumaticaUsername`), the `McpServer` object, and the log buffer — none of which you'd want to rebuild per request.
3. **It needs durable storage + alarms.** The audit-log buffer is persisted to `ctx.storage` and flushed on a DO **alarm** — a mechanism only Durable Objects provide.

The per-session isolation, cached tool registry, and consistent routing are welcome consequences, not the primary reason. Note the contrast with the **`TokenManager`** DO, which uses the *same* primitive for a different property: it is keyed per-**user** (`idFromName(username)`), not per-session, specifically to serialize refresh-token rotation across a user's concurrent sessions.

### Why unwrapFields()?

Acumatica's contract-based REST API wraps every field value as `{value: X}`. This is verbose and confusing for AI assistants. The `unwrapFields()` utility recursively strips these wrappers, turning `{CustomerName: {value: "Acme Corp"}}` into `{CustomerName: "Acme Corp"}`.

### Why AppEnv instead of full Env abstraction?

Rather than abstracting the entire Worker infrastructure (OAuth provider, Durable Objects, auth flow), only the storage layer is abstracted via `IKeyValueStore` + `AppEnv`. This is because:

1. **Tools are the reusable part.** All 48 tools and the Acumatica client only need config strings and a key-value store. They never touch OAuth, DOs, or R2.
2. **Auth varies fundamentally by platform.** A Node.js self-host would use Express + Passport or skip auth entirely. Abstracting the auth handler would create an interface that no two implementations share.
3. **Minimal disruption.** Tool handler changes were limited to import swaps (`Env` -> `AppEnv`). No function bodies changed.
