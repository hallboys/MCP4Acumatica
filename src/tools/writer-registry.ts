// Copyright 2026 Hall Boys, Inc.
// SPDX-License-Identifier: Apache-2.0

import { z } from "zod";
import type { AppEnv } from "../types/acumatica";
import { AcumaticaClient, wrapFields, unwrapFields } from "../lib/acumatica-client";
import { getConfig } from "../lib/config";
import { logMutation } from "../lib/logger";
import { redactFields } from "../lib/redact";
import { validateWriterPayload } from "./writer-validation";

const PAYLOAD_MAX_CHARS = 8_000;

// ── Spec types ────────────────────────────────────────────────────────────────

export interface WriterToolSpec {
  /** MCP tool name (e.g. "acumatica_create_or_update_customer"). */
  name: string;
  /** MCP tool description shown to the model. */
  description: string;
  /** Acumatica entity name used as the first URL path segment. */
  entity: string;
  /**
   * Field name holding the record key in the PUT response (e.g. "CustomerID",
   * "OrderNbr", "ReferenceNbr"). Used only to surface `recordKey` in the result
   * + audit log. Defaults to `${entity}ID` when omitted — correct for Customer
   * but wrong for entities keyed differently, so set it explicitly per entity.
   */
  keyField?: string;
  /** Optional $expand value (comma-separated sub-entity names to include in the response). */
  expand?: string;
  /**
   * Allowed top-level field names for this entity. Any field name NOT in this
   * list is rejected before the payload ever reaches Acumatica. This is the
   * primary safety gate: write tools should be conservative in what they accept
   * rather than passing arbitrary model-generated JSON to a live ERP.
   */
  allowedFields: readonly string[];
  /**
   * Allowed inner field names for nested sub-entity objects, keyed by the
   * top-level field name (which must also appear in `allowedFields`). A nested
   * object whose key is listed here is validated against its inner allowlist;
   * an inner field not in the list is rejected before reaching Acumatica. A
   * top-level key that is present in `allowedFields` but absent here may not be
   * an object. This closes the allowlist to the sub-entity level rather than
   * accepting arbitrary inner fields.
   */
  nestedAllowedFields?: Readonly<Record<string, readonly string[]>>;
}

// ── Registry ──────────────────────────────────────────────────────────────────

/**
 * Registry of write tools (one entry = one MCP tool).
 * Adding a new entity: add one spec here; the registration loop in index.ts
 * picks it up automatically.
 */
export const WRITER_TOOLS: readonly WriterToolSpec[] = [
  {
    name: "acumatica_create_or_update_customer",
    description:
      "Create a new Customer or update an existing one in Acumatica. " +
      "Uses PUT-as-upsert: if CustomerID is provided the existing record is updated; if omitted Acumatica assigns an auto-number ID and creates a new record. " +
      "Pass a JSON object via the `payload` parameter with any of the allowed fields. " +
      "Write tools are disabled by default — an admin must enable them at /docs/admin/settings before this tool will apply changes. " +
      "Call without `confirm` first to preview what would be written (dry-run). Pass `confirm: 'true'` to commit. " +
      "Allowed top-level fields: CustomerID, CustomerName, CustomerClass, Status, Email, Phone1, MainContact (nested: Email, Phone1, Address1, Address2, City, State, PostalCode, Country).",
    entity: "Customer",
    keyField: "CustomerID",
    expand: "MainContact",
    allowedFields: [
      "CustomerID",
      "CustomerName",
      "CustomerClass",
      "Status",
      "Email",
      "Phone1",
      "MainContact",
    ],
    nestedAllowedFields: {
      MainContact: [
        "Email",
        "Phone1",
        "Address1",
        "Address2",
        "City",
        "State",
        "PostalCode",
        "Country",
      ],
    },
  },
] as const;

// ── Shared param shape ────────────────────────────────────────────────────────

/** Build the Zod parameter shape for a writer tool. */
export function writerParamsShape(_spec: WriterToolSpec): Record<string, z.ZodTypeAny> {
  return {
    payload: z
      .string()
      .describe(
        "JSON object with fields to create or update. " +
        "Only the fields listed in the tool description are accepted — any others are rejected before anything is sent to Acumatica. " +
        "Example: '{\"CustomerName\": \"Acme Corp\", \"CustomerClass\": \"DEFAULT\", \"Email\": \"accounts@acme.com\"}'"
      ),
    confirm: z
      .string()
      .optional()
      .describe(
        "Pass 'true' to commit the change. Omit (or pass anything else) to get a dry-run preview of exactly what would be written — no data is changed."
      ),
  };
}

// ── runWriter ─────────────────────────────────────────────────────────────────

/**
 * Shared handler for all write tools.
 *
 * Safety layers (in order):
 * 1. Writes-enabled kill-switch — returns an error if disabled.
 * 2. Payload size cap — rejects oversized JSON strings.
 * 3. JSON parse — rejects malformed JSON or non-object payloads.
 * 4. Field allowlist (top-level + nested) — rejects any key not allowed.
 * 5. Dry-run gate — returns a preview if confirm !== "true".
 * 6. wrapFields() — converts plain values to {value: X} before PUT.
 * 7. Mutation audit log — emitted for BOTH dry-run and committed, and forwarded
 *    to `auditSink` (when provided) so the DO can persist it to R2. Values are
 *    redacted using the same configured REDACT_PATTERNS/REDACT_SKIP as reads.
 */
export async function runWriter(
  spec: WriterToolSpec,
  env: AppEnv,
  acumaticaUsername: string,
  args: { payload: string; confirm?: string },
  auditSink?: (entry: Record<string, unknown>) => void
): Promise<unknown> {
  // 1. Kill-switch
  const writesEnabled = await getConfig(env.store, "writes_enabled", env.ACUMATICA_WRITES_ENABLED);
  if (writesEnabled?.trim().toLowerCase() !== "true") {
    return {
      error:
        "Write tools are currently disabled. An admin must set 'Enable Write Tools' to 'true' at /docs/admin/settings before mutations are permitted.",
    };
  }

  // 2-4. Payload size cap + JSON parse + top-level & nested field allowlist
  const validation = validateWriterPayload(
    args.payload,
    spec.allowedFields,
    PAYLOAD_MAX_CHARS,
    spec.nestedAllowedFields
  );
  if (!validation.ok) return { error: validation.error };
  const payloadObj = validation.data;

  const isDryRun = args.confirm !== "true";

  // Redact field values for logging using the same admin-configured patterns
  // as read responses (KV override with env-var fallback), so REDACT_PATTERNS /
  // REDACT_SKIP apply to the audit trail too. Used for BOTH the mutation log
  // and the http-call `params` (so PII never lands unredacted in tail logs).
  const redactPatterns = await getConfig(env.store, "redact_patterns", env.REDACT_PATTERNS);
  const redactSkip = await getConfig(env.store, "redact_skip", env.REDACT_SKIP);
  const { data: redactedForLog } = redactFields(payloadObj, redactPatterns, redactSkip);

  // 5. Dry-run gate
  if (isDryRun) {
    auditSink?.(
      logMutation({
        timestamp: new Date().toISOString(),
        tool: spec.name,
        acumaticaUsername,
        entity: spec.entity,
        fields: redactedForLog as Record<string, unknown>,
        dryRun: true,
      })
    );
    return {
      dryRun: true,
      willWrite: wrapFields(payloadObj),
      target: `PUT ${spec.entity}`,
      note: "This is a preview — no data has been changed. Re-call with confirm='true' to commit.",
    };
  }

  // 6. Commit. The http-call log gets the REDACTED payload as `params` — the
  // real (unredacted) data goes in the request body only.
  const client = new AcumaticaClient(env, acumaticaUsername);
  const query: Record<string, string> = {};
  if (spec.expand) query.$expand = spec.expand;

  const response = await client.put<Record<string, unknown>>(
    spec.entity,
    spec.name,
    wrapFields(payloadObj) as Record<string, unknown>,
    redactedForLog as Record<string, unknown>,
    query
  );

  const result = unwrapFields(response);
  const resultObj = result as Record<string, unknown>;
  const keyField = spec.keyField ?? `${spec.entity}ID`;
  const recordKey = (resultObj?.[keyField] as string) ?? undefined;

  // 7. Mutation audit log
  auditSink?.(
    logMutation({
      timestamp: new Date().toISOString(),
      tool: spec.name,
      acumaticaUsername,
      entity: spec.entity,
      recordKey,
      fields: redactedForLog as Record<string, unknown>,
      dryRun: false,
    })
  );

  return {
    action: "upsert",
    entity: spec.entity,
    recordKey,
    result,
  };
}
