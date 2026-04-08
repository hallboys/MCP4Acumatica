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
  eventType: "login_success" | "login_denied" | "consent_accepted",
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
