# CLAUDE.md — Project Memory for Acumatica MCP Server

## Project Overview

Remote MCP (Model Context Protocol) server on Cloudflare Workers that connects Claude to an Acumatica ERP 2025 R2 instance via the contract-based REST API. Each user authenticates directly with Acumatica — their Acumatica role controls what records they can access.

- **License:** Apache 2.0 — Copyright 2026 Hall Boys, Inc.
- **Copyright header** required on all `.ts` source files: `// Copyright 2026 Hall Boys, Inc.` + `// SPDX-License-Identifier: Apache-2.0`
- **Git config (this repo only):** `user.email = saratvemuri@hallboys.com`
- **Current tag:** `25R2-0.17.0`
- **Deployed at:** `https://acumatica-mcp.hallboys.com` (custom domain) / `https://acumatica-mcp-server.it-495.workers.dev` (workers.dev fallback)
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
│    ├─ /token, /register (DCR+CIMD) │
│    ├─ /docs → Documentation site │
│    └─ /mcp → McpAgent DO        │
│       ├─ 43 tools (38 read-only  │
│       │   + 5 utility/discovery) │
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

3. **`@cloudflare/workers-oauth-provider`** wraps the entire worker. It acts as an OAuth 2.1 server for Claude, handling both CIMD (Client ID Metadata Documents, preferred) and DCR (Dynamic Client Registration, fallback) for client registration, plus token issuance, etc. The `defaultHandler` (Hono app) manages the Acumatica OAuth redirect flow. The `apiHandler` (McpAgent DO) handles `/mcp` requests with bearer token auth. CIMD requires the `global_fetch_strictly_public` compatibility flag in wrangler.jsonc for SSRF protection.

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
│   ├── acumatica-auth-handler.ts  # Acumatica OAuth flow (/authorize, /callback, OIDC discovery, health)
│   └── acumatica-oauth.ts         # Per-user token retrieval + refresh from KV
├── docs/
│   ├── docs-handler.ts            # Hono sub-app: renders markdown docs to HTML
│   └── markdown.d.ts              # TypeScript declaration for .md text module imports
├── lib/
│   ├── acumatica-client.ts        # HTTP client for Acumatica REST API
│   ├── rate-limiter.ts            # 3 concurrent, 40/min limits
│   └── logger.ts                  # Structured JSON audit logging
├── tools/                         # 41 tools across 10 modules + 3 utility
│   ├── accounts.ts                # acumatica_get_account (GL)
│   ├── appointments.ts            # acumatica_get_appointment (Field Service)
│   ├── bills.ts                   # acumatica_get_bill (AP)
│   ├── business-accounts.ts       # acumatica_get_business_account (CRM)
│   ├── cases.ts                   # acumatica_get_case (Support)
│   ├── checks.ts                  # acumatica_get_check (AP)
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
- `TOKEN_STORE` — per-user Acumatica tokens and temporary OAuth state during login
- `OAUTH_KV` — required by `@cloudflare/workers-oauth-provider` internally (points to the same physical namespace as `TOKEN_STORE`)

### Acumatica Connected Application (SM303010):
- **Redirect URI:** `https://acumatica-mcp.hallboys.com/callback` (add both custom domain and workers.dev URLs if using both)
- **Scope:** `api`

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

## Known Issues / Tech Debt

- The user info endpoint (`/entity/auth/25.200.001/UserSecurityInfo`) used to get the Acumatica username after login has not been fully validated — if it fails, the code falls back to a UUID-based key which would break token reuse across sessions
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

### Completed — Utility/Discovery Tools (5 total, 0.11.0–0.16.0)
- [x] Generic Inquiry: acumatica_run_inquiry (0.11.0)
- [x] Entity List/Search: acumatica_list_entities (0.12.0)
- [x] Entity Schema Discovery: acumatica_describe_entity (0.13.0)
- [x] GI Discovery: acumatica_list_generic_inquiries, acumatica_describe_inquiry (0.16.0; switched to OData GI endpoint with OAuth 2.0 Bearer tokens)

### Completed — Documentation & Infrastructure
- [x] Documentation site served from `/docs` on the same worker (0.14.0)
- [x] docs/tool-reference.md, example-prompts.md, odata-filtering.md, architecture.md
- [x] CIMD support enabled alongside DCR, OpenID Connect discovery endpoint added (0.15.0)

### High Priority — Features
- [ ] Add write tools: Create/update Sales Orders, Customers, Vendors (per project brief Phase 2)
- [ ] Add action tools: Release Invoice, Confirm Shipment (per project brief Phase 3)
- [ ] Validate the Acumatica user info endpoint works reliably for username retrieval
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
