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
┌─────────────────────────────────────────────┐
│  Cloudflare Worker                          │
│                                             │
│  ┌──────────────────────────────────┐       │
│  │  OAuthProvider                   │       │
│  │  (@cloudflare/workers-oauth-     │       │
│  │   provider)                      │       │
│  │                                  │       │
│  │  Endpoints:                      │       │
│  │  /register   - DCR               │       │
│  │  /authorize  - Start OAuth flow  │       │
│  │  /callback   - Handle redirect   │       │
│  │  /token      - Issue tokens      │       │
│  └──────────────────────────────────┘       │
│                                             │
│  ┌──────────────────────────────────┐       │
│  │  Hono App (defaultHandler)       │       │
│  │  AcumaticaAuthHandler            │       │
│  │                                  │       │
│  │  Routes:                         │       │
│  │  /authorize  - Acumatica redirect│       │
│  │  /callback   - Token exchange +  │       │
│  │               role gate          │       │
│  │  /consent    - AI data consent   │       │
│  │  /health     - Health check      │       │
│  │  /           - Landing page      │       │
│  └──────────────────────────────────┘       │
│                                             │
│  ┌──────────────────────────────────┐       │
│  │  McpAgent Durable Object         │       │
│  │  AcumaticaMcpServer (apiHandler) │       │
│  │                                  │       │
│  │  /mcp  - MCP protocol endpoint   │       │
│  │  /sse  - SSE transport           │       │
│  │                                  │       │
│  │  44 tools registered in init()   │       │
│  └──────────────┬───────────────────┘       │
│                 │                            │
│  ┌──────────────┴───────────────────┐       │
│  │  KV Namespaces                   │       │
│  │  TOKEN_STORE - per-user tokens   │       │
│  │               + OAuth state      │       │
│  └──────────────────────────────────┘       │
└─────────────────────┬───────────────────────┘
                      │ HTTPS (Bearer token)
                      ▼
┌─────────────────────────────────────────────┐
│  Acumatica 25R2 SaaS Instance              │
│  Contract-Based REST API                    │
│  /entity/Default/25.200.001/...            │
│                                             │
│  Per-user access based on Acumatica roles   │
└─────────────────────────────────────────────┘
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

1. **`/authorize`** -- Builds the Acumatica OAuth authorization URL with `scope=api openid profile email` and redirects the user to Acumatica's login page
2. **`/callback`** -- Receives the authorization code from Acumatica, exchanges it for access + refresh tokens, identifies the user via OIDC userinfo, performs the **role gate check** (see below), and redirects to the consent page
3. **`/consent`** (GET) -- Displays the **consent interstitial** page explaining AI data processing, audit logging, and field redaction
4. **`/consent`** (POST) -- User acknowledges the consent; tokens are stored in KV and the MCP OAuth flow completes
5. **`/health`** -- Returns server status
6. **`/`** -- Landing page

### 3. McpAgent Durable Object (AcumaticaMcpServer)

A [Durable Object](https://developers.cloudflare.com/durable-objects/) that extends `McpAgent` from the `agents` SDK. Each MCP session gets its own DO instance with:

- **`init()`** -- Registers all 44 tools with the MCP server
- **`callTool()`** -- Wrapper that catches errors and returns MCP-formatted responses
- **`this.props.acumaticaUsername`** -- The authenticated user's Acumatica username, set during the OAuth callback

The DO binding must be named `MCP_OBJECT` (required by the `agents` SDK's `McpAgent.serve()`).

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
       │                             │  9. Role gate: query        │
       │                             │     MCPAccess canary GI     │
       │                             │──────────────────────────>  │
       │                             │  <── 200 (has role) or      │
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
- **Token refresh.** When an access token expires, the server uses the refresh token to get a new one automatically.
- **Acumatica is the sole identity provider.** No separate identity layer.
- **Role gate before access.** After login, a canary GI check ensures the user has the required Acumatica role (see Access Control below).
- **Consent required.** Users must acknowledge an AI data processing consent page before the MCP session activates.

---

## Security Model

### Authentication

1. **MCP clients** authenticate via OAuth 2.1 (DCR + authorization code flow)
2. **The Worker** authenticates with Acumatica via per-user OAuth tokens
3. **Users** log in with their Acumatica credentials (or SSO configured on the Acumatica instance)

### Authorization & Access Control

Acumatica's role-based access control governs what data each user can access -- if a user can't see a record in Acumatica's UI, they can't access it through the MCP server. On top of that, the MCP server adds its own access control layer:

#### Role Gate (Canary GI)

Before a user can access the MCP server, the `/callback` handler checks whether they belong to a specific Acumatica role. This is implemented using a **canary Generic Inquiry (GI)** approach:

1. A trivial GI named `MCPAccess` is created in Acumatica (SM208000). Its content is irrelevant -- it can be any single column.
2. The `MCPAccess` GI is assigned **only** to the `MCP Access` role in Acumatica.
3. The GI is enabled for **OData** exposure.
4. During login, the server queries the GI via OData: `GET /t/{tenant}/api/odata/gi/MCPAccess?$top=1`
5. If the response is **200**, the user has the role and may proceed.
6. If the response is **403**, the user does not have the role and sees an access denied page directing them to contact their Acumatica administrator.

This approach avoids exposing user/role membership data -- the GI content itself is never used. It works reliably across Acumatica SaaS instances where direct user/role API endpoints are not available.

The required role name defaults to `MCP Access` and is configurable via the `ACUMATICA_MCP_ROLE` environment variable.

**Acumatica setup required:**
- **Role:** Create `MCP Access` in Acumatica (SM201005). No screen permissions are needed -- it is purely a marker role.
- **Generic Inquiry:** Create `MCPAccess` in Acumatica (SM208000) with any trivial query. Assign it only to the `MCP Access` role. Enable **Expose via OData**.
- **Users:** Assign the `MCP Access` role to each user who should have AI assistant access.

#### Consent Interstitial

Users who pass the role gate are shown a consent page before the MCP session activates. The page explains that:

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

## Tool Architecture

### Tool Registration

All 44 tools are registered in the `init()` method of `AcumaticaMcpServer`. Each tool has:

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
├── index.ts                       # Entry point, OAuthProvider + McpAgent DO
├── admin/
│   └── admin-handler.ts           # Admin console: auth, settings, log viewer
├── auth/
│   ├── acumatica-auth-handler.ts  # Hono app: OAuth flow, health, landing
│   └── acumatica-oauth.ts         # Token retrieval + refresh (via AppEnv.store)
├── lib/
│   ├── acumatica-client.ts        # HTTP client, unwrapFields()
│   ├── config.ts                  # KV-backed runtime config (via IKeyValueStore)
│   ├── kv-store.ts                # IKeyValueStore interface
│   ├── metadata-cache.ts          # KV-backed cache (via IKeyValueStore)
│   ├── rate-limiter.ts            # Concurrent + per-minute rate limits
│   └── logger.ts                  # Structured JSON audit logging
├── platform/
│   └── cloudflare-kv-store.ts     # CF adapter for IKeyValueStore
├── tools/                         # 42 tools across 32 handler files
│   ├── entity-list.ts             # acumatica_list_entities
│   ├── entity-schema.ts           # acumatica_describe_entity
│   ├── generic-inquiries.ts       # acumatica_run_inquiry
│   ├── generic-inquiry-discovery.ts # acumatica_list_generic_inquiries, _describe_inquiry
│   ├── clear-cache.ts             # acumatica_clear_cache
│   ├── customers.ts               # acumatica_get_customer
│   ├── vendors.ts                 # acumatica_get_vendor
│   ├── ... (29 more handler files)
│   └── warehouses.ts              # acumatica_get_warehouse
├── types/
│   └── acumatica.ts               # TypeScript types, AppEnv, Env, AuthProps
docs/
├── tool-reference.md              # Complete tool specification
├── example-prompts.md             # Example prompts by use case
├── odata-filtering.md             # OData query parameter guide
└── architecture.md                # This file
```

---

## Deployment

### Infrastructure

| Component | Service |
|-----------|---------|
| Compute | Cloudflare Workers |
| State | Durable Objects (per-session) |
| Storage | Cloudflare KV (tokens, OAuth state) |
| DNS/TLS | Cloudflare (automatic) |

### Configuration

| Type | Location | Example |
|------|----------|---------|
| Environment variables | `wrangler.jsonc` `vars` | `ACUMATICA_URL`, `ACUMATICA_ENDPOINT_VERSION` |
| Secrets | `wrangler secret put` | `ACUMATICA_CLIENT_ID`, `ACUMATICA_CLIENT_SECRET`, `COOKIE_ENCRYPTION_KEY` |
| KV bindings | `wrangler.jsonc` `kv_namespaces` | `TOKEN_STORE`, `OAUTH_KV` (same namespace) |
| DO binding | `wrangler.jsonc` `durable_objects` | `MCP_OBJECT` (must be this name) |

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
| `AppEnv` | Portable: Acumatica config strings + `store: IKeyValueStore` | All 44 tool handlers, `AcumaticaClient`, `config.ts`, `metadata-cache.ts`, `acumatica-oauth.ts` |
| `Env` | CF-specific: extends `AppEnv` with `TOKEN_STORE`, `OAUTH_KV`, `MCP_OBJECT`, `OAUTH_PROVIDER`, `R2Bucket` | `index.ts`, `acumatica-auth-handler.ts`, `admin-handler.ts` |

Since `Env extends AppEnv`, the Cloudflare entry point (`index.ts`) passes `this.env` (typed `Env`) to tool handlers (typed `AppEnv`) with no cast needed.

### Cloudflare Adapter

`CloudflareKVStore` (`src/platform/cloudflare-kv-store.ts`) wraps a `KVNamespace` binding as an `IKeyValueStore`. It is a thin passthrough -- every method maps 1:1 to the KV API. Initialized in `AcumaticaMcpServer.init()`:

```typescript
this.env.store = new CloudflareKVStore(this.env.TOKEN_STORE);
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

Each MCP session needs persistent state (tool registry, user context). Durable Objects provide:

1. Per-session isolation
2. In-memory tool registration (no re-registration per request)
3. Consistent routing (all requests for a session go to the same DO instance)

### Why unwrapFields()?

Acumatica's contract-based REST API wraps every field value as `{value: X}`. This is verbose and confusing for AI assistants. The `unwrapFields()` utility recursively strips these wrappers, turning `{CustomerName: {value: "Acme Corp"}}` into `{CustomerName: "Acme Corp"}`.

### Why AppEnv instead of full Env abstraction?

Rather than abstracting the entire Worker infrastructure (OAuth provider, Durable Objects, auth flow), only the storage layer is abstracted via `IKeyValueStore` + `AppEnv`. This is because:

1. **Tools are the reusable part.** All 44 tool handlers and the Acumatica client only need config strings and a key-value store. They never touch OAuth, DOs, or R2.
2. **Auth varies fundamentally by platform.** A Node.js self-host would use Express + Passport or skip auth entirely. Abstracting the auth handler would create an interface that no two implementations share.
3. **Minimal disruption.** Tool handler changes were limited to import swaps (`Env` -> `AppEnv`). No function bodies changed.
