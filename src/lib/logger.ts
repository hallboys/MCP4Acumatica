// Copyright 2026 Hall Boys, Inc.
// SPDX-License-Identifier: Apache-2.0

export interface HttpCallEntry {
  timestamp: string;
  tool: string;
  acumaticaUsername: string;
  params: Record<string, unknown>;
  endpoint: string;
  statusCode: number;
  durationMs: number;
  recordCount?: number;
}

/**
 * Log a single HTTP roundtrip to Acumatica. One tool invocation may
 * produce multiple of these (e.g. a retry after 401). Distinct from
 * `tool_invocation`, which is the MCP-level outcome as seen by the model.
 */
export function logHttpCall(entry: HttpCallEntry): void {
  console.log(JSON.stringify({
    level: "info",
    type: "acumatica_http_call",
    ...entry,
  }));
}

export function logError(tool: string, error: unknown): void {
  console.error(JSON.stringify({
    level: "error",
    type: "tool_error",
    timestamp: new Date().toISOString(),
    tool,
    error: error instanceof Error ? error.message : String(error),
  }));
}

export function logAuthEvent(
  eventType:
    | "login_success"
    | "login_denied"
    | "consent_accepted"
    | "callback_state_mismatch",
  username: string,
  details?: Record<string, unknown>
): void {
  console.log(JSON.stringify({
    level: "info",
    type: "auth_event",
    timestamp: new Date().toISOString(),
    eventType,
    username,
    ...details,
  }));
}

export function logRedaction(
  tool: string,
  acumaticaUsername: string,
  redactedFields: string[]
): void {
  console.log(JSON.stringify({
    level: "info",
    type: "field_redaction",
    timestamp: new Date().toISOString(),
    tool,
    acumaticaUsername,
    redactedFields,
    redactedCount: redactedFields.length,
  }));
}

export interface MutationEntry {
  timestamp: string;
  tool: string;
  acumaticaUsername: string;
  entity: string;
  /** Key of the created/updated record (e.g. CustomerID), if available. */
  recordKey?: string;
  /**
   * Payload field names + (redacted) values that were sent to Acumatica.
   * Values have already been run through name-based redaction before logging
   * so sensitive fields (SSN, salary, etc.) do not appear in the audit trail.
   */
  fields: Record<string, unknown>;
  /** True when this was a dry-run preview — no write was sent to Acumatica. */
  dryRun: boolean;
}

/**
 * Log an attempted mutation (write) tool call. Emitted for both dry-run
 * previews and committed writes so every mutation attempt is in the trail.
 * Field values are redacted by the caller before being passed here.
 *
 * `console.log` only reaches `wrangler tail`; Logpush does not capture DO
 * traces (that's why `writeLogsToR2` exists). So this returns the log record
 * it emitted, letting the DO also buffer it to R2 for the durable audit trail
 * / admin console — the same split used for `tool_invocation` in index.ts.
 */
export function logMutation(entry: MutationEntry): Record<string, unknown> {
  const record = {
    level: "info",
    type: "write_mutation",
    ...entry,
  };
  console.log(JSON.stringify(record));
  return record;
}

/**
 * Write structured log entries directly to R2 as NDJSON.
 * Used by the Durable Object to persist tool logs that Logpush
 * (Worker-level only) does not capture.
 *
 * Returns true on success (or no-op for missing bucket / empty batch),
 * false if the R2 put failed. Callers that buffer should re-enqueue on
 * false so entries aren't lost.
 */
export async function writeLogsToR2(
  bucket: R2Bucket | undefined,
  entries: Record<string, unknown>[]
): Promise<boolean> {
  if (!bucket || entries.length === 0) return true;
  try {
    const ndjson = entries.map((e) => JSON.stringify(e)).join("\n") + "\n";
    const now = new Date();
    const date = now.toISOString().split("T")[0];
    const ts = now.getTime();
    // Use the full UUID rather than an 8-char slice — two flushes in the
    // same millisecond across many DO instances can collide on a short
    // suffix and silently overwrite one of the log files.
    const rand = crypto.randomUUID();
    const key = `do-logs/${date}/${ts}-${rand}.ndjson`;
    await bucket.put(key, ndjson);
    return true;
  } catch (err) {
    console.error(JSON.stringify({
      level: "error",
      type: "log_persist_error",
      timestamp: new Date().toISOString(),
      error: err instanceof Error ? err.message : String(err),
    }));
    return false;
  }
}
