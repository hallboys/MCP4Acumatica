// Copyright 2026 Hall Boys, Inc.
// SPDX-License-Identifier: Apache-2.0

import type { Env } from "../types/acumatica";
import { AcumaticaClient } from "../lib/acumatica-client";

/** OData query response with value array */
interface ODataQueryResponse {
  value: Record<string, unknown>[];
}

export async function handleRunInquiry(
  env: Env,
  acumaticaUsername: string,
  args: {
    inquiryName: string;
    filterExpression?: string;
    topN?: number;
    selectFields?: string;
  }
): Promise<unknown> {
  const MAX_TOP = 500;
  const client = new AcumaticaClient(env, acumaticaUsername);
  const requestedTop = args.topN ?? 100;
  const effectiveTop = Math.min(requestedTop, MAX_TOP);

  const query: Record<string, string> = {};

  if (args.filterExpression) {
    query.$filter = args.filterExpression;
  }

  query.$top = String(effectiveTop);

  if (args.selectFields) {
    query.$select = args.selectFields;
  }

  const response = await client.getOData<ODataQueryResponse>(
    args.inquiryName,
    "acumatica_run_inquiry",
    { inquiryName: args.inquiryName, filter: args.filterExpression, topN: effectiveTop, select: args.selectFields },
    query
  );

  const rows = response.value || [];

  // Strip OData metadata fields from each row
  const cleaned = rows.map((row) => {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(row)) {
      if (!key.startsWith("@odata")) {
        result[key] = value;
      }
    }
    return result;
  });

  if (cleaned.length >= effectiveTop) {
    return {
      results: cleaned,
      note: `Returned ${cleaned.length} records (limit: ${effectiveTop}). There may be more results — use filterExpression to narrow your query.`,
    };
  }

  return cleaned;
}
