// Copyright 2026 Hall Boys, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Pagination guard — prevents repeated calls to the same tool+resource
 * within a cooldown window. Off by default; enabled per-tool via
 * PAGINATION_GUARD_TOOLS env var.
 */

export class PaginationGuard {
  private readonly guardedTools: Set<string>;
  private readonly cooldownMs: number;
  private readonly recentCalls = new Map<string, number>();

  constructor(toolsCsv: string | undefined, cooldownSeconds: string | undefined) {
    this.guardedTools = new Set(
      (toolsCsv || "")
        .split(",")
        .map((t) => t.trim())
        .filter(Boolean)
    );
    this.cooldownMs = (parseInt(cooldownSeconds || "30", 10) || 30) * 1000;
  }

  /** Whether any tools are guarded at all. */
  get enabled(): boolean {
    return this.guardedTools.size > 0;
  }

  /**
   * Check whether a tool call is allowed.
   * @param toolName  MCP tool name (e.g. "acumatica_list_entities")
   * @param discriminator  Optional sub-key (e.g. entity name or inquiry name)
   */
  check(
    toolName: string,
    discriminator?: string
  ): { allowed: true } | { allowed: false; message: string } {
    if (!this.guardedTools.has(toolName)) {
      return { allowed: true };
    }

    this.prune();

    const key = discriminator ? `${toolName}:${discriminator}` : toolName;
    const last = this.recentCalls.get(key);

    if (last !== undefined && Date.now() - last < this.cooldownMs) {
      const waitSec = Math.ceil((this.cooldownMs - (Date.now() - last)) / 1000);
      return {
        allowed: false,
        message:
          `Pagination guard: A query for this resource (${discriminator || toolName}) was made recently. ` +
          `To avoid excessive data retrieval, help the user refine their filterExpression to narrow the result set ` +
          `rather than making multiple calls. Cooldown resets in ${waitSec}s.`,
      };
    }

    return { allowed: true };
  }

  /** Record a successful call timestamp. */
  record(toolName: string, discriminator?: string): void {
    if (!this.guardedTools.has(toolName)) return;
    const key = discriminator ? `${toolName}:${discriminator}` : toolName;
    this.recentCalls.set(key, Date.now());
  }

  /** Remove stale entries older than the cooldown window. */
  private prune(): void {
    const cutoff = Date.now() - this.cooldownMs;
    for (const [key, ts] of this.recentCalls) {
      if (ts < cutoff) {
        this.recentCalls.delete(key);
      }
    }
  }
}
