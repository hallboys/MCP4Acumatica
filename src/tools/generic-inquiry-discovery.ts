// Copyright 2026 Hall Boys, Inc.
// SPDX-License-Identifier: Apache-2.0

import type { Env } from "../types/acumatica";
import { AcumaticaClient, AcumaticaApiError, unwrapFields } from "../lib/acumatica-client";

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

  const query: Record<string, string> = {
    $select: "InquiryID,InquiryTitle,ScreenID,IsVisible",
    $filter: "IsVisible eq true",
    $top: String(effectiveTop),
  };

  if (args.titleFilter) {
    query.$filter = `IsVisible eq true and substringof('${args.titleFilter}', InquiryTitle)`;
  }

  try {
    const results = await client.get<unknown[]>(
      "GenericInquiry",
      "acumatica_list_generic_inquiries",
      { titleFilter: args.titleFilter, topN: args.topN },
      query
    );

    const unwrapped = Array.isArray(results) ? results.map(unwrapFields) : [];

    // Reshape to cleaner output
    const items = (unwrapped as Record<string, unknown>[]).map((row) => ({
      inquiryName: row.InquiryID,
      title: row.InquiryTitle,
      screenID: row.ScreenID,
    }));

    if (items.length === 0) {
      return { results: [], note: "No visible Generic Inquiries found matching the criteria." };
    }

    return items;
  } catch (error) {
    if (error instanceof AcumaticaApiError && error.statusCode === 404) {
      return {
        error: "GenericInquiry entity not available. Check API user permissions or Acumatica version.",
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

export async function handleDescribeInquiry(
  env: Env,
  acumaticaUsername: string,
  args: { inquiryName: string }
): Promise<unknown> {
  const client = new AcumaticaClient(env, acumaticaUsername);

  // Probe with $top=1 to get a sample row and infer fields
  try {
    const results = await client.get<unknown[]>(
      args.inquiryName,
      "acumatica_describe_inquiry",
      { inquiryName: args.inquiryName },
      { $top: "1" }
    );

    const unwrapped = Array.isArray(results) ? results.map(unwrapFields) : [];

    if (unwrapped.length === 0) {
      return {
        inquiryName: args.inquiryName,
        fields: [],
        sampleRow: null,
        note: "GI returned no data — field schema cannot be inferred. Try running it in the Acumatica UI first to confirm it returns data, or use acumatica_run_inquiry with a filter.",
      };
    }

    const sampleRow = unwrapped[0] as Record<string, unknown>;

    const fields = Object.entries(sampleRow).map(([fieldName, value]) => ({
      fieldName,
      dataType: inferType(value),
    }));

    return {
      inquiryName: args.inquiryName,
      fields,
      sampleRow,
      note: "Field list inferred from live sample row. Types may be approximate.",
    };
  } catch (error) {
    if (error instanceof AcumaticaApiError) {
      if (error.statusCode === 404) {
        return {
          error: `GI '${args.inquiryName}' not found. Use acumatica_list_generic_inquiries to verify the name.`,
        };
      }
      if (error.statusCode === 400) {
        return {
          error: "GI may require filter parameters to execute. Try acumatica_run_inquiry with a filter first.",
        };
      }
    }
    throw error;
  }
}
