// Copyright 2026 Hall Boys, Inc.
// SPDX-License-Identifier: Apache-2.0

import type { Env } from "../types/acumatica";
import { AcumaticaClient, unwrapFields } from "../lib/acumatica-client";

/**
 * Build an OData $filter string from key-value pairs.
 * String values are quoted; numbers and booleans are left bare.
 */
function buildFilter(filters: Record<string, unknown>): string {
  const clauses: string[] = [];
  for (const [field, value] of Object.entries(filters)) {
    if (value === null || value === undefined) continue;
    if (typeof value === "number" || typeof value === "boolean") {
      clauses.push(`${field} eq ${value}`);
    } else {
      clauses.push(`${field} eq '${String(value).replace(/'/g, "''")}'`);
    }
  }
  return clauses.join(" and ");
}

export async function handleRunInquiry(
  env: Env,
  acumaticaUsername: string,
  args: {
    inquiryName: string;
    filters?: Record<string, unknown>;
    topN?: number;
    select?: string[];
  }
): Promise<unknown> {
  const client = new AcumaticaClient(env, acumaticaUsername);

  const query: Record<string, string> = {};

  if (args.filters && Object.keys(args.filters).length > 0) {
    query.$filter = buildFilter(args.filters);
  }

  const top = args.topN ?? 100;
  query.$top = String(top);

  if (args.select && args.select.length > 0) {
    query.$select = args.select.join(",");
  }

  const results = await client.get<unknown[]>(
    args.inquiryName,
    "acumatica_run_inquiry",
    { inquiryName: args.inquiryName, filters: args.filters, topN: top, select: args.select },
    query
  );

  return Array.isArray(results) ? results.map(unwrapFields) : unwrapFields(results);
}
