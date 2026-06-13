// Copyright 2026 Hall Boys, Inc.
// SPDX-License-Identifier: Apache-2.0

import type { AppEnv } from "../types/acumatica";
import { AcumaticaClient, AcumaticaApiError, unwrapFields } from "../lib/acumatica-client";
import { getConfig, parsePositiveIntConfig, validateStringArg } from "../lib/config";
import { normalizeODataFilter } from "../lib/odata-filter";
import {
  getComplexEntityInfo,
  getFilterErrorKind,
  isKeyedFilter,
} from "../lib/complex-entities";

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

  // Acumatica's contract-REST parser returns an empty set for
  // `substringof(...) eq true`; strip the `eq true` so the bare boolean
  // function reaches Acumatica. See normalizeODataFilter for details.
  const filterExpression = normalizeODataFilter(args.filterExpression);

  const query: Record<string, string> = {};

  if (filterExpression) {
    query.$filter = filterExpression;
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
        filter: filterExpression,
        topN: effectiveTop,
        select: args.selectFields,
        orderBy: args.orderBy,
        expand: args.expand,
      },
      query
    );
  } catch (error) {
    // Acumatica's contract-API OData filter binder 500s when it can't apply a
    // $filter — an unbound/computed/BQL-delegate field (CannotOptimizeException),
    // a type mismatch, an unknown field, or a child-collection reference. These
    // all surface as an opaque "Acumatica internal error" 500. Convert them into
    // a structured, actionable error. Checked before the $select retry: the
    // filter, not $select, is the cause, so dropping $select wouldn't help. The
    // body-based classifier returns null for a genuine $select 500, so that case
    // still falls through to the retry below.
    const filterErrorKind =
      filterExpression && error instanceof AcumaticaApiError && error.statusCode === 500
        ? getFilterErrorKind(error.body)
        : null;
    if (filterErrorKind) {
      const info = getComplexEntityInfo(entityName);
      const keyHint = info?.keyField
        ? `filter on the key field for a single record (filterExpression="${info.keyField} eq '<value>'", topN=1)`
        : `filter on the entity's key field for a single record (topN=1)`;
      const giHint = `use a Generic Inquiry (acumatica_list_generic_inquiries to find one, then acumatica_run_inquiry) for a broad search`;
      const message =
        filterErrorKind === "child_collection"
          ? `The filterExpression on entity '${entityName}' references a child-collection field, which the contract API cannot filter on. Instead, ${giHint}, or filter on a top-level field.`
          : `Entity '${entityName}' could not be server-side $filtered with this expression — Acumatica could not bind or optimize it ` +
            `(common causes: an unbound/computed/BQL-delegate field, a type mismatch, or an unknown field name; this includes CannotOptimizeException). ` +
            `Verify field names and types with acumatica_describe_entity, ${keyHint}, or ${giHint}.`;
      return {
        error: message,
        entity: entityName,
        filterNotApplicable: true,
        filterErrorKind,
        ...(info?.keyField ? { keyField: info.keyField } : {}),
      };
    }
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
          filter: filterExpression,
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

  // False-negative guard (failure mode B). A complex document entity can
  // silently return [] (HTTP 200) for a non-key $filter that Acumatica's
  // optimizer dropped — even when matching records exist (e.g. substringof on
  // Shipment.Description). Flag an empty result on these entities so the model
  // doesn't conclude "no such record exists". A keyed filter is optimizable and
  // trustworthy, so we don't warn when the filter references the key field.
  const complexInfo = getComplexEntityInfo(entityName);
  if (
    complexInfo &&
    Array.isArray(unwrapped) &&
    unwrapped.length === 0 &&
    filterExpression &&
    !isKeyedFilter(filterExpression, complexInfo.keyField)
  ) {
    const keyedSuggestion = complexInfo.keyField
      ? `a keyed lookup (filterExpression="${complexInfo.keyField} eq '<value>'", topN=1)`
      : `a keyed lookup on the entity's key field (topN=1)`;
    return {
      results: [],
      possibleFalseNegative: true,
      warning:
        `0 rows returned, but '${entityName}' is a complex document entity that Acumatica often cannot server-side $filter on a non-key field — ` +
        `it may silently return an empty set instead of matching rows. This 0 may be a FALSE NEGATIVE; do NOT conclude that no matching record exists. ` +
        `Verify with ${keyedSuggestion}, or use a Generic Inquiry (acumatica_list_generic_inquiries, then acumatica_run_inquiry) for the search.`,
    };
  }

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
