// Copyright 2026 Hall Boys, Inc.
// SPDX-License-Identifier: Apache-2.0

// Guards the detection helpers behind the CannotOptimizeException handling for
// complex document entities (PurchaseOrder, PhysicalInventoryCount, Shipment).
//
// Run with:  node --test --experimental-strip-types test/complex-entities.test.ts

import { test } from "node:test";
import assert from "node:assert";
import {
  getComplexEntityInfo,
  getFilterErrorKind,
  isKeyedFilter,
} from "../src/lib/complex-entities.ts";

test("getComplexEntityInfo: known entities, case/prefix-insensitive", () => {
  assert.equal(getComplexEntityInfo("PurchaseOrder")?.keyField, "OrderNbr");
  assert.equal(getComplexEntityInfo("shipment")?.keyField, "ShipmentNbr");
  assert.equal(getComplexEntityInfo(" Default/Shipment ")?.name, "Shipment");
  assert.equal(getComplexEntityInfo("PhysicalInventoryCount")?.keyField, undefined);
});

test("getComplexEntityInfo: simple master entities are not flagged", () => {
  for (const e of ["Customer", "Vendor", "Project", "StockItem", "CostCode"]) {
    assert.equal(getComplexEntityInfo(e), undefined, e);
  }
});

test("getFilterErrorKind: child-collection access", () => {
  // ODataException from filtering by a child-collection field (real 25R2 body).
  assert.equal(
    getFilterErrorKind('{"exceptionMessage":"The parent value for a property access of a property \'AlternateID\' is not a single value."}'),
    "child_collection"
  );
});

test("getFilterErrorKind: the not-filterable family (real 25R2 bodies)", () => {
  // CannotOptimizeException (BQL-delegate, per report)
  assert.equal(getFilterErrorKind("...the given query cannot be optimized..."), "not_filterable");
  assert.equal(getFilterErrorKind('{"exceptionType":"CannotOptimizeException"}'), "not_filterable");
  // Type mismatch on a computed field
  assert.equal(getFilterErrorKind('{"exceptionMessage":"Type conversions not supported"}'), "not_filterable");
  // Unknown/unbound field
  assert.equal(getFilterErrorKind('{"exceptionMessage":"The given key was not present in the dictionary."}'), "not_filterable");
  // Caught via the OData filter-binder namespace even with an unanticipated message
  assert.equal(getFilterErrorKind('{"stackTrace":"at PX.Api.ContractBased.OData.FilterVisitor.Visit(...)"}'), "not_filterable");
});

test("getFilterErrorKind: unrelated 500s are not misclassified", () => {
  assert.equal(getFilterErrorKind("Some other internal error"), null);
  assert.equal(getFilterErrorKind(""), null);
});

test("isKeyedFilter: true only when the key field is referenced with eq", () => {
  assert.ok(isKeyedFilter("OrderNbr eq 'PO017606'", "OrderNbr"));
  assert.ok(isKeyedFilter("ShipmentNbr eq '061727' and Status eq 'Open'", "ShipmentNbr"));
  assert.ok(isKeyedFilter("OrderNbr  eq  'PO1'", "OrderNbr")); // flexible whitespace
  assert.ok(!isKeyedFilter("substringof('x', Description)", "ShipmentNbr"));
  assert.ok(!isKeyedFilter("Status eq 'Open'", "OrderNbr"));
});

test("isKeyedFilter: no key field known → never treated as keyed", () => {
  assert.ok(!isKeyedFilter("anything eq 'x'", undefined));
});
