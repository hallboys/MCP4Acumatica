// Copyright 2026 Hall Boys, Inc.
// SPDX-License-Identifier: Apache-2.0

import { OAuthProvider } from "@cloudflare/workers-oauth-provider";
import { McpAgent } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Env, AppEnv, AuthProps } from "./types/acumatica";
import { GETTER_TOOLS, paramsShape, runGetter } from "./tools/getter-registry";
import { handleRunInquiry } from "./tools/generic-inquiries";
import { handleListEntities } from "./tools/entity-list";
import { handleDescribeEntity } from "./tools/entity-schema";
import { handleListGenericInquiries, handleDescribeInquiry } from "./tools/generic-inquiry-discovery";
import { handleClearCache } from "./tools/clear-cache";
import { AcumaticaApiError } from "./lib/acumatica-client";
import { RateLimitError } from "./lib/rate-limiter";
import { redactFields, redactParamsForLog } from "./lib/redact";
import { logRedaction, logError, writeLogsToR2 } from "./lib/logger";
import { getConfig } from "./lib/config";
import { CloudflareKVStore } from "./platform/cloudflare-kv-store";
import { AcumaticaAuthHandler } from "./auth/acumatica-auth-handler";

export class AcumaticaMcpServer extends McpAgent<Env, Record<string, unknown>, AuthProps> {
  server = new McpServer({
    name: "mcp4acumatica",
    version: "0.29.1",
  });

  private redactPatterns?: string;
  private redactSkip?: string;
  // Constructed in init(); never mutate `this.env` (which the CF runtime
  // hands us) because that object is shared across the isolate.
  private appEnv!: AppEnv;

  // ── Log buffering ──────────────────────────────────────────────
  // Buffer entries and flush to R2 when the buffer hits a size
  // threshold OR a DO alarm fires. The buffer is persisted to
  // `ctx.storage` on every append, so eviction between the tool call
  // and the alarm firing can't drop the batch — the alarm handler
  // runs on a fresh DO instance with empty memory and hydrates the
  // buffer from storage before flushing.
  private logBuffer: Record<string, unknown>[] = [];
  private bufferHydrated = false;
  private alarmScheduled = false;
  private flushing = false;
  private static readonly LOG_FLUSH_THRESHOLD = 25;  // entries
  private static readonly LOG_FLUSH_DELAY_MS = 15_000;
  private static readonly LOG_RETRY_DELAY_MS = 30_000;
  private static readonly LOG_BUFFER_KEY = "log_buffer";

  async init() {
    // Build the platform-agnostic AppEnv from the Cloudflare bindings.
    // We construct a fresh object rather than mutating `this.env`; the CF
    // runtime may share that env reference across requests in the same
    // isolate, so hot-patching a `store` field onto it would be a
    // cross-request side effect masquerading as instance state.
    this.appEnv = {
      ACUMATICA_URL: this.env.ACUMATICA_URL,
      ACUMATICA_TENANT: this.env.ACUMATICA_TENANT,
      ACUMATICA_ENDPOINT_VERSION: this.env.ACUMATICA_ENDPOINT_VERSION,
      ACUMATICA_MAX_RECORDS: this.env.ACUMATICA_MAX_RECORDS,
      ACUMATICA_CLIENT_ID: this.env.ACUMATICA_CLIENT_ID,
      ACUMATICA_CLIENT_SECRET: this.env.ACUMATICA_CLIENT_SECRET,
      COOKIE_ENCRYPTION_KEY: this.env.COOKIE_ENCRYPTION_KEY,
      ACUMATICA_MCP_ROLE: this.env.ACUMATICA_MCP_ROLE,
      REDACT_PATTERNS: this.env.REDACT_PATTERNS,
      REDACT_SKIP: this.env.REDACT_SKIP,
      store: new CloudflareKVStore(this.env.TOKEN_STORE),
    };

    // Read runtime config from KV with env var fallback
    this.redactPatterns = await getConfig(this.appEnv.store, "redact_patterns", this.appEnv.REDACT_PATTERNS);
    this.redactSkip = await getConfig(this.appEnv.store, "redact_skip", this.appEnv.REDACT_SKIP);

    // Register the 38 per-entity getter tools from the registry.
    // Each entry describes a path shape + optional $expand; the shared
    // `runGetter` handler does the actual work. Adding a new single-record
    // lookup = one entry in GETTER_TOOLS — no per-tool handler file or
    // per-tool `server.tool(...)` boilerplate.
    for (const spec of GETTER_TOOLS) {
      this.server.tool(
        spec.name,
        spec.description,
        paramsShape(spec.params),
        async (args: Record<string, string | undefined>) => {
          return this.callTool(
            () => runGetter(spec, this.appEnv, this.props.acumaticaUsername, args),
            spec.name,
            args
          );
        }
      );
    }

    // ── Utility / discovery tools ─────────────────────────────
    // These do more than a plain GET (cache, pagination envelope,
    // OData $metadata parse, cache invalidation), so they stay as
    // dedicated handlers.

    this.server.tool(
      "acumatica_run_inquiry",
      "Execute a Generic Inquiry (GI) exposed via OData in Acumatica and return filtered results. Use this for custom reports and cross-entity queries. Use acumatica_list_generic_inquiries to discover GI names and acumatica_describe_inquiry to get field schema before calling this tool.",
      {
        inquiryName: z
          .string()
          .describe("Generic Inquiry name as configured in Acumatica (e.g., 'GI000001')"),
        filterExpression: z
          .string()
          .optional()
          .describe("OData v3 $filter expression (e.g., \"BranchID eq 'BTC' and Status eq 'Open'\"). Use substringof('needle', Field) for partial match (needle comes first). Do NOT use contains() (v4 syntax) or wrap fields in toupper()/tolower() — Acumatica does not support these and returns a 500. Substring matching is case-insensitive, so pass the needle in any casing."),
        topN: z
          .coerce.number()
          .int()
          .min(1)
          .max(1000)
          .default(100)
          .describe("Maximum number of rows to return (default 100, max 1000). Do NOT paginate or make multiple calls to retrieve all records. If results are truncated, ask the user to narrow their query with filterExpression instead."),
        selectFields: z
          .string()
          .optional()
          .describe("Comma-separated field names to return (e.g., 'CustomerID,Balance')"),
      },
      async ({ inquiryName, filterExpression, topN, selectFields }) => {
        return this.callTool(
          () => handleRunInquiry(this.appEnv, this.props.acumaticaUsername, { inquiryName, filterExpression, topN, selectFields }),
          "acumatica_run_inquiry",
          { inquiryName, filterExpression, topN, selectFields }
        );
      }
    );

    this.server.tool(
      "acumatica_list_entities",
      "List or search any Acumatica entity with filtering, sorting, and field selection. Use this to find records matching criteria (e.g., all open invoices over $10,000, customers in a state, stock items below reorder point). IMPORTANT: Always use filterExpression to scope queries. Never retrieve all records from large entities (JournalTransaction, Invoice, Bill, etc.). Do NOT paginate by making multiple calls to fetch all data — if results are truncated, help the user refine their filter. Supported entity names include: Customer, Vendor, SalesOrder, Invoice, Bill, Payment, Check, StockItem, NonStockItem, PurchaseOrder, PurchaseReceipt, Shipment, SalesInvoice, Project, Case, ServiceOrder, Appointment, Contact, BusinessAccount, Opportunity, Lead, Employee, ExpenseClaim, JournalTransaction, and more.",
      {
        entityName: z
          .string()
          .describe("Acumatica entity name (e.g., 'Customer', 'Invoice', 'SalesOrder', 'StockItem')"),
        filterExpression: z
          .string()
          .optional()
          .describe("OData v3 $filter expression (e.g., \"Status eq 'Open' and Amount gt 10000\", \"CustomerClass eq 'LOCAL'\", \"Date gt datetimeoffset'2026-01-01'\"). Use substringof('needle', Field) for partial match (needle comes first). Do NOT use contains() (v4 syntax) or wrap fields in toupper()/tolower() — Acumatica does not support these and returns a 500. Substring matching is case-insensitive, so pass the needle in any casing."),
        topN: z
          .coerce.number()
          .int()
          .min(1)
          .max(1000)
          .default(100)
          .describe("Maximum number of rows to return (default 100, max 1000). Do NOT paginate or make multiple calls to retrieve all records. If results are truncated, ask the user to narrow their query with filterExpression instead."),
        selectFields: z
          .string()
          .optional()
          .describe("Comma-separated field names to return (e.g., 'CustomerID,CustomerName,Status')"),
        orderBy: z
          .string()
          .optional()
          .describe("OData $orderby expression (e.g., 'Amount desc', 'Date asc', 'CustomerName asc')"),
        expand: z
          .string()
          .optional()
          .describe("Comma-separated sub-entities to include (e.g., 'Details', 'MainContact,BillingContact')"),
      },
      async ({ entityName, filterExpression, topN, selectFields, orderBy, expand }) => {
        return this.callTool(
          () => handleListEntities(this.appEnv, this.props.acumaticaUsername, { entityName, filterExpression, topN, selectFields, orderBy, expand }),
          "acumatica_list_entities",
          { entityName, filterExpression, topN, selectFields, orderBy, expand }
        );
      }
    );

    this.server.tool(
      "acumatica_describe_entity",
      "Describe the fields and structure of any Acumatica entity. Call this before using acumatica_list_entities to discover available field names, types, and sub-entities for filtering, sorting, and selection.",
      {
        entityName: z
          .string()
          .describe("Acumatica entity name (e.g., 'Customer', 'Invoice', 'SalesOrder', 'StockItem')"),
      },
      async ({ entityName }) => {
        return this.callTool(
          () => handleDescribeEntity(this.appEnv, this.props.acumaticaUsername, { entityName }),
          "acumatica_describe_entity",
          { entityName }
        );
      }
    );

    this.server.tool(
      "acumatica_list_generic_inquiries",
      "List all Generic Inquiries (GIs) exposed via OData in Acumatica. Returns inquiry names. Use this to discover available GI names before calling acumatica_run_inquiry or acumatica_describe_inquiry.",
      {
        titleFilter: z
          .string()
          .optional()
          .describe("Optional partial name match to narrow results (case-insensitive contains)."),
        topN: z
          .coerce.number()
          .int()
          .min(1)
          .max(1000)
          .default(200)
          .describe("Maximum number of GIs to return (default 200, max 1000)"),
      },
      async ({ titleFilter, topN }) => {
        return this.callTool(
          () => handleListGenericInquiries(this.appEnv, this.props.acumaticaUsername, { titleFilter, topN }),
          "acumatica_list_generic_inquiries",
          { titleFilter, topN }
        );
      }
    );

    this.server.tool(
      "acumatica_describe_inquiry",
      "Returns the field schema for a Generic Inquiry (GI) exposed via OData — field names and inferred types. Use this before calling acumatica_run_inquiry to know which fields are available for filtering and selection.",
      {
        inquiryName: z
          .string()
          .describe("Generic Inquiry name as configured in Acumatica (e.g., 'ProjectBudgetSummary'). Use acumatica_list_generic_inquiries to discover names."),
      },
      async ({ inquiryName }) => {
        return this.callTool(
          () => handleDescribeInquiry(this.appEnv, this.props.acumaticaUsername, { inquiryName }),
          "acumatica_describe_inquiry",
          { inquiryName }
        );
      }
    );

    this.server.tool(
      "acumatica_clear_cache",
      "Clear cached metadata (entity schemas, GI lists, GI field schemas). Use when Acumatica customizations have changed and cached schema data is stale. With no arguments, clears all cached metadata. Optionally specify a target to clear only that cache.",
      {
        target: z
          .string()
          .optional()
          .describe("What to clear: 'schema:EntityName' (one entity schema), 'schemas' (all entity schemas), 'gi' (GI list + metadata), 'gi_schema:InquiryName' (one GI schema), or omit to clear everything."),
      },
      async ({ target }) => {
        return this.callTool(
          () => handleClearCache(this.appEnv, target),
          "acumatica_clear_cache",
          { target }
        );
      }
    );
  }

  /**
   * Hydrate the in-memory buffer from persistent storage. Runs once per
   * DO instance lifetime. This is the piece that lets the alarm path
   * survive DO eviction: when the runtime spins up a fresh instance to
   * run `alarm()`, `this.logBuffer` starts empty, and without hydration
   * the flush would be a no-op.
   */
  private async hydrateBuffer(): Promise<void> {
    if (this.bufferHydrated) return;
    const persisted = await this.ctx.storage.get<Record<string, unknown>[]>(
      AcumaticaMcpServer.LOG_BUFFER_KEY
    );
    if (persisted && persisted.length > 0) {
      // Persisted entries are older than anything already pushed in this
      // instance — keep them first so R2 files stay chronologically ordered.
      this.logBuffer = [...persisted, ...this.logBuffer];
    }
    this.bufferHydrated = true;
  }

  /** Mirror the in-memory buffer to DO storage (or clear it when empty). */
  private async persistBuffer(): Promise<void> {
    if (this.logBuffer.length === 0) {
      await this.ctx.storage.delete(AcumaticaMcpServer.LOG_BUFFER_KEY);
    } else {
      await this.ctx.storage.put(AcumaticaMcpServer.LOG_BUFFER_KEY, this.logBuffer);
    }
  }

  /**
   * Flush buffered log entries to R2. Serialized via `flushing` so the
   * threshold path and alarm path can't race. On R2 failure the snapshot
   * is re-enqueued at the head of the buffer and a retry alarm is
   * scheduled — previously this silently dropped the batch.
   */
  private async flushLogs(): Promise<void> {
    if (this.flushing) return;
    this.flushing = true;
    try {
      await this.hydrateBuffer();
      if (this.logBuffer.length === 0) return;
      const entries = this.logBuffer.slice();
      this.logBuffer = [];
      await this.persistBuffer();
      const ok = await writeLogsToR2(this.env.mcp4acumatica_logs, entries);
      if (!ok) {
        // Re-enqueue at the head so ordering is preserved, and schedule
        // a retry alarm. Any entries buffered during the await go after.
        this.logBuffer = [...entries, ...this.logBuffer];
        await this.persistBuffer();
        await this.scheduleAlarm(AcumaticaMcpServer.LOG_RETRY_DELAY_MS);
      }
    } finally {
      this.flushing = false;
    }
  }

  /**
   * Add log entries to the buffer. Flush immediately if the size
   * threshold is reached; otherwise ensure a DO alarm is scheduled
   * so an idle buffer still lands in R2. The buffer is mirrored to
   * DO storage so eviction before the alarm fires can't drop it.
   */
  private async bufferLogs(entries: Record<string, unknown>[]): Promise<void> {
    await this.hydrateBuffer();
    this.logBuffer.push(...entries);
    await this.persistBuffer();
    if (this.logBuffer.length >= AcumaticaMcpServer.LOG_FLUSH_THRESHOLD && !this.flushing) {
      await this.flushLogs();
      return;
    }
    await this.scheduleAlarm(AcumaticaMcpServer.LOG_FLUSH_DELAY_MS);
  }

  private async scheduleAlarm(delayMs: number): Promise<void> {
    if (this.alarmScheduled) return;
    await this.ctx.storage.setAlarm(Date.now() + delayMs);
    this.alarmScheduled = true;
  }

  /**
   * DO alarm handler — fires after LOG_FLUSH_DELAY_MS of idle to drain
   * the buffer. Runs on a fresh DO instance after eviction, so
   * `flushLogs()` must hydrate from storage before flushing to R2.
   */
  async alarm(): Promise<void> {
    this.alarmScheduled = false;
    await this.flushLogs();
  }

  /**
   * Wraps a tool handler, catching known errors and returning
   * MCP-formatted text content.
   */
  private async callTool(
    fn: () => Promise<unknown>,
    toolName?: string,
    params?: Record<string, unknown>
  ): Promise<{ content: Array<{ type: "text"; text: string }> }> {
    const start = Date.now();
    const r2Entries: Record<string, unknown>[] = [];
    // Scrub any SSN/card-shaped needles the model passed inside filter
    // expressions or other string params. These go into the long-term
    // audit log; the name-based redactor doesn't help here because the
    // param *keys* (filterExpression, topN, etc.) are not PII.
    const toolParams = redactParamsForLog(params || {});

    try {
      const result = await fn();

      // Apply sensitive field redaction (uses KV config with env var fallback)
      const { data, redactedFields: redacted } = redactFields(
        result,
        this.redactPatterns,
        this.redactSkip
      );

      if (redacted.length > 0) {
        logRedaction(
          toolName || "unknown",
          this.props.acumaticaUsername,
          redacted
        );
        r2Entries.push({
          level: "info",
          type: "field_redaction",
          timestamp: new Date().toISOString(),
          tool: toolName || "unknown",
          acumaticaUsername: this.props.acumaticaUsername,
          redactedFields: redacted,
          redactedCount: redacted.length,
        });
      }

      // Log successful tool invocation. Per-HTTP-call logs are emitted
      // separately by AcumaticaClient as `acumatica_http_call`; this is
      // the MCP-level outcome as seen by the model.
      const durationMs = Date.now() - start;
      const invocationEntry = {
        level: "info",
        type: "tool_invocation",
        timestamp: new Date().toISOString(),
        tool: toolName || "unknown",
        acumaticaUsername: this.props.acumaticaUsername,
        params: toolParams,
        status: "success",
        durationMs,
      };
      console.log(JSON.stringify(invocationEntry));
      r2Entries.push(invocationEntry);

      // Buffer log entries (flushed to R2 on threshold or delayed alarm)
      await this.bufferLogs(r2Entries);

      const content: Array<{ type: "text"; text: string }> = [
        { type: "text" as const, text: JSON.stringify(data, null, 2) },
      ];

      if (redacted.length > 0) {
        content.push({
          type: "text" as const,
          text: `[Note: ${redacted.length} sensitive field(s) were automatically redacted. Verify critical data directly in Acumatica.]`,
        });
      }

      return { content };
    } catch (error) {
      const message =
        error instanceof AcumaticaApiError
          ? error.message
          : error instanceof RateLimitError
            ? error.message
            : error instanceof Error
              ? error.message
              : "An unexpected error occurred.";

      // Log failed tool invocation
      const durationMs = Date.now() - start;
      const errorEntry = {
        level: "error",
        type: "tool_invocation",
        timestamp: new Date().toISOString(),
        tool: toolName || "unknown",
        acumaticaUsername: this.props.acumaticaUsername,
        params: toolParams,
        status: "error",
        durationMs,
        error: message,
      };
      logError(toolName || "unknown", error);
      r2Entries.push(errorEntry);

      // Buffer log entries (flushed to R2 on threshold or delayed alarm)
      await this.bufferLogs(r2Entries);

      return {
        content: [{ type: "text" as const, text: `Error: ${message}` }],
      };
    }
  }
}

// The OAuthProvider wraps the entire worker.
// - apiRoute requests (/mcp, /sse) require a valid bearer token
// - All other requests are passed to the AcumaticaAuthHandler (login flow, health, etc.)
//
// The cast on `apiHandler` is narrow on purpose: `McpAgent.serve(path)`
// returns `{ fetch<E>(...) }` with a generic method, while OAuthProvider
// expects `ExportedHandler<Env>`. The shapes match but TS can't unify the
// generic, so we cast to the interface OAuthProvider wants. Replacing the
// previous `as any` keeps the rest of the type-check honest.
type ExportedHandlerWithFetch<E> = ExportedHandler<E> & Required<Pick<ExportedHandler<E>, "fetch">>;
const mcpApiHandler = AcumaticaMcpServer.serve("/mcp") as unknown as ExportedHandlerWithFetch<Env>;

export default new OAuthProvider({
  apiRoute: ["/mcp", "/sse"],
  apiHandler: mcpApiHandler,
  defaultHandler: AcumaticaAuthHandler,
  authorizeEndpoint: "/authorize",
  tokenEndpoint: "/token",
  clientRegistrationEndpoint: "/register",
  clientIdMetadataDocumentEnabled: true,
  scopesSupported: ["api"],
});
