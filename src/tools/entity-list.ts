// Copyright 2026 Hall Boys, Inc.
// SPDX-License-Identifier: Apache-2.0

import type { Env } from "../types/acumatica";
import { AcumaticaClient, unwrapFields } from "../lib/acumatica-client";

export async function handleListEntities(
  env: Env,
  acumaticaUsername: string,
  args: {
    entityName: string;
    filterExpression?: string;
    topN?: number;
    selectFields?: string;
    orderBy?: string;
    expand?: string;
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

  if (args.orderBy) {
    query.$orderby = args.orderBy;
  }

  if (args.expand) {
    query.$expand = args.expand;
  }

  const results = await client.get<unknown[]>(
    args.entityName,
    "acumatica_list_entities",
    {
      entityName: args.entityName,
      filter: args.filterExpression,
      topN: args.topN ?? 100,
      select: args.selectFields,
      orderBy: args.orderBy,
      expand: args.expand,
    },
    query
  );

  return Array.isArray(results) ? results.map(unwrapFields) : unwrapFields(results);
}
