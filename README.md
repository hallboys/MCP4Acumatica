# MCP4Acumatica

> **Disclaimer:** This project is an independent, community-built integration and is **not affiliated with, endorsed by, or supported by Acumatica, Inc.** "Acumatica" is a registered trademark of Acumatica, Inc. Use of the Acumatica name and API is for interoperability purposes only.

A remote [Model Context Protocol](https://modelcontextprotocol.io) (MCP) server that connects Claude to [Acumatica ERP](https://www.acumatica.com) 2025 R2. Runs on Cloudflare Workers with per-user OAuth authentication against your Acumatica instance.

Each user authenticates with their own Acumatica credentials. Their Acumatica role controls which records they can access. The MCP server additionally requires a specific Acumatica role for access, shows a consent interstitial, and automatically redacts sensitive fields before data reaches the AI model.

## Features

- **48 tools** -- 38 read-only lookups + 6 utility/discovery + 4 schema-knowledge tools (see [Available Tools](#available-tools))
- **Per-user OAuth** -- users log in with their Acumatica credentials (or SSO)
- **Role-based access** -- Acumatica's security model governs what each user sees
- **Role gate** -- only users with a designated Acumatica role (e.g., `MCP Access`) can connect
- **Consent interstitial** -- users must acknowledge AI data processing before accessing tools
- **Sensitive field redaction** -- SSN, bank accounts, salary, and other PII fields are automatically redacted before data leaves the server
- **Rate limiting** -- 3 concurrent requests, 40 requests/minute per user
- **Pagination refusal** -- list/query tools return a structured `{ truncated, paginationSupported: false, actionRequired }` envelope when results hit the record cap, instructing the AI to ask the user for a narrower filter rather than calling the tool again
- **Structured audit logging** -- all tool invocations, auth events, and field redactions are logged
- **Admin console** -- web-based admin interface at `/docs/admin` for viewing logs and managing runtime settings without redeploying
- **Long-term log retention** -- R2-backed log storage via Cloudflare Logpush with searchable log viewer

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
|      (role gate + OIDC userinfo) |
|    /consent   -> AI data consent |
|    /token, /register (DCR)       |
|    /mcp -> McpAgent DO (48 tools)|
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
  - A **Connected Application** configured in SM303010 with the **Authorization Code** OAuth 2.0 flow (scopes are sent by the server in the request, not configured on the app)
  - A redirect URI pointing to your worker's `/callback` endpoint
  - An **`MCP Access` role** (SM201005) -- a marker role with no permissions required
  - An **`MCPAccess` Generic Inquiry** (SM208000) -- a trivial GI assigned only to the `MCP Access` role, with **Expose via OData** enabled (see [Architecture docs](docs/architecture.md) for details)

## Setup

There are three install paths. All three rely on the same Acumatica-side prerequisites — finish those first (see "[Acumatica-side configuration](#acumatica-side-configuration)" below) regardless of which path you pick.

| Path | Best for | Terminal needed? |
|------|----------|------------------|
| **A. Deploy to Cloudflare button** | Adopters who want a fully GUI install | No |
| **B. One-line installer** | Developers who already have `git` / `node` / `npm` | Yes (one command) |
| **C. Manual setup** | Anyone who wants to inspect each step | Yes |

### Path A — Deploy to Cloudflare button (no terminal)

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/hallboys/MCP4Acumatica)

The button forks this repo to your GitHub account, reads `wrangler.jsonc`, auto-creates the KV namespace and R2 bucket, prompts for secrets, and deploys. Step-by-step:

1. **Click the button.** Cloudflare will ask you to sign in (or create an account) and authorize a GitHub fork.
2. **Confirm bindings.** You'll be prompted to create KV namespaces **twice** — once for the `TOKEN_STORE` binding (app data: tokens, OAuth state, cache, config, admin sessions) and once for `OAUTH_KV` (used internally by the OAuth library). This is expected: they're two separate bindings and never share keys, so accept **"+ Create new"** for both. Give them distinct names (e.g. `mcp4acumatica` and `mcp4acumatica-oauth`) so they're easy to tell apart in the dashboard later — using the same name for both works but is confusing. The R2 buckets (`mcp4acumatica-logs`, `mcp4acumatica-index`) are created the same way. (The terminal install paths point both KV bindings at a single namespace for convenience; the GUI can't do that in one pass, but two namespaces are functionally identical.)
3. **Set secrets.** When prompted, paste:
   - `ACUMATICA_CLIENT_ID` — from your Connected Application (SM303010)
   - `ACUMATICA_CLIENT_SECRET` — from the same screen
   - `COOKIE_ENCRYPTION_KEY` — open your browser console on any page and run:
     ```js
     [...crypto.getRandomValues(new Uint8Array(32))].map(b => b.toString(16).padStart(2,'0')).join('')
     ```
     Copy the resulting 64-character hex string.
   - `ADMIN_SECRET` — any password you'll remember (protects the `/docs/admin` console). Generate one with `[...crypto.getRandomValues(new Uint8Array(24))].map(b => b.toString(16).padStart(2,'0')).join('')` if you don't have a preference.
4. **Deploy.** Cloudflare connects the fork to Workers Builds and pushes the first deployment.
5. **Update the Acumatica vars.** After the deploy completes, open `Workers & Pages → mcp4acumatica → Settings → Variables and Secrets` in the Cloudflare dashboard and edit:
   - `ACUMATICA_URL` (e.g. `https://yourcompany.acumatica.com`)
   - `ACUMATICA_TENANT` (your login company)
   - Optionally `ACUMATICA_MAX_RECORDS`, `ACUMATICA_MCP_ROLE`, `REDACT_PATTERNS`, `REDACT_SKIP`
   Click **Save and Deploy** — Cloudflare redeploys with the new values.
6. **Add a redirect URI to your Connected Application.** Your worker is now reachable at `https://mcp4acumatica.<your-account>.workers.dev`. Add `https://<that-host>/callback` to the redirect URIs in Acumatica's SM303010 screen. (To use a custom domain instead, see "[Custom domain](#custom-domain-optional)" below.)
7. **Test the deploy.** Visit `https://<your-host>/docs/admin/preflight`, log in with your `ADMIN_SECRET`, and run the preflight diagnostic. It probes Acumatica connectivity, the OIDC discovery endpoint, the Connected App credentials, the tenant path, and the contract API version — any misconfiguration is called out by name.

After this point Claude can connect (see "[Connecting Claude](#connecting-claude)" below).

### Path B — One-line installer (terminal)

If you already have `git`, `node`, and `npm`, run:

```bash
curl -fsSL https://mcp4acumatica.hallboys.com/install.sh | bash
```

This clones the repo, installs dependencies, and runs `./setup.sh`. The setup script prompts for the Acumatica values you must supply (URL, tenant, Connected App client ID and secret), auto-generates the crypto secrets, creates the KV namespace and R2 bucket, uploads secrets, deploys, and then runs the preflight check.

If you prefer to inspect the script first:

```bash
curl -fsSL https://mcp4acumatica.hallboys.com/install.sh -o install.sh
less install.sh   # read it
bash install.sh   # then run
```

### Path C — Manual setup (terminal)

#### 1. Clone and install

```bash
git clone https://github.com/hallboys/MCP4Acumatica.git
cd MCP4Acumatica
npm install
```

#### 2. Create KV namespace

```bash
npx wrangler kv namespace create TOKEN_STORE
```

Note the namespace ID from the output — you'll paste it into `wrangler.jsonc` next. The same ID is used for both the `TOKEN_STORE` and `OAUTH_KV` bindings.

#### 3. Configure wrangler

`wrangler.jsonc` is tracked in the repo as the deploy template. Edit it in place and fill in:

- The KV namespace ID from step 2 (both `TOKEN_STORE` and `OAUTH_KV` bindings — same id)
- `ACUMATICA_URL` — your Acumatica instance URL (e.g. `https://yourcompany.acumatica.com`)
- `ACUMATICA_TENANT` — your Acumatica company/tenant name

To keep your local values out of `git status` (so you can still pull updates without conflicts):

```bash
git update-index --skip-worktree wrangler.jsonc
```

#### 4. Set secrets

```bash
npx wrangler secret put ACUMATICA_CLIENT_ID
npx wrangler secret put ACUMATICA_CLIENT_SECRET
npx wrangler secret put COOKIE_ENCRYPTION_KEY      # use `openssl rand -hex 32`
npx wrangler secret put ADMIN_SECRET                # any password — protects /docs/admin
```

#### 5. Deploy

```bash
npx wrangler deploy
```

#### 6. Local development (optional)

```bash
cp .dev.vars.example .dev.vars
# Edit .dev.vars with your Acumatica credentials
npx wrangler dev
```

### Acumatica-side configuration

These steps are required regardless of which install path you pick. They can't be automated — Acumatica's API doesn't expose them.

#### Connected Application (SM303010)

1. In Acumatica: **System > Integration > Connected Applications (SM303010)**.
2. Create a new Connected Application.
3. Set the **OAuth 2.0 Flow** to **Authorization Code**.
4. Add a redirect URI: `https://<your-worker-url>/callback` (use the `*.workers.dev` hostname or your custom domain).
5. Note the **Client ID** and **Client Secret** — you'll provide these as secrets during deploy.

> There is no scope field to configure here. OAuth scopes (`api openid profile email offline_access`, including the `offline_access` that makes Acumatica issue refresh tokens) are sent by the MCP server in the authorization request — they aren't set on the Connected Application.

#### Role and Generic Inquiry (SM201005, SM208000)

The MCP server requires users to have a specific Acumatica role before they can access AI tools. This is enforced via a canary Generic Inquiry (GI) that is assigned only to that role.

1. **Create role:** **System > Access Rights > User Roles (SM201005)** → create a role named `MCP Access`. No screen permissions are needed — it's purely a marker role.
2. **Create Generic Inquiry:** **System > Customization > Generic Inquiry (SM208000)** → create a GI named `MCPAccess` with any trivial query (a single column from any table is fine). Assign it only to the `MCP Access` role. Enable **Expose via OData**.
3. **Assign role to users:** Assign the `MCP Access` role to each Acumatica user who should have AI assistant access.

> The role name is configurable via the `ACUMATICA_MCP_ROLE` variable. Edit it in the Cloudflare dashboard (`Variables and Secrets`) or in `wrangler.jsonc`.

### Custom domain (optional)

The deploy gives you a `*.workers.dev` hostname out of the box. To attach a branded hostname:

- **Via the Cloudflare dashboard:** `Workers & Pages → mcp4acumatica → Settings → Domains & Routes → Add`. The domain's zone must be on your Cloudflare account.
- **Via `wrangler.jsonc`:** uncomment the `routes` block at the top of the file, edit `pattern` and `zone_name`, redeploy.

If you change hostnames, remember to add the new `https://<host>/callback` to your Connected Application's redirect URIs in SM303010.

## Connecting Claude

### Claude.ai / Claude Desktop

1. Go to **Settings > Connectors**
2. Click **Add Connector** and enter the URL: `https://<your-worker-url>/mcp`
3. On first use, you'll be redirected to your Acumatica login page
4. If your account has the `MCP Access` role, you'll see a consent page explaining AI data processing
5. After acknowledging consent, Claude will have access to all 48 tools

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
| `acumatica_clear_cache` | Clear cached metadata when schemas change |

> **Tip:** Use `acumatica_describe_entity` first to discover available fields, then `acumatica_list_entities` to search/filter. For Generic Inquiries, use `acumatica_list_generic_inquiries` to find GI names and `acumatica_describe_inquiry` to see available fields. See [docs/example-prompts.md](docs/example-prompts.md) for usage patterns.

## Documentation

Detailed documentation is available in the [`docs/`](docs/) folder:

- **[Tool Reference](docs/tool-reference.md)** -- Complete specification for all 48 tools with parameters and endpoints
- **[Example Prompts](docs/example-prompts.md)** -- Example prompts for Claude and other MCP clients organized by use case
- **[OData Filtering Guide](docs/odata-filtering.md)** -- Guide to `$filter`, `$orderby`, `$select`, `$expand`, and `$top` query parameters
- **[Schema Knowledge](docs/schema-discovery.md)** -- Offline schema-discovery tools for building integrations/customizations, and how the schema index is built
- **[Architecture](docs/architecture.md)** -- Detailed architecture, OAuth flow, security model, and design decisions
- **[Self-Hosting Guide](docs/self-hosting-guide.md)** -- How to run the MCP server on Node.js or other platforms outside Cloudflare
- **[Upgrading Acumatica](docs/upgrading-acumatica.md)** -- Steps to take when changing or upgrading the connected Acumatica version

## Security

- **No stored credentials.** The MCP server does not store Acumatica passwords. It uses OAuth 2.0 authorization code flow -- users authenticate directly with Acumatica.
- **Per-user tokens.** Each user's Acumatica access token is stored in the platform key-value store (Cloudflare KV on the default deployment), scoped to their username. Tokens are automatically refreshed when expired. If a refresh token expires, the connection re-authenticates automatically instead of requiring a manual reconnect.
- **Role gate.** Only users with the `MCP Access` role (configurable) can connect. This is enforced via a canary Generic Inquiry check during login -- users without the role see an access denied page.
- **Consent interstitial.** After passing the role check, users must acknowledge that their data will be processed by an external AI model before the MCP session activates.
- **Sensitive field redaction.** Tool responses are automatically scanned for sensitive field names (SSN, bank accounts, salary, credit card, etc.) and matched values are replaced with `[REDACTED]`. Patterns are configurable via `REDACT_PATTERNS` and `REDACT_SKIP` environment variables.
- **Role-based access.** The user's Acumatica role determines which records they can read. If a user doesn't have access to a record in Acumatica, they won't be able to access it through the MCP server either.
- **Read-only.** All current tools are read-only lookups. No data is created, modified, or deleted.
- **Rate limiting.** 3 concurrent requests, 40 requests per minute, and a configurable record cap per query to protect your Acumatica instance.
- **Pagination refusal.** The list/query tools (`acumatica_list_entities`, `acumatica_run_inquiry`, `acumatica_list_generic_inquiries`) do not support pagination. When a response hits `ACUMATICA_MAX_RECORDS`, the tool returns a structured envelope (`truncated: true`, `paginationSupported: false`, `actionRequired: "..."`) instructing the AI to stop and ask the user for a narrower filter rather than retrieving more records.
- **Audit logging.** All tool invocations, auth events (login success/denied, consent accepted), and field redaction events are logged as structured JSON. View with `npx wrangler tail`.

## Platform Portability

While the default deployment targets Cloudflare Workers, the tool handlers and core libraries are platform-agnostic. A storage abstraction (`IKeyValueStore` interface + `AppEnv` type) decouples tool logic from Cloudflare-specific APIs, enabling self-hosted deployments on Node.js with Redis, SQLite, or other storage backends. See the [Self-Hosting Guide](docs/self-hosting-guide.md) for details.

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
