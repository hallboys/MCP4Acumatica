# Acumatica MCP Server

A remote [Model Context Protocol](https://modelcontextprotocol.io) (MCP) server that connects Claude to [Acumatica ERP](https://www.acumatica.com) 2025 R2. Runs on Cloudflare Workers with per-user OAuth authentication against your Acumatica instance.

Each user authenticates with their own Acumatica credentials. Their Acumatica role controls which records they can access -- the MCP server does not enforce permissions itself.

## Features

- **43 tools** -- 38 read-only lookups + 5 utility/discovery tools (see [Available Tools](#available-tools))
- **Per-user OAuth** -- users log in with their Acumatica credentials (or SSO)
- **Role-based access** -- Acumatica's security model governs what each user sees
- **Rate limiting** -- 3 concurrent requests, 40 requests/minute per user
- **Structured audit logging** for all API calls

## Architecture

```
Claude (claude.ai / Desktop / API)
    |
    v  MCP over streamable-http
+----------------------------------+
|  Cloudflare Worker               |
|  OAuth 2.1 Provider              |
|    /authorize -> Acumatica login |
|    /callback  <- Acumatica       |
|    /token, /register (DCR)       |
|    /mcp -> McpAgent DO (43 tools)|
+---------------+------------------+
                |  Bearer token (per-user)
                v
        Acumatica 25R2 SaaS
        Contract-Based REST API
        Default/25.200.001
```

## Prerequisites

- [Node.js](https://nodejs.org) >= 18
- A [Cloudflare](https://cloudflare.com) account (Workers paid plan for Durable Objects)
- An Acumatica 2025 R2 instance with:
  - A **Connected Application** configured in SM303010
  - OAuth 2.0 enabled with `api` scope
  - A redirect URI pointing to your worker's `/callback` endpoint

## Setup

### 1. Clone and install

```bash
git clone https://github.com/hallboys/AcumaticaMCP.git
cd AcumaticaMCP
npm install
```

### 2. Configure Acumatica Connected Application

In your Acumatica instance, navigate to **System > Integration > Connected Applications (SM303010)**:

1. Create a new Connected Application
2. Set the **OAuth 2.0 Flow** to **Authorization Code**
3. Add a redirect URI: `https://<your-worker-url>/callback`
4. Set the scope to `api`
5. Note the **Client ID** and **Client Secret**

### 3. Create KV namespace

```bash
npx wrangler kv namespace create TOKEN_STORE
```

Note the namespace ID from the output. You'll use this same ID for both the `TOKEN_STORE` and `OAUTH_KV` bindings in the next step.

### 4. Configure wrangler

```bash
cp wrangler.jsonc.example wrangler.jsonc
```

Edit `wrangler.jsonc` and fill in:
- Your KV namespace ID from step 3 (for both `TOKEN_STORE` and `OAUTH_KV` bindings)
- `ACUMATICA_URL` -- your Acumatica instance URL (e.g., `https://yourcompany.acumatica.com`)
- `ACUMATICA_COMPANY` -- your Acumatica company/tenant name

### 5. Set secrets

```bash
npx wrangler secret put ACUMATICA_CLIENT_ID
npx wrangler secret put ACUMATICA_CLIENT_SECRET
npx wrangler secret put COOKIE_ENCRYPTION_KEY
```

For `COOKIE_ENCRYPTION_KEY`, generate a random 256-bit hex key:

```bash
openssl rand -hex 32
```

### 6. Deploy

```bash
npx wrangler deploy
```

### 7. Local development (optional)

```bash
cp .dev.vars.example .dev.vars
# Edit .dev.vars with your Acumatica credentials
npx wrangler dev
```

## Connecting Claude

### Claude.ai / Claude Desktop

1. Go to **Settings > MCP Servers** (or Claude Desktop's MCP configuration)
2. Add a new remote MCP server with the URL: `https://<your-worker-url>/mcp`
3. On first use, you'll be redirected to your Acumatica login page
4. After authenticating, Claude will have access to all 43 tools

### Claude Code (CLI)

```bash
claude mcp add acumatica-erp --transport streamable-http https://<your-worker-url>/mcp
```

### API (via Anthropic SDK)

When using the Anthropic API with MCP, point the MCP client to `https://<your-worker-url>/mcp`. The server supports OAuth 2.1 with Dynamic Client Registration at `/register`.

## Available Tools

### Core
| Tool | Description |
|------|-------------|
| `acumatica_get_customer` | Customer record with contacts, credit rules, balance |
| `acumatica_get_vendor` | Vendor record with contacts, terms, tax info |
| `acumatica_get_sales_order` | Sales order with line items, totals, shipping |

### Financial / Accounting
| Tool | Description |
|------|-------------|
| `acumatica_get_invoice` | AR invoice with line items and tax details |
| `acumatica_get_bill` | AP bill with line items and PO linkage |
| `acumatica_get_journal_transaction` | GL journal batch with debit/credit details |
| `acumatica_get_payment` | AR payment with applied documents and orders |
| `acumatica_get_account` | GL chart of accounts lookup |
| `acumatica_get_check` | AP check/vendor payment with history |

### Inventory & Warehouse
| Tool | Description |
|------|-------------|
| `acumatica_get_stock_item` | Stock item with pricing, warehouse qty, vendors |
| `acumatica_get_non_stock_item` | Non-stock item (service, labor, expense) |
| `acumatica_get_inventory_quantity_available` | Real-time available quantity across warehouses |
| `acumatica_get_inventory_summary` | Aggregated inventory balances by warehouse |
| `acumatica_get_warehouse` | Warehouse with locations and settings |
| `acumatica_get_item_class` | Item classification defaults |

### Purchasing
| Tool | Description |
|------|-------------|
| `acumatica_get_purchase_order` | PO with line items, vendor, totals |
| `acumatica_get_purchase_receipt` | Receipt with received qty and PO linkage |

### Projects
| Tool | Description |
|------|-------------|
| `acumatica_get_project` | Project header, status, financials |
| `acumatica_get_project_task` | Task within a project |
| `acumatica_get_project_budget` | Budget line with actuals vs budgeted |
| `acumatica_get_project_transaction` | Project cost/revenue transaction details |

### Service & Field
| Tool | Description |
|------|-------------|
| `acumatica_get_case` | Support case with SLA, priority, time tracking |
| `acumatica_get_service_order` | Field service order with details and appointments |
| `acumatica_get_appointment` | Scheduled/actual times, staff, cost/profit |

### Sales & CRM
| Tool | Description |
|------|-------------|
| `acumatica_get_contact` | CRM contact with address, phone, owner |
| `acumatica_get_business_account` | Unified prospect/customer/vendor record |
| `acumatica_get_opportunity` | Sales pipeline deal with products and amounts |
| `acumatica_get_lead` | Marketing lead with status and source |
| `acumatica_get_salesperson` | Sales rep with commission settings |

### Shipping & Fulfillment
| Tool | Description |
|------|-------------|
| `acumatica_get_shipment` | Shipment with packages, tracking, freight |
| `acumatica_get_sales_invoice` | Invoice with SO/shipment linkage |

### HR & Payroll
| Tool | Description |
|------|-------------|
| `acumatica_get_employee` | Employee with contact and financial settings |
| `acumatica_get_expense_claim` | Expense report with line items and approval |
| `acumatica_get_time_entry` | Time tracking with project, billable/overtime |

### CRM Activities
| Tool | Description |
|------|-------------|
| `acumatica_get_email` | Email activity with from/to/body |
| `acumatica_get_event` | Calendar event with attendees |
| `acumatica_get_activity` | General CRM activity |
| `acumatica_get_task` | CRM task with related activities |

### Utility / Discovery
| Tool | Description |
|------|-------------|
| `acumatica_run_inquiry` | Execute any configured Generic Inquiry (GI) with filtering |
| `acumatica_list_entities` | List/search any entity with OData filtering, sorting, field selection |
| `acumatica_describe_entity` | Discover fields, types, and sub-entities for any entity |
| `acumatica_list_generic_inquiries` | List available GIs exposed via OData |
| `acumatica_describe_inquiry` | Infer field schema for a GI before running it |

> **Tip:** Use `acumatica_describe_entity` first to discover available fields, then `acumatica_list_entities` to search/filter. For Generic Inquiries, use `acumatica_list_generic_inquiries` to find GI names and `acumatica_describe_inquiry` to see available fields. See [docs/example-prompts.md](docs/example-prompts.md) for usage patterns.

## Documentation

Detailed documentation is available in the [`docs/`](docs/) folder:

- **[Tool Reference](docs/tool-reference.md)** -- Complete specification for all 43 tools with parameters and endpoints
- **[Example Prompts](docs/example-prompts.md)** -- Example prompts for Claude and other MCP clients organized by use case
- **[OData Filtering Guide](docs/odata-filtering.md)** -- Guide to `$filter`, `$orderby`, `$select`, `$expand`, and `$top` query parameters
- **[Architecture](docs/architecture.md)** -- Detailed architecture, OAuth flow, security model, and design decisions

## Security

- **No stored credentials.** The MCP server does not store Acumatica passwords. It uses OAuth 2.0 authorization code flow -- users authenticate directly with Acumatica.
- **Per-user tokens.** Each user's Acumatica access token is stored in Cloudflare KV, scoped to their username. Tokens are automatically refreshed when expired.
- **Role-based access.** The user's Acumatica role determines which records they can read. If a user doesn't have access to a record in Acumatica, they won't be able to access it through the MCP server either.
- **Read-only.** All current tools are read-only lookups. No data is created, modified, or deleted.
- **Rate limiting.** 3 concurrent requests, 40 requests per minute, and a 500-record cap per query to protect your Acumatica instance.

## Tech Stack

- **Runtime:** [Cloudflare Workers](https://workers.cloudflare.com) + [Durable Objects](https://developers.cloudflare.com/durable-objects/)
- **MCP:** [`agents` SDK](https://www.npmjs.com/package/agents) (McpAgent), [`@modelcontextprotocol/sdk`](https://www.npmjs.com/package/@modelcontextprotocol/sdk)
- **Auth:** [`@cloudflare/workers-oauth-provider`](https://www.npmjs.com/package/@cloudflare/workers-oauth-provider)
- **HTTP routing:** [Hono](https://hono.dev)
- **Language:** TypeScript
- **Validation:** [Zod](https://zod.dev)

## Development

```bash
npx wrangler dev       # Start local dev server
npx tsc --noEmit       # Type check
npx wrangler tail      # Stream live logs from deployed worker
```

## License

Apache 2.0 -- Copyright 2026 Hall Boys, Inc.
