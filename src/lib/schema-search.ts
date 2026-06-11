// Copyright 2026 Hall Boys, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Schema-knowledge search over the offline schema index (built from
 * swagger.json by scripts/build-schema-index.mjs).
 *
 * Search is keyword + structured today. The `ISchemaSearch` interface is the
 * seam for a future Vectorize-backed `VectorSchemaSearch` — tool handlers
 * depend only on this interface, so semantic search can be added without
 * touching them.
 */

export interface SchemaField {
  name: string;
  type: string;
  format?: string;
  nullable?: boolean;
}

export interface SchemaSubCollection {
  name: string;
  /** Target entity schema name — the type reached via $expand=<name>. */
  type: string;
  /** true = array (collection / Details-style), false = single nested object. */
  array: boolean;
}

export interface SchemaEntity {
  name: string;
  /** OpenAPI tag (module grouping), when known. */
  tag?: string;
  fields: SchemaField[];
  actions: string[];
  subCollections: SchemaSubCollection[];
}

export interface SchemaIndex {
  generatedFrom: string;
  generatedAt: string;
  entityCount: number;
  entities: Record<string, SchemaEntity>;
  /** Inverted map: lowercased field name -> entity names containing it. */
  fieldToEntities: Record<string, string[]>;
}

export interface SchemaSearchHit {
  name: string;
  tag?: string;
  fieldCount: number;
  /** Why this entity matched (e.g. "name contains 'tax'", "has field 'TaxZoneID'"). */
  matchedOn: string[];
}

export interface SchemaListItem {
  name: string;
  tag?: string;
  fieldCount: number;
}

export interface ISchemaSearch {
  /** Find entities by name/keyword and/or by a field they contain. */
  search(opts: { text?: string; field?: string; limit?: number }): SchemaSearchHit[];
  /** Authoritative full detail for one entity, or null if unknown. */
  get(name: string): SchemaEntity | null;
  /** List the catalog, optionally filtered by name/tag prefix. */
  list(opts?: { namespace?: string; limit?: number }): SchemaListItem[];
}

/** Keyword + structured implementation backed by a parsed SchemaIndex. */
export class KeywordSchemaSearch implements ISchemaSearch {
  private byLowerName: Map<string, string>; // lowercased -> canonical entity name

  constructor(private index: SchemaIndex) {
    this.byLowerName = new Map(
      Object.keys(index.entities).map((n) => [n.toLowerCase(), n])
    );
  }

  get(name: string): SchemaEntity | null {
    const direct = this.index.entities[name];
    if (direct) return direct;
    const canonical = this.byLowerName.get(name.trim().toLowerCase());
    return canonical ? this.index.entities[canonical] : null;
  }

  list(opts: { namespace?: string; limit?: number } = {}): SchemaListItem[] {
    const ns = opts.namespace?.trim().toLowerCase();
    const limit = clampLimit(opts.limit, 200);
    const items: SchemaListItem[] = [];
    for (const e of Object.values(this.index.entities)) {
      if (ns) {
        const hay = `${e.name} ${e.tag ?? ""}`.toLowerCase();
        if (!e.name.toLowerCase().startsWith(ns) && !(e.tag?.toLowerCase().startsWith(ns)) && !hay.includes(ns)) {
          continue;
        }
      }
      items.push({ name: e.name, tag: e.tag, fieldCount: e.fields.length });
    }
    items.sort((a, b) => a.name.localeCompare(b.name));
    return items.slice(0, limit);
  }

  search(opts: { text?: string; field?: string; limit?: number }): SchemaSearchHit[] {
    const text = opts.text?.trim().toLowerCase();
    const field = opts.field?.trim();
    const limit = clampLimit(opts.limit, 25);

    // Field filter narrows the candidate set via the inverted index.
    let candidates: string[];
    const matchedByField = new Map<string, string>();
    if (field) {
      const fieldLower = field.toLowerCase();
      const exact = this.index.fieldToEntities[fieldLower] ?? [];
      const partial = new Set(exact);
      // Allow partial field-name matches too (e.g. "tax" -> TaxZoneID).
      for (const [fname, entities] of Object.entries(this.index.fieldToEntities)) {
        if (fname.includes(fieldLower)) entities.forEach((e) => partial.add(e));
      }
      candidates = [...partial];
      candidates.forEach((c) => matchedByField.set(c, field));
    } else {
      candidates = Object.keys(this.index.entities);
    }

    const hits: Array<SchemaSearchHit & { score: number }> = [];
    for (const name of candidates) {
      const entity = this.index.entities[name];
      if (!entity) continue;
      const matchedOn: string[] = [];
      let score = 0;

      if (matchedByField.has(name)) {
        matchedOn.push(`has field matching '${matchedByField.get(name)}'`);
        score += 2;
      }

      if (text) {
        const nameLower = name.toLowerCase();
        if (nameLower === text) {
          matchedOn.push(`name is '${name}'`);
          score += 10;
        } else if (nameLower.startsWith(text)) {
          matchedOn.push(`name starts with '${opts.text}'`);
          score += 6;
        } else if (nameLower.includes(text)) {
          matchedOn.push(`name contains '${opts.text}'`);
          score += 4;
        } else if (entity.tag?.toLowerCase().includes(text)) {
          matchedOn.push(`module '${entity.tag}'`);
          score += 1;
        } else if (!field) {
          // Text given, no field filter, nothing matched on this entity.
          continue;
        }
      } else if (!field) {
        // Neither text nor field — not a meaningful search.
        continue;
      }

      if (matchedOn.length === 0) continue;
      hits.push({ name, tag: entity.tag, fieldCount: entity.fields.length, matchedOn, score });
    }

    hits.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
    return hits.slice(0, limit).map(({ score, ...hit }) => hit);
  }
}

function clampLimit(n: number | undefined, fallback: number): number {
  if (!n || !Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(Math.floor(n), 500);
}
