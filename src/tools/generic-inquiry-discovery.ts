// Copyright 2026 Hall Boys, Inc.
// SPDX-License-Identifier: Apache-2.0

import type { Env } from "../types/acumatica";
import { AcumaticaClient, AcumaticaApiError, unwrapFields } from "../lib/acumatica-client";

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
          error: `GI '${args.inquiryName}' not found. The GI must be added to the Default Web Services endpoint in Acumatica (SM208000) to be accessible via REST API. Check the GI name in the Acumatica UI.`,
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
