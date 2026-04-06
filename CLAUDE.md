# CLAUDE.md — Project Memory for Acumatica MCP Server

## Project Overview

Remote MCP (Model Context Protocol) server on Cloudflare Workers that connects Claude to an Acumatica ERP 2025 R2 instance via the contract-based REST API. Each user authenticates directly with Acumatica — their Acumatica role controls what records they can access.

- **License:** Apache 2.0 — Copyright 2026 Hall Boys, Inc.
- **Copyright header** required on all `.ts` source files: `// Copyright 2026 Hall Boys, Inc.` + `// SPDX-License-Identifier: Apache-2.0`
- **Git config (this repo only):** `user.email = saratvemuri@hallboys.com`
- **Current tag:** `25R2-0.1.0`
- **Deployed at:** `https://acumatica-mcp-server.it-495.workers.dev`
- **GitHub:** `https://github.com/hallboys/AcumaticaMCP`

## Architecture

```
Claude (claude.ai / Desktop / API)
    │
    ▼  MCP over streamable-http
┌─────────────────────────────────┐
│  Cloudflare Worker              │
│  OAuthProvider wrapper          │
│    ├─ /authorize → Acumatica    │
│    ├─ /callback  ← Acumatica   │
│    ├─ /token, /register (DCR)   │
│    └─ /mcp → McpAgent DO        │
│       ├─ acumatica_get_customer │
│       ├─ acumatica_get_vendor   │
│       └─ acumatica_get_sales_order │
└──────────────┬──────────────────┘
               │  Bearer token (per-user)
               ▼
        Acumatica 25R2 SaaS
        Contract-Based REST API
        Default/25.200.001
```

## OAuth Flow

Single-step: Claude → Worker `/authorize` → Acumatica login → Worker `/callback` → token stored → MCP session active.

Acumatica is the sole identity provider. Users log in with their Acumatica credentials (or via whatever SSO their Acumatica instance is configured with). The MCP server does not manage identity separately — it delegates entirely to Acumatica.

## Key Design Decisions

1. **Acumatica as sole OAuth provider.** The MCP server redirects directly to Acumatica for login. No separate identity provider layer. See "Historical Note" below for why.

2. **Per-user Acumatica tokens.** Each MCP user gets their own Acumatica OAuth token stored in KV keyed by `user_token:{acumaticaUsername}`. The user's Acumatica role governs record-level access — the MCP server does not enforce permissions itself.

3. **`@cloudflare/workers-oauth-provider`** wraps the entire worker. It acts as an OAuth 2.1 server for Claude, handling DCR (Dynamic Client Registration), token issuance, etc. The `defaultHandler` (Hono app) manages the Acumatica OAuth redirect flow. The `apiHandler` (McpAgent DO) handles `/mcp` requests with bearer token auth.

4. **DO binding must be named `MCP_OBJECT`** — this is the default the `agents` SDK looks for in `McpAgent.serve()`.

5. **Acumatica field values** are wrapped as `{value: X}`. The `unwrapFields()` utility recursively strips these before returning data to Claude.

## Historical Note: Why We Removed Microsoft Entra ID

The initial design used a two-login chained OAuth flow: users first authenticated via Microsoft Entra ID (to identify who they are), then were chained to Acumatica OAuth (to get API permissions). This required a separate Entra app registration, three callback routes, and intermediate state management in KV.

We removed Entra ID entirely because:
- **It was redundant.** Since every user must authenticate with Acumatica anyway (to get a per-user API token with their role-based permissions), the Entra login added no value — Acumatica already knows who the user is.
- **Acumatica can use Entra SSO natively.** If an Acumatica instance is configured with Entra SSO, users still get the Microsoft login experience — it just happens through Acumatica's own login page, not through our MCP server.
- **Simpler flow.** One login instead of two. One callback route instead of three. No Entra secrets to manage.

Old Entra-related secrets (`ENTRA_CLIENT_ID`, `ENTRA_CLIENT_SECRET`, `ENTRA_TENANT_ID`) may still exist on the Cloudflare side and should be cleaned up with `wrangler secret delete`.

## File Structure

```
src/
├── index.ts                       # Entry point — OAuthProvider + AcumaticaMcpServer (McpAgent DO)
├── auth/
│   ├── acumatica-auth-handler.ts  # Acumatica OAuth flow (/authorize, /callback, health checks)
│   └── acumatica-oauth.ts         # Per-user token retrieval + refresh from KV
├── lib/
│   ├── acumatica-client.ts        # HTTP client for Acumatica REST API
│   ├── rate-limiter.ts            # 3 concurrent, 40/min limits
│   └── logger.ts                  # Structured JSON audit logging
├── tools/
│   ├── customers.ts               # acumatica_get_customer
│   ├── vendors.ts                 # acumatica_get_vendor
│   └── sales-orders.ts            # acumatica_get_sales_order
└── types/
    └── acumatica.ts               # All TypeScript types, Env interface, AuthProps
```

## Configuration

### Gitignored (instance-specific):
- `wrangler.jsonc` — real KV IDs and instance vars
- `.dev.vars` — secrets for local dev
- `swagger.json` — instance OpenAPI spec

### Tracked templates:
- `wrangler.jsonc.example` — placeholder config for new users
- `.dev.vars.example` — documents required secrets

### Environment Variables (in wrangler.jsonc `vars`):
- `ACUMATICA_URL` — e.g., `https://your-instance.acumatica.com`
- `ACUMATICA_COMPANY` — e.g., `YourCompany`
- `ACUMATICA_ENDPOINT_VERSION` — `25.200.001`

### Secrets (via `wrangler secret put` or `.dev.vars`):
- `ACUMATICA_CLIENT_ID` — from Acumatica Connected Application (SM303010)
- `ACUMATICA_CLIENT_SECRET` — from Acumatica Connected Application
- `COOKIE_ENCRYPTION_KEY` — random 256-bit hex (`openssl rand -hex 32`)

### KV Namespaces:
- `TOKEN_STORE` — per-user Acumatica tokens
- `OAUTH_KV` — temporary OAuth state during login (10-min TTL)

### Acumatica Connected Application (SM303010):
- **Redirect URI:** `https://<worker-url>/callback`
- **Scope:** `api`

## Tech Stack

- **Runtime:** Cloudflare Workers + Durable Objects
- **MCP:** `agents` SDK (McpAgent), `@modelcontextprotocol/sdk`
- **Auth:** `@cloudflare/workers-oauth-provider`
- **HTTP routing:** Hono
- **Language:** TypeScript
- **Validation:** Zod (tool parameter schemas)

## Common Commands

```bash
npx wrangler dev              # Local dev
npx wrangler deploy           # Deploy to Cloudflare
npx tsc --noEmit              # Type check
npx wrangler tail             # Live logs
npx wrangler secret put X     # Set a secret
npx wrangler kv namespace create X  # Create KV namespace
```

## Known Issues / Tech Debt

- The user info endpoint (`/entity/auth/25.200.001/UserSecurityInfo`) used to get the Acumatica username after login has not been fully validated — if it fails, the code falls back to a UUID-based key which would break token reuse across sessions
- `@anthropic-ai/sdk` is in dependencies but not used — can be removed
- Old Entra ID secrets may still exist on Cloudflare — clean up with `wrangler secret delete ENTRA_CLIENT_ID`, etc.

## TODO — Remaining Project Work

### High Priority
- [ ] Add more read-only tools: Inventory Items, Stock Items, Purchase Orders, Invoices, Bills, GL Journal Transactions, Shipments
- [ ] Add write tools: Create/update Sales Orders, Customers, Vendors (per project brief Phase 2)
- [ ] Add action tools: Release Invoice, Confirm Shipment (per project brief Phase 3)
- [ ] Validate the Acumatica user info endpoint works reliably for username retrieval
- [ ] Better error message when refresh token expires (tell user to reconnect)

### Medium Priority
- [ ] Add search/list tools with pagination, filtering, and $filter support
- [ ] Remove unused `@anthropic-ai/sdk` dependency
- [ ] Add Generic Inquiry (GI) tool for custom reports
- [ ] Add Attachment upload/download tools

### Low Priority
- [ ] README.md (to be written when project is more complete)
- [ ] Remove old Entra ID secrets from Cloudflare (`wrangler secret delete`)
- [ ] Consider removing `OAUTH_KV` namespace if it can share `TOKEN_STORE`
- [ ] Add unit tests
- [ ] Add CI/CD pipeline

## Acumatica API Patterns

### Endpoint format:
```
GET {ACUMATICA_URL}/entity/Default/{version}/{Entity}/{key}
```

### Common query parameters:
- `$expand=SubEntity1,SubEntity2` — include nested records
- `$filter=Field eq 'value'` — filter results
- `$select=Field1,Field2` — limit returned fields
- `$top=N` — limit result count

### Field value wrapping:
Every Acumatica field is `{value: X}`. Use `unwrapFields()` before returning to Claude.

### Auth header:
```
Authorization: Bearer {per-user-access-token}
```
