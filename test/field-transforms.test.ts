// Copyright 2026 Hall Boys, Inc.
// SPDX-License-Identifier: Apache-2.0

// Tests for wrapFields / unwrapFields in src/lib/field-transforms.ts.
// Both functions are pure with no imports, so they run cleanly under
// `node --test --experimental-strip-types`.
//
// Run with:  node --test --experimental-strip-types test/field-transforms.test.ts

import { test } from "node:test";
import assert from "node:assert";
import { wrapFields, unwrapFields } from "../src/lib/field-transforms.ts";

// ── wrapFields ────────────────────────────────────────────────────────────────

test("wrapFields: scalars get wrapped", () => {
  const result = wrapFields({ CustomerName: "Acme", Status: "Active" }) as Record<string, unknown>;
  assert.deepStrictEqual(result.CustomerName, { value: "Acme" });
  assert.deepStrictEqual(result.Status, { value: "Active" });
});

test("wrapFields: null value wraps to {value: null}", () => {
  const result = wrapFields({ Phone1: null }) as Record<string, unknown>;
  assert.deepStrictEqual(result.Phone1, { value: null });
});

test("wrapFields: nested sub-entity scalars are wrapped recursively", () => {
  const input = {
    MainContact: {
      Email: "a@b.com",
      City: "Austin",
    },
  };
  const result = wrapFields(input) as Record<string, Record<string, unknown>>;
  assert.deepStrictEqual(result.MainContact.Email, { value: "a@b.com" });
  assert.deepStrictEqual(result.MainContact.City, { value: "Austin" });
});

test("wrapFields: array elements are recursively wrapped", () => {
  const input = { Lines: [{ Qty: 2 }, { Qty: 5 }] };
  const result = wrapFields(input) as Record<string, unknown[]>;
  assert.deepStrictEqual(result.Lines[0], { Qty: { value: 2 } });
  assert.deepStrictEqual(result.Lines[1], { Qty: { value: 5 } });
});

test("wrapFields: already-wrapped {value: X} is left untouched (idempotent)", () => {
  const wrapped = { CustomerName: { value: "Acme" } };
  // Passing a {value: X} object directly — should not double-wrap.
  const result = wrapFields(wrapped) as Record<string, unknown>;
  // The container is a plain object (not a {value} itself), so its keys get
  // wrapped — but the inner {value: "Acme"} is already wrapped and is passed
  // through as-is.
  const inner = result.CustomerName as Record<string, unknown>;
  assert.deepStrictEqual(inner, { value: "Acme" });
});

test("wrapFields: a top-level {value: X} object is left untouched", () => {
  const alreadyWrapped = { value: "hello" };
  const result = wrapFields(alreadyWrapped);
  assert.deepStrictEqual(result, { value: "hello" });
});

test("wrapFields: null / undefined passthrough", () => {
  assert.strictEqual(wrapFields(null), null);
  assert.strictEqual(wrapFields(undefined), undefined);
});

// ── unwrapFields ──────────────────────────────────────────────────────────────

test("unwrapFields: {value: X} objects are unwrapped", () => {
  const input = { CustomerName: { value: "Acme" }, Status: { value: "Active" } };
  const result = unwrapFields(input) as Record<string, unknown>;
  assert.strictEqual(result.CustomerName, "Acme");
  assert.strictEqual(result.Status, "Active");
});

test("unwrapFields: nested sub-entities are recursed", () => {
  const input = {
    MainContact: {
      Email: { value: "a@b.com" },
    },
  };
  const result = unwrapFields(input) as Record<string, Record<string, unknown>>;
  assert.strictEqual(result.MainContact.Email, "a@b.com");
});

test("unwrapFields: drops _links, rowNumber, custom", () => {
  const input = {
    CustomerID: { value: "C000001" },
    _links: { self: "https://..." },
    rowNumber: { value: 1 },
    custom: { Document: { UsrField: { value: "x" } } },
  };
  const result = unwrapFields(input) as Record<string, unknown>;
  assert.strictEqual(result.CustomerID, "C000001");
  assert.ok(!("_links" in result));
  assert.ok(!("rowNumber" in result));
  assert.ok(!("custom" in result));
});

test("unwrapFields: arrays are recursed", () => {
  const input = { Lines: [{ Qty: { value: 2 } }, { Qty: { value: 5 } }] };
  const result = unwrapFields(input) as Record<string, unknown[]>;
  assert.strictEqual((result.Lines[0] as Record<string, unknown>).Qty, 2);
  assert.strictEqual((result.Lines[1] as Record<string, unknown>).Qty, 5);
});

// ── round-trip ────────────────────────────────────────────────────────────────

test("round-trip: wrapFields then unwrapFields returns original plain values", () => {
  const original = {
    CustomerName: "Acme Corp",
    Status: "Active",
    Phone1: null,
    MainContact: {
      Email: "billing@acme.com",
      City: "Austin",
    },
  };
  const wrapped = wrapFields(original);
  const roundTripped = unwrapFields(wrapped);
  // unwrapFields drops _links/rowNumber/custom but our input has none, so the
  // result should deep-equal the original.
  assert.deepStrictEqual(roundTripped, original);
});

test("round-trip: wrapFields then unwrapFields with array detail lines", () => {
  const original = {
    Lines: [
      { Qty: 3, UnitCost: 9.99 },
      { Qty: 1, UnitCost: 4.5 },
    ],
  };
  const wrapped = wrapFields(original);
  const roundTripped = unwrapFields(wrapped);
  assert.deepStrictEqual(roundTripped, original);
});
