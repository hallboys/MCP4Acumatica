// Copyright 2026 Hall Boys, Inc.
// SPDX-License-Identifier: Apache-2.0

export interface AuditEntry {
  timestamp: string;
  tool: string;
  acumaticaUsername: string;
  params: Record<string, unknown>;
  endpoint: string;
  statusCode: number;
  durationMs: number;
  recordCount?: number;
}

export function logToolInvocation(entry: AuditEntry): void {
  console.log(JSON.stringify({
    level: "info",
    type: "tool_invocation",
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

/**
 * Write structured log entries directly to R2 as NDJSON.
 * Used by the Durable Object to persist tool logs that Logpush
 * (Worker-level only) does not capture.
 *
 * Falls back silently to console-only if bucket is unavailable.
 */
export async function writeLogsToR2(
  bucket: R2Bucket | undefined,
  entries: Record<string, unknown>[]
): Promise<void> {
  if (!bucket || entries.length === 0) return;
  try {
    const ndjson = entries.map((e) => JSON.stringify(e)).join("\n") + "\n";
    const now = new Date();
    const date = now.toISOString().split("T")[0];
    const ts = now.getTime();
    const rand = crypto.randomUUID().slice(0, 8);
    const key = `do-logs/${date}/${ts}-${rand}.ndjson`;
    await bucket.put(key, ndjson);
  } catch (err) {
    // R2 write failure must not break tool responses
    console.error(JSON.stringify({
      level: "error",
      type: "log_persist_error",
      timestamp: new Date().toISOString(),
      error: err instanceof Error ? err.message : String(err),
    }));
  }
}
