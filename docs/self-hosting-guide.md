# MCP4Acumatica -- Self-Hosting Guide

How to run the MCP4Acumatica server outside Cloudflare Workers -- on Node.js, Docker, or any platform that supports TypeScript/JavaScript.

## Overview

The default deployment uses Cloudflare Workers, Durable Objects, and KV. However, the tool handlers and core libraries are designed to be **platform-agnostic**. Two abstractions make this possible:

| Abstraction | File | Purpose |
|-------------|------|---------|
| `IKeyValueStore` | `src/lib/kv-store.ts` | Platform-agnostic key-value storage interface |
| `AppEnv` | `src/types/acumatica.ts` | Portable environment type (Acumatica config + store) |

All 44 tool handlers, the `AcumaticaClient`, config system, metadata cache, and token management use `AppEnv` -- they never import Cloudflare-specific types.

---

## What's Portable vs. What's Not

### Portable (reuse as-is)

These files use `AppEnv` and `IKeyValueStore` -- no Cloudflare dependencies:

| File(s) | Purpose |
|---------|---------|
| `src/tools/*.ts` (36 files) | All 44 tool handlers |
| `src/lib/acumatica-client.ts` | HTTP client for Acumatica REST API |
| `src/auth/acumatica-oauth.ts` | Per-user token storage and refresh |
| `src/lib/config.ts` | Runtime config with env var fallback |
| `src/lib/metadata-cache.ts` | Schema and GI metadata caching |
| `src/lib/rate-limiter.ts` | In-memory rate limiting |
| `src/lib/redact.ts` | Sensitive field redaction |
| `src/lib/logger.ts` | Structured JSON audit logging |
| `src/lib/kv-store.ts` | `IKeyValueStore` interface |
| `src/types/acumatica.ts` | `AppEnv` type + all entity types |

### Cloudflare-Specific (must be replaced)

| File | Purpose | Self-Host Replacement |
|------|---------|----------------------|
| `src/index.ts` | McpAgent DO, OAuthProvider wrapper, tool registration | New entry point using `@modelcontextprotocol/sdk` Server |
| `src/platform/cloudflare-kv-store.ts` | Wraps KVNamespace as IKeyValueStore | Your own IKeyValueStore implementation |
| `src/auth/acumatica-auth-handler.ts` | Acumatica OAuth flow (Hono + CF helpers) | Your own auth flow (or skip for single-tenant) |
| `src/admin/admin-handler.ts` | Admin console web UI | Optional -- can be omitted |
| `src/docs/docs-handler.ts` | Documentation site | Optional -- can be omitted |

---

## Step-by-Step: Node.js Self-Hosted Adapter

### 1. Implement `IKeyValueStore`

Choose a storage backend and implement the interface from `src/lib/kv-store.ts`:

```typescript
interface IKeyValueStore {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>;
  delete(key: string): Promise<void>;
  list(options: { prefix: string; cursor?: string }): Promise<{
    keys: Array<{ name: string }>;
    list_complete: boolean;
    cursor?: string;
  }>;
}
```

#### Option A: In-Memory (simplest, for development)

```typescript
import type { IKeyValueStore } from "../lib/kv-store";

export class InMemoryStore implements IKeyValueStore {
  private data = new Map<string, { value: string; expiresAt?: number }>();

  async get(key: string): Promise<string | null> {
    const entry = this.data.get(key);
    if (!entry) return null;
    if (entry.expiresAt && Date.now() > entry.expiresAt) {
      this.data.delete(key);
      return null;
    }
    return entry.value;
  }

  async put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void> {
    this.data.set(key, {
      value,
      expiresAt: options?.expirationTtl
        ? Date.now() + options.expirationTtl * 1000
        : undefined,
    });
  }

  async delete(key: string): Promise<void> {
    this.data.delete(key);
  }

  async list(options: { prefix: string; cursor?: string }): Promise<{
    keys: Array<{ name: string }>;
    list_complete: boolean;
    cursor?: string;
  }> {
    const keys = [...this.data.keys()]
      .filter((k) => k.startsWith(options.prefix))
      .map((name) => ({ name }));
    return { keys, list_complete: true };
  }
}
```

#### Option B: Redis (production)

```typescript
import type { IKeyValueStore } from "../lib/kv-store";
import Redis from "ioredis";

export class RedisStore implements IKeyValueStore {
  constructor(private redis: Redis) {}

  async get(key: string): Promise<string | null> {
    return this.redis.get(key);
  }

  async put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void> {
    if (options?.expirationTtl) {
      await this.redis.set(key, value, "EX", options.expirationTtl);
    } else {
      await this.redis.set(key, value);
    }
  }

  async delete(key: string): Promise<void> {
    await this.redis.del(key);
  }

  async list(options: { prefix: string; cursor?: string }): Promise<{
    keys: Array<{ name: string }>;
    list_complete: boolean;
    cursor?: string;
  }> {
    const startCursor = options.cursor || "0";
    const [nextCursor, results] = await this.redis.scan(
      parseInt(startCursor),
      "MATCH", `${options.prefix}*`,
      "COUNT", 100
    );
    return {
      keys: results.map((name) => ({ name })),
      list_complete: nextCursor === "0",
      cursor: nextCursor === "0" ? undefined : nextCursor,
    };
  }
}
```

#### Option C: SQLite (lightweight production)

```typescript
import type { IKeyValueStore } from "../lib/kv-store";
import Database from "better-sqlite3";

export class SQLiteStore implements IKeyValueStore {
  private db: Database.Database;

  constructor(dbPath: string) {
    this.db = new Database(dbPath);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS kv (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        expires_at INTEGER
      )
    `);
  }

  async get(key: string): Promise<string | null> {
    const row = this.db.prepare(
      "SELECT value FROM kv WHERE key = ? AND (expires_at IS NULL OR expires_at > ?)"
    ).get(key, Date.now()) as { value: string } | undefined;
    return row?.value ?? null;
  }

  async put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void> {
    const expiresAt = options?.expirationTtl
      ? Date.now() + options.expirationTtl * 1000
      : null;
    this.db.prepare(
      "INSERT OR REPLACE INTO kv (key, value, expires_at) VALUES (?, ?, ?)"
    ).run(key, value, expiresAt);
  }

  async delete(key: string): Promise<void> {
    this.db.prepare("DELETE FROM kv WHERE key = ?").run(key);
  }

  async list(options: { prefix: string; cursor?: string }): Promise<{
    keys: Array<{ name: string }>;
    list_complete: boolean;
    cursor?: string;
  }> {
    const rows = this.db.prepare(
      "SELECT key FROM kv WHERE key LIKE ? AND (expires_at IS NULL OR expires_at > ?)"
    ).all(`${options.prefix}%`, Date.now()) as Array<{ key: string }>;
    return {
      keys: rows.map((r) => ({ name: r.key })),
      list_complete: true,
    };
  }
}
```

### 2. Build an `AppEnv`

Construct the portable environment from your config source (env vars, config file, etc.):

```typescript
import type { AppEnv } from "./types/acumatica";
import { InMemoryStore } from "./platform/in-memory-store";
// or: import { RedisStore } from "./platform/redis-store";

const store = new InMemoryStore();
// or: const store = new RedisStore(new Redis(process.env.REDIS_URL));

const appEnv: AppEnv = {
  ACUMATICA_URL: process.env.ACUMATICA_URL!,
  ACUMATICA_TENANT: process.env.ACUMATICA_TENANT!,
  ACUMATICA_ENDPOINT_VERSION: process.env.ACUMATICA_ENDPOINT_VERSION || "25.200.001",
  ACUMATICA_MAX_RECORDS: process.env.ACUMATICA_MAX_RECORDS || "1000",
  ACUMATICA_CLIENT_ID: process.env.ACUMATICA_CLIENT_ID!,
  ACUMATICA_CLIENT_SECRET: process.env.ACUMATICA_CLIENT_SECRET!,
  COOKIE_ENCRYPTION_KEY: process.env.COOKIE_ENCRYPTION_KEY!,
  store,
  tokenProvider,  // see step 2b
};
```

### 2b. Implement `ITokenProvider` (token-refresh serialization)

`AppEnv` requires a `tokenProvider: ITokenProvider` (`src/lib/token-provider.ts`) — a `getAccessToken(username)` that returns a fresh access token. **This must serialize refreshes per user.** Acumatica's IdentityServer rotates the refresh token on every use, so two concurrent refreshes of the same user's token race: the loser submits an already-rotated token and is rejected. On Cloudflare a per-user Durable Object provides the lock for free; self-hosted you supply your own.

The shared `refreshAcumaticaToken(config, refreshToken, username)` helper (exported from `src/auth/acumatica-oauth.ts`) does the HTTP call + transient-vs-permanent classification; your provider only needs to add storage + a per-user lock around it. Sketch with a Redis lock:

```typescript
import type { ITokenProvider, TokenResult } from "./lib/token-provider";
import { refreshAcumaticaToken } from "./auth/acumatica-oauth";

class LockingTokenProvider implements ITokenProvider {
  constructor(private store: IKeyValueStore, private redis: Redis, private cfg: { url: string; clientId: string; clientSecret: string; cookieKey: string }) {}

  async getAccessToken(username: string): Promise<TokenResult> {
    // 1. read stored token; if access token has >60s life, return { status: "ok", accessToken }
    // 2. acquire a per-user lock (e.g. SET lock:{username} NX PX 10000, spin/back-off if held)
    // 3. re-read inside the lock (another holder may have just refreshed)
    // 4. call refreshAcumaticaToken(this.cfg, decrypt(stored.refresh_token), username)
    //    - "ok"        → persist new (encrypted) token, return { status: "ok", accessToken }
    //    - "reauth"    → return { status: "reauth", message }
    //    - "transient" → return { status: "transient", message }
    // 5. release the lock
  }
}
```

The CF reference implementation is `src/platform/do-token-provider.ts` + `src/token-manager.ts`.

### 3. Wire Up the MCP Server

Use `@modelcontextprotocol/sdk` directly (not the `agents` SDK, which requires Cloudflare DO):

```typescript
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import express from "express";

// Import the shared getter registry and the utility-tool handlers.
// These modules are fully portable — they take AppEnv (not the Cloudflare Env)
// and never touch worker-specific bindings.
import { GETTER_TOOLS, paramsShape, runGetter } from "./tools/getter-registry";
import { handleListEntities } from "./tools/entity-list";
import { handleDescribeEntity } from "./tools/entity-schema";
import { handleRunInquiry } from "./tools/generic-inquiries";
import {
  handleListGenericInquiries,
  handleDescribeInquiry,
} from "./tools/generic-inquiry-discovery";
import { handleClearCache } from "./tools/clear-cache";

const app = express();
app.use(express.json());

// Create MCP server
const server = new McpServer({
  name: "mcp4acumatica",
  version: "0.30.1",
});

// Register all 38 per-entity getter tools from the shared registry. This is
// the same loop used in src/index.ts — adding a new single-record lookup is a
// new entry in GETTER_TOOLS, not a new server.tool(...) block.
for (const spec of GETTER_TOOLS) {
  server.tool(
    spec.name,
    spec.description,
    paramsShape(spec.params),
    async (args: Record<string, string | undefined>) => {
      try {
        const result = await runGetter(spec, appEnv, username, args);
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      } catch (error) {
        return { content: [{ type: "text", text: `Error: ${(error as Error).message}` }] };
      }
    }
  );
}

// Register the 6 utility/discovery tools (acumatica_list_entities,
// acumatica_describe_entity, acumatica_run_inquiry,
// acumatica_list_generic_inquiries, acumatica_describe_inquiry,
// acumatica_clear_cache). Each takes AppEnv + username and ports without
// modification — copy the corresponding server.tool(...) blocks from
// src/index.ts (the Zod schemas and descriptions are identical).

// MCP endpoint
app.post("/mcp", async (req, res) => {
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);
});

app.listen(3000, () => {
  console.log("MCP server listening on http://localhost:3000/mcp");
});
```

### 4. Handle Authentication

For the Cloudflare deployment, authentication is handled by `@cloudflare/workers-oauth-provider` + `acumatica-auth-handler.ts`. For self-hosting, you have several options:

#### Option A: No Auth (Single-User / Local)

If running locally or for a single user, you can pre-seed the token store and hardcode the username:

```typescript
// Pre-seed a token (obtained via Acumatica's OAuth playground or manual flow)
await store.put("user_token:admin@mycompany.com", JSON.stringify({
  access_token: "your-access-token",
  refresh_token: "your-refresh-token",
  expires_at: Date.now() + 3600 * 1000,
}));

const username = "admin@mycompany.com";
```

#### Option B: Express + Passport (Multi-User)

Implement the Acumatica OAuth 2.0 authorization code flow using Passport.js or a custom Express middleware. The flow is:

1. Redirect user to `{ACUMATICA_URL}/identity/connect/authorize` with `scope=api openid profile email offline_access` (**`offline_access` is required** — without it Acumatica issues no refresh token, so sessions die when the ~1h access token expires; scopes are sent here in the request, not configured on the Connected Application)
   - **Keep the scope as `api`, not `api:concurrent_access`.** Under `api`, each access token is a single Acumatica session that closes automatically when the token expires (~1h), so the stateless client (no session-cookie reuse, no logout) never leaks API-user seats. Under `api:concurrent_access`, every cookie-less request counts as a *new* session and exhausts the license's API-user seats in seconds unless you also implement a cookie jar + explicit `/entity/auth/logout`. See [Acumatica Session & License Model](architecture.md#acumatica-session--license-model).
2. Handle the callback, exchange the code for tokens at `{ACUMATICA_URL}/identity/connect/token`
3. Store the tokens via `store.put("user_token:{username}", ...)`
4. Attach the username to the MCP session

The shared `refreshAcumaticaToken()` helper in `src/auth/acumatica-oauth.ts` performs the refresh + transient/permanent classification; your `ITokenProvider` (step 2b) wraps it with per-user serialization. Provided you requested `offline_access`, refresh works for free.

#### Option C: MCP Protocol Auth

The MCP specification supports OAuth 2.1. You can implement the MCP auth flow using libraries like `oidc-provider` for Node.js. This is the most complete option but requires the most setup.

---

## Key Patterns in the Codebase

Understanding these patterns will help you wire things up correctly.

### Token Storage Keys

| Key Pattern | Purpose | TTL |
|-------------|---------|-----|
| `user_token:{username}` | Per-user Acumatica OAuth tokens | None (refreshed on expiry) |
| `config:{key}` | Runtime config overrides | None |
| `cache:schema:{entityName}` | Cached entity schemas | 24 hours |
| `cache:gi_list` | Cached GI service document | 1 hour |
| `cache:gi_metadata` | Cached GI OData metadata | 1 hour |
| `cache:gi_schema:{giName}` | Cached GI field schemas | 1 hour |

The auth handler (Cloudflare-specific) also uses `acumatica_state:{state}` (10 min TTL) and `consent:{id}` (5 min TTL) for OAuth flow state.

### Tool Handler Signature

Every tool handler follows the same pattern:

```typescript
export async function handleGetXxx(
  env: AppEnv,
  acumaticaUsername: string,
  args: { /* tool-specific params */ }
): Promise<unknown>
```

They create an `AcumaticaClient(env, username)` internally, make HTTP calls to Acumatica, and return unwrapped JSON. They never access storage directly (except the 3 caching/discovery tools which use `getCached`/`setCached` with `env.store`).

### Error Handling

The Cloudflare deployment wraps tool calls in `callTool()` which catches `AcumaticaApiError` and `RateLimitError`, applies field redaction, and formats MCP responses. You'll want to replicate this wrapper:

```typescript
import { AcumaticaApiError } from "./lib/acumatica-client";
import { RateLimitError } from "./lib/rate-limiter";
import { redactFields } from "./lib/redact";

async function callTool(fn: () => Promise<unknown>) {
  try {
    const result = await fn();
    const { data, redactedFields } = redactFields(result);
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  } catch (error) {
    const message = error instanceof AcumaticaApiError ? error.message
      : error instanceof RateLimitError ? error.message
      : error instanceof Error ? error.message
      : "An unexpected error occurred.";
    return { content: [{ type: "text", text: `Error: ${message}` }] };
  }
}
```

---

## Docker Deployment Example

```dockerfile
FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --production
COPY src/ ./src/
COPY tsconfig.json ./
RUN npx tsc
EXPOSE 3000
CMD ["node", "dist/server.js"]
```

```yaml
# docker-compose.yml
services:
  mcp:
    build: .
    ports:
      - "3000:3000"
    environment:
      - ACUMATICA_URL=https://yourcompany.acumatica.com
      - ACUMATICA_TENANT=Production
      - ACUMATICA_ENDPOINT_VERSION=25.200.001
      - ACUMATICA_MAX_RECORDS=1000
      - ACUMATICA_CLIENT_ID=your-client-id
      - ACUMATICA_CLIENT_SECRET=your-client-secret
      - COOKIE_ENCRYPTION_KEY=your-random-hex-key
      - REDIS_URL=redis://redis:6379
    depends_on:
      - redis
  redis:
    image: redis:7-alpine
    volumes:
      - redis-data:/data
volumes:
  redis-data:
```

---

## FAQ

**Q: Do I need to copy all 36 tool files?**
A: Yes, but they work as-is. No modifications needed. Just import them and register each tool with your MCP server using the same Zod schemas from the Cloudflare `index.ts`.

**Q: Can I use only some tools?**
A: Absolutely. Each tool file is independent. Import only what you need.

**Q: What about the admin console?**
A: The admin console (`src/admin/admin-handler.ts`) is Cloudflare-specific and optional. For self-hosted, manage config via environment variables or direct store writes.

**Q: What about the access gate and consent?**
A: These are implemented in `src/auth/acumatica-auth-handler.ts` (CF-specific). For self-hosted, you can implement equivalent checks in your auth middleware, or skip them for trusted environments.

**Q: Does `expirationTtl` matter for my store implementation?**
A: Yes for caching (prevents stale data) and OAuth state (security). For tokens, TTL is not used -- expiration is handled by checking `expires_at` in the stored token JSON. If your store doesn't support automatic expiration, you can handle it in the `get()` method (check timestamp, return null if expired).

**Q: Will the token refresh work without Cloudflare?**
A: Yes. `getAcumaticaTokenForUser()` in `src/auth/acumatica-oauth.ts` uses `AppEnv` and standard `fetch()`. It reads/writes tokens via `env.store` and calls Acumatica's token endpoint directly. Fully portable.
