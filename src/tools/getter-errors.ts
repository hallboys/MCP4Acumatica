// Copyright 2026 Hall Boys, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Endpoint-aware error helpers for the per-entity getters.
 *
 * Kept as an import-free leaf module so it can be unit-tested directly
 * (node --test type-stripping can't resolve the extensionless imports that
 * getter-registry.ts uses for the runtime client).
 */

/**
 * Endpoint-aware 404 message for a getter, or null to keep the client's plain
 * message. The getter entity names in GETTER_TOOLS are curated against the stock
 * "Default" contract endpoint; when the server is pointed at a custom Web Service
 * Endpoint (ACUMATICA_ENDPOINT_NAME), a 404 is ambiguous — the key could be wrong,
 * OR that endpoint may simply not expose (or may have renamed/reshaped) this
 * entity. Acumatica returns the same 404 for both, so on a non-"Default" endpoint
 * we surface the second cause. On "Default" (which exposes all standard entities)
 * the extra cause is just noise, so we return null and keep the plain message.
 */
export function endpointAware404Message(
  statusCode: number,
  endpointName: string,
  entity: string
): string | null {
  if (statusCode !== 404 || endpointName === "Default") return null;
  return (
    `No '${entity}' record was found for the given key on contract endpoint '${endpointName}'. ` +
    `Two possible causes: (1) the key/ID is wrong — use acumatica_list_entities with entityName='${entity}' to look it up; or ` +
    `(2) endpoint '${endpointName}' may not expose a '${entity}' entity. The built-in get tools are curated for the stock 'Default' endpoint, and a custom endpoint can omit, rename, or reshape entities. ` +
    `Confirm the entity exists on this endpoint with acumatica_describe_entity (entityName='${entity}') or acumatica_search_schema.`
  );
}
