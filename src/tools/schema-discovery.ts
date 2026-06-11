// Copyright 2026 Hall Boys, Inc.
// SPDX-License-Identifier: Apache-2.0

import type { AppEnv } from "../types/acumatica";
import { loadIndex, INDEX_KEYS } from "../lib/index-store";
import { KeywordSchemaSearch, type ISchemaSearch, type SchemaIndex } from "../lib/schema-search";

/**
 * Offline schema-knowledge tools, backed by the schema index built from
 * swagger.json (scripts/build-schema-index.mjs). These answer "what entities
 * exist / what fields does X have / which entities have field Y" with no
 * tenant round-trip and no per-record sampling.
 *
 * Relationship to the live tools:
 *  - acumatica_search_schema / _list_schema_entities / _get_schema_entity →
 *    fast cross-entity discovery + shape from the offline catalog.
 *  - acumatica_describe_entity (live $adHocSchema) → authoritative per-entity
 *    detail including custom fields, when you need the current truth.
 */

const BUILD_HINT =
  "Schema index not available. Build and upload it with `npm run build-index` " +
  "(generates .index/schema-index.json from your instance's swagger.json and " +
  "uploads it to the INDEX_STORE R2 bucket), then reconnect.";

// Memoize the search wrapper per parsed index object so we don't rebuild the
// name Map on every call (loadIndex already memoizes the parse per isolate).
let cachedFor: SchemaIndex | null = null;
let cachedSearch: ISchemaSearch | null = null;

async function getSearch(env: AppEnv): Promise<ISchemaSearch | null> {
  const index = await loadIndex<SchemaIndex>(env, INDEX_KEYS.schema);
  if (!index) return null;
  if (cachedFor !== index) {
    cachedFor = index;
    cachedSearch = new KeywordSchemaSearch(index);
  }
  return cachedSearch;
}

export async function handleSearchSchema(
  env: AppEnv,
  args: { query?: string; field?: string; topN?: number }
): Promise<unknown> {
  const search = await getSearch(env);
  if (!search) return { error: BUILD_HINT };

  const query = args.query?.trim();
  const field = args.field?.trim();
  if (!query && !field) {
    return { error: "Provide `query` (entity name/keyword) and/or `field` (a field name to find)." };
  }

  const results = search.search({ text: query, field, limit: args.topN });
  return {
    results,
    resultCount: results.length,
    note: "Offline catalog from swagger.json. For authoritative live per-entity detail (incl. custom fields) use acumatica_describe_entity.",
  };
}

export async function handleGetSchemaEntity(
  env: AppEnv,
  args: { entityName: string }
): Promise<unknown> {
  const search = await getSearch(env);
  if (!search) return { error: BUILD_HINT };

  const name = args.entityName?.trim();
  if (!name) return { error: "entityName is required." };

  const entity = search.get(name);
  if (!entity) {
    return {
      error: `Entity '${name}' not found in the schema index. Use acumatica_search_schema to find the correct name.`,
    };
  }
  return {
    ...entity,
    expandHint:
      entity.subCollections.length > 0
        ? `Expandable via $expand: ${entity.subCollections.map((s) => s.name).join(", ")}`
        : "No expandable sub-entities.",
  };
}

export async function handleListSchemaEntities(
  env: AppEnv,
  args: { namespace?: string; topN?: number }
): Promise<unknown> {
  const search = await getSearch(env);
  if (!search) return { error: BUILD_HINT };

  const items = search.list({ namespace: args.namespace?.trim(), limit: args.topN });
  return { entities: items, count: items.length };
}
