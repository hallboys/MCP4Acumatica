// Copyright 2026 Hall Boys, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * build-schema-index.mjs — produce the compact contract/OData schema index
 * consumed by the acumatica_search_schema / _get_schema_entity /
 * _list_schema_entities tools.
 *
 * Input:  ./swagger.json  — the OpenAPI 3.0 spec exported from the Acumatica
 *         contract endpoint (Instance → ... → Swagger / the /entity/Default/
 *         <version>/swagger.json URL). This is *your* instance's own API
 *         description, including your customizations — no third-party IP.
 * Output: ./.index/schema-index.json
 *
 * The index is derived purely from swagger.json; run it whenever the endpoint
 * version or your customizations change. Upload with `npm run upload-index`.
 *
 * Usage: node scripts/build-schema-index.mjs [path/to/swagger.json]
 */

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

const INPUT = process.argv[2] || "./swagger.json";
const OUTPUT = "./.index/schema-index.json";

const refName = (ref) => (ref || "").split("/").pop();

function getInlineProps(sch) {
  if (sch.properties) return sch.properties;
  if (Array.isArray(sch.allOf)) {
    const withProps = sch.allOf.find((part) => part.properties);
    return withProps ? withProps.properties : {};
  }
  return {};
}

function main() {
  const spec = JSON.parse(readFileSync(INPUT, "utf8"));
  const schemas = spec.components?.schemas ?? {};

  // 1. Identify the Acumatica value-wrapper schemas ({ value, error }) and map
  //    each to a simple scalar type. Every entity field is a $ref to one of these.
  const wrappers = {}; // wrapperSchemaName -> { type, format }
  for (const [name, sch] of Object.entries(schemas)) {
    const props = sch.properties;
    if (props?.value && Object.keys(props).every((k) => k === "value" || k === "error")) {
      wrappers[name] = { type: props.value.type || "string", format: props.value.format };
    }
  }

  // 2. Collect named actions per entity from POST paths like
  //    POST /SalesOrder/CancelSalesOrder. Skip templates ({...}), $adHocSchema,
  //    files, and the generic {actionName} catch-all.
  const actionsByEntity = {};
  for (const [path, ops] of Object.entries(spec.paths ?? {})) {
    const seg = path.split("/").filter(Boolean);
    if (seg.length !== 2 || !ops.post) continue;
    const [entity, action] = seg;
    if (action.startsWith("{") || action.startsWith("$") || action === "files") continue;
    (actionsByEntity[entity] ??= []).push(action);
  }

  // 3. Best-effort OpenAPI tag per entity (its module grouping), used for the
  //    namespace/list filter. Pull from the GET /{Entity} operation if present.
  const tagOf = (name) => spec.paths?.[`/${name}`]?.get?.tags?.[0];

  const isActionParamSchema = (props) => {
    const keys = Object.keys(props);
    return keys.length > 0 && keys.every((k) => k === "entity" || k === "parameters");
  };

  const entities = {};
  const fieldToEntities = {};

  for (const [name, sch] of Object.entries(schemas)) {
    if (wrappers[name]) continue; // value wrapper, not an entity
    if (/CustomAction$/.test(name)) continue; // generic action envelope
    const props = getInlineProps(sch);
    if (Object.keys(props).length === 0) continue; // no shape to describe
    if (isActionParamSchema(props)) continue; // named-action parameter schema

    const fields = [];
    const subCollections = [];

    for (const [propName, prop] of Object.entries(props)) {
      if (prop.$ref) {
        const target = refName(prop.$ref);
        if (wrappers[target]) {
          const w = wrappers[target];
          fields.push({ name: propName, type: w.type, ...(w.format ? { format: w.format } : {}) });
        } else {
          // Nested object that is itself an entity — expandable via $expand.
          subCollections.push({ name: propName, type: target, array: false });
        }
      } else if (prop.type === "array" && prop.items?.$ref) {
        subCollections.push({ name: propName, type: refName(prop.items.$ref), array: true });
      } else if (prop.type && prop.type !== "object") {
        // Inline scalar (e.g. Entity.id: uuid). Keep format if present.
        fields.push({ name: propName, type: prop.type, ...(prop.format ? { format: prop.format } : {}) });
      }
    }

    const tag = tagOf(name);
    entities[name] = {
      name,
      ...(tag ? { tag } : {}),
      fields,
      actions: (actionsByEntity[name] ?? []).sort(),
      subCollections,
    };

    for (const f of fields) {
      const key = f.name.toLowerCase();
      (fieldToEntities[key] ??= []).push(name);
    }
  }

  const index = {
    generatedFrom: `${spec.info?.title ?? "Acumatica"} swagger v${spec.info?.version ?? "?"}`,
    generatedAt: new Date().toISOString(),
    entityCount: Object.keys(entities).length,
    entities,
    fieldToEntities,
  };

  mkdirSync(dirname(OUTPUT), { recursive: true });
  writeFileSync(OUTPUT, JSON.stringify(index));
  console.log(
    `Wrote ${OUTPUT}: ${index.entityCount} entities, ` +
      `${Object.keys(fieldToEntities).length} distinct field names ` +
      `(from ${index.generatedFrom}).`
  );
}

main();
