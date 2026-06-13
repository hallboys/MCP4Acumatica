// Copyright 2026 Hall Boys, Inc.
// SPDX-License-Identifier: Apache-2.0

// Regression guard for the substringof/startswith/endswith "returns []" bug.
// Acumatica's contract-REST $filter parser silently returns an empty result
// set (HTTP 200, no error) for `substringof(...) eq true`, but works for the
// bare boolean function `substringof(...)`. Verified live: `eq true` → [],
// bare → matching rows. normalizeODataFilter strips the `eq true` so the bare
// form reaches Acumatica.
//
// Run with:  node --test --experimental-strip-types test/odata-filter.test.ts
// (Node >= 22; on Node >= 23.6 the --experimental-strip-types flag is implied.)

import { test } from "node:test";
import assert from "node:assert";
import { normalizeODataFilter } from "../src/lib/odata-filter.ts";

test("substringof: strips trailing 'eq true'", () => {
  assert.equal(
    normalizeODataFilter("substringof('LENNAR', CustomerName) eq true"),
    "substringof('LENNAR', CustomerName)"
  );
});

test("startswith: strips 'eq true'", () => {
  assert.equal(
    normalizeODataFilter("startswith(VendorID,'A-') eq true"),
    "startswith(VendorID,'A-')"
  );
});

test("endswith: strips 'eq true'", () => {
  assert.equal(
    normalizeODataFilter("endswith(InventoryID,'TRACE-G') eq true"),
    "endswith(InventoryID,'TRACE-G')"
  );
});

test("compound filter: only the function comparison is rewritten", () => {
  assert.equal(
    normalizeODataFilter("substringof('x', Description) eq true and Status eq 'Open'"),
    "substringof('x', Description) and Status eq 'Open'"
  );
});

test("eq false: left verbatim (Acumatica 500s on `not substringof(...)`)", () => {
  // We intentionally do NOT rewrite `eq false` — the only equivalent negation
  // (`not startswith(...)`) is rejected by Acumatica's contract API with a 500.
  assert.equal(
    normalizeODataFilter("startswith(CustomerName,'LEN') eq false"),
    "startswith(CustomerName,'LEN') eq false"
  );
});

test("case-insensitive: EQ TRUE is also stripped", () => {
  assert.equal(
    normalizeODataFilter("substringof('x', F) EQ TRUE"),
    "substringof('x', F)"
  );
});

test("bare boolean function is left unchanged", () => {
  assert.equal(
    normalizeODataFilter("substringof('TRACER', Description)"),
    "substringof('TRACER', Description)"
  );
});

test("a plain boolean field comparison is NOT touched", () => {
  // No preceding substringof/startswith/endswith — must survive verbatim.
  assert.equal(
    normalizeODataFilter("IsActive eq true and Balance gt 100"),
    "IsActive eq true and Balance gt 100"
  );
});

test("undefined / empty pass through unchanged", () => {
  assert.equal(normalizeODataFilter(undefined), undefined);
  assert.equal(normalizeODataFilter(""), "");
});
