// Copyright 2026 Hall Boys, Inc.
// SPDX-License-Identifier: Apache-2.0

import type { Env } from "../types/acumatica";
import { AcumaticaClient, unwrapFields } from "../lib/acumatica-client";

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
  const client = new AcumaticaClient(env, acumaticaUsername);

  const query: Record<string, string> = {};

  if (args.filterExpression) {
    query.$filter = args.filterExpression;
  }

  query.$top = String(args.topN ?? 100);

  if (args.selectFields) {
    query.$select = args.selectFields;
  }

  const results = await client.get<unknown[]>(
    args.inquiryName,
    "acumatica_run_inquiry",
    { inquiryName: args.inquiryName, filter: args.filterExpression, topN: args.topN, select: args.selectFields },
    query
  );

  return Array.isArray(results) ? results.map(unwrapFields) : unwrapFields(results);
}
