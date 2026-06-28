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
  /** Target column's DAC field name (MCPGIFields "SchemaField"); fallback for
   *  predicting the OData property name when the column has no caption. */
  SchemaField?: string;
  /** Target column's caption (MCPGIFields "Caption"). */
  Caption?: string;
  /** Curated per-column description (MCPGIFields "AIDescription"). */
  AIDescription?: string;
  /** Target column's result-grid line number (MCPGIFields "LineNbr"); orders
   *  columns for collision disambiguation. */
  LineNbr?: number | string;
}

/** Parsed EDMX EntityType: ordered property names + declared types. */
export interface EdmxEntity {
  /** Property names in declaration order (carry `_N` collision suffixes). */
  order: string[];
  /** propertyName → raw Edm type (e.g. "Edm.Decimal"). */
  types: Map<string, string>;
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
    const propRe = /<Property\s+Name="([^"]+)"\s+Type="([^"]+)"/g;
    for (const p of body.matchAll(propRe)) {
      order.push(p[1]);
      types.set(p[1], p[2]);
    }
    out.set(normalizeName(name), { order, types });
  }
  return out;
}

/**
 * Predicted OData property name for a MCPGIFields row, per the precedence rule
 * (spec §3): caption (whitespace/invalid stripped) → `Usr`-stripped field →
 * field name. The result is only used to *match* against authoritative
 * $metadata names, so it's returned un-normalized; callers normalize.
 */
export function predictPropertyName(row: FeedFieldRow): string {
  const caption = row.Caption?.trim();
  if (caption) return caption.replace(/[^A-Za-z0-9]/g, "");
  const field = (row.SchemaField ?? "").trim();
  if (field.startsWith("Usr")) return field.slice(3);
  return field;
}

function lineNbr(row: FeedFieldRow): number {
  const n = typeof row.LineNbr === "string" ? parseInt(row.LineNbr, 10) : row.LineNbr;
  return Number.isFinite(n as number) ? (n as number) : Number.MAX_SAFE_INTEGER;
}

/**
 * Assemble a registry from the two feeds + parsed EDMX. Pure.
 *
 * Field resolution per GI:
 *  - If EDMX has the EntityType, its property names (with `_N` suffixes) are the
 *    authoritative field list, in order, with declared types. Curated
 *    descriptions/captions from MCPGIFields are matched onto them: rows are
 *    grouped by predicted name (LineNbr order), then assigned to authoritative
 *    properties by stripped-base name so collisions (`InventoryID`,
 *    `InventoryID_2`) line up with the result-grid order.
 *  - If EDMX lacks the GI, fields fall back to the MCPGIFields rows by predicted
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

function resolveFields(
  giName: string,
  rows: FeedFieldRow[],
  edmxTypes: Map<string, EdmxEntity>
): GiFieldMeta[] {
  const sorted = [...rows].sort((a, b) => lineNbr(a) - lineNbr(b));

  // Group description rows by normalized predicted base name, preserving
  // LineNbr order within each group (collision disambiguation).
  const byPredicted = new Map<string, FeedFieldRow[]>();
  for (const row of sorted) {
    const key = normalizeName(predictPropertyName(row));
    if (!key) continue;
    (byPredicted.get(key) ?? byPredicted.set(key, []).get(key)!).push(row);
  }

  const edmx = edmxTypes.get(normalizeName(giName));
  if (edmx && edmx.order.length) {
    // Authoritative path: $metadata property names win.
    const cursor = new Map<string, number>();
    return edmx.order.map((prop) => {
      const meta: GiFieldMeta = { name: prop };
      const edm = edmx.types.get(prop);
      if (edm) meta.type = edmTypeToSimple(edm);

      const base = normalizeName(stripCollisionSuffix(prop));
      const queue = byPredicted.get(base);
      if (queue && queue.length) {
        const i = cursor.get(base) ?? 0;
        const row = queue[Math.min(i, queue.length - 1)];
        cursor.set(base, i + 1);
        const caption = row.Caption?.trim();
        if (caption) meta.caption = caption;
        const d = row.AIDescription?.trim();
        if (d) meta.description = d;
      }
      return meta;
    });
  }

  // Fallback path: no EDMX for this GI — emit fields from the feed rows by
  // predicted name, no declared types (runtime inference fills in types).
  return sorted.map((row) => {
    const meta: GiFieldMeta = { name: predictPropertyName(row) };
    const caption = row.Caption?.trim();
    if (caption) meta.caption = caption;
    const d = row.AIDescription?.trim();
    if (d) meta.description = d;
    return meta;
  });
}
