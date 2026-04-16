// Copyright 2026 Hall Boys, Inc.
// SPDX-License-Identifier: Apache-2.0

import type { AppEnv } from "../types/acumatica";
import { AcumaticaClient } from "../lib/acumatica-client";
import { getConfig } from "../lib/config";

/** OData query response with value array */
interface ODataQueryResponse {
  value: Record<string, unknown>[];
}

export async function handleRunInquiry(
  env: AppEnv,
  acumaticaUsername: string,
  args: {
    inquiryName: string;
    filterExpression?: string;
    topN?: number;
    selectFields?: string;
  }
): Promise<unknown> {
  const maxRecords = await getConfig(env.store, "acumatica_max_records", env.ACUMATICA_MAX_RECORDS);
  const MAX_TOP = parseInt(maxRecords || "", 10) || 1000;
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
      truncated: true,
      recordsReturned: cleaned.length,
      recordLimit: effectiveTop,
      paginationSupported: false,
      actionRequired:
        `Results were truncated at ${effectiveTop} records and this tool does NOT support pagination. ` +
        `Do NOT call this tool again with a different offset or topN to retrieve more records — no such mechanism exists. ` +
        `Instead, stop and ask the user to narrow their request by providing a more specific filterExpression ` +
        `(e.g., date range, status, or other criteria) so the result set fits within the limit.`,
    };
  }

  return cleaned;
}
