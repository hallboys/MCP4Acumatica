// Copyright 2026 Hall Boys, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * GI tool registry — the opt-in gate + curated enrichment for Generic-Inquiry
 * tools.
 *
 * The registry is built lazily with the *requesting user's* token (see
 * gi-registry-build.ts) — there is no background service identity. The gate
 * list and field schemas are global data (identical for every user), so it is
 * safe to build them from whoever's token is in hand and cache the result for
 * everyone; execution still uses each user's own token with their row-level
 * access, and the registry holds only GI/field metadata, never business rows.
 *
 * GATE SEMANTICS (this is NOT fail-open):
 *  - No registry yet (never built — feed GIs not exposed, or cold bootstrap)
 *    → gate INACTIVE. GI tools behave as before this feature (any OData-exposed
 *    GI allowed). This is the rollout state; no dead period before first build.
 *  - Registry present → gate ACTIVE, fail-closed. Only listed GIs allowed; an
 *    empty list denies every GI. A failed rebuild keeps serving the last-good
 *    registry rather than flapping the gate.
 *
 * This module is a runtime-leaf (type-only imports) so its pure gate + parsing
 * logic stays unit-testable under `node --test`. The impure lazy-build /
 * KV-cache orchestration lives in gi-registry-build.ts.
 */

/** Per-column curated/resolved metadata for an exposed GI. */
export interface GiFieldMeta {
  /** Authoritative OData $metadata property name (carries any `_N` collision suffix). */
  name: string;
  /** Simplified declared type from $metadata (Path A): "decimal"|"integer"|"string"|"datetime"|"boolean". Omitted → runtime inference. */
  type?: string;
  /** GI result-grid caption, when present. */
  caption?: string;
  /** Curated per-column description (UsrResAIDescription on GIResult). Optional. */
  description?: string;
  /**
   * The column is a calculated expression (`=…` design field), not a stored
   * field. A `$filter` referencing one makes Acumatica return HTTP 200 with an
   * EMPTY BODY — not an error, not an empty list — so run_inquiry refuses such
   * filters before calling Acumatica. Only set where a design row was aligned
   * to this property; a GI whose alignment was rejected carries no flags.
   */
  expression?: boolean;
}

/** One exposed GI in the registry. */
export interface GiRegistryEntry {
  /** GI name (MCPGIs "Name" column) = OData entity name = the path segment used by run_inquiry. */
  giName: string;
  /** GIDesign designID, for traceability. */
  designID?: string;
  /** Entry screen id (MCPGIs "ScreenID"), informational. */
  entryScreen?: string;
  /** Curated GI-level description (UsrAIDescription on GIDesign). Optional — exposure is never gated on it. */
  description?: string;
  /** Resolved field metadata. Empty/absent → pure runtime inference. */
  fields?: GiFieldMeta[];
}

/** The cached registry artifact. */
export interface GiRegistry {
  /** ISO timestamp the build stamped — drives the freshness/rebuild decision. */
  builtAt: string;
  /** Acumatica endpoint version built against (upgrade awareness). */
  endpointVersion?: string;
  /** Exposed GIs. Never includes feed GIs or the canary (see EXCLUDED_GI_NAMES). */
  gis: GiRegistryEntry[];
}

/**
 * GIs that must never be surfaced as agent-facing tools regardless of gate
 * state: the registry's own feed GIs and the role-gate canary. Shared source of
 * truth so discovery hides them even while the gate is inactive, and the build
 * skips them when emitting the registry.
 */
export const EXCLUDED_GI_NAMES: ReadonlySet<string> = new Set([
  "MCPGIs",
  "MCPGIFields",
  "MCPAccess",
]);

/**
 * Names of parameterized GIs found in an OData `$metadata` document. Acumatica
 * exposes a parameterized GI as a `{Name}_WithParameters` FunctionImport; the
 * base entity set, queried without those parameters (as the agent does), returns
 * default/unfiltered — i.e. *wrong* — rows with no error. Callers use this to
 * exclude such GIs from discovery and to refuse them in `run_inquiry`. Pure.
 */
export function parameterizedGiNames(metadataXml: string): ReadonlySet<string> {
  const names = new Set<string>();
  if (!metadataXml) return names;
  for (const m of metadataXml.matchAll(/FunctionImport\s+Name="([^"]+)_WithParameters"/g)) {
    names.add(m[1]);
  }
  return names;
}

/** Result of a gate check, so callers can give the model a precise reason. */
export type GateDecision =
  | { allowed: true; inactive: boolean; entry?: GiRegistryEntry }
  | { allowed: false; reason: string };

/**
 * Decide whether `giName` may be queried.
 *  - Gate inactive (no registry) → allowed, `inactive: true`.
 *  - Feed/canary GI → always denied, even while inactive.
 *  - Gate active → allowed iff present in the registry; otherwise denied.
 */
export function checkGiGate(registry: GiRegistry | null, giName: string): GateDecision {
  const name = giName.trim();

  if (EXCLUDED_GI_NAMES.has(name)) {
    return {
      allowed: false,
      reason: `'${name}' is an internal MCP infrastructure inquiry and is not available as a tool.`,
    };
  }

  if (!registry) {
    return { allowed: true, inactive: true };
  }

  const entry = registry.gis.find((g) => g.giName === name);
  if (!entry) {
    return {
      allowed: false,
      reason:
        `Generic Inquiry '${name}' is not exposed to the AI assistant. ` +
        `Only inquiries explicitly opted in (ExposedtoMCP) in Acumatica are available. ` +
        `Ask an Acumatica administrator to expose this GI if it should be usable here.`,
    };
  }

  return { allowed: true, inactive: false, entry };
}

// ── Pure build/parse helpers (used by gi-registry-build.ts; unit-tested) ──────

/**
 * Raw MCPGIs feed row (registry: one row per exposed GI). Property names are the
 * MCPGIs result-column captions (Acumatica derives the OData property from the
 * caption). See acumatica/MCPGIs.xml.
 */
export interface FeedGiRow {
  /** GI name = OData entity name (MCPGIs "Name" column). */
  Name?: string;
  /** Curated GI-level description (MCPGIs "AIDescription"). */
  AIDescription?: string;
  /** Entry screen id (MCPGIs "ScreenID"), informational. */
  ScreenID?: string;
  /** GIDesign designID (MCPGIs "DesignID"), for traceability. */
  DesignID?: string;
}

/**
 * Raw MCPGIFields feed row (one row per (exposed GI, output column)). Property
 * names are the MCPGIFields result-column captions. See acumatica/MCPGIFields.xml.
 */
export interface FeedFieldRow {
  /** Owning GI name (MCPGIFields "Name") — groups columns by GI. */
  Name?: string;
  /** Target column's DAC field name (MCPGIFields "SchemaField"). NULL for most
   *  rows, and DAC-qualified ("INTran.RefNbr") where present, so it cannot be
   *  used to predict a property name — kept for the no-$metadata fallback only. */
  SchemaField?: string;
  /** Target column's caption (MCPGIFields "Caption"). An *override*, usually
   *  NULL — see the alignment note on resolveFields. */
  Caption?: string;
  /** Curated per-column description (MCPGIFields "AIDescription"). */
  AIDescription?: string;
  /** Target column's design line number (MCPGIFields "LineNbr"). NOT the grid
   *  position — see SortOrder. */
  LineNbr?: number | string;
  /** Grid position (GIResult.SortOrder). This, not LineNbr, is the order the
   *  columns appear in — and therefore the order OData declares them in. */
  SortOrder?: number | string;
  /** Whether the column is active (GIResult.IsActive). Inactive columns never
   *  reach OData at all, so they must not consume a property slot. */
  IsActive?: boolean | number | string;
  /** Alias for IsActive, as captioned by the MCPGIColumnsAll feed. */
  ColumnIsActive?: boolean | number | string;
  /** Target column's GIResult field name (MCPGIFields "Field"), e.g.
   *  "primaryScreenID_description". Only a weak tiebreak during alignment. */
  Field?: string;
}

/** Parsed EDMX EntityType: ordered property names + declared types + key props. */
export interface EdmxEntity {
  /** Property names in declaration order (carry `_N` collision suffixes). */
  order: string[];
  /** propertyName → raw Edm type (e.g. "Edm.Decimal"). */
  types: Map<string, string>;
  /** `<Key><PropertyRef>` property names. Acumatica hoists result columns that
   *  are also keys to the front of the property list — see resolveFields. */
  keys: string[];
}

/** Normalize a GI or field name for matching: alphanumerics only, lower-cased. */
export function normalizeName(s: string): string {
  return s.replace(/[^A-Za-z0-9]/g, "").toLowerCase();
}

/** Strip a trailing `_N` collision suffix from a property name. */
export function stripCollisionSuffix(prop: string): string {
  return prop.replace(/_\d+$/, "");
}

/** Map an Edm.* type to the simplified vocabulary used by describe_inquiry. */
export function edmTypeToSimple(edmType: string): string {
  switch (edmType) {
    case "Edm.Decimal":
    case "Edm.Double":
    case "Edm.Single":
      return "decimal";
    case "Edm.Byte":
    case "Edm.SByte":
    case "Edm.Int16":
    case "Edm.Int32":
    case "Edm.Int64":
      return "integer";
    case "Edm.Boolean":
      return "boolean";
    case "Edm.DateTime":
    case "Edm.DateTimeOffset":
    case "Edm.Date":
    case "Edm.Time":
      return "datetime";
    default:
      // Edm.String, Edm.Guid, Edm.Binary, anything else → string-ish.
      return edmType.startsWith("Edm.") ? edmType.slice(4).toLowerCase() : edmType;
  }
}

/**
 * Parse an OData EDMX `$metadata` document into per-EntityType property maps,
 * keyed by normalized EntityType name. Tolerant by design: any GI whose
 * EntityType isn't found simply yields no declared types and falls back to
 * runtime inference downstream.
 */
export function parseEdmxTypes(xml: string): Map<string, EdmxEntity> {
  const out = new Map<string, EdmxEntity>();
  if (!xml) return out;
  const entityRe = /<EntityType\s+Name="([^"]+)"[^>]*>([\s\S]*?)<\/EntityType>/g;
  for (const m of xml.matchAll(entityRe)) {
    const name = m[1];
    const body = m[2];
    const order: string[] = [];
    const types = new Map<string, string>();
    // `<Property Name= Type=>` only — `<PropertyRef Name=>` has no Type and the
    // `\s+` after `Property` keeps the two apart.
    const propRe = /<Property\s+Name="([^"]+)"\s+Type="([^"]+)"/g;
    for (const p of body.matchAll(propRe)) {
      order.push(p[1]);
      types.set(p[1], p[2]);
    }
    const keys: string[] = [];
    for (const k of body.matchAll(/<PropertyRef\s+Name="([^"]+)"/g)) keys.push(k[1]);
    out.set(normalizeName(name), { order, types, keys });
  }
  return out;
}

/**
 * Best-effort property name for a MCPGIFields row: caption (invalid characters
 * stripped) → `Usr`-stripped schema field → schema field.
 *
 * This is a *guess*, and only good enough for the degraded no-$metadata path.
 * It cannot be used to join design rows to real properties: a caption is only an
 * override and is NULL for most columns, and where SchemaField is populated it
 * is DAC-qualified ("INTran.RefNbr"), which never equals the bare property name.
 * The real join is positional — see resolveFields.
 */
export function predictPropertyName(row: FeedFieldRow): string {
  const caption = row.Caption?.trim();
  if (caption) return caption.replace(/[^A-Za-z0-9]/g, "");
  const field = (row.SchemaField ?? "").trim();
  if (field.startsWith("Usr")) return field.slice(3);
  return field;
}

/** Whether a design row's source field is a calculated expression (`=…`). */
function isExpressionRow(row: FeedFieldRow): boolean {
  return (row.Field ?? "").trim().startsWith("=");
}

function toNumber(v: number | string | undefined): number {
  const n = typeof v === "string" ? parseInt(v, 10) : v;
  return Number.isFinite(n as number) ? (n as number) : Number.MAX_SAFE_INTEGER;
}

function lineNbr(row: FeedFieldRow): number {
  return toNumber(row.LineNbr);
}

/** Grid position of a column. SortOrder is authoritative; LineNbr is the
 *  fallback for a feed that doesn't (yet) emit SortOrder. */
function sortOrder(row: FeedFieldRow): number {
  const n = toNumber(row.SortOrder);
  return n === Number.MAX_SAFE_INTEGER ? lineNbr(row) : n;
}

/**
 * Whether a design row is an active column. Inactive rows are excluded from the
 * OData projection entirely, so counting them would shift every later column.
 * A feed that doesn't emit the flag yields `true` (no worse than before it did).
 */
function isActiveRow(row: FeedFieldRow): boolean {
  const raw = row.IsActive ?? row.ColumnIsActive;
  if (raw === undefined || raw === null || raw === "") return true;
  if (typeof raw === "boolean") return raw;
  if (typeof raw === "number") return raw !== 0;
  const s = String(raw).trim().toLowerCase();
  return !(s === "false" || s === "0" || s === "no" || s === "n");
}

/** Whether a row carries a usable active flag at all (vs. the feed omitting the
 *  column). Distinct from `isActiveRow`, which defaults a missing flag to true. */
function hasActiveFlag(row: FeedFieldRow): boolean {
  const raw = row.IsActive ?? row.ColumnIsActive;
  return raw !== undefined && raw !== null && raw !== "";
}

/** Active design rows for one GI, deduped by LineNbr, in grid order. */
function gridOrderedRows(rows: FeedFieldRow[]): FeedFieldRow[] {
  // LineNbr is the row identity (GIResult's key), so it also dedupes an
  // overlapping feed pull. A row with no parseable LineNbr keeps its own slot —
  // collapsing every such row into one would silently lose columns.
  const byLine = new Map<number, FeedFieldRow>();
  const unnumbered: FeedFieldRow[] = [];
  for (const row of rows) {
    const n = lineNbr(row);
    if (n === Number.MAX_SAFE_INTEGER) unnumbered.push(row);
    else byLine.set(n, row);
  }
  return [...byLine.values(), ...unnumbered]
    .filter(isActiveRow)
    .sort((a, b) => sortOrder(a) - sortOrder(b) || lineNbr(a) - lineNbr(b));
}

/**
 * Assemble a registry from the two feeds + parsed EDMX. Pure.
 *
 * Field resolution per GI:
 *  - If EDMX has the EntityType, its property names (with `_N` suffixes) are the
 *    authoritative field list, in order, with declared types. Curated
 *    captions/descriptions from MCPGIFields are attached POSITIONALLY (see
 *    resolveFields) — a GI whose design rows can't be aligned keeps its names
 *    and types but gets no annotation.
 *  - If EDMX lacks the GI, fields fall back to the MCPGIFields rows by guessed
 *    name with no declared types (still useful for descriptions; types infer at
 *    runtime). If neither feed has fields, `fields` is omitted entirely.
 */
export function assembleRegistry(opts: {
  giRows: FeedGiRow[];
  fieldRows: FeedFieldRow[];
  edmxTypes: Map<string, EdmxEntity>;
  builtAt: string;
  endpointVersion?: string;
}): GiRegistry {
  const { giRows, fieldRows, edmxTypes, builtAt, endpointVersion } = opts;

  // Index field rows by GI name (trimmed).
  const fieldsByGi = new Map<string, FeedFieldRow[]>();
  for (const row of fieldRows) {
    const gi = row.Name?.trim();
    if (!gi) continue;
    (fieldsByGi.get(gi) ?? fieldsByGi.set(gi, []).get(gi)!).push(row);
  }

  const gis: GiRegistryEntry[] = [];
  for (const giRow of giRows) {
    const giName = giRow.Name?.trim();
    if (!giName || EXCLUDED_GI_NAMES.has(giName)) continue;

    const entry: GiRegistryEntry = { giName };
    if (giRow.DesignID) entry.designID = String(giRow.DesignID).trim();
    if (giRow.ScreenID) entry.entryScreen = giRow.ScreenID.trim();
    const desc = giRow.AIDescription?.trim();
    if (desc) entry.description = desc;

    const fields = resolveFields(giName, fieldsByGi.get(giName) ?? [], edmxTypes);
    if (fields.length) entry.fields = fields;

    gis.push(entry);
  }

  const registry: GiRegistry = { builtAt, gis };
  if (endpointVersion) registry.endpointVersion = endpointVersion;
  return registry;
}

/**
 * Score for pairing design `row` with property `prop`.
 *
 * A captioned row is a *hard constraint*: the caption is what Acumatica derives
 * the property name from, so a captioned row that doesn't land on its own
 * property proves the alignment is wrong. Uncaptioned rows score only a weak
 * field-name resemblance, used purely to break ties.
 */
const VIOLATION = -1e6;

/**
 * Coarse type family implied by a design row's source field NAME, or null when
 * nothing can be said.
 *
 * Deliberately conservative: a false positive here rejects a *correct* alignment
 * and silently drops a GI's annotations, so only patterns that are unambiguous in
 * Acumatica's field-naming conventions are classified. Calculated columns (`=…`)
 * are always null — their result type is not derivable from the expression.
 */
export function expectedTypeFamily(
  field: string | undefined
): "datetime" | "boolean" | "numeric" | "text" | null {
  const raw = (field ?? "").trim();
  if (!raw || raw.startsWith("=")) return null;
  // `*_description` is the resolved display text of a foreign key — always text,
  // and checked before the suffix rules below strip it.
  if (/_description$/i.test(raw)) return "text";
  const n = raw.toLowerCase();
  if (/^(is|has)[a-z]/.test(n) || /^(released|voided|prebooked|opendoc|depreciable|active|approved|printed|emailed)$/.test(n)) {
    return "boolean";
  }
  if (/(datetime|date)$/.test(n) && !/(update|dateid)$/.test(n)) return "datetime";
  if (/(amt|amount|balance|bal|cost|price|qty|quantity|total|discount|profit|percent|rate)$/.test(n)) {
    return "numeric";
  }
  if (/(descr|description|name|cd|code|status)$/.test(n)) return "text";
  return null;
}

/**
 * Whether a design row's implied family is impossible for a property's DECLARED
 * type. Only clearly-disjoint pairs conflict; `integer` is treated as compatible
 * with everything, because Acumatica surfaces identifiers and line numbers as
 * either an int or a string depending on the DAC.
 *
 * This is the constraint that makes an uncaptioned GI alignable at all: without
 * it the aligner scores every uncaptioned candidate 0, ties, and commits to an
 * arbitrary hoist — observed in production putting the string field `invoiceNbr`
 * on the decimal property `Amount` (SO-Invoice, 0.48.1).
 */
export function typeConflicts(
  family: ReturnType<typeof expectedTypeFamily>,
  simpleType: string | undefined
): boolean {
  if (!family || !simpleType || simpleType === "integer") return false;
  switch (family) {
    case "datetime":
      return simpleType !== "datetime";
    case "boolean":
      return simpleType !== "boolean";
    case "numeric":
      return simpleType !== "decimal";
    case "text":
      return simpleType === "decimal" || simpleType === "boolean" || simpleType === "datetime";
  }
}

/** camelCase/underscore tokens of length >= 4, lower-cased. */
function tokens(s: string): Set<string> {
  return new Set(
    s
      .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
      .split(/[^A-Za-z0-9]+/)
      .map((t) => t.toLowerCase())
      .filter((t) => t.length >= 4)
  );
}

function columnScore(row: FeedFieldRow, prop: string, simpleType?: string): number {
  const base = normalizeName(stripCollisionSuffix(prop));
  const caption = row.Caption?.trim();
  // Compare against the stripped *and* the full property name: a trailing `_N`
  // may be a collision suffix the platform added, or part of a caption someone
  // typed literally (seen in production as `ItemStatus_2`).
  if (caption) {
    const c = normalizeName(caption);
    return c === base || c === normalizeName(prop) ? 100 : VIOLATION;
  }

  const rawField = (row.Field ?? "").trim();
  if (typeConflicts(expectedTypeFamily(rawField), simpleType)) return VIOLATION;

  const field = normalizeName(
    rawField
      .replace(/_description$/i, "")
      .replace(/_Attributes$/i, "")
      .replace(/^Attribute/i, "")
  );
  if (!field) return 0;
  if (field === base) return 10;
  if (field.length > 3 && (base.includes(field) || field.includes(base))) return 3;
  // Weak shared-token signal, enough to separate two otherwise-tied candidates
  // (`finPeriodID`→`PostPeriod` shares "period"; `acctCD`→`PostPeriod` shares
  // nothing). Scored below the substring tiers so it never outranks them.
  const shared = [...tokens(rawField)].filter((t) => tokens(prop).has(t)).length;
  return shared > 0 ? 1 : 0;
}

/**
 * Align `rows` (active design rows, grid order) to `rest` (the properties that
 * kept their grid position) plus `hoisted` (leading key properties that were
 * pulled to the front). Each row either takes the next `rest` property or is one
 * of the hoisted ones; exactly `hoisted.length` rows must be hoisted.
 *
 * dp[i][h] = best score for rows i.. given h rows already hoisted, and cnt[i][h]
 * how many distinct hoist sets achieve it (saturating at 2). Returns null when no
 * assignment satisfies every captioned row, and ALSO when the optimum is TIED —
 * two hoist sets scoring equally means nothing in the data chooses between them,
 * and committing to one silently mis-shifts every column after the disagreement.
 * An unaligned GI must not be annotated from guesswork.
 */
function alignRows(
  rows: FeedFieldRow[],
  rest: string[],
  hoisted: string[],
  typeOf: (prop: string) => string | undefined
): Array<[FeedFieldRow, string]> | null {
  const n = rows.length;
  const H = hoisted.length;
  const NEG = -Infinity;
  const score = (row: FeedFieldRow, prop: string) => columnScore(row, prop, typeOf(prop));
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(H + 1).fill(NEG));
  const cnt: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(H + 1).fill(0));
  const back: (string | null)[][] = Array.from({ length: n + 1 }, () =>
    new Array<string | null>(H + 1).fill(null)
  );
  dp[n][H] = 0;
  cnt[n][H] = 1;

  const relax = (i: number, h: number, v: number, ways: number, how: string) => {
    if (v > dp[i][h]) {
      dp[i][h] = v;
      cnt[i][h] = ways;
      back[i][h] = how;
    } else if (v === dp[i][h] && v > NEG) {
      cnt[i][h] = Math.min(2, cnt[i][h] + ways);
    }
  };

  for (let i = n - 1; i >= 0; i--) {
    for (let h = 0; h <= Math.min(H, i); h++) {
      const j = i - h; // index into rest
      if (j < rest.length && dp[i + 1][h] > NEG) {
        relax(i, h, score(rows[i], rest[j]) + dp[i + 1][h], cnt[i + 1][h], "align");
      }
      if (h < H && dp[i + 1][h + 1] > NEG) {
        // Optimistic: the best any hoisted property could do. The exact
        // row→property assignment happens below.
        const best = Math.max(...hoisted.map((p) => score(rows[i], p)));
        relax(i, h, best + dp[i + 1][h + 1], cnt[i + 1][h + 1], "hoist");
      }
    }
  }
  if (dp[0][0] <= VIOLATION / 2) return null; // a captioned row could not be satisfied
  if (cnt[0][0] > 1) return null; // under-determined: nothing picks between the hoist sets

  const pairs: Array<[FeedFieldRow, string]> = [];
  const hoistedRows: FeedFieldRow[] = [];
  for (let i = 0, h = 0; i < n; i++) {
    if (back[i][h] === "hoist") {
      hoistedRows.push(rows[i]);
      h++;
    } else {
      pairs.push([rows[i], rest[i - h]]);
    }
  }

  // Assign the hoisted rows to the hoisted properties (H is small — greedy on
  // best score). Rejects outright if a captioned row can't be placed, and also if
  // the best score is achieved by more than one (row, property) pair: a tie here
  // swaps two key columns' descriptions with nothing to justify the choice.
  const propsLeft = [...hoisted];
  const rowsLeft = [...hoistedRows];
  while (propsLeft.length && rowsLeft.length) {
    let bi = 0;
    let bj = 0;
    let bs = -Infinity;
    for (let i = 0; i < rowsLeft.length; i++) {
      for (let j = 0; j < propsLeft.length; j++) {
        const s = score(rowsLeft[i], propsLeft[j]);
        if (s > bs) {
          bs = s;
          bi = i;
          bj = j;
        }
      }
    }
    if (bs <= VIOLATION / 2) return null;
    // Ambiguity is NOT "several pairs share the best score" — four captioned rows
    // each scoring 100 on their own property tie at 100 and resolve perfectly.
    // It is the chosen row being equally happy on another property, or the chosen
    // property being equally happy with another row. Either way nothing in the
    // data picks, so refuse rather than swap two key columns' descriptions.
    const rowAmbiguous = propsLeft.some((p, j) => j !== bj && score(rowsLeft[bi], p) === bs);
    const propAmbiguous = rowsLeft.some((r, i) => i !== bi && score(r, propsLeft[bj]) === bs);
    if (rowAmbiguous || propAmbiguous) return null;
    pairs.push([rowsLeft[bi], propsLeft[bj]]);
    rowsLeft.splice(bi, 1);
    propsLeft.splice(bj, 1);
  }

  // Final sweep: no captioned row may sit on a property it doesn't name, and no
  // row may sit on a property whose declared type its source field contradicts.
  for (const [row, prop] of pairs) {
    if (score(row, prop) <= VIOLATION / 2) return null;
  }
  return pairs;
}

/**
 * Resolve one GI's field metadata: authoritative property names + declared types
 * from $metadata, annotated with the curated captions/descriptions of the design
 * rows they correspond to.
 *
 * The join is POSITIONAL, not by name. Property names cannot be predicted from
 * the design: `GIResult.Caption` is only an override (NULL for the majority of
 * columns — 57% on a 115-GI production instance), and where `SchemaField` is
 * populated it is DAC-qualified ("INTran.RefNbr"), which never equals the bare
 * property. Matching by predicted name therefore dropped most descriptions.
 *
 * The verified layout rule (25R2):
 *
 *   properties = [result columns that are also entity keys, hoisted to the FRONT
 *                 in key order]
 *             ++ [remaining ACTIVE design rows in SortOrder order]
 *             ++ [keys that are not result columns, appended at the END, with no
 *                 design row]
 *
 * Validity checks, in order: the active-row count must not exceed the property
 * count; every captioned row must land on the property matching its caption; no
 * row may land on a property whose DECLARED type its source field contradicts;
 * and the optimum must be unique. If any fails the GI's annotation is rejected
 * *wholesale* — names and types are still returned, but no caption or description
 * is attached, because a mis-shifted annotation is worse than none.
 *
 * The last two checks were added in 0.48.2. Captions are a hard constraint but
 * most columns have none, so on a lightly-captioned GI every candidate scored 0,
 * the aligner tied, and it committed to an arbitrary hoist — which on production
 * SO-Invoice put the string field `invoiceNbr` on the decimal property `Amount`
 * and shifted six columns' descriptions by one. Declared types now rule such an
 * assignment out, and a surviving tie refuses instead of guessing.
 */
function resolveFields(
  giName: string,
  rows: FeedFieldRow[],
  edmxTypes: Map<string, EdmxEntity>
): GiFieldMeta[] {
  const active = gridOrderedRows(rows);
  const edmx = edmxTypes.get(normalizeName(giName));

  // Fallback path: no $metadata for this GI — emit fields from the feed rows by
  // guessed name, no declared types (runtime inference fills in types).
  if (!edmx || !edmx.order.length) {
    return active.map((row) => {
      const meta: GiFieldMeta = { name: predictPropertyName(row) };
      const caption = row.Caption?.trim();
      if (caption) meta.caption = caption;
      const d = row.AIDescription?.trim();
      if (d) meta.description = d;
      if (isExpressionRow(row)) meta.expression = true;
      return meta;
    });
  }

  const bare = (): GiFieldMeta[] =>
    edmx.order.map((prop) => {
      const meta: GiFieldMeta = { name: prop };
      const edm = edmx.types.get(prop);
      if (edm) meta.type = edmTypeToSimple(edm);
      return meta;
    });

  // A feed that emits no active flag at all cannot be aligned safely. Inactive
  // rows are then indistinguishable from active ones, so they consume property
  // slots and shift every later column — and a GI with no captions has no hard
  // constraint to catch it, so the misalignment is accepted silently. That is
  // the one path that produces *wrong* annotations rather than none, so refuse
  // it outright: an operator on a pre-0.48.0 MCPGIFields keeps names and types
  // until they re-import.
  if (!rows.some(hasActiveFlag)) return bare();

  // More active design rows than properties → the feed and $metadata disagree
  // about this GI (stale cache, truncated feed, renamed GI). Don't guess.
  if (edmx.order.length < active.length) return bare();

  // Trailing properties beyond the active-row count are keys that aren't result
  // columns; they get no design row.
  const head = edmx.order.slice(0, active.length);
  const keys = new Set(edmx.keys);
  let hoistCount = 0;
  while (hoistCount < head.length && keys.has(head[hoistCount])) hoistCount++;

  const typeOf = (prop: string): string | undefined => {
    const edm = edmx.types.get(prop);
    return edm ? edmTypeToSimple(edm) : undefined;
  };
  const pairs = alignRows(active, head.slice(hoistCount), head.slice(0, hoistCount), typeOf);
  if (!pairs) return bare();

  const rowByProp = new Map(pairs.map(([row, prop]) => [prop, row]));
  return edmx.order.map((prop) => {
    const meta: GiFieldMeta = { name: prop };
    const edm = edmx.types.get(prop);
    if (edm) meta.type = edmTypeToSimple(edm);

    const row = rowByProp.get(prop);
    if (row) {
      const caption = row.Caption?.trim();
      if (caption) meta.caption = caption;
      const d = row.AIDescription?.trim();
      if (d) meta.description = d;
      if (isExpressionRow(row)) meta.expression = true;
    }
    return meta;
  });
}
