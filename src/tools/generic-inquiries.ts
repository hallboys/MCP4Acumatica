// Copyright 2026 Hall Boys, Inc.
// SPDX-License-Identifier: Apache-2.0

import type { AppEnv } from "../types/acumatica";
import { AcumaticaClient } from "../lib/acumatica-client";
import { getConfig, parsePositiveIntConfig, validateStringArg } from "../lib/config";
import { normalizeODataFilter } from "../lib/odata-filter";
import { cleanGiRows } from "../lib/gi-rows";
import { checkGiGate, parameterizedGiNames } from "../lib/gi-registry";
import { getGiRegistry } from "../lib/gi-registry-build";
import { getCached, setCached } from "../lib/metadata-cache";

/** OData query response with value array */
interface ODataQueryResponse {
  value: Record<string, unknown>[];
}

const GI_METADATA_TTL_SECONDS = 3600; // 1 hour, shared "gi_metadata" cache

/**
 * Cached OData `$metadata` fetch (shared `gi_metadata` key, same as the GI list
 * and registry build). Used to detect parameterized GIs. Returns "" on failure
 * so the caller fails open — a metadata fetch error never blocks a query.
 */
async function loadGiMetadata(env: AppEnv, client: AcumaticaClient): Promise<string> {
  const cached = await getCached<string>(env.store, "gi_metadata");
  if (cached !== null) return cached;
  const xml = await client.getODataMetadata("acumatica_run_inquiry").catch(() => "");
  if (xml) await setCached(env.store, "gi_metadata", xml, GI_METADATA_TTL_SECONDS);
  return xml;
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
  const lengthErr =
    validateStringArg(args.inquiryName, "inquiryName", 200) ||
    validateStringArg(args.filterExpression, "filterExpression", 2000) ||
    validateStringArg(args.selectFields, "selectFields", 1000);
  if (lengthErr) return { error: lengthErr };

  // Opt-in gate: when a registry has been built, only GIs explicitly exposed
  // (ExposedtoMCP) may be queried. Absent registry → gate inactive (see
  // gi-registry.ts). Feed/canary GIs are always denied.
  const registry = await getGiRegistry(env, acumaticaUsername);
  const gate = checkGiGate(registry, args.inquiryName);
  if (!gate.allowed) return { error: gate.reason };

  const client = new AcumaticaClient(env, acumaticaUsername);

  // Guard: a parameterized GI queried over OData without its parameters returns
  // default/unfiltered — i.e. wrong — rows with no error. Refuse rather than hand
  // the model misleading data. An active gate already keeps parameterized GIs out
  // of the registry (the MCPGIs feed filters parameter-free); this also closes the
  // inactive-state hole, where run_inquiry could otherwise reach one. Fails open
  // if $metadata is unavailable (empty set → no false refusals).
  if (parameterizedGiNames(await loadGiMetadata(env, client)).has(args.inquiryName.trim())) {
    return {
      error:
        `Generic Inquiry '${args.inquiryName}' takes parameters and cannot be queried correctly over OData — ` +
        `without its parameters it returns default/unfiltered results (often wrong) with no error, so it was refused. ` +
        `Use a parameter-free Generic Inquiry, or run this inquiry in the Acumatica UI where its parameters can be supplied.`,
      parameterized: true,
    };
  }

  const maxRecords = await getConfig(env.store, "acumatica_max_records", env.ACUMATICA_MAX_RECORDS);
  const MAX_TOP = parsePositiveIntConfig(maxRecords, 1000);
  const requestedTop = args.topN ?? 100;
  const effectiveTop = Math.min(requestedTop, MAX_TOP);

  // Keep filter handling identical to acumatica_list_entities: strip
  // `substringof(...) eq true` → bare boolean function. See normalizeODataFilter.
  const filterExpression = normalizeODataFilter(args.filterExpression);

  const query: Record<string, string> = {};

  if (filterExpression) {
    query.$filter = filterExpression;
  }

  query.$top = String(effectiveTop);

  if (args.selectFields) {
    query.$select = args.selectFields;
  }

  const response = await client.getOData<ODataQueryResponse>(
    args.inquiryName,
    "acumatica_run_inquiry",
    { inquiryName: args.inquiryName, filter: filterExpression, topN: effectiveTop, select: args.selectFields },
    query
  );

  const rows = response.value || [];

  // Strip OData metadata fields and trim space-padded fixed-width values.
  const cleaned = cleanGiRows(rows);

  // OData GI endpoints return no total count, so "exactly at cap" is
  // indistinguishable from "more rows exist". See entity-list.ts for the
  // same reasoning.
  if (cleaned.length >= effectiveTop) {
    return {
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
    };
  }

  return cleaned;
}
