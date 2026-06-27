// Copyright 2026 Hall Boys, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Shared post-processing for OData GI result rows.
 *
 * Two jobs, both needed everywhere a GI row reaches the model (run_inquiry,
 * describe_inquiry, and the promoted per-GI tools):
 *  1. Drop OData control fields (`@odata.*`).
 *  2. Trim string values. Acumatica returns fixed-width key fields space-padded
 *     (e.g. "GARES     "); untrimmed, they bloat context and — worse — break
 *     equality filters the model builds from them ("WarehouseID eq 'GARES     '"
 *     won't round-trip). Trailing/leading spaces on GI output are never
 *     semantically meaningful, so trimming every string value is safe.
 */

/** Strip `@odata.*` keys and trim string values from a single GI row. */
export function cleanGiRow(row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) {
    if (key.startsWith("@odata")) continue;
    out[key] = typeof value === "string" ? value.trim() : value;
  }
  return out;
}

/** Apply cleanGiRow to every row. */
export function cleanGiRows(rows: Record<string, unknown>[]): Record<string, unknown>[] {
  return rows.map(cleanGiRow);
}
