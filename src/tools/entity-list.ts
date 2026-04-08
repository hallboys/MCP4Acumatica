// Copyright 2026 Hall Boys, Inc.
// SPDX-License-Identifier: Apache-2.0

import type { Env } from "../types/acumatica";
import { AcumaticaClient, AcumaticaApiError, unwrapFields } from "../lib/acumatica-client";

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
  const MAX_TOP = parseInt(env.ACUMATICA_MAX_RECORDS, 10) || 1000;
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

  if (args.orderBy) {
    query.$orderby = args.orderBy;
  }

  if (args.expand) {
    query.$expand = args.expand;
  }

  let results: unknown[];
  try {
    results = await client.get<unknown[]>(
      args.entityName,
      "acumatica_list_entities",
      {
        entityName: args.entityName,
        filter: args.filterExpression,
        topN: effectiveTop,
        select: args.selectFields,
        orderBy: args.orderBy,
        expand: args.expand,
      },
      query
    );
  } catch (error) {
    // If the query fails with $select, retry without it and advise the user.
    // Some Acumatica entities return 500 when $select includes unsupported fields.
    if (args.selectFields && error instanceof AcumaticaApiError && error.statusCode === 500) {
      const retryQuery = { ...query };
      delete retryQuery.$select;
      results = await client.get<unknown[]>(
        args.entityName,
        "acumatica_list_entities",
        {
          entityName: args.entityName,
          filter: args.filterExpression,
          topN: effectiveTop,
          orderBy: args.orderBy,
          expand: args.expand,
          note: "Retried without $select due to Acumatica error",
        },
        retryQuery
      );

      const unwrapped = Array.isArray(results) ? results.map(unwrapFields) : unwrapFields(results);
      return {
        results: unwrapped,
        warning: `The selectFields parameter caused an Acumatica error and was removed. Some entities do not support $select with certain field names. Use acumatica_describe_entity to discover valid field names.`,
      };
    }
    throw error;
  }

  const unwrapped = Array.isArray(results) ? results.map(unwrapFields) : unwrapFields(results);

  if (Array.isArray(unwrapped) && unwrapped.length >= effectiveTop) {
    return {
      results: unwrapped,
      note: `Returned ${unwrapped.length} records (limit: ${effectiveTop}). There may be more results — use filterExpression to narrow your query.`,
    };
  }

  return unwrapped;
}
