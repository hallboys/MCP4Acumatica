// Copyright 2026 Hall Boys, Inc.
// SPDX-License-Identifier: Apache-2.0

// Guards the bulk-clear key matching for acumatica_clear_cache — in particular
// that target=gi sweeps the per-GI inferred sample caches (gi_schema:*), not
// just the three shared GI artifacts. Regression for the 2026-08-18 live
// finding: after a GI design change, clear_cache target=gi left a stale
// sampleRow (removed columns) alongside the fresh curated field list.
//
// Run with:  node --test --experimental-strip-types test/clear-cache-match.test.ts

import { test } from "node:test";
import assert from "node:assert";
import { BULK_TARGETS, matchesClearTarget } from "../src/tools/clear-cache-match.ts";

test("no target clears everything", () => {
  for (const key of ["gi_list", "schema:Customer", "gi_schema:PM-Projects", "anything"]) {
    assert.equal(matchesClearTarget(key), true, key);
  }
});

test("target=schemas matches only entity schemas", () => {
  assert.equal(matchesClearTarget("schema:Customer", "schemas"), true);
  assert.equal(matchesClearTarget("schema:SalesOrder", "schemas"), true);
  // Not the GI namespaces — 'schemas' is the entity-schema bulk target only.
  assert.equal(matchesClearTarget("gi_schema:PM-Projects", "schemas"), false);
  assert.equal(matchesClearTarget("gi_list", "schemas"), false);
  assert.equal(matchesClearTarget("gi_registry", "schemas"), false);
});

test("target=gi matches the shared GI artifacts", () => {
  assert.equal(matchesClearTarget("gi_list", "gi"), true);
  assert.equal(matchesClearTarget("gi_metadata", "gi"), true);
  assert.equal(matchesClearTarget("gi_registry", "gi"), true);
});

test("target=gi also matches per-GI inferred sample caches (gi_schema:*)", () => {
  assert.equal(matchesClearTarget("gi_schema:PM-Projects", "gi"), true);
  assert.equal(matchesClearTarget("gi_schema:SO-Invoice", "gi"), true);
  // GI names can contain spaces and colons don't recur, but be permissive:
  assert.equal(matchesClearTarget("gi_schema:AP-Bills and Adjustments", "gi"), true);
});

test("target=gi does not match entity schemas or unrelated keys", () => {
  assert.equal(matchesClearTarget("schema:Customer", "gi"), false);
  assert.equal(matchesClearTarget("gi_schemas", "gi"), false); // bare typo, not a namespace
  assert.equal(matchesClearTarget("gi_schemaX:Foo", "gi"), false);
});

test("unknown targets match nothing", () => {
  assert.equal(matchesClearTarget("gi_list", "everything"), false);
  assert.equal(matchesClearTarget("schema:Customer", "GI"), false); // case-sensitive
});

test("BULK_TARGETS lists exactly the two bulk targets", () => {
  assert.deepEqual([...BULK_TARGETS].sort(), ["gi", "schemas"]);
});
