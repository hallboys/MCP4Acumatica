// Copyright 2026 Hall Boys, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Parameterized Generic Inquiries over OData.
 *
 * WHY THIS EXISTS. A GI with parameters, queried through its plain entity set,
 * runs with no parameter values and returns plausible but unfiltered rows with
 * no error. Acumatica documents a function form that takes the values:
 *
 *   /api/odata/gi/{FunctionImport}(P1=@p1,P2=@p2)?@p1='x'&@p2=2026-10-01
 *
 * `$metadata` declares a `<FunctionImport Name="X_WithParameters" Function=
 * "GenericInquiry.{GI name}">` pointing at a `<Function Name="{GI name}">` that
 * lists each `<Parameter Name Type [Nullable="false"]>`.
 *
 * VERIFIED LIVE (2026 R2, 2026-11-03):
 *   - Nullable="false" ⇔ "Is Required" on the GI's Parameters tab (SM208000).
 *   - Required parameter omitted → HTTP 404. Optional omitted → GI default value.
 *   - A MISSPELLED parameter name is silently ignored → unfiltered rows. Names
 *     must therefore be validated here, before Acumatica is called.
 *   - $filter/$select/$top/$count all work on the function URL.
 *   - Edm.DateTimeOffset values cannot go in the URL path (ASP.NET rejects the
 *     ':'); parameter aliases in the query string work. Every value is passed
 *     as an alias for that reason — one code path, no path-character surprises.
 *
 * Import-free leaf so `node --test` can load it under strip-only mode.
 */

/** One parameter of a parameterized GI. */
export interface GiParamMeta {
  /** `$metadata` parameter name — exactly what goes in the function URL. */
  name: string;
  /** Raw Edm type (e.g. "Edm.Date"); drives validation and literal formatting. */
  edmType: string;
  /** `Nullable="false"` in `$metadata` = "Is Required" on the GI. */
  required: boolean;
  /** Label from the GI's Parameters tab (MCPGIParams feed). */
  displayName?: string;
  /** Raw default value from the GI's Parameters tab (e.g. "@QuarterStart"). */
  defaultValue?: string;
}

/** A parameterized GI as declared in `$metadata`. */
export interface GiFunction {
  /** The GI name as `$metadata` spells it (XML entities decoded). */
  giName: string;
  /** e.g. "DBStorageDetails_WithParameters" — the URL path segment. */
  functionImport: string;
  params: GiParamMeta[];
  /**
   * A `_WithParameters` import whose `<Function>` could not be parsed. The GI
   * is known to take parameters but not which — it must be refused, never
   * treated as parameter-free.
   */
  unparsed?: boolean;
}

/** Raw MCPGIParams feed row (one per GIFilter row of an exposed GI). */
export interface FeedParamRow {
  /** Owning GI name. */
  Name?: string;
  /** GIFilter.Name — matched to the `$metadata` parameter name. */
  ParamName?: string;
  DisplayName?: string;
  IsRequired?: boolean | number | string;
  DefaultValue?: string;
  IsActive?: boolean | number | string;
}

/** Same normalization the GI registry uses: alphanumerics only, lower-cased. */
export function normalizeGiKey(s: string): string {
  return s.replace(/[^A-Za-z0-9]/g, "").toLowerCase();
}

function decodeXml(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

function attr(tag: string, name: string): string | undefined {
  const m = tag.match(new RegExp(`\\s${name}="([^"]*)"`));
  return m ? decodeXml(m[1]) : undefined;
}

/**
 * Parse every parameterized GI out of a GI `$metadata` document, keyed by the
 * exact (decoded) GI name. Pure. A `_WithParameters` import whose `<Function>`
 * can't be matched is still recorded, flagged `unparsed`, so the GI is refused
 * rather than silently treated as parameter-free.
 */
export function parseEdmxFunctions(xml: string): Map<string, GiFunction> {
  const out = new Map<string, GiFunction>();
  if (!xml) return out;

  const paramsByFunction = new Map<string, GiParamMeta[]>();
  for (const m of xml.matchAll(/<Function\b([^>]*)>([\s\S]*?)<\/Function>/g)) {
    const fnName = attr(m[1], "Name");
    if (!fnName) continue;
    const params: GiParamMeta[] = [];
    for (const p of m[2].matchAll(/<Parameter\b[^>]*>/g)) {
      const name = attr(p[0], "Name");
      const edmType = attr(p[0], "Type");
      if (!name || !edmType) continue;
      params.push({ name, edmType, required: attr(p[0], "Nullable") === "false" });
    }
    paramsByFunction.set(fnName, params);
  }

  for (const m of xml.matchAll(/<FunctionImport\b[^>]*>/g)) {
    const importName = attr(m[0], "Name");
    if (!importName || !importName.endsWith("_WithParameters")) continue;
    const fnRef = attr(m[0], "Function");
    const giName = fnRef
      ? fnRef.startsWith("GenericInquiry.") ? fnRef.slice("GenericInquiry.".length) : fnRef
      : importName.slice(0, -"_WithParameters".length);
    const params = paramsByFunction.get(giName);
    out.set(giName, params
      ? { giName, functionImport: importName, params }
      : { giName, functionImport: importName, params: [], unparsed: true });
  }
  return out;
}

/**
 * Find a GI's function: exact name first, then a normalized match only when
 * it is unique (the service document's entity-set names drop characters such
 * as "/" that the GI name keeps). Two candidates → "ambiguous".
 */
export function findGiFunction(
  fns: Map<string, GiFunction>,
  inquiryName: string
): GiFunction | "ambiguous" | undefined {
  const name = inquiryName.trim();
  const exact = fns.get(name);
  if (exact) return exact;
  const key = normalizeGiKey(name);
  if (!key) return undefined;
  const hits = [...fns.values()].filter((f) => normalizeGiKey(f.giName) === key);
  if (hits.length > 1) return "ambiguous";
  return hits[0];
}

function truthy(v: unknown): boolean {
  return v === true || v === 1 || v === "1" || (typeof v === "string" && v.toLowerCase() === "true");
}

/**
 * Attach the feed's labels and defaults to `$metadata` parameters, matched by
 * normalized name. `$metadata` stays authoritative for name, type and
 * required-ness; inactive feed rows are used only when no active row matches.
 */
export function enrichParams(params: GiParamMeta[], feedRows: FeedParamRow[]): GiParamMeta[] {
  return params.map((p) => {
    const key = normalizeGiKey(p.name);
    const matches = feedRows.filter((r) => r.ParamName && normalizeGiKey(r.ParamName) === key);
    // An inactive GIFilter row's label/default is not what the GI uses — show none.
    const row = matches.find((r) => r.IsActive === undefined || truthy(r.IsActive));
    if (!row) return { ...p };
    const out: GiParamMeta = { ...p };
    const label = row.DisplayName?.trim();
    if (label) out.displayName = label;
    const def = row.DefaultValue?.trim();
    if (def) out.defaultValue = def;
    return out;
  });
}

/**
 * Overlay labels/defaults from a cached registry copy onto live `$metadata`
 * parameters. Live metadata wins on everything it declares.
 */
export function overlayParams(live: GiParamMeta[], cached?: GiParamMeta[]): GiParamMeta[] {
  if (!cached?.length) return live;
  const byKey = new Map(cached.map((c) => [normalizeGiKey(c.name), c]));
  return live.map((p) => {
    const c = byKey.get(normalizeGiKey(p.name));
    return {
      ...p,
      ...(c?.displayName ? { displayName: c.displayName } : {}),
      ...(c?.defaultValue ? { defaultValue: c.defaultValue } : {}),
    };
  });
}

/** Human-readable type + format hint, for describe/list and refusal messages. */
export function paramTypeHint(edmType: string): string {
  switch (edmType) {
    case "Edm.Date":
      return "date (YYYY-MM-DD)";
    case "Edm.DateTimeOffset":
      return "date (YYYY-MM-DD) or date-time with offset (e.g. 2026-10-01T00:00:00Z)";
    case "Edm.Boolean":
      return "boolean (true/false)";
    case "Edm.Byte":
    case "Edm.SByte":
    case "Edm.Int16":
    case "Edm.Int32":
    case "Edm.Int64":
      return "integer";
    case "Edm.Decimal":
    case "Edm.Double":
    case "Edm.Single":
      return "number";
    case "Edm.String":
      return "string";
    default:
      return edmType;
  }
}

/** Model-facing description of one parameter. */
export function describeParam(p: GiParamMeta): Record<string, unknown> {
  return {
    name: p.name,
    type: paramTypeHint(p.edmType),
    required: p.required,
    ...(p.displayName ? { displayName: p.displayName } : {}),
    ...(p.defaultValue ? { defaultValue: p.defaultValue } : {}),
  };
}

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const DATETIME_RE = /^(\d{4})-(\d{2})-(\d{2})T([01]\d|2[0-3]):[0-5]\d(:[0-5]\d(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/;
const INT_RE = /^-?\d+$/;
const DEC_RE = /^-?\d+(\.\d+)?$/;

/** Shape alone accepts 2026-13-45; check the calendar too. */
function realDate(y: string, m: string, d: string): boolean {
  const dt = new Date(Date.UTC(+y, +m - 1, +d));
  return dt.getUTCFullYear() === +y && dt.getUTCMonth() === +m - 1 && dt.getUTCDate() === +d;
}

/**
 * Numbers are passed through as the caller wrote them, never via Number():
 * that would round Int64/decimal values past 2^53, accept "0x1F", and write
 * large values with an exponent OData does not accept.
 */
function numericText(value: string | number | boolean): string | null {
  if (typeof value === "boolean") return null;
  const s = String(value).trim();
  return /e/i.test(s) ? null : s;
}

/**
 * Format one value as an OData v4 literal for `edmType`, or explain why it
 * doesn't fit. Strings are single-quoted with `'` doubled.
 */
export function formatODataLiteral(
  edmType: string,
  value: string | number | boolean
): { ok: true; literal: string } | { ok: false; reason: string } {
  switch (edmType) {
    case "Edm.String":
      return { ok: true, literal: `'${String(value).replace(/'/g, "''")}'` };
    case "Edm.Date": {
      const s = String(value).trim();
      const m = s.match(DATE_RE);
      return m && realDate(m[1], m[2], m[3])
        ? { ok: true, literal: s }
        : { ok: false, reason: `expected a date as YYYY-MM-DD, got '${s}'` };
    }
    case "Edm.DateTimeOffset": {
      // A plain date is passed through as-is: 2025 R2 declares GI date
      // parameters as Edm.DateTimeOffset (2026 R2 as Edm.Date) and accepts
      // YYYY-MM-DD for them (verified 2026-11-03). Forcing a full date-time
      // would make the model pick a time zone, which can shift a range edge.
      const s = String(value).trim();
      const m = s.match(DATETIME_RE) ?? s.match(DATE_RE);
      return m && realDate(m[1], m[2], m[3])
        ? { ok: true, literal: s }
        : { ok: false, reason: `expected a date (YYYY-MM-DD) or an ISO-8601 date-time with offset (e.g. 2026-10-01T00:00:00Z), got '${s}'` };
    }
    case "Edm.Boolean": {
      const s = String(value).trim().toLowerCase();
      return s === "true" || s === "false"
        ? { ok: true, literal: s }
        : { ok: false, reason: `expected true or false, got '${value}'` };
    }
    case "Edm.Byte":
    case "Edm.SByte":
    case "Edm.Int16":
    case "Edm.Int32":
    case "Edm.Int64": {
      const s = numericText(value);
      return s !== null && INT_RE.test(s)
        ? { ok: true, literal: s }
        : { ok: false, reason: `expected a whole number written in digits, got '${value}'` };
    }
    case "Edm.Decimal":
    case "Edm.Double":
    case "Edm.Single": {
      const s = numericText(value);
      return s !== null && DEC_RE.test(s)
        ? { ok: true, literal: s }
        : { ok: false, reason: `expected a number written in digits (e.g. 1250.50), got '${value}'` };
    }
    default:
      return { ok: false, reason: `parameter type ${edmType} is not supported by this server` };
  }
}

export type ParamValidation =
  | {
      ok: true;
      /** Function path segment, e.g. "X_WithParameters(Warehouse=@p1)". */
      path: string;
      /** Alias query parameters, e.g. { "@p1": "'WHOLESALE'" }. */
      aliases: Record<string, string>;
      /** Canonical name → value as supplied. */
      applied: Record<string, string | number | boolean>;
      /** Optional parameters left out — they take the GI's default value. */
      defaulted: GiParamMeta[];
    }
  | { ok: false; error: Record<string, unknown> };

/**
 * Validate the model's `parameters` argument (a JSON object as a string)
 * against a parameterized GI and build the aliased function path. Pure.
 *
 * Refuses — before Acumatica is contacted — when the argument is absent (so the
 * model must have seen the parameters), malformed, names an unknown parameter
 * (Acumatica would silently ignore it), omits or blanks a required one, or
 * carries a value that does not fit the parameter's type.
 */
export function validateGiParameters(
  inquiryName: string,
  fn: GiFunction,
  raw: string | undefined
): ParamValidation {
  const parameters = fn.params.map(describeParam);
  const refuse = (error: string, extra: Record<string, unknown> = {}): ParamValidation => ({
    ok: false,
    error: {
      error,
      inquiryName,
      ...extra,
      parameters,
      actionRequired:
        "The query was NOT executed. Pass `parameters` as a JSON object keyed by the parameter names listed here " +
        '(e.g. {"Name":"value"}). Required parameters must have a value; optional ones may be left out, in which case ' +
        "the inquiry uses its own default value — tell the user which defaults applied. Ask the user for any value you do not know; do not guess.",
    },
  });

  if (raw === undefined || raw.trim() === "") {
    return refuse("parameters_required", {
      problem:
        `Generic Inquiry '${inquiryName}' takes parameters, and no \`parameters\` argument was given. ` +
        `Pass {} to run it with every optional parameter at its default` +
        (fn.params.some((p) => p.required) ? ", after supplying the required ones." : "."),
    });
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return refuse("invalid_parameters", { problem: "`parameters` is not valid JSON." });
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return refuse("invalid_parameters", { problem: "`parameters` must be a JSON object." });
  }

  const byExact = new Map(fn.params.map((p) => [p.name, p]));
  const byLower = new Map(fn.params.map((p) => [p.name.toLowerCase(), p]));
  const supplied = new Map<string, { param: GiParamMeta; value: string | number | boolean }>();
  const seen = new Set<string>();

  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    const param = byExact.get(key) ?? byLower.get(key.toLowerCase());
    if (!param) {
      return refuse("unknown_parameter", {
        problem:
          `'${key}' is not a parameter of '${inquiryName}'. Acumatica silently ignores unknown parameter names ` +
          `and returns unfiltered rows, so this server refuses them.`,
      });
    }
    if (seen.has(param.name)) {
      return refuse("invalid_parameters", { problem: `Parameter '${param.name}' is given more than once.` });
    }
    seen.add(param.name);
    if (value === null) continue; // explicit null = leave it out
    if (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") {
      return refuse("invalid_parameters", {
        problem: `Parameter '${param.name}' must be a single string, number or boolean value.`,
      });
    }
    // A blank string is treated as "not supplied": passed through it would be
    // the literal '' — which Acumatica accepts and which matches no rows.
    if (typeof value === "string" && value.trim() === "") continue;
    supplied.set(param.name, { param, value });
  }

  const missing = fn.params.filter((p) => p.required && !supplied.has(p.name));
  if (missing.length) {
    return refuse("missing_required_parameters", {
      problem: `Required parameter(s) without a value: ${missing.map((p) => p.displayName ? `${p.name} (${p.displayName})` : p.name).join(", ")}.`,
      missing: missing.map((p) => p.name),
    });
  }

  const aliases: Record<string, string> = {};
  const assignments: string[] = [];
  const applied: Record<string, string | number | boolean> = {};
  let n = 0;
  for (const p of fn.params) {
    const s = supplied.get(p.name);
    if (!s) continue;
    const lit = formatODataLiteral(p.edmType, s.value);
    if (!lit.ok) {
      return refuse("invalid_parameter_value", { problem: `Parameter '${p.name}': ${lit.reason}.` });
    }
    n++;
    aliases[`@p${n}`] = lit.literal;
    assignments.push(`${p.name}=@p${n}`);
    applied[p.name] = s.value;
  }

  return {
    ok: true,
    path: `${fn.functionImport}(${assignments.join(",")})`,
    aliases,
    applied,
    defaulted: fn.params.filter((p) => !supplied.has(p.name)),
  };
}

/** Characters that cannot be addressed in an OData GI path segment. */
const UNADDRESSABLE = /[/\\()?#@%]|\.\.|_WithParameters/;

export type GiRouting =
  | { kind: "refuse"; error: Record<string, unknown> }
  | { kind: "plain" }
  | { kind: "function"; fn: GiFunction };

/**
 * Decide how a GI may be queried — before any request. Pure.
 *
 * Fails CLOSED: a parameterized GI sent to its plain entity set runs with no
 * parameter values and returns unfiltered rows with no error, so every case
 * where the server cannot be sure a GI is parameter-free is refused:
 *  - `$metadata` unavailable (`fns` null);
 *  - a name that normalizes to more than one GI;
 *  - a `_WithParameters` import whose definition did not parse;
 *  - the registry says the GI has parameters but `$metadata` shows none
 *    (stale cache, or `$metadata` that differs between users).
 * A plain-path name must also be addressable: a name carrying path or query
 * syntax would otherwise be sent verbatim (and could smuggle in a hand-built
 * `_WithParameters(...)` call that skips the parameter checks).
 *
 * With `parametersEnabled` false (ACUMATICA_GI_PARAMETERS off — the default
 * until a release is verified), every parameterized GI is refused, as before
 * 0.56.0; detection still uses the same fail-closed rules.
 */
export function resolveGiRouting(
  fns: Map<string, GiFunction> | null,
  inquiryName: string,
  registryParams?: GiParamMeta[],
  parametersEnabled = true
): GiRouting {
  const refuse = (error: string, problem: string): GiRouting => ({
    kind: "refuse",
    error: {
      error,
      inquiryName,
      problem,
      actionRequired: "The query was NOT executed — do not report 'no records'.",
    },
  });

  if (!fns) {
    return refuse(
      "metadata_unavailable",
      "The inquiry definitions (OData $metadata) could not be read, so the server cannot tell whether this inquiry " +
        "takes parameters — and a parameterized inquiry run without them returns unfiltered rows with no error. " +
        "Retry the same request in a few seconds; if it keeps failing, tell the user Acumatica's OData metadata is unavailable."
    );
  }
  const fn = findGiFunction(fns, inquiryName);
  if (fn === "ambiguous") {
    return refuse(
      "ambiguous_inquiry_name",
      `'${inquiryName}' matches more than one inquiry once punctuation and case are ignored. Use the exact name from acumatica_list_generic_inquiries.`
    );
  }
  if ((fn || registryParams?.length) && !parametersEnabled) {
    return refuse(
      "parameterized_not_supported",
      `Generic Inquiry '${inquiryName}' takes parameters, and this server is configured not to run parameterized ` +
        "inquiries (ACUMATICA_GI_PARAMETERS is off). Run without its parameters it would return unfiltered rows with " +
        "no error, so it was refused. Use a parameter-free inquiry, or run this one in the Acumatica UI."
    );
  }
  if (fn?.unparsed) {
    return refuse(
      "parameters_unreadable",
      `'${inquiryName}' takes parameters, but their definitions could not be read from OData $metadata, so it cannot be run safely.`
    );
  }
  if (fn) return { kind: "function", fn };
  if (registryParams?.length) {
    return refuse(
      "metadata_mismatch",
      `'${inquiryName}' is recorded as taking parameters, but the current OData $metadata does not list them. ` +
        "Run acumatica_clear_cache with target=gi, then retry once."
    );
  }
  if (UNADDRESSABLE.test(inquiryName)) {
    return refuse(
      "unaddressable_inquiry_name",
      `'${inquiryName}' contains characters that cannot be used in an OData inquiry address. Use the exact name from acumatica_list_generic_inquiries.`
    );
  }
  return { kind: "plain" };
}

/** Whether a `parameters` argument carries any value at all ({} and blank do not). */
export function hasParameterValues(raw: string | undefined): boolean {
  if (!raw?.trim()) return false;
  try {
    const v = JSON.parse(raw);
    return !(v && typeof v === "object" && !Array.isArray(v) && Object.keys(v).length === 0);
  } catch {
    return true;
  }
}

export type GiRequestPlan =
  | { kind: "refuse"; error: Record<string, unknown> }
  | { kind: "plain"; path: string }
  | ({ kind: "function"; fn: GiFunction } & Extract<ParamValidation, { ok: true }>);

/**
 * Full request plan for acumatica_run_inquiry: routing, then parameter
 * validation for a parameterized GI, or a refusal of `parameters` given to a
 * GI that has none (they would be dropped). Pure.
 */
export function planGiRequest(
  fns: Map<string, GiFunction> | null,
  inquiryName: string,
  parametersArg: string | undefined,
  registryParams?: GiParamMeta[],
  parametersEnabled = true
): GiRequestPlan {
  const routing = resolveGiRouting(fns, inquiryName, registryParams, parametersEnabled);
  if (routing.kind === "refuse") return routing;
  if (routing.kind === "plain") {
    if (hasParameterValues(parametersArg)) {
      return {
        kind: "refuse",
        error: {
          error: "not_parameterized",
          inquiryName,
          problem: `Generic Inquiry '${inquiryName}' takes no parameters, so the values given would be ignored.`,
          actionRequired: "The query was NOT executed. Remove `parameters` and narrow the results with filterExpression instead.",
        },
      };
    }
    return { kind: "plain", path: inquiryName };
  }
  const fn = { ...routing.fn, params: overlayParams(routing.fn.params, registryParams) };
  const v = validateGiParameters(inquiryName, fn, parametersArg);
  if (!v.ok) return { kind: "refuse", error: v.error };
  return { kind: "function", fn, ...v };
}
