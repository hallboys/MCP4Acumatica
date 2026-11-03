// Copyright 2026 Hall Boys, Inc.
// SPDX-License-Identifier: Apache-2.0

import type { AppEnv } from "../types/acumatica";
import { AcumaticaClient, AcumaticaApiError } from "../lib/acumatica-client";
import { getCached, setCached } from "../lib/metadata-cache";
import { getConfig, parsePositiveIntConfig, validateStringArg } from "../lib/config";
import { cleanGiRow } from "../lib/gi-rows";
import {
  checkGiGate,
  EXCLUDED_GI_NAMES,
  parseEdmxTypes,
  edmTypeToSimple,
  type GiRegistryEntry,
} from "../lib/gi-registry";
import {
  parseEdmxFunctions,
  findGiFunction,
  resolveGiRouting,
  overlayParams,
  describeParam,
  normalizeGiKey,
  type GiParamMeta,
} from "../lib/gi-parameters";
import { loadGiMetadata } from "../lib/gi-metadata";
import { getGiRegistry } from "../lib/gi-registry-build";

const GI_LIST_TTL_SECONDS = 3600; // 1 hour
const GI_SCHEMA_TTL_SECONDS = 3600; // 1 hour

/** OData service document entry */
interface ODataServiceEntry {
  name: string;
  url: string;
}

/** OData service document response */
interface ODataServiceDocument {
  value: ODataServiceEntry[];
}

export async function handleListGenericInquiries(
  env: AppEnv,
  acumaticaUsername: string,
  args: {
    titleFilter?: string;
    topN?: number;
  }
): Promise<unknown> {
  const lengthErr = validateStringArg(args.titleFilter, "titleFilter", 500);
  if (lengthErr) return { error: lengthErr };

  const maxRecords = await getConfig(env.store, "acumatica_max_records", env.ACUMATICA_MAX_RECORDS);
  const MAX_TOP = parsePositiveIntConfig(maxRecords, 1000);
  const effectiveTop = Math.min(args.topN ?? 200, MAX_TOP);

  try {
    // Opt-in gate, checked FIRST. With no registry built, the gate is INACTIVE:
    // we do NOT enumerate GIs — handing the model an uncurated menu (including GIs
    // that return wrong data) is exactly the risk the gate exists to prevent.
    // Discovery is suppressed; a specific GI can still be run by exact name via
    // acumatica_run_inquiry / acumatica_describe_inquiry. Once a registry exists,
    // list shows only the gated (ExposedtoMCP) GIs. (Feed/canary GIs are hidden
    // either way.) Skipping the service-document fetch here is also an efficiency win.
    const registry = await getGiRegistry(env, acumaticaUsername);
    if (!registry) {
      return {
        results: [],
        gateInactive: true,
        note:
          "Generic Inquiry discovery is disabled: no GIs have been exposed to the AI assistant. " +
          "An administrator enables this by configuring the MCP GI registry (the MCPGIs/MCPGIFields feed GIs) and tagging GIs 'Exposed to MCP'. " +
          "No GIs are listed until then — but a specific inquiry can still be run by exact name with acumatica_run_inquiry if you already know it.",
      };
    }
    const gatedNames = new Set(registry.gis.map((g) => g.giName));
    const descByName = new Map(
      registry.gis.filter((g) => g.description).map((g) => [g.giName, g.description!])
    );

    const client = new AcumaticaClient(env, acumaticaUsername);
    const cachedServiceDoc = await getCached<ODataServiceDocument>(env.store, "gi_list");
    const [serviceDoc, metadata] = await Promise.all([
      cachedServiceDoc
        ? Promise.resolve(cachedServiceDoc)
        : client.getOData<ODataServiceDocument>(
            "",
            "acumatica_list_generic_inquiries",
            { titleFilter: args.titleFilter, topN: effectiveTop }
          ),
      loadGiMetadata(env, client, acumaticaUsername, "acumatica_list_generic_inquiries"),
    ]);
    if (!cachedServiceDoc) await setCached(env.store, "gi_list", serviceDoc, GI_LIST_TTL_SECONDS);

    // Parameterized GIs are listed with their parameters, so the model knows
    // to supply them (run_inquiry refuses a parameterized GI called without a
    // `parameters` argument).
    // Without $metadata the list still works, just without parameter names;
    // run/describe refuse a GI they can't classify, so nothing runs unchecked.
    const functions = parseEdmxFunctions(metadata ?? "");
    const paramsByName = new Map(registry.gis.map((g) => [g.giName, g.parameters]));

    // With ACUMATICA_GI_PARAMETERS off, parameterized GIs stay out of the menu
    // altogether (run/describe refuse them), as before 0.56.0.
    const parametersEnabled = env.ACUMATICA_GI_PARAMETERS === "true";
    const isParameterized = (name: string) =>
      findGiFunction(functions, name) !== undefined || !!paramsByName.get(name)?.length;

    let items = (serviceDoc.value || [])
      .filter((entry) => !EXCLUDED_GI_NAMES.has(entry.name))
      .filter((entry) => gatedNames.has(entry.name))
      .filter((entry) => parametersEnabled || !isParameterized(entry.name))
      .map((entry) => {
        const description = descByName.get(entry.name);
        const found = findGiFunction(functions, entry.name);
        const fn = found && found !== "ambiguous" && !found.unparsed ? found : undefined;
        const params = fn ? overlayParams(fn.params, paramsByName.get(entry.name)) : undefined;
        return {
          inquiryName: entry.name,
          url: entry.url,
          ...(description ? { description } : {}),
          ...(params ? { parameters: params.map((p) => (p.required ? `${p.name} (required)` : p.name)) } : {}),
        };
      });

    // Client-side title filter (OData service document doesn't support $filter)
    if (args.titleFilter) {
      const filter = args.titleFilter.toLowerCase();
      items = items.filter((item) =>
        item.inquiryName.toLowerCase().includes(filter)
      );
    }

    // Apply top limit
    const totalMatched = items.length;
    const truncated = totalMatched > effectiveTop;
    if (truncated) {
      items = items.slice(0, effectiveTop);
    }

    if (items.length === 0) {
      return { results: [], note: "No Generic Inquiries found matching the criteria." };
    }

    if (truncated) {
      return {
        results: items,
        truncated: true,
        recordsReturned: items.length,
        recordLimit: effectiveTop,
        paginationSupported: false,
        actionRequired:
          `Results were truncated at ${effectiveTop} records and this tool does NOT support pagination. ` +
          `Do NOT call this tool again with a different topN to retrieve more records — no such mechanism exists. ` +
          `Instead, stop and ask the user to narrow their request by providing a more specific titleFilter ` +
          `so the result set fits within the limit.`,
      };
    }

    return items;
  } catch (error) {
    if (error instanceof AcumaticaApiError) {
      return {
        error: `OData GI endpoint returned ${error.statusCode}: ${error.message}`,
      };
    }
    throw error;
  }
}

/**
 * Infer a data type string from a sample value.
 */
function inferType(value: unknown): string {
  if (value === null || value === undefined) return "unknown";
  if (typeof value === "number") return Number.isInteger(value) ? "integer" : "decimal";
  if (typeof value === "boolean") return "boolean";
  if (typeof value === "string") {
    if (/^\d{4}-\d{2}-\d{2}/.test(value)) return "datetime";
    return "string";
  }
  return "object";
}

/** Cached GI schema shape */
interface CachedGiSchema {
  inquiryName: string;
  fields: Array<{ fieldName: string; dataType: string }>;
  sampleRow: Record<string, unknown>;
}

/** OData query response with value array */
interface ODataQueryResponse {
  value: Record<string, unknown>[];
}

type InferredField = { fieldName: string; dataType: string };

/**
 * Build the describe_inquiry response, overlaying curated registry metadata
 * (authoritative field names + declared types + descriptions) onto the
 * live-sample inference. Curated wins; inference is the fallback for any field
 * the registry didn't resolve a type for. Without a curated entry (gate
 * inactive, or a gated GI with no resolved fields), the inferred schema is
 * returned unchanged.
 */
function buildSchemaResponse(
  inquiryName: string,
  inferredFields: InferredField[],
  sampleRow: Record<string, unknown> | null,
  entry?: GiRegistryEntry
): Record<string, unknown> {
  if (entry?.fields?.length) {
    const inferred = new Map(inferredFields.map((f) => [f.fieldName, f.dataType]));
    const fields = entry.fields.map((cf) => ({
      fieldName: cf.name,
      dataType: cf.type ?? inferred.get(cf.name) ?? "unknown",
      ...(cf.caption ? { caption: cf.caption } : {}),
      ...(cf.description ? { description: cf.description } : {}),
      ...(cf.expression ? { calculated: true } : {}),
    }));
    const hasCalculated = fields.some((f) => "calculated" in f);
    return {
      inquiryName,
      ...(entry.description ? { description: entry.description } : {}),
      fields,
      sampleRow,
      note:
        "Curated schema: field names and types from the GI definition / OData $metadata, " +
        "annotated with curated descriptions. Any field without a curated type falls back to a live-sample inference." +
        (hasCalculated
          ? " Fields marked 'calculated: true' are computed expressions and CANNOT be used in a filterExpression — " +
            "Acumatica fails such filters with an empty response instead of an error. Filter on stored fields and " +
            "apply conditions on calculated fields to the returned rows yourself."
          : ""),
    };
  }
  return {
    inquiryName,
    fields: inferredFields,
    sampleRow,
    note: "Field list inferred from live sample row via OData. Types may be approximate.",
  };
}

/**
 * Add a parameterized GI's parameters to a describe_inquiry response, with how
 * to pass them and what the sample (if any) was run with.
 */
function withParameters(
  response: Record<string, unknown>,
  params: GiParamMeta[] | undefined,
  sampled: boolean
): Record<string, unknown> {
  if (!params) return response;
  const required = params.some((p) => p.required);
  return {
    ...response,
    parameters: params.map(describeParam),
    parametersNote:
      "This inquiry takes parameters. Pass them to acumatica_run_inquiry as `parameters`, a JSON object keyed by these names " +
      '(e.g. {"Name":"value"}). Required parameters must have a value; an optional parameter left out takes the defaultValue ' +
      "shown (or the inquiry's own default), which can narrow the results. Pass {} to run with every optional parameter at its default." +
      (required
        ? " No sample row is shown because a required parameter has no value yet; field names and types come from OData $metadata."
        : sampled
          ? " The sample row was taken with every parameter at its default."
          : ""),
  };
}

export async function handleDescribeInquiry(
  env: AppEnv,
  acumaticaUsername: string,
  args: { inquiryName: string }
): Promise<unknown> {
  // Opt-in gate (mirrors run_inquiry): don't describe a GI the model isn't
  // allowed to query. Absent registry → inactive. Feed/canary always denied.
  const registry = await getGiRegistry(env, acumaticaUsername);
  const gate = checkGiGate(registry, args.inquiryName);
  if (!gate.allowed) return { error: gate.reason };

  const client = new AcumaticaClient(env, acumaticaUsername);
  const entry = gate.entry;

  // Parameterized GI: report its parameters, and sample through its
  // `_WithParameters` function — never the plain entity set, which runs it
  // with no parameter values. With a required parameter there is no honest
  // sample to take (the model hasn't chosen the values yet), so field names
  // and types come from $metadata alone.
  const metadata = await loadGiMetadata(env, client, acumaticaUsername, "acumatica_describe_inquiry");
  const routing = resolveGiRouting(
    metadata === null ? null : parseEdmxFunctions(metadata),
    args.inquiryName,
    entry?.parameters,
    env.ACUMATICA_GI_PARAMETERS === "true"
  );
  if (routing.kind === "refuse") return routing.error;
  const fn = routing.kind === "function" ? routing.fn : undefined;
  const params = fn ? overlayParams(fn.params, entry?.parameters) : undefined;
  const respond = (fields: InferredField[], sampleRow: Record<string, unknown> | null) =>
    withParameters(buildSchemaResponse(args.inquiryName, fields, sampleRow, entry), params, sampleRow !== null);

  if (fn && params?.some((p) => p.required)) {
    const edmx = parseEdmxTypes(metadata ?? "").get(normalizeGiKey(args.inquiryName));
    const declared = edmx
      ? edmx.order.map((name) => ({ fieldName: name, dataType: edmTypeToSimple(edmx.types.get(name) ?? "") }))
      : [];
    const response = respond(declared, null);
    return declared.length || entry?.fields?.length
      ? response
      : { ...response, note: "No field list: OData $metadata has no entity type matching this inquiry's name." };
  }

  const cacheKey = `gi_schema:${args.inquiryName}`;

  // Check KV cache first (cache holds the raw inference; curated overlay is
  // applied at response time so registry edits take effect without a recache).
  // A parameterized GI's sample is never cached: it ran at the GI's defaults,
  // which can depend on the user or the date (@me, @Today).
  const cached = fn ? null : await getCached<CachedGiSchema>(env.store, cacheKey);
  if (cached) {
    return respond(cached.fields, cached.sampleRow);
  }

  try {
    const response = await client.getOData<ODataQueryResponse>(
      fn ? `${fn.functionImport}()` : args.inquiryName,
      "acumatica_describe_inquiry",
      { inquiryName: args.inquiryName },
      { $top: "1" }
    );

    const rows = response.value || [];

    if (rows.length === 0) {
      // No sample to infer from. If the registry resolved this GI's fields, we
      // can still return the curated schema (it needs no live data).
      if (entry?.fields?.length) {
        return respond([], null);
      }
      // Don't cache empty results — the GI may just not have data right now
      return withParameters(
        {
          inquiryName: args.inquiryName,
          fields: [],
          sampleRow: null,
          note: "GI returned no data — field schema cannot be inferred. Try running it in the Acumatica UI first to confirm it returns data, or use acumatica_run_inquiry with a filter.",
        },
        params,
        false
      );
    }

    // Strip OData control fields and trim space-padded values before inference.
    const sampleRow = cleanGiRow(rows[0]);

    const fields = Object.entries(sampleRow).map(([fieldName, value]) => ({
      fieldName,
      dataType: inferType(value),
    }));

    // Cache the raw inference (not the curated overlay) for future calls.
    if (!fn) {
      await setCached(env.store, cacheKey, { inquiryName: args.inquiryName, fields, sampleRow }, GI_SCHEMA_TTL_SECONDS);
    }

    return respond(fields, sampleRow);
  } catch (error) {
    if (error instanceof AcumaticaApiError) {
      return {
        error: `GI '${args.inquiryName}' — OData returned ${error.statusCode}: ${error.message}`,
      };
    }
    throw error;
  }
}
