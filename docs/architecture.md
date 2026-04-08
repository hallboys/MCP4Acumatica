# Acumatica MCP Server -- Architecture

Detailed architecture documentation for the Acumatica MCP Server.

## Overview

The Acumatica MCP Server is a remote [Model Context Protocol](https://modelcontextprotocol.io) (MCP) server that runs on [Cloudflare Workers](https://workers.cloudflare.com). It connects AI assistants (Claude, or any MCP-compatible client) to an [Acumatica ERP](https://www.acumatica.com) 2025 R2 instance via the contract-based REST API.

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
│  │  /callback   - Token exchange    │       │
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
│  │  43 tools registered in init()   │       │
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

1. **`/authorize`** -- Builds the Acumatica OAuth authorization URL with `scope=api` and redirects the user to Acumatica's login page
2. **`/callback`** -- Receives the authorization code from Acumatica, exchanges it for access + refresh tokens, stores them in KV keyed by the Acumatica username, and completes the MCP OAuth flow
3. **`/health`** -- Returns server status
4. **`/`** -- Landing page

### 3. McpAgent Durable Object (AcumaticaMcpServer)

A [Durable Object](https://developers.cloudflare.com/durable-objects/) that extends `McpAgent` from the `agents` SDK. Each MCP session gets its own DO instance with:

- **`init()`** -- Registers all 43 tools with the MCP server
- **`callTool()`** -- Wrapper that catches errors and returns MCP-formatted responses
- **`this.props.acumaticaUsername`** -- The authenticated user's Acumatica username, set during the OAuth callback

The DO binding must be named `MCP_OBJECT` (required by the `agents` SDK's `McpAgent.serve()`).

### 4. AcumaticaClient

HTTP client for the Acumatica contract-based REST API. Features:

- **Per-user tokens** -- Fetches the user's token from KV on each request
- **Automatic retry on 401** -- If a token expires mid-request, fetches a fresh token and retries once
- **Rate limiting** -- Enforced via `withRateLimit()` wrapper (3 concurrent, 40/min)
- **Audit logging** -- Every API call is logged with tool name, endpoint, status code, and duration
- **Friendly error messages** -- HTTP errors are translated to human-readable messages

### 5. KV Namespaces

Both bindings point to the same physical KV namespace (one namespace, two bindings).

| Binding | Purpose | Key Pattern | TTL |
|---------|---------|-------------|-----|
| `TOKEN_STORE` | Per-user Acumatica OAuth tokens | `user_token:{username}` | None (refreshed on expiry) |
| `TOKEN_STORE` | Temporary OAuth state during login flow | `acumatica_state:{state}` | 10 minutes |
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
       │                             │  8. Store token in KV       │
       │                             │  9. Complete OAuth flow     │
       │  <── MCP session active ────│                             │
       │                             │                             │
       │  10. Tool calls via /mcp    │                             │
       │──────────────────────────>  │  11. API call with token    │
       │                             │──────────────────────────>  │
       │                             │  <── JSON response ─────── │
       │  <── MCP tool result ───────│                             │
```

### Key Points

- **Single login.** Users authenticate once with Acumatica (or their configured SSO).
- **No stored passwords.** Only OAuth tokens are stored.
- **Token refresh.** When an access token expires, the server uses the refresh token to get a new one automatically.
- **Acumatica is the sole identity provider.** No separate identity layer.

---

## Security Model

### Authentication

1. **MCP clients** authenticate via OAuth 2.1 (DCR + authorization code flow)
2. **The Worker** authenticates with Acumatica via per-user OAuth tokens
3. **Users** log in with their Acumatica credentials (or SSO configured on the Acumatica instance)

### Authorization

- **Role-based access control** is entirely managed by Acumatica
- Each user's API token carries their Acumatica role permissions
- If a user can't access a record in Acumatica's UI, they can't access it through the MCP server
- The MCP server does not add any additional permission layer

### Data Protection

- **Read-only** -- All 38 entity tools are read-only `GET` requests. No data is created, modified, or deleted.
- **Per-user isolation** -- Each user's token is stored separately. Users cannot access other users' tokens.
- **No credential storage** -- The server never stores passwords. Only OAuth tokens (access + refresh) are stored in KV.
- **Token encryption** -- OAuth state is encrypted with `COOKIE_ENCRYPTION_KEY`

### Rate Limiting

Multiple safeguards protect the Acumatica instance:

| Limit | Value | Scope |
|-------|-------|-------|
| Concurrent requests | 3 | Per user |
| Requests per minute | 40 | Per user |
| Max records per query (`$top`) | 500 | Per request |

When a rate limit is exceeded, the tool returns a friendly error message asking the user to wait. When query results hit the 500-record cap, a note is included in the response indicating there may be more records.

---

## Tool Architecture

### Tool Registration

All 43 tools are registered in the `init()` method of `AcumaticaMcpServer`. Each tool has:

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
callTool() wrapper (error handling)
       │
       ▼
Tool handler (e.g., handleGetCustomer)
       │
       ▼
AcumaticaClient.get()
       │
       ├── withRateLimit() check
       ├── getAcumaticaTokenForUser() from KV
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
| Utility/Discovery | 5 | Schema discovery, entity listing, generic inquiries, GI discovery |
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
├── auth/
│   ├── acumatica-auth-handler.ts  # Hono app: OAuth flow, health, landing
│   └── acumatica-oauth.ts         # Token retrieval + refresh from KV
├── lib/
│   ├── acumatica-client.ts        # HTTP client, unwrapFields()
│   ├── rate-limiter.ts            # Concurrent + per-minute rate limits
│   └── logger.ts                  # Structured JSON audit logging
├── tools/                         # 41 tools across 31 handler files
│   ├── entity-list.ts             # acumatica_list_entities
│   ├── entity-schema.ts           # acumatica_describe_entity
│   ├── generic-inquiries.ts       # acumatica_run_inquiry
│   ├── generic-inquiry-discovery.ts # acumatica_list_generic_inquiries, _describe_inquiry
│   ├── customers.ts               # acumatica_get_customer
│   ├── vendors.ts                 # acumatica_get_vendor
│   ├── ... (29 more handler files)
│   └── warehouses.ts              # acumatica_get_warehouse
├── types/
│   └── acumatica.ts               # TypeScript types, Env, AuthProps
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
