// Copyright 2026 Hall Boys, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Acumatica's contract-REST API frequently cannot apply a server-side
 * `$filter`, and it fails in two broad ways depending on the field:
 *
 *   A) HTTP 500 from the OData filter binder. Observed (live, 25R2) for a
 *      variety of fields, all surfacing through `PX.Api.ContractBased.OData`
 *      / `Microsoft.Data.OData.Query` with different exception messages:
 *        - "the given query cannot be optimized" / CannotOptimizeException
 *          (BQL-delegate / unbound fields)
 *        - "...is not a single value" (filtering by a CHILD-COLLECTION field,
 *          e.g. StockItem CrossReferences/AlternateID)
 *        - "Type conversions not supported" (e.g. a computed numeric field)
 *        - "The given key was not present in the dictionary" (a field the
 *          entity's contract view doesn't bind)
 *   B) A SILENT HTTP 200 with `[]` — matches nothing even though records
 *      exist. Confirmed on PurchaseOrder VendorID / VendorRef: a
 *      `substringof(...)` over an unbound text field returns `[]`, while a
 *      keyed lookup returns the record.
 *
 * What still works: a KEYED lookup. Filtering on the entity's key field (e.g.
 * `OrderNbr eq 'PO017606'`, `ShipmentNbr eq '061727'`) with `topN=1` is
 * optimizable and returns the record; only broad/non-key filters fail. Broad
 * search on these entities must go through a Generic Inquiry.
 *
 * Failure mode A is detected from the response body (`getFilterErrorKind`),
 * entity-agnostic, so it also covers the child-collection case on entities not
 * listed here. The known-list drives the mode-B false-negative warning and the
 * tool-description guidance.
 *
 * This module is intentionally dependency-free so the regression test can
 * import it under Node's TypeScript type-stripping.
 */

export interface ComplexEntityInfo {
  /** Canonical Acumatica entity name. */
  name: string;
  /** Key field usable in an optimizable equality `$filter`, if known. */
  keyField?: string;
}

// Document entities whose non-key $filter can silently return [] (mode B).
// Add entities here as they're discovered; keep src/index.ts's tool
// description in sync when this list changes.
const COMPLEX_DOCUMENT_ENTITIES: ComplexEntityInfo[] = [
  { name: "PurchaseOrder", keyField: "OrderNbr" },
  { name: "PhysicalInventoryCount" },
  { name: "Shipment", keyField: "ShipmentNbr" },
];

const BY_NAME = new Map(
  COMPLEX_DOCUMENT_ENTITIES.map((e) => [e.name.toLowerCase(), e])
);

/** Names of the known complex entities, for tool-description guidance. */
export const COMPLEX_ENTITY_NAMES = COMPLEX_DOCUMENT_ENTITIES.map((e) => e.name);

/**
 * Canonicalize an entity name the same way entity-list does (trim, strip any
 * leading path prefix, lowercase) so `" Shipment "`, `Default/Shipment`, and
 * `SHIPMENT` all resolve.
 */
function canon(name: string): string {
  const trimmed = name.trim();
  const last = trimmed.includes("/")
    ? trimmed.slice(trimmed.lastIndexOf("/") + 1)
    : trimmed;
  return last.toLowerCase();
}

export function getComplexEntityInfo(
  entityName: string
): ComplexEntityInfo | undefined {
  return BY_NAME.get(canon(entityName));
}

/**
 * Classify an upstream 500 body as a contract-API filter-binding failure.
 * Returns:
 *  - "child_collection": the filter referenced a child-collection field.
 *  - "not_filterable":   the field is unbound/computed/BQL-delegate, the wrong
 *                        type, or not bound by the entity's contract view
 *                        (includes CannotOptimizeException).
 *  - null:               not a recognizable filter-binding error.
 *
 * Matches both the specific exception messages and the OData filter-binder
 * namespaces (`PX.Api.ContractBased.OData`, `Microsoft.Data.OData.Query`) that
 * appear in the stack trace of every such 500 — so an unanticipated message
 * still classifies as long as it came through the filter binder.
 */
export function getFilterErrorKind(
  body: string
): "child_collection" | "not_filterable" | null {
  const b = body.toLowerCase();
  // Child-collection access fails with this distinctive OData binder message.
  if (b.includes("not a single value")) return "child_collection";
  if (
    b.includes("cannotoptimize") ||
    b.includes("cannot be optimized") ||
    b.includes("type conversions not supported") ||
    b.includes("the given key was not present") ||
    b.includes("contractbased.odata") ||
    b.includes("data.odata.query")
  ) {
    return "not_filterable";
  }
  return null;
}

/**
 * Heuristic: does `filter` contain an equality on the entity's key field
 * (a keyed, optimizable lookup)? Such a filter is trustworthy on a complex
 * entity, so we must NOT flag its 0-row result as a possible false negative.
 * Detects a `keyField eq '…'` clause anywhere in the expression — additional
 * ANDed clauses don't make it non-keyed.
 */
export function isKeyedFilter(
  filter: string,
  keyField: string | undefined
): boolean {
  if (!keyField) return false;
  return new RegExp(`\\b${keyField}\\s+eq\\s+'`, "i").test(filter);
}
