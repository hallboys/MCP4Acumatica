// Copyright 2026 Hall Boys, Inc.
// SPDX-License-Identifier: Apache-2.0

export interface AuditEntry {
  timestamp: string;
  tool: string;
  params: Record<string, unknown>;
  endpoint: string;
  statusCode: number;
  durationMs: number;
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
