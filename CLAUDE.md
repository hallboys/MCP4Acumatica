# CLAUDE.md — Project Memory for MCP4Acumatica

## Project Overview

Remote MCP (Model Context Protocol) server on Cloudflare Workers that connects Claude to an Acumatica ERP 2025 R2 instance via the contract-based REST API. Each user authenticates directly with Acumatica — their Acumatica role controls what records they can access.

- **License:** Apache 2.0 — Copyright 2026 Hall Boys, Inc.
- **Copyright header** required on all `.ts` source files: `// Copyright 2026 Hall Boys, Inc.` + `// SPDX-License-Identifier: Apache-2.0`
- **Git config (this repo only):** `user.email = saratvemuri@hallboys.com`
- **Current tag:** `25R2-0.26.0`
- **Deployed at:** `https://acumatica-mcp.hallboys.com` (custom domain) / `https://mcp4acumatica.it-495.workers.dev` (workers.dev fallback)
- **GitHub:** `https://github.com/hallboys/MCP4Acumatica`

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
│    ├─ /token, /register (DCR+CIMD) │
│    ├─ /docs → Documentation site │
│    └─ /mcp → McpAgent DO        │
│       ├─ 44 tools (38 read-only  │
│       │   + 6 utility/discovery) │
└──────────────┬──────────────────┘
               │  Bearer token (per-user)
               ▼
        Acumatica 25R2 SaaS
        Contract-Based REST API
        Default/25.200.001
```

### Storage Abstraction (Platform Portability)

Tool handlers, the Acumatica HTTP client, config, and caching are decoupled from Cloudflare via two abstractions:

- **`IKeyValueStore`** (`src/lib/kv-store.ts`) — Platform-agnostic interface for key-value storage (get, put, delete, list). Cloudflare Workers uses `CloudflareKVStore` which wraps `KVNamespace`.
- **`AppEnv`** (`src/types/acumatica.ts`) — Portable environment type containing Acumatica connection settings and a `store: IKeyValueStore`. All tool handlers and shared libraries use `AppEnv`. The Cloudflare-specific `Env` extends `AppEnv` with CF bindings (`TOKEN_STORE`, `OAUTH_KV`, `MCP_OBJECT`, etc.).

This design allows future self-hosted adapters (Node.js + Redis/SQLite) to reuse all tool handlers without modification. See `docs/self-hosting-guide.md`.

## OAuth Flow

Claude → Worker `/authorize` → Acumatica login (with `openid profile email api` scopes) → Worker `/callback` → OIDC userinfo → canary GI role check → `/consent` interstitial → token stored → MCP session active.

Acumatica is the sole identity provider. Users log in with their Acumatica credentials (or via whatever SSO their Acumatica instance is configured with). The MCP server does not manage identity separately — it delegates entirely to Acumatica.

### Access Control & Governance

1. **Role gate (canary GI):** After login, the callback queries the `MCPAccess` Generic Inquiry via OData. This GI is assigned only to the `MCP Access` role in Acumatica. If the OData query returns 200, the user has the role; if 403, they don't. This avoids exposing user/role data — the GI content is irrelevant, it's purely an access gate. Users without the role see a 403 page directing them to contact their Acumatica admin. The role name is configurable via `ACUMATICA_MCP_ROLE` env var.

2. **Consent interstitial:** Users who pass the role check see a consent page explaining that data will be processed by AI, access is logged, and sensitive fields are redacted. They must acknowledge before the MCP session activates.

3. **Sensitive field redaction:** Tool responses are automatically scanned for sensitive field names (SSN, bank accounts, salary, credit card, etc.) using pattern matching. Matched values are replaced with `[REDACTED]`. Patterns are configurable via `REDACT_PATTERNS` (add) and `REDACT_SKIP` (whitelist) env vars. See `src/lib/redact.ts`.

4. **Enhanced audit logging:** All tool invocations include the Acumatica username, tool parameters (what was queried), duration, and success/error status. Auth events (login success, access denied, consent accepted) are logged separately in the Worker handler. Tool invocation and field redaction logs are written directly to R2 from the Durable Object (Cloudflare Logpush only captures Worker-level traces, not DO traces). The `writeLogsToR2()` function in `src/lib/logger.ts` writes NDJSON entries to `do-logs/{date}/{timestamp}-{random}.ndjson` keys in R2. To minimize R2 file count, the DO buffers log entries in memory (`logBuffer` in `AcumaticaMcpServer`) and flushes them when the buffer reaches 25 entries OR a DO alarm fires 15 seconds after the last buffered entry. The alarm is critical — without it, short sessions (<25 entries) would sit in memory until the DO was evicted and the buffer would be lost. Alarms are registered via `this.ctx.storage.setAlarm(...)` and handled in the class's `alarm()` method, which Cloudflare wakes the DO specifically to run even if it has gone idle. Console.log is preserved for `wrangler tail` live debugging. The admin console at `/docs/admin` reads both Logpush-written and DO-written logs from R2 using streaming server-side pagination (prefix-scoped R2 listing, parallel batched reads, incremental filtering, early-exit once one page of results is collected) to keep load times fast even for multi-day queries.

5. **Pagination refusal semantics:** The list/query tools (`acumatica_list_entities`, `acumatica_run_inquiry`, `acumatica_list_generic_inquiries`) hard-cap results at `ACUMATICA_MAX_RECORDS` (default 1000, runtime-overridable via the admin console → KV `config:acumatica_max_records`). When a response hits the cap, the tool returns a structured envelope `{ results, truncated: true, paginationSupported: false, actionRequired: "..." }` instructing the model to stop calling and ask the user to refine `filterExpression`/`titleFilter`. No server-side cooldown — the semantic response is the mechanism.

## Key Design Decisions

1. **Acumatica as sole OAuth provider.** The MCP server redirects directly to Acumatica for login. No separate identity provider layer. See "Historical Note" below for why.

2. **Per-user Acumatica tokens.** Each MCP user gets their own Acumatica OAuth token stored in KV keyed by `user_token:{acumaticaUsername}`. The user's Acumatica role governs record-level access. The MCP server additionally requires the `MCP Access` role (gate check) and applies sensitive field redaction before returning data to Claude.

3. **`@cloudflare/workers-oauth-provider`** wraps the entire worker. It acts as an OAuth 2.1 server for Claude, handling both CIMD (Client ID Metadata Documents, preferred) and DCR (Dynamic Client Registration, fallback) for client registration, plus token issuance, etc. The `defaultHandler` (Hono app) manages the Acumatica OAuth redirect flow. The `apiHandler` (McpAgent DO) handles `/mcp` requests with bearer token auth. CIMD requires the `global_fetch_strictly_public` compatibility flag in wrangler.jsonc for SSRF protection.

4. **DO binding must be named `MCP_OBJECT`** — this is the default the `agents` SDK looks for in `McpAgent.serve()`.

5. **Acumatica field values** are wrapped as `{value: X}`. The `unwrapFields()` utility recursively strips these before returning data to Claude.

6. **`AppEnv` / `IKeyValueStore` abstraction.** Tool handlers and shared libraries (`config.ts`, `metadata-cache.ts`, `acumatica-oauth.ts`, `acumatica-client.ts`) use the platform-agnostic `AppEnv` type (which has `store: IKeyValueStore`) instead of the Cloudflare-specific `Env`. The CF entry point (`index.ts`) initializes `env.store = new CloudflareKVStore(env.TOKEN_STORE)` in `init()`. CF-specific code (auth handler, admin handler) continues to use raw `Env` / `KVNamespace` directly. This keeps the Cloudflare deployment unchanged while enabling future Node.js self-hosting.

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
│   ├── acumatica-auth-handler.ts  # Acumatica OAuth flow (/authorize, /callback, /consent, role gate, OIDC discovery)
│   └── acumatica-oauth.ts         # Token retrieval + refresh (uses AppEnv.store)
├── admin/
│   └── admin-handler.ts           # Admin console: auth, settings, log viewer (Hono sub-app)
├── docs/
│   ├── docs-handler.ts            # Hono sub-app: renders markdown docs to HTML, mounts admin
│   └── markdown.d.ts              # TypeScript declaration for .md text module imports
├── lib/
│   ├── acumatica-client.ts        # HTTP client for Acumatica REST API
│   ├── config.ts                  # KV-backed runtime config (uses IKeyValueStore)
│   ├── kv-store.ts                # IKeyValueStore interface (platform-agnostic storage)
│   ├── metadata-cache.ts           # KV-backed cache (uses IKeyValueStore)
│   ├── rate-limiter.ts            # 3 concurrent, 40/min limits
│   ├── logger.ts                  # Structured JSON audit logging (tool, auth, redaction events)
│   └── redact.ts                  # Pattern-based sensitive field redaction
├── platform/
│   └── cloudflare-kv-store.ts     # CloudflareKVStore — wraps KVNamespace as IKeyValueStore
├── tools/                         # 42 tools across 10 modules + 4 utility
│   ├── accounts.ts                # acumatica_get_account (GL)
│   ├── appointments.ts            # acumatica_get_appointment (Field Service)
│   ├── bills.ts                   # acumatica_get_bill (AP)
│   ├── business-accounts.ts       # acumatica_get_business_account (CRM)
│   ├── cases.ts                   # acumatica_get_case (Support)
│   ├── checks.ts                  # acumatica_get_check (AP)
│   ├── clear-cache.ts             # acumatica_clear_cache (Utility)
│   ├── contacts.ts                # acumatica_get_contact (CRM)
│   ├── crm-activities.ts          # acumatica_get_email, _event, _activity, _task
│   ├── customers.ts               # acumatica_get_customer
│   ├── entity-list.ts             # acumatica_list_entities (Utility)
│   ├── entity-schema.ts           # acumatica_describe_entity (Utility)
│   ├── employees.ts               # acumatica_get_employee (HR)
│   ├── expense-claims.ts          # acumatica_get_expense_claim (HR)
│   ├── generic-inquiries.ts       # acumatica_run_inquiry (Utility)
│   ├── generic-inquiry-discovery.ts # acumatica_list_generic_inquiries, _describe_inquiry (Utility)
│   ├── inventory-availability.ts  # acumatica_get_inventory_quantity_available, _summary
│   ├── invoices.ts                # acumatica_get_invoice (AR)
│   ├── item-classes.ts            # acumatica_get_item_class (Inventory)
│   ├── journal-transactions.ts    # acumatica_get_journal_transaction (GL)
│   ├── leads.ts                   # acumatica_get_lead (CRM)
│   ├── non-stock-items.ts         # acumatica_get_non_stock_item (Inventory)
│   ├── opportunities.ts           # acumatica_get_opportunity (CRM)
│   ├── payments.ts                # acumatica_get_payment (AR)
│   ├── projects.ts                # acumatica_get_project, _task, _budget, _transaction
│   ├── purchase-orders.ts         # acumatica_get_purchase_order
│   ├── purchase-receipts.ts       # acumatica_get_purchase_receipt
│   ├── sales-invoices.ts          # acumatica_get_sales_invoice
│   ├── sales-orders.ts            # acumatica_get_sales_order
│   ├── salespersons.ts            # acumatica_get_salesperson (CRM)
│   ├── service-orders.ts          # acumatica_get_service_order (Field Service)
│   ├── shipments.ts               # acumatica_get_shipment
│   ├── stock-items.ts             # acumatica_get_stock_item (Inventory)
│   ├── time-entries.ts            # acumatica_get_time_entry (HR)
│   ├── vendors.ts                 # acumatica_get_vendor
│   └── warehouses.ts              # acumatica_get_warehouse (Inventory)
└── types/
    └── acumatica.ts               # All TypeScript types, AppEnv, Env, AuthProps
```

## Configuration

### Gitignored (instance-specific):
- `wrangler.jsonc` — real KV IDs and instance vars (**still edit this file when config changes — do not skip it because it's gitignored**)
- `.dev.vars` — secrets for local dev
- `swagger.json` — instance OpenAPI spec

### Tracked templates:
- `wrangler.jsonc.example` — placeholder config for new users
- `.dev.vars.example` — documents required secrets

### Environment Variables (in wrangler.jsonc `vars`):
- `ACUMATICA_URL` — e.g., `https://your-instance.acumatica.com`
- `ACUMATICA_TENANT` — Acumatica tenant/login company name (e.g., `Production`). Used for OData GI endpoint URL.
- `ACUMATICA_ENDPOINT_VERSION` — `25.200.001`
- `ACUMATICA_MAX_RECORDS` — max rows per query (default `1000`). Runtime-overridable via `config:acumatica_max_records` in KV (set from the admin console).
- `ACUMATICA_MCP_ROLE` — Acumatica role name required to use MCP (default `"MCP Access"`)
- `REDACT_PATTERNS` — comma-separated additional field name patterns to redact (e.g., `CustomSSN,EmployeeNotes`)
- `REDACT_SKIP` — comma-separated field name patterns to whitelist from redaction (e.g., `BirthDate`)

### Secrets (via `wrangler secret put` or `.dev.vars`):
- `ACUMATICA_CLIENT_ID` — from Acumatica Connected Application (SM303010)
- `ACUMATICA_CLIENT_SECRET` — from Acumatica Connected Application
- `COOKIE_ENCRYPTION_KEY` — random 256-bit hex (`openssl rand -hex 32`)
- `ADMIN_SECRET` — password for the admin console at `/docs/admin`

### KV Namespaces:
- `TOKEN_STORE` — per-user Acumatica tokens, temporary OAuth state, metadata cache, and runtime config overrides (`config:*` prefix)
- `OAUTH_KV` — required by `@cloudflare/workers-oauth-provider` internally (points to the same physical namespace as `TOKEN_STORE`)

### R2 Buckets:
- `mcp4acumatica_logs` — long-term log storage via Logpush (requires Workers Paid plan for Logpush; R2 free tier: 10 GB)

### Runtime Config (KV-backed):
Settings can be changed at runtime via the admin console at `/docs/admin/settings` without redeploying. KV overrides take precedence over env vars. Changes take effect when the next DO instance starts (DOs recycle within minutes on idle). Config keys stored in KV with `config:` prefix:
- `config:redact_patterns`, `config:redact_skip`
- `config:acumatica_max_records`

### Acumatica Connected Application (SM303010):
- **Redirect URI:** `https://acumatica-mcp.hallboys.com/callback` (add both custom domain and workers.dev URLs if using both)
- **Scope:** `api openid profile email`

### Acumatica Role & GI Prerequisites:
- **Role:** Create `MCP Access` role (SM201005). No permissions needed — it's a marker role for the canary GI gate check.
- **Generic Inquiry:** Create `MCPAccess` GI (SM208000). Can be trivial (any single column). Assign it only to the `MCP Access` role. Enable **Expose via OData**.
- **User assignment:** Assign the `MCP Access` role to users who should have AI assistant access.

## Tech Stack

- **Runtime:** Cloudflare Workers + Durable Objects
- **MCP:** `agents` SDK (McpAgent), `@modelcontextprotocol/sdk`
- **Auth:** `@cloudflare/workers-oauth-provider`
- **HTTP routing:** Hono
- **Language:** TypeScript
- **Validation:** Zod (tool parameter schemas)
- **Markdown rendering:** marked (docs site)

## Common Commands

```bash
npx wrangler dev              # Local dev
npx wrangler deploy           # Deploy to Cloudflare
npx tsc --noEmit              # Type check
npx wrangler tail             # Live logs
npx wrangler secret put X     # Set a secret
npx wrangler kv namespace create X  # Create KV namespace
```

## Commit / Push / Tag Checklist

Before every commit, push, or tag:

1. **Update documentation** — ensure all docs (`README.md`, `docs/*.md`) reflect any changes made in the commit.
2. **Update version strings in documentation** — if the tag is changing, update the version in:
   - `CLAUDE.md` → `Current tag` field in Project Overview
   - `docs/tool-reference.md` → version in the opening paragraph
   - `src/docs/docs-handler.ts` → `<span>v... &middot; 44 tools</span>` in the nav brand
   - `src/index.ts` → McpServer version string

## Close Session Procedure

When the user says **"close session"**, perform all of the following:

1. **Update CLAUDE.md** — ensure it reflects all changes made during the session
2. **Increment version** — bump the patch version (e.g., 0.22.0 → 0.22.1) unless a minor/major bump is warranted
3. **Update version strings** in:
   - `CLAUDE.md` → `Current tag` field in Project Overview
   - `docs/tool-reference.md` → version in the opening paragraph
   - `src/docs/docs-handler.ts` → `<span>v... &middot; 44 tools</span>` in the nav brand
   - `src/index.ts` → McpServer version string
4. **Commit** all changes with a descriptive message
5. **Push** to `origin/main`
6. **Tag** with `25R2-X.Y.Z` format
7. **Deploy** with `npx wrangler deploy` and verify the deployment succeeds

## Known Issues / Tech Debt

- **User identity retrieval:** The OIDC `/identity/connect/userinfo` endpoint (with `openid profile email` scopes) is the primary method. Falls back to `/entity/auth/25.200.001/UserSecurityInfo` which may not exist on all instances. If both fail, username defaults to a UUID-based key (breaks token reuse across sessions).
- **Acumatica system entities not available via contract API:** `User`, `UserRole`, and screen-based API (`/entity/Default/.../screen/SM201010`) all return 404 on SaaS instances. The canary GI approach for role checking was adopted because of this limitation.
- **`$select` on some entities causes Acumatica 500:** Some entities (e.g., Payment) return internal server errors when `$select` is used with certain field names. The `acumatica_list_entities` tool auto-retries without `$select` when this occurs.
- Old Entra ID secrets may still exist on Cloudflare — clean up with `wrangler secret delete ENTRA_CLIENT_ID`, etc.
- **Zod schema constraint:** MCP tool parameter schemas MUST use only simple types (`z.string()`, `z.string().optional()`, `z.string().default("value")`). Complex types like `z.record()`, `z.unknown()`, `z.number()` cause MCP SDK JSON Schema serialization failures and tools won't appear in client discovery. Use `z.string()` with manual `parseInt()` in the handler for numeric parameters.
- **ChatGPT CIMD bug (as of April 2026):** ChatGPT's MCP client sees `client_id_metadata_document_supported: true` in our metadata but fails to complete CIMD (it doesn't have its own metadata document URL) and does not auto-fallback to DCR. Users must manually select DCR when adding the server in ChatGPT. Our server correctly advertises both — this is a ChatGPT client-side issue.
- **Claude.ai tool list caching:** Claude.ai may cache the tool list from a previous Durable Object session. If tools appear stale, disconnect and reconnect the MCP server in Claude.ai to force a fresh `init()` call.

## TODO — Remaining Project Work

### Completed — Read-Only Tools (38 total, 0.1.0–0.10.0)
- [x] Core: Customer, Vendor, SalesOrder (0.1.0)
- [x] Financial/Accounting: Invoice, Bill, JournalTransaction, Payment, Account, Check (0.2.0)
- [x] Inventory & Warehouse: StockItem, NonStockItem, InventoryQuantityAvailable, InventorySummaryInquiry, Warehouse, ItemClass (0.3.0)
- [x] Purchasing: PurchaseOrder, PurchaseReceipt (0.4.0)
- [x] Projects: Project, ProjectTask, ProjectBudget, ProjectTransaction (0.5.0)
- [x] Service & Field: Case, ServiceOrder, Appointment (0.6.0)
- [x] Sales & CRM: Contact, BusinessAccount, Opportunity, Lead, Salesperson (0.7.0)
- [x] Shipping & Fulfillment: Shipment, SalesInvoice (0.8.0)
- [x] HR & Payroll: Employee, ExpenseClaim, TimeEntry (0.9.0)
- [x] CRM Activities: Email, Event, Activity, Task (0.10.0)

### Completed — Utility/Discovery Tools (6 total, 0.11.0–0.20.0)
- [x] Generic Inquiry: acumatica_run_inquiry (0.11.0)
- [x] Entity List/Search: acumatica_list_entities (0.12.0)
- [x] Entity Schema Discovery: acumatica_describe_entity (0.13.0)
- [x] GI Discovery: acumatica_list_generic_inquiries, acumatica_describe_inquiry (0.16.0; switched to OData GI endpoint with OAuth 2.0 Bearer tokens)
- [x] Metadata Cache: KV-backed caching for entity schemas (24h), GI lists (1h), GI field schemas (1h); acumatica_clear_cache tool for on-demand invalidation (0.20.0)

### Completed — Documentation & Infrastructure
- [x] Documentation site served from `/docs` on the same worker (0.14.0)
- [x] docs/tool-reference.md, example-prompts.md, odata-filtering.md, architecture.md, self-hosting-guide.md
- [x] CIMD support enabled alongside DCR, OpenID Connect discovery endpoint added (0.15.0)

### Completed — Access Control & Governance (0.19.0)
- [x] Role gate via canary GI (`MCPAccess` GI assigned to `MCP Access` role, queried via OData)
- [x] Consent interstitial page between role check and MCP session activation
- [x] Sensitive field redaction (pattern-based, configurable via REDACT_PATTERNS/REDACT_SKIP)
- [x] Enhanced audit logging (username in all entries, auth events, redaction events)
- [x] OIDC userinfo for identity (openid profile email scopes)
- [x] Auto-retry without $select on entity list 500 errors
- [x] Anti-pagination tool descriptions and structured truncation envelope (`truncated`, `paginationSupported: false`, `actionRequired`) — instructs the model to ask the user for a narrower filter rather than retry
- [x] `ACUMATICA_MAX_RECORDS` is runtime-overridable from the admin console (`config:acumatica_max_records` in KV)
- [x] Storage abstraction layer — `IKeyValueStore` interface + `AppEnv` type for platform portability (0.23.0)
- [x] Self-hosting documentation — `docs/self-hosting-guide.md` with Node.js adapter guide

### High Priority — Features
- [ ] Add write tools: Create/update Sales Orders, Customers, Vendors (per project brief Phase 2)
- [ ] Add action tools: Release Invoice, Confirm Shipment (per project brief Phase 3)
- [ ] Better error message when refresh token expires (tell user to reconnect)

### Low Priority — Read-Only Tools

**Financial (additional):**
- [ ] AccountSummaryInquiry — GL account balances by period/ledger
- [ ] AccountDetailsForPeriodInquiry — GL transaction detail for a period
- [ ] CashSale — point-of-sale cash transactions
- [ ] CashTransaction — bank deposits, withdrawals, transfers
- [ ] Budget — GL budget lines by period
- [ ] Ledger — ledger master data (actual, budget, statistical)
- [ ] Subaccount — sub-account segments
- [ ] Tax — tax ID master data
- [ ] TaxCategory — tax category definitions
- [ ] TaxZone — tax zone definitions

**Sales (additional):**
- [ ] CustomerLocation — customer ship-to/bill-to locations
- [ ] CustomerClass — customer classification defaults
- [ ] CustomerPaymentMethod — stored payment methods
- [ ] SalesPricesInquiry — item price lookup
- [ ] Discount / DiscountCode — discount rules

**Purchasing (additional):**
- [ ] VendorClass — vendor classification defaults
- [ ] VendorPricesInquiry — vendor price lookup

**Inventory (additional):**
- [ ] InventoryAllocationInquiry — allocation breakdown (on hand, available, on PO, etc.)
- [ ] StorageDetailsInquiry / StorageDetailsByLocationInquiry — lot/serial detail
- [ ] ItemWarehouse — per-warehouse item settings
- [ ] KitSpecification — kit/BOM definitions
- [ ] TransferOrder — inter-warehouse transfers
- [ ] InventoryAdjustment / InventoryIssue / InventoryReceipt — inventory transactions

**Other:**
- [ ] FinancialPeriod / FinancialYear — fiscal calendar
- [ ] Currency — currency master data
- [ ] ShipVia / ShippingTerm / ShippingZones — shipping config

### Low Priority — Infrastructure
- [ ] Add Attachment upload/download tools
- [ ] Remove old Entra ID secrets from Cloudflare (`wrangler secret delete`)
- [ ] Add unit tests
- [ ] Add CI/CD pipeline

## MCP Client Compatibility (as of April 2026)

| Client | Registration | Status |
|--------|-------------|--------|
| Claude.ai (Team/Pro/Max/Enterprise) | DCR | ✅ Works — uses `/register` |
| Claude Code (v2.1.81+) | CIMD preferred, DCR fallback | ✅ Works — publishes metadata at `https://claude.ai/oauth/claude-code-client-metadata` |
| Claude Desktop | DCR | ✅ Works — uses `/register` |
| ChatGPT | DCR (manual selection required) | ⚠️ Works with manual DCR — CIMD auto-detection broken on their side |

### OAuth Discovery Endpoints

The server responds on three well-known paths (all return identical metadata):
- `/.well-known/oauth-protected-resource` (and `/mcp` suffixed variant) — RFC 9728
- `/.well-known/oauth-authorization-server` — RFC 8414
- `/.well-known/openid-configuration` — added for ChatGPT compatibility (proxies to oauth-authorization-server)

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
