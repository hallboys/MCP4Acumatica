// Copyright 2026 Hall Boys, Inc.
// SPDX-License-Identifier: Apache-2.0

import type { Env } from "../types/acumatica";
import { AcumaticaClient, AcumaticaApiError } from "../lib/acumatica-client";

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
  env: Env,
  acumaticaUsername: string,
  args: {
    titleFilter?: string;
    topN?: number;
  }
): Promise<unknown> {
  const MAX_TOP = 500;
  const client = new AcumaticaClient(env, acumaticaUsername);
  const effectiveTop = Math.min(args.topN ?? 200, MAX_TOP);

  try {
    // OData service document lists all exposed GIs
    const serviceDoc = await client.getOData<ODataServiceDocument>(
      "",
      "acumatica_list_generic_inquiries",
      { titleFilter: args.titleFilter, topN: effectiveTop }
    );

    let items = (serviceDoc.value || []).map((entry) => ({
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
    if (items.length > effectiveTop) {
      items = items.slice(0, effectiveTop);
    }

    if (items.length === 0) {
      return { results: [], note: "No Generic Inquiries found matching the criteria." };
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

/** OData query response with value array */
interface ODataQueryResponse {
  value: Record<string, unknown>[];
}

export async function handleDescribeInquiry(
  env: Env,
  acumaticaUsername: string,
  args: { inquiryName: string }
): Promise<unknown> {
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
