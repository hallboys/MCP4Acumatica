// Copyright 2026 Hall Boys, Inc.
// SPDX-License-Identifier: Apache-2.0

import type { AppEnv } from "../types/acumatica";
import { AcumaticaClient, AcumaticaApiError } from "../lib/acumatica-client";
import { getCached, setCached } from "../lib/metadata-cache";
import { getConfig } from "../lib/config";

const GI_LIST_TTL_SECONDS = 3600; // 1 hour
const GI_METADATA_TTL_SECONDS = 3600; // 1 hour
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
  const maxRecords = await getConfig(env.store, "acumatica_max_records", env.ACUMATICA_MAX_RECORDS);
  const MAX_TOP = parseInt(maxRecords || "", 10) || 1000;
  const effectiveTop = Math.min(args.topN ?? 200, MAX_TOP);

  try {
    // Try KV cache for both the service document and $metadata
    const [cachedServiceDoc, cachedMetadata] = await Promise.all([
      getCached<ODataServiceDocument>(env.store, "gi_list"),
      getCached<string>(env.store, "gi_metadata"),
    ]);

    let serviceDoc: ODataServiceDocument;
    let metadata: string;

    if (cachedServiceDoc && cachedMetadata !== null) {
      // Full cache hit — skip both API calls
      serviceDoc = cachedServiceDoc;
      metadata = cachedMetadata;
    } else {
      // Fetch whichever is missing (or both)
      const client = new AcumaticaClient(env, acumaticaUsername);

      const [fetchedServiceDoc, fetchedMetadata] = await Promise.all([
        cachedServiceDoc
          ? Promise.resolve(cachedServiceDoc)
          : client.getOData<ODataServiceDocument>(
              "",
              "acumatica_list_generic_inquiries",
              { titleFilter: args.titleFilter, topN: effectiveTop }
            ),
        cachedMetadata !== null
          ? Promise.resolve(cachedMetadata)
          : client.getODataMetadata("acumatica_list_generic_inquiries").catch(() => ""),
      ]);

      serviceDoc = fetchedServiceDoc;
      metadata = fetchedMetadata;

      // Store any freshly fetched data in KV
      const cacheWrites: Promise<void>[] = [];
      if (!cachedServiceDoc) {
        cacheWrites.push(setCached(env.store, "gi_list", serviceDoc, GI_LIST_TTL_SECONDS));
      }
      if (cachedMetadata === null) {
        cacheWrites.push(setCached(env.store, "gi_metadata", metadata, GI_METADATA_TTL_SECONDS));
      }
      await Promise.all(cacheWrites);
    }

    // Extract parameterized GI names from $metadata FunctionImport entries
    // Pattern: <FunctionImport Name="GIName_WithParameters" ...>
    const parameterizedNames = new Set<string>();
    if (metadata) {
      const matches = metadata.matchAll(/FunctionImport\s+Name="([^"]+)_WithParameters"/g);
      for (const match of matches) {
        parameterizedNames.add(match[1]);
      }
    }

    let items = (serviceDoc.value || [])
      .filter((entry) => !parameterizedNames.has(entry.name))
      .map((entry) => ({
        inquiryName: entry.name,
        url: entry.url,
      }));

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

    const excludedNote = parameterizedNames.size > 0
      ? `Excluded ${parameterizedNames.size} parameterized GI(s) that cannot be queried directly via OData.`
      : undefined;

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
        ...(excludedNote ? { note: excludedNote } : {}),
      };
    }

    return excludedNote ? { results: items, note: excludedNote } : items;
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

export async function handleDescribeInquiry(
  env: AppEnv,
  acumaticaUsername: string,
  args: { inquiryName: string }
): Promise<unknown> {
  const cacheKey = `gi_schema:${args.inquiryName}`;

  // Check KV cache first
  const cached = await getCached<CachedGiSchema>(env.store, cacheKey);
  if (cached) {
    return {
      ...cached,
      note: "Field list inferred from live sample row via OData. Types may be approximate.",
    };
  }

  const client = new AcumaticaClient(env, acumaticaUsername);

  try {
    const response = await client.getOData<ODataQueryResponse>(
      args.inquiryName,
      "acumatica_describe_inquiry",
      { inquiryName: args.inquiryName },
      { $top: "1" }
    );

    const rows = response.value || [];

    if (rows.length === 0) {
      // Don't cache empty results — the GI may just not have data right now
      return {
        inquiryName: args.inquiryName,
        fields: [],
        sampleRow: null,
        note: "GI returned no data — field schema cannot be inferred. Try running it in the Acumatica UI first to confirm it returns data, or use acumatica_run_inquiry with a filter.",
      };
    }

    const sampleRow = rows[0];

    // Filter out OData metadata fields
    const fields = Object.entries(sampleRow)
      .filter(([key]) => !key.startsWith("@odata"))
      .map(([fieldName, value]) => ({
        fieldName,
        dataType: inferType(value),
      }));

    // Cache the schema (fields + sample row) for future calls
    await setCached(env.store, cacheKey, { inquiryName: args.inquiryName, fields, sampleRow }, GI_SCHEMA_TTL_SECONDS);

    return {
      inquiryName: args.inquiryName,
      fields,
      sampleRow,
      note: "Field list inferred from live sample row via OData. Types may be approximate.",
    };
  } catch (error) {
    if (error instanceof AcumaticaApiError) {
      return {
        error: `GI '${args.inquiryName}' — OData returned ${error.statusCode}: ${error.message}`,
      };
    }
    throw error;
  }
}
