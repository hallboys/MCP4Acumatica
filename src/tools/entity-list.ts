// Copyright 2026 Hall Boys, Inc.
// SPDX-License-Identifier: Apache-2.0

import type { AppEnv } from "../types/acumatica";
import { AcumaticaClient, AcumaticaApiError, unwrapFields } from "../lib/acumatica-client";
import { getConfig, parsePositiveIntConfig, validateStringArg } from "../lib/config";

// Entities that contain auth/credential/role metadata — blocked from the
// generic lister because there's no legitimate AI-assistant use case and
// the per-entity contract-API surface is small enough that accidental
// exposure is easy. The caller's entityName is first canonicalized (trim,
// strip any `Default/` or other path prefix, lowercase) so variations
// like `" User "`, `Default/User`, or `default/USER` all hit the denylist.
const DENY_ENTITIES = new Set([
  "user",
  "usersecurityinfo",
  "userrole",
  "role",
  "rolelist",
  "rolesbyuser",
]);

function canonicalEntityName(name: string): string {
  const trimmed = name.trim();
  // Strip a leading path component like `Default/` (the Acumatica contract
  // API prefix) — we re-add it server-side, and without stripping, the
  // denylist check misses.
  const lastSegment = trimmed.includes("/") ? trimmed.slice(trimmed.lastIndexOf("/") + 1) : trimmed;
  return lastSegment.toLowerCase();
}

export async function handleListEntities(
  env: AppEnv,
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
  const entityName = args.entityName.trim();
  if (!entityName) {
    return { error: "entityName is required." };
  }
  if (entityName.includes("/")) {
    return {
      error: "entityName must be a bare entity name (e.g., 'Customer'), not a path.",
    };
  }

  // Length guards — keep attacker-supplied strings from turning into huge
  // Acumatica URLs (which would burn CPU on encoding and then 414 / 500
  // at the edge). Limits are generous relative to real OData usage.
  const lengthErr =
    validateStringArg(entityName, "entityName", 200) ||
    validateStringArg(args.filterExpression, "filterExpression", 2000) ||
    validateStringArg(args.selectFields, "selectFields", 1000) ||
    validateStringArg(args.orderBy, "orderBy", 500) ||
    validateStringArg(args.expand, "expand", 500);
  if (lengthErr) return { error: lengthErr };
  if (DENY_ENTITIES.has(canonicalEntityName(entityName))) {
    return {
      error: `Entity '${entityName}' is not available via this tool. Auth and role metadata is intentionally out of scope for AI-assistant queries.`,
    };
  }
  // Disallow $expand path traversal (`Details/Tax`, `MainContact/UserInfo`, etc.).
  // Single-level sub-entities are still allowed (`Details`, `MainContact`). This
  // prevents reaching sensitive sub-records via a navigation chain that the
  // role gate on the parent entity did not anticipate.
  if (args.expand && args.expand.includes("/")) {
    return {
      error: "Nested $expand paths (containing '/') are not permitted. Use a single sub-entity level and pull further detail with a dedicated get_* tool.",
    };
  }
  const maxRecords = await getConfig(env.store, "acumatica_max_records", env.ACUMATICA_MAX_RECORDS);
  const MAX_TOP = parsePositiveIntConfig(maxRecords, 1000);
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
      entityName,
      "acumatica_list_entities",
      {
        entityName: entityName,
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
        entityName,
        "acumatica_list_entities",
        {
          entityName: entityName,
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

  // Acumatica's contract API does not return a total count, so we cannot
  // distinguish "result set happened to equal the cap" from "more records
  // exist past the cap". The wording below reflects that — the result set
  // *may* be complete. The model must still stop and ask for a narrower
  // filter rather than paginate.
  if (Array.isArray(unwrapped) && unwrapped.length >= effectiveTop) {
    return {
      results: unwrapped,
      truncated: true,
      mayBeComplete: true,
      recordsReturned: unwrapped.length,
      recordLimit: effectiveTop,
      paginationSupported: false,
      actionRequired:
        `Result set hit the ${effectiveTop}-record cap, so more records may exist beyond this response — Acumatica's contract API does not report a total count, so we cannot tell from here whether the result is complete. ` +
        `This tool does NOT support pagination. Do NOT call this tool again with a different offset or topN to retrieve more records — no such mechanism exists. ` +
        `If the user needs confidence the result is complete, stop and ask them to narrow their request with a more specific filterExpression ` +
        `(e.g., date range, status, customer class, or other criteria) so the result set fits comfortably under the limit.`,
    };
  }

  return unwrapped;
}
