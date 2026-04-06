# Acumatica MCP Server — Claude Code Project Brief

## Objective

Build a remote MCP (Model Context Protocol) server hosted on Cloudflare Workers that connects Claude (via Cowork, Desktop, or API) to our Acumatica ERP 2025 R2 (SaaS) instance via the contract-based REST API.

---

## Architecture Overview

```
Claude Cowork / Desktop
        │
        ▼  (HTTPS — streamable-http transport)
┌──────────────────────────┐
│  Cloudflare Worker        │
│  (MCP Server)             │
│                           │
│  - OAuth provider layer   │
│    (authenticates Claude) │
│  - MCP tool definitions   │
│  - Rate limiter           │
│  - Audit logger           │
│  - Token manager          │
│    (Acumatica OAuth2)     │
└──────────┬───────────────┘
           │
           ▼  (HTTPS — REST API calls)
┌──────────────────────────┐
│  Acumatica 25R2 SaaS      │
│  Contract-Based REST API   │
│  Endpoint: Default/25.200.001 │
└──────────────────────────┘
```

---

## Technology Stack

| Component | Technology | Notes |
|-----------|-----------|-------|
| MCP Server Runtime | Cloudflare Workers | Serverless, global edge |
| MCP Framework | Cloudflare Agents SDK (`McpAgent` class) | Handles remote transport natively |
| Auth (inbound) | `workers-oauth-provider` | Claude → MCP server auth |
| Auth (outbound) | OAuth 2.0 Authorization Code flow | MCP server → Acumatica auth |
| Token Storage | Cloudflare KV or Durable Objects | Persist Acumatica refresh tokens |
| Secrets | Wrangler secrets | Client ID, Client Secret, encryption keys |
| Logging | Cloudflare Workers Logs / Logpush | Audit trail for all tool invocations |
| Language | TypeScript | Best MCP SDK support |

---

## Acumatica API Details

### Base URL Pattern
```
https://<instance>.acumatica.com/entity/Default/25.200.001/
```

### Authentication Setup

Register a Connected Application in Acumatica:
1. Navigate to **Integration → Connected Applications** (SM303010)
2. Set **OAuth 2.0 Flow** to "Authorization Code"
3. On the **Secrets** tab, click **Add Shared Secret** — copy the value immediately
4. Save — the system generates a **Client ID** (format: `GUID@CompanyName`)
5. Configure **Redirect URI** to point to your Worker's `/callback` path
6. Configure **Scopes**: grant `api` scope (do NOT add `api:concurrent_access` unless you handle session cookies)

### OpenAPI Spec Retrieval

Download the full API schema from your instance:
```
https://<instance>.acumatica.com/entity/Default/25.200.001/swagger.json?company=<CompanyName>
```
This returns an OpenAPI 3.0 spec (as of 2024 R2+). Use this to generate MCP tool definitions.

### API Conventions

- All field values are wrapped in `{value: "..."}` objects
- Field names use PascalCase matching screen definitions
- GET = retrieve, POST = create, PUT = update/create, DELETE = remove
- Filter syntax: `$filter=FieldName eq 'value'`
- Expand details: `$expand=Details`
- Custom fields appear in `custom` object within responses
- Actions (release, approve, etc.) are invoked via separate action endpoints

### Key Constraints

- **Concurrent API request limit**: Determined by license tier (e.g., 3 for S-series, 6 for L-series). Check License Monitoring Console (SM604000).
- **Requests per minute**: Also license-dependent; excess requests are throttled or declined.
- **API user sessions**: Each OAuth token consumes an API user slot until it expires.
- **Async operations**: Document release, billing runs, etc. are long-running. Poll for completion using the long-running operation endpoint.

---

## Phase 1: Read-Only Tools (Build First)

Start with GET operations only. No writes until Phase 2.

### Tool Definitions

```typescript
// Tool 1: Customer Lookup
{
  name: "acumatica_get_customer",
  description: "Retrieve customer record by Customer ID. Returns customer name, status, billing/shipping addresses, primary contact, credit terms, and balance.",
  inputSchema: {
    type: "object",
    properties: {
      customerId: { type: "string", description: "Acumatica Customer ID (e.g., 'C000001')" }
    },
    required: ["customerId"]
  }
}
// API: GET /entity/Default/25.200.001/Customer/{customerId}

// Tool 2: Vendor Lookup
{
  name: "acumatica_get_vendor",
  description: "Retrieve vendor record by Vendor ID. Returns vendor name, status, payment terms, tax info, and primary contact.",
  inputSchema: {
    type: "object",
    properties: {
      vendorId: { type: "string", description: "Acumatica Vendor ID (e.g., 'V000001')" }
    },
    required: ["vendorId"]
  }
}
// API: GET /entity/Default/25.200.001/Vendor/{vendorId}

// Tool 3: Sales Order Lookup
{
  name: "acumatica_get_sales_order",
  description: "Retrieve a sales order by order type and order number. Returns header info, line items, totals, shipping details, and status.",
  inputSchema: {
    type: "object",
    properties: {
      orderType: { type: "string", description: "Order type (e.g., 'SO')", default: "SO" },
      orderNbr: { type: "string", description: "Order number" }
    },
    required: ["orderNbr"]
  }
}
// API: GET /entity/Default/25.200.001/SalesOrder/{orderType}/{orderNbr}?$expand=Details

// Tool 4: Stock Item Lookup
{
  name: "acumatica_get_stock_item",
  description: "Retrieve inventory item by Inventory ID. Returns description, item class, pricing, warehouse availability, and status.",
  inputSchema: {
    type: "object",
    properties: {
      inventoryId: { type: "string", description: "Inventory ID / SKU" }
    },
    required: ["inventoryId"]
  }
}
// API: GET /entity/Default/25.200.001/StockItem/{inventoryId}

// Tool 5: GL Account Balance Inquiry
{
  name: "acumatica_get_account_balance",
  description: "Retrieve GL account summary. Returns account description, type, and current balance. Use for quick balance checks.",
  inputSchema: {
    type: "object",
    properties: {
      accountCD: { type: "string", description: "GL Account code (e.g., '10000')" }
    },
    required: ["accountCD"]
  }
}
// API: GET /entity/Default/25.200.001/Account/{accountCD}

// Tool 6: Invoice Lookup
{
  name: "acumatica_get_invoice",
  description: "Retrieve AR invoice by reference number. Returns customer, amounts, due date, payment status, and line details.",
  inputSchema: {
    type: "object",
    properties: {
      referenceNbr: { type: "string", description: "Invoice reference number" },
      docType: { type: "string", description: "Document type", default: "INV" }
    },
    required: ["referenceNbr"]
  }
}
// API: GET /entity/Default/25.200.001/Invoice/{docType}/{referenceNbr}?$expand=Details

// Tool 7: Purchase Order Lookup
{
  name: "acumatica_get_purchase_order",
  description: "Retrieve purchase order by order number. Returns vendor, line items, totals, receipt status.",
  inputSchema: {
    type: "object",
    properties: {
      orderNbr: { type: "string", description: "PO number" },
      orderType: { type: "string", description: "PO type", default: "RO" }
    },
    required: ["orderNbr"]
  }
}
// API: GET /entity/Default/25.200.001/PurchaseOrder/{orderType}/{orderNbr}?$expand=Details

// Tool 8: List/Search Customers
{
  name: "acumatica_search_customers",
  description: "Search or list customers with optional filters. Returns summary list with IDs, names, and status. Use for finding customers before drilling into detail.",
  inputSchema: {
    type: "object",
    properties: {
      filter: { type: "string", description: "OData filter expression (e.g., \"Status eq 'Active'\" or \"CustomerName like '%Acme%'\")" },
      top: { type: "number", description: "Max records to return", default: 20 }
    }
  }
}
// API: GET /entity/Default/25.200.001/Customer?$filter={filter}&$top={top}&$select=CustomerID,CustomerName,Status

// Tool 9: List Open Sales Orders
{
  name: "acumatica_list_open_sales_orders",
  description: "List open (not completed/cancelled) sales orders. Optionally filter by customer or date range.",
  inputSchema: {
    type: "object",
    properties: {
      customerId: { type: "string", description: "Filter by Customer ID (optional)" },
      startDate: { type: "string", description: "Filter orders on or after this date (YYYY-MM-DD)" },
      endDate: { type: "string", description: "Filter orders on or before this date (YYYY-MM-DD)" },
      top: { type: "number", description: "Max records", default: 25 }
    }
  }
}
// API: GET /entity/Default/25.200.001/SalesOrder?$filter=Status eq 'Open'{+ optional filters}&$top={top}

// Tool 10: AP Aging / Open Bills
{
  name: "acumatica_list_open_bills",
  description: "List open (unpaid) AP bills. Optionally filter by vendor. Useful for cash flow and AP aging analysis.",
  inputSchema: {
    type: "object",
    properties: {
      vendorId: { type: "string", description: "Filter by Vendor ID (optional)" },
      top: { type: "number", description: "Max records", default: 25 }
    }
  }
}
// API: GET /entity/Default/25.200.001/Bill?$filter=Status eq 'Open'{+ optional}&$top={top}
```

---

## Phase 2: Write Operations (Build Second — Requires Approval Gates)

**CRITICAL: Every write tool MUST implement a confirmation pattern.** The MCP tool should return a preview of the proposed change and require explicit user confirmation before executing.

### Candidate Write Tools (prioritize based on use case)
- Create Sales Order
- Create AR Invoice
- Create AP Bill
- Create Journal Entry
- Update Customer
- Release Document (async — must poll for completion)
- Create Purchase Order

### Approval Pattern
```
User: "Create a journal entry debiting 6000 to account 60100 and crediting 60200"
  ↓
MCP Tool returns: preview JSON showing the proposed JE with accounts, amounts, date
  ↓
Claude presents: "Here's the journal entry I'll create: [details]. Shall I proceed?"
  ↓
User confirms: "Yes"
  ↓
MCP Tool executes: PUT /entity/Default/25.200.001/JournalTransaction
```

---

## Security Requirements

### 1. Dedicated API User
- Create a dedicated Acumatica user (e.g., `mcp-integration@company.com`)
- Assign a **custom role** with access limited to only the entities/screens the MCP tools need
- Do NOT use admin or any human user's account
- Set maximum allowed sessions appropriately (2-3)

### 2. MCP Server Authentication
- Use `workers-oauth-provider` to require authentication before any tool is invoked
- Options: GitHub OAuth (quick start), or your own identity provider
- The MCP server URL should not be an open endpoint

### 3. Acumatica OAuth Token Lifecycle
```typescript
// Token management pseudocode
async function getAcumaticaToken(env: Env): Promise<string> {
  // 1. Check KV/DO for existing access token
  const stored = await env.TOKEN_STORE.get("acumatica_token", "json");

  if (stored && stored.expires_at > Date.now()) {
    return stored.access_token;
  }

  // 2. If expired, use refresh token to get new access token
  const response = await fetch(`${env.ACUMATICA_URL}/identity/connect/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      client_id: env.ACUMATICA_CLIENT_ID,
      client_secret: env.ACUMATICA_CLIENT_SECRET,
      refresh_token: stored.refresh_token,
    }),
  });

  const tokens = await response.json();

  // 3. Store new tokens
  await env.TOKEN_STORE.put("acumatica_token", JSON.stringify({
    access_token: tokens.access_token,
    refresh_token: tokens.refresh_token,
    expires_at: Date.now() + (tokens.expires_in * 1000),
  }));

  return tokens.access_token;
}
```

### 4. Secrets Configuration
```bash
# Set via Wrangler CLI — never commit to source
wrangler secret put ACUMATICA_CLIENT_ID
wrangler secret put ACUMATICA_CLIENT_SECRET
wrangler secret put COOKIE_ENCRYPTION_KEY    # openssl rand -hex 32
```

### 5. Rate Limiting
Implement in the MCP server to stay within Acumatica license limits:
```typescript
// Simple rate limiter using Cloudflare KV or Durable Objects
const MAX_CONCURRENT = 3;  // Adjust to your license tier
const MAX_PER_MINUTE = 40; // Leave headroom below Acumatica's limit
```

### 6. Audit Logging
Log every MCP tool invocation with:
- Timestamp
- Tool name
- Input parameters (redact sensitive fields)
- Acumatica API endpoint called
- Response status code
- Duration

Use `console.log()` in Workers (appears in Workers Logs) or pipe to Logpush for persistent storage.

---

## Cloudflare Workers Setup

### Project Scaffolding
```bash
npm create cloudflare@latest -- acumatica-mcp-server \
  --template=cloudflare/ai/demos/remote-mcp-authless

cd acumatica-mcp-server
npm install
```

### wrangler.jsonc Configuration
```jsonc
{
  "name": "acumatica-mcp-server",
  "main": "src/index.ts",
  "compatibility_date": "2025-03-01",
  "compatibility_flags": ["nodejs_compat"],

  // Acumatica instance URL (not secret)
  "vars": {
    "ACUMATICA_URL": "https://<your-instance>.acumatica.com",
    "ACUMATICA_COMPANY": "<YourCompanyName>",
    "ACUMATICA_ENDPOINT_VERSION": "25.200.001"
  },

  // KV namespace for token storage
  "kv_namespaces": [
    {
      "binding": "TOKEN_STORE",
      "id": "<your-kv-namespace-id>"
    }
  ],

  // CPU limit — increase if Acumatica responses are slow
  "limits": {
    "cpu_ms": 30000
  }
}
```

### Deploy
```bash
# Local development
npx wrangler dev

# Deploy to production
npx wrangler deploy

# Your MCP server will be at:
# https://acumatica-mcp-server.<your-account>.workers.dev/mcp
```

### Connect from Claude Desktop (for testing)
```json
{
  "mcpServers": {
    "acumatica": {
      "command": "npx",
      "args": [
        "mcp-remote",
        "https://acumatica-mcp-server.<your-account>.workers.dev/mcp"
      ]
    }
  }
}
```

---

## Error Handling

Acumatica returns specific error patterns. Handle these gracefully:

```typescript
// Common Acumatica API errors to handle
const ERROR_HANDLERS = {
  401: "Token expired — trigger refresh and retry once",
  403: "Insufficient permissions — check API user role",
  404: "Record not found — return friendly message, not raw error",
  429: "Rate limited by Acumatica — queue and retry with backoff",
  500: "Acumatica internal error — log full response, return generic message",
  // Acumatica-specific: validation errors return 400 with detailed messages
  400: "Parse response body for field-level validation errors and return them clearly",
};
```

---

## Testing Checklist

- [ ] OAuth flow: Claude → MCP server authentication works
- [ ] OAuth flow: MCP server → Acumatica token acquisition works
- [ ] Token refresh: Expired tokens are refreshed automatically
- [ ] Each Phase 1 tool returns correct data for known test records
- [ ] Rate limiter prevents exceeding Acumatica license limits
- [ ] Error handling: 404 returns friendly "not found" message
- [ ] Error handling: 401 triggers token refresh and retry
- [ ] Error handling: 429 queues and retries
- [ ] Audit log captures tool name, params, status for each invocation
- [ ] MCP Inspector connects and lists all tools
- [ ] Claude Desktop connects via mcp-remote and can invoke tools
- [ ] Claude Cowork connects directly to the remote URL

---

## File Structure

```
acumatica-mcp-server/
├── src/
│   ├── index.ts              # Worker entry point, MCP server setup
│   ├── tools/                # MCP tool definitions
│   │   ├── customers.ts      # Customer lookup & search
│   │   ├── vendors.ts        # Vendor lookup
│   │   ├── sales-orders.ts   # Sales order tools
│   │   ├── invoices.ts       # AR invoice tools
│   │   ├── bills.ts          # AP bill tools
│   │   ├── inventory.ts      # Stock item tools
│   │   ├── gl-accounts.ts    # GL account tools
│   │   └── purchase-orders.ts
│   ├── auth/
│   │   ├── acumatica-oauth.ts # Acumatica token management
│   │   └── mcp-auth.ts        # Inbound MCP authentication
│   ├── lib/
│   │   ├── acumatica-client.ts # HTTP client wrapper for Acumatica API
│   │   ├── rate-limiter.ts     # Concurrency & rate limiting
│   │   └── logger.ts           # Audit logging
│   └── types/
│       └── acumatica.ts        # TypeScript types from OpenAPI spec
├── wrangler.jsonc
├── package.json
├── tsconfig.json
└── README.md
```

---

## Known Gotchas

1. **Acumatica field value wrapping**: Every field value in API responses is `{value: "actual_value"}`, not a plain value. Your tools must unwrap these before returning to Claude, or Claude will see noisy JSON.

2. **OpenAPI spec quirks**: The swagger.json may not perfectly match actual response shapes (e.g., `_links` objects in responses not in spec). Test against real data.

3. **Long-running operations**: Release, billing, and similar actions return a `202 Accepted` with a location header for polling. Do not block — implement async polling.

4. **Session cookies with `concurrent_access` scope**: If using `api:concurrent_access` scope, Acumatica tracks sessions via cookies. You must pass cookies back on subsequent requests or each request counts as a new session. Recommendation: use plain `api` scope and rely on stateless tokens.

5. **Custom fields**: If your Acumatica instance has custom fields, they won't appear in the default endpoint. You may need to create a custom endpoint extension in Acumatica (SM207060) to expose them.

6. **Cloudflare Workers runtime**: This is V8-based, NOT Node.js. Most npm packages work, but anything requiring Node-specific APIs (fs, net, etc.) will not. The `fetch` API is native and preferred.

7. **$expand depth**: Acumatica limits expand depth. If you need nested details (e.g., SO → line items → allocations), you may need multiple API calls.

---

## References

- Acumatica REST API Help: `https://help.acumatica.com/` → Integration Development
- Acumatica OpenAPI Spec: `https://<instance>/entity/Default/25.200.001/swagger.json`
- Cloudflare Remote MCP Guide: `https://developers.cloudflare.com/agents/guides/remote-mcp-server/`
- Cloudflare Agents SDK: `https://developers.cloudflare.com/agents/`
- `workers-oauth-provider`: `https://github.com/cloudflare/workers-oauth-provider`
- CData Acumatica MCP (reference): `https://github.com/CDataSoftware/acumatica-mcp-server-by-cdata`
- MCP Specification: `https://modelcontextprotocol.io`
- Acumatica REST Client (C# reference): `https://github.com/Acumatica/AcumaticaRESTAPIClientForCSharp`
