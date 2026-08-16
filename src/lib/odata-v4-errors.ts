// Copyright 2026 Hall Boys, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Turns Acumatica's OData **v4** filter-parser errors into corrections the model
 * can act on, for the Generic-Inquiry endpoint (`/t/{tenant}/api/odata/gi`).
 *
 * WHY THIS EXISTS. The GI endpoint speaks OData **v4** (its errors are verbatim
 * Microsoft.OData.Core wording), while the contract-based REST API speaks **v3**.
 * Until 0.46.0 both tools carried byte-identical v3 filter guidance, so every
 * partial-match GI query was instructed to use a function that does not exist
 * there. Production logs for July 2026 (242 tool errors) showed:
 *
 *   44  unknown function with name '?'          <- substringof on a v4 endpoint
 *   43  Could not find a property named '?'     <- GI property names are captions
 *   10  binary operator with incompatible types
 *    2  Unrecognized '?' literal                <- datetimeoffset'...' is v3
 *
 * i.e. ~41% of current errors were dialect/naming mistakes that the response
 * could have corrected instead of merely reporting.
 *
 * VERIFIED LIVE against a 25R2 GI endpoint (2026-07-31):
 *   substringof('BAD', Description)        -> "unknown function 'substringof'"
 *   contains(Description,'BAD')            -> works
 *   startswith(Description,'AR')           -> works (same in both dialects)
 *   tolower(...)                           -> works  (500s on contract REST)
 *   CreatedOn gt datetimeoffset'2024-01-01'-> "Unrecognized 'Edm.String' literal"
 *   CreatedOn gt 2024-01-01T00:00:00Z      -> works
 *
 * Import-free leaf so `node --test` can load it under strip-only mode.
 */

export type ODataV4ErrorKind =
  | { kind: "unknown_function"; name: string }
  | { kind: "unknown_property"; property: string; type?: string }
  | { kind: "unrecognized_literal"; literal?: string }
  | { kind: "type_mismatch" };

/**
 * v3 → v4 substitutions for functions the model is likely to reach for because
 * the contract-REST guidance (correctly) tells it to use them there.
 */
const V4_SUBSTITUTES: Record<string, string> = {
  substringof: "contains(Field,'needle') — note the reversed argument order: field first in v4, needle first in v3",
  indexof: "indexof(Field,'needle') is valid v4; check the argument order",
};

/** Functions confirmed working on the v4 GI endpoint. */
export const V4_SUPPORTED_FUNCTIONS = [
  "contains(Field,'needle')",
  "startswith(Field,'prefix')",
  "endswith(Field,'suffix')",
  "tolower(Field)",
  "toupper(Field)",
  "length(Field)",
];

/**
 * Property identifiers referenced by a `$filter` that appear in `names`,
 * in filter order, deduped. Single-quoted string literals are removed first
 * (OData doubles a quote to escape it) so a literal like `'Amount due'` cannot
 * false-positive on a column named `Amount`. Matching is exact and
 * case-sensitive — a wrong-case reference is rejected by the endpoint as
 * unknown_property before it could ever hit the calculated-column failure.
 *
 * Used to pre-flight run_inquiry filters against the registry's
 * expression-flagged columns: a `$filter` referencing a calculated GI column
 * makes Acumatica return HTTP 200 with an EMPTY BODY (no error, no rows), so
 * the only good handling is to refuse before calling Acumatica at all.
 */
export function filterReferencedColumns(
  filterExpression: string,
  names: readonly string[]
): string[] {
  if (!filterExpression || !names.length) return [];
  const candidates = new Set(names);
  const withoutLiterals = filterExpression.replace(/'(?:[^']|'')*'/g, " ");
  const found: string[] = [];
  for (const m of withoutLiterals.matchAll(/[A-Za-z_][A-Za-z0-9_]*/g)) {
    if (candidates.has(m[0]) && !found.includes(m[0])) found.push(m[0]);
  }
  return found;
}

/**
 * Refusal envelope for a filter that references calculated (expression)
 * columns. Same shape family as buildODataV4Correction, but this one is a
 * PRE-FLIGHT refusal — Acumatica was never contacted, because its response to
 * such a filter is an empty-body 200 that cannot be distinguished from an
 * outage after the fact.
 */
export function buildCalculatedColumnRefusal(context: {
  inquiryName: string;
  filterExpression: string;
  calculatedColumns: string[];
  filterableFields?: string[];
}): Record<string, unknown> {
  const stored = context.filterableFields ?? [];
  return {
    error: "invalid_filter",
    inquiryName: context.inquiryName,
    filterExpression: context.filterExpression,
    problem:
      `The filter references ${context.calculatedColumns.length === 1 ? "a calculated column" : "calculated columns"} ` +
      `(${context.calculatedColumns.map((c) => `'${c}'`).join(", ")}). ` +
      `These are computed by an expression in the inquiry design, not stored fields, and Acumatica cannot ` +
      `filter on them — it fails with an empty response instead of an error, which is why the query was refused up front.`,
    calculatedColumns: context.calculatedColumns,
    ...(stored.length ? { filterableFields: stored } : {}),
    actionRequired:
      `Rewrite filterExpression using only stored columns` +
      (stored.length ? ` (see filterableFields)` : "") +
      ` — typically keys, dates, statuses, and codes — and apply any condition on the calculated ` +
      `column${context.calculatedColumns.length === 1 ? "" : "s"} to the returned rows yourself. ` +
      `Do not report to the user that no records matched — the query was never executed.`,
  };
}

/**
 * Classify a v4 parser error. Returns null when the message is not one of the
 * recognized shapes, so the caller falls through to the original error.
 */
export function classifyODataV4Error(message: string): ODataV4ErrorKind | null {
  const fn = message.match(/unknown function with name '([^']+)'/i);
  if (fn) return { kind: "unknown_function", name: fn[1] };

  const prop = message.match(/Could not find a property named '([^']+)' on type '([^']*)'/i);
  if (prop) return { kind: "unknown_property", property: prop[1], type: prop[2] || undefined };

  const lit = message.match(/Unrecognized '[^']*' literal '([^']*)'/i);
  if (lit) return { kind: "unrecognized_literal", literal: lit[1] };

  if (/binary operator with incompatible types/i.test(message)) return { kind: "type_mismatch" };

  return null;
}

/**
 * Build a corrective response for a classified GI filter error.
 *
 * `availableFields` is the GI's real property list when known — for the
 * unknown-property case this is the whole point: the names are already resolved
 * from `$metadata` by the GI registry, so the response can hand the model the
 * correct spelling instead of leaving it to guess again.
 */
export function buildODataV4Correction(
  err: ODataV4ErrorKind,
  originalMessage: string,
  context: { inquiryName: string; filterExpression?: string; availableFields?: string[] }
): Record<string, unknown> {
  const base = {
    error: "invalid_filter",
    inquiryName: context.inquiryName,
    filterExpression: context.filterExpression,
    acumaticaMessage: originalMessage,
    dialect:
      "Generic Inquiries are queried over OData v4. This is a DIFFERENT dialect from " +
      "acumatica_list_entities, which uses the contract-based REST API (OData v3). Do not carry " +
      "filter syntax between the two tools.",
  };

  switch (err.kind) {
    case "unknown_function": {
      const swap = V4_SUBSTITUTES[err.name.toLowerCase()];
      return {
        ...base,
        problem: `'${err.name}' is not a function on this OData v4 endpoint.`,
        ...(swap ? { useInstead: swap } : {}),
        supportedFunctions: V4_SUPPORTED_FUNCTIONS,
        actionRequired:
          `Rewrite filterExpression using a supported v4 function and retry once. ` +
          (swap ? `Replace '${err.name}' with ${swap}. ` : "") +
          `Do not report to the user that no records matched — the query was never executed.`,
      };
    }
    case "unknown_property": {
      const known = context.availableFields ?? [];
      return {
        ...base,
        problem:
          `'${err.property}' is not a property of this inquiry` +
          (err.type ? ` (type '${err.type}')` : "") +
          `. Generic Inquiry property names are the inquiry's RESULT-COLUMN CAPTIONS, which often ` +
          `differ from the underlying entity's field names.`,
        ...(known.length ? { availableFields: known } : {}),
        actionRequired: known.length
          ? `Pick the intended column from availableFields, rewrite filterExpression with that exact name (case-sensitive), and retry once. Do not report to the user that no records matched — the query was never executed.`
          : `Call acumatica_describe_inquiry for '${context.inquiryName}' to get the exact property names, then retry once. Do not report to the user that no records matched — the query was never executed.`,
      };
    }
    case "unrecognized_literal":
      return {
        ...base,
        problem:
          `The literal ${err.literal ? `'${err.literal}' ` : ""}is not valid on this OData v4 endpoint. ` +
          `Most often this is a v3-style date: 'datetimeoffset'2024-01-01'' is v3 syntax and is rejected here.`,
        useInstead:
          "A bare ISO-8601 instant, e.g. CreatedOn gt 2024-01-01T00:00:00Z (no datetimeoffset prefix, no quotes).",
        actionRequired:
          "Rewrite the literal and retry once. Do not report to the user that no records matched — the query was never executed.",
      };
    case "type_mismatch":
      return {
        ...base,
        problem:
          "The filter compares two incompatible types — e.g. quoting a number ('100' instead of 100), " +
          "comparing a date column to a plain string, or comparing a numeric column to quoted text.",
        actionRequired:
          `Check the column's type with acumatica_describe_inquiry for '${context.inquiryName}', fix the ` +
          `literal (numbers unquoted, strings single-quoted, dates as bare ISO-8601), and retry once. ` +
          `Do not report to the user that no records matched — the query was never executed.`,
      };
  }
}
