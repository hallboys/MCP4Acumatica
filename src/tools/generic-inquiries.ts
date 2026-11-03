// Copyright 2026 Hall Boys, Inc.
// SPDX-License-Identifier: Apache-2.0

import type { AppEnv } from "../types/acumatica";
import { AcumaticaClient } from "../lib/acumatica-client";
import { getConfig, parsePositiveIntConfig, validateStringArg } from "../lib/config";
import { normalizeODataFilter } from "../lib/odata-filter";
import { cleanGiRows } from "../lib/gi-rows";
import { checkGiGate } from "../lib/gi-registry";
import { parseEdmxFunctions, planGiRequest, describeParam } from "../lib/gi-parameters";
import { loadGiMetadata, forgetGiMetadata } from "../lib/gi-metadata";
import { getGiRegistry } from "../lib/gi-registry-build";
import {
  classifyODataV4Error,
  buildODataV4Correction,
  filterReferencedColumns,
  buildCalculatedColumnRefusal,
} from "../lib/odata-v4-errors";
import { AcumaticaApiError } from "../lib/acumatica-client";

/** OData query response with value array */
interface ODataQueryResponse {
  value: Record<string, unknown>[];
  // Present only when `$count=true` was requested and the endpoint honors it.
  "@odata.count"?: number;
}

export async function handleRunInquiry(
  env: AppEnv,
  acumaticaUsername: string,
  args: {
    inquiryName: string;
    filterExpression?: string;
    topN?: number;
    selectFields?: string;
    parameters?: string;
  }
): Promise<unknown> {
  const lengthErr =
    validateStringArg(args.inquiryName, "inquiryName", 200) ||
    validateStringArg(args.filterExpression, "filterExpression", 2000) ||
    validateStringArg(args.selectFields, "selectFields", 1000) ||
    validateStringArg(args.parameters, "parameters", 2000);
  if (lengthErr) return { error: lengthErr };

  // Opt-in gate: when a registry has been built, only GIs explicitly exposed
  // (ExposedtoMCP) may be queried. Absent registry → gate inactive (see
  // gi-registry.ts). Feed/canary GIs are always denied.
  const registry = await getGiRegistry(env, acumaticaUsername);
  const gate = checkGiGate(registry, args.inquiryName);
  if (!gate.allowed) return { error: gate.reason };

  const client = new AcumaticaClient(env, acumaticaUsername);

  // Parameterized GI: the plain entity set would run it with no parameter
  // values and return plausible but unfiltered rows, with no error. So it is
  // queried through its `_WithParameters` function instead, after the model's
  // `parameters` are checked against live $metadata — including unknown names,
  // which Acumatica silently ignores. planGiRequest fails closed: when the
  // server can't be sure a GI is parameter-free ($metadata unavailable, an
  // ambiguous name, unparsable definitions) it refuses. Labels/defaults come
  // from the registry (MCPGIParams feed) when present.
  const metadata = await loadGiMetadata(env, client, acumaticaUsername, "acumatica_run_inquiry");
  const plan = planGiRequest(
    metadata === null ? null : parseEdmxFunctions(metadata),
    args.inquiryName,
    args.parameters,
    gate.entry?.parameters,
    env.ACUMATICA_GI_PARAMETERS === "true"
  );
  if (plan.kind === "refuse") return plan.error;
  const odataPath = plan.path;
  const aliasQuery: Record<string, string> = plan.kind === "function" ? plan.aliases : {};
  const paramBlock: Record<string, unknown> | undefined =
    plan.kind === "function"
      ? {
          applied: plan.applied,
          defaulted: plan.defaulted.map(describeParam),
          ...(plan.defaulted.length
            ? {
                note:
                  "Parameters under 'defaulted' were not supplied and took the inquiry's own default value, " +
                  "which can narrow the results (a default date range, for example). Tell the user which defaults applied.",
              }
            : {}),
        }
      : undefined;
  const withParams = (result: unknown): unknown =>
    !paramBlock
      ? result
      : Array.isArray(result)
        ? { results: result, parameters: paramBlock }
        : { ...(result as Record<string, unknown>), parameters: paramBlock };

  const maxRecords = await getConfig(env.store, "acumatica_max_records", env.ACUMATICA_MAX_RECORDS);
  const MAX_TOP = parsePositiveIntConfig(maxRecords, 1000);
  const requestedTop = args.topN ?? 100;
  const effectiveTop = Math.min(requestedTop, MAX_TOP);

  // normalizeODataFilter strips `substringof|startswith|endswith(...) eq true`.
  // That workaround is motivated by the CONTRACT-REST (v3) parser; this endpoint
  // is v4, where `f(...) eq true` is legal anyway. Kept because it is harmless
  // here (a bare boolean function is equally valid in v4) and because dropping it
  // would silently change behavior for filters already in use.
  const filterExpression = normalizeODataFilter(args.filterExpression);

  // Pre-flight: a $filter that references a CALCULATED column (an `=…`
  // expression in the GI design) makes Acumatica return HTTP 200 with an empty
  // body — no error, no rows — which parseAcumaticaJson can only report as an
  // anomaly after the fact. The registry knows which columns are expressions
  // (flagged during the positional alignment), so refuse before calling
  // Acumatica and hand the model the stored columns to rewrite against.
  // Production logs attribute ~14% of tool errors to exactly this (279
  // empty-body occurrences, 259 of them in run_inquiry).
  if (filterExpression && gate.entry?.fields?.length) {
    const calculated = gate.entry.fields.filter((f) => f.expression).map((f) => f.name);
    const offending = filterReferencedColumns(filterExpression, calculated);
    if (offending.length) {
      return buildCalculatedColumnRefusal({
        inquiryName: args.inquiryName,
        filterExpression,
        calculatedColumns: offending,
        filterableFields: gate.entry.fields.filter((f) => !f.expression).map((f) => f.name),
      });
    }
  }

  const query: Record<string, string> = {};

  if (filterExpression) {
    query.$filter = filterExpression;
  }

  query.$top = String(effectiveTop);

  if (args.selectFields) {
    query.$select = args.selectFields;
  }

  // Opt-in per deployment: 2025 R2 documents `$count` as unsupported on the
  // GI-based OData interface, so production never sends it.
  if (env.ACUMATICA_GI_COUNT === "true") {
    query.$count = "true";
  }

  Object.assign(query, aliasQuery);

  let response: ODataQueryResponse;
  try {
    response = await client.getOData<ODataQueryResponse>(
      odataPath,
      "acumatica_run_inquiry",
      {
        inquiryName: args.inquiryName,
        filter: filterExpression,
        topN: effectiveTop,
        select: args.selectFields,
        ...(paramBlock ? { parameters: paramBlock.applied } : {}),
      },
      query
    );
  } catch (err) {
    // On the function URL a 404 means a required parameter did not reach
    // Acumatica (validated above, so unexpected) — not "no such record".
    if (plan.kind === "function" && err instanceof AcumaticaApiError && err.statusCode === 404) {
      // Re-read $metadata on the retry: the parameter list may have changed.
      await forgetGiMetadata(env, acumaticaUsername);
      return {
        error: "parameterized_inquiry_failed",
        inquiryName: args.inquiryName,
        problem:
          "Acumatica rejected the parameterized call with HTTP 404, which on this endpoint means it did not receive a " +
          "required parameter. The inquiry's parameter definitions may have changed since they were last read.",
        parameters: plan.fn.params.map(describeParam),
        actionRequired:
          "The query was NOT executed — do not report 'no records'. Check the parameters with acumatica_describe_inquiry and retry once.",
      };
    }
    // Turn an OData v4 filter-parser rejection into a correction instead of a
    // dead end. The GI endpoint is v4 while acumatica_list_entities is v3, so
    // the most common cause is v3 syntax carried across (substringof,
    // datetimeoffset'...') — and for a bad property name the registry already
    // holds the authoritative $metadata names, so we can simply supply them.
    // No extra round-trip: `gate.entry` was resolved above.
    if (err instanceof AcumaticaApiError) {
      const kind = classifyODataV4Error(err.message);
      if (kind) {
        return buildODataV4Correction(kind, err.message, {
          inquiryName: args.inquiryName,
          filterExpression,
          availableFields: gate.entry?.fields?.map((f) => f.name),
        });
      }
    }
    throw err;
  }

  const rows = response.value || [];

  // Strip OData metadata fields and trim space-padded fixed-width values.
  const cleaned = cleanGiRows(rows);

  // With an exact total, "at the cap" no longer has to be ambiguous.
  const totalCount = response["@odata.count"];
  if (typeof totalCount === "number") {
    if (totalCount <= cleaned.length) return withParams(cleaned);
    return withParams({
      results: cleaned,
      truncated: true,
      mayBeComplete: false,
      totalCount,
      recordsReturned: cleaned.length,
      recordLimit: effectiveTop,
      paginationSupported: false,
      actionRequired:
        `${totalCount} records match this query; this response contains only the first ${cleaned.length}. ` +
        `This tool does NOT support pagination. Do NOT call this tool again with a different offset or topN to retrieve more records — no such mechanism exists. ` +
        `Report the total if that answers the question; otherwise ask the user to narrow their request with a more specific filterExpression ` +
        `(e.g., date range, status, or other criteria) so the result set fits under the limit.`,
    });
  }

  // Without a total count (the default), "exactly at cap" is
  // indistinguishable from "more rows exist". See entity-list.ts for the
  // same reasoning.
  if (cleaned.length >= effectiveTop) {
    return withParams({
      results: cleaned,
      truncated: true,
      mayBeComplete: true,
      recordsReturned: cleaned.length,
      recordLimit: effectiveTop,
      paginationSupported: false,
      actionRequired:
        `Result set hit the ${effectiveTop}-record cap, so more records may exist beyond this response — the OData GI endpoint does not report a total count, so we cannot tell from here whether the result is complete. ` +
        `This tool does NOT support pagination. Do NOT call this tool again with a different offset or topN to retrieve more records — no such mechanism exists. ` +
        `If the user needs confidence the result is complete, stop and ask them to narrow their request with a more specific filterExpression ` +
        `(e.g., date range, status, or other criteria) so the result set fits comfortably under the limit.`,
    });
  }

  return withParams(cleaned);
}
