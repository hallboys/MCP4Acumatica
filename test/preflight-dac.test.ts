// Copyright 2026 Hall Boys, Inc.
// SPDX-License-Identifier: Apache-2.0

// Guards the authenticated DAC-OData probe's pure parts:
//   - parseODataServiceDocument: entity-set names out of a service document
//   - pickProbeEntitySets: which sets to attempt, and why order matters
//   - interpretDacProbe: the verdict, incl. the absent-vs-unaddressable split
//
// The three-step design (root → discover names → read one) exists because
// entity naming is instance-dependent: Acumatica's docs show
// `PX.Objects.SO.SOOrder`, but that is the OData *type*, and a live 25R2
// instance 404s it while the service root returns 200. These tests pin the
// distinctions that made the earlier one-shot version inconclusive.
//
// Run with:  node --test --experimental-strip-types test/preflight-dac.test.ts

import { test } from "node:test";
import assert from "node:assert";
import {
  interpretDacProbe,
  parseODataServiceDocument,
  pickProbeEntitySets,
  DAC_PROBE_PREFERRED_SETS,
} from "../src/lib/preflight.ts";

// ── parseODataServiceDocument ────────────────────────────────────

test("parses entity-set names from a normal OData v4 service document", () => {
  const doc = JSON.stringify({
    "@odata.context": "https://x/t/T/api/odata/dac/$metadata",
    value: [
      { name: "SOOrder", kind: "EntitySet", url: "SOOrder" },
      { name: "Customer", kind: "EntitySet", url: "Customer" },
    ],
  });
  assert.deepEqual(parseODataServiceDocument(doc), ["SOOrder", "Customer"]);
});

test("treats a missing `kind` as an entity set (many implementations omit it)", () => {
  const doc = JSON.stringify({ value: [{ name: "SOOrder", url: "SOOrder" }] });
  assert.deepEqual(parseODataServiceDocument(doc), ["SOOrder"]);
});

test("skips non-EntitySet members (singletons, function imports)", () => {
  const doc = JSON.stringify({
    value: [
      { name: "SOOrder", kind: "EntitySet" },
      { name: "Me", kind: "Singleton" },
      { name: "DoThing", kind: "FunctionImport" },
    ],
  });
  assert.deepEqual(parseODataServiceDocument(doc), ["SOOrder"]);
});

test("tolerates malformed input rather than throwing", () => {
  for (const bad of ["", "not json", "null", "[]", "{}", '{"value":"nope"}', '{"value":[null,3,{}]}']) {
    assert.deepEqual(parseODataServiceDocument(bad), [], JSON.stringify(bad));
  }
});

// ── pickProbeEntitySets ──────────────────────────────────────────

test("prefers well-known business tables over document order", () => {
  const available = ["APSetup", "Customer", "ZZObscure", "SOOrder"];
  const picked = pickProbeEntitySets(available, 2);
  // Preference order comes from DAC_PROBE_PREFERRED_SETS, not the input order.
  assert.deepEqual(picked, ["SOOrder", "Customer"]);
});

test("matches preferred names case-insensitively, returning the instance's casing", () => {
  const picked = pickProbeEntitySets(["soorder", "other"], 1);
  assert.deepEqual(picked, ["soorder"]);
});

test("falls back to whatever the instance exposes when no preferred name is present", () => {
  const picked = pickProbeEntitySets(["Aaa", "Bbb", "Ccc"], 2);
  assert.deepEqual(picked, ["Aaa", "Bbb"]);
});

test("returns at most `limit` candidates, and [] for an empty document", () => {
  assert.equal(pickProbeEntitySets(DAC_PROBE_PREFERRED_SETS, 2).length, 2);
  assert.deepEqual(pickProbeEntitySets([], 3), []);
});

test("never returns duplicates even when a name repeats", () => {
  const picked = pickProbeEntitySets(["Customer", "Customer", "Customer"], 3);
  assert.deepEqual(picked, ["Customer"]);
});

// ── interpretDacProbe ────────────────────────────────────────────

test("root 404 → endpoint absent, reported as skip (not a failure)", () => {
  const r = interpretDacProbe(404, null);
  assert.equal(r.status, "skip");
  assert.match(r.headline, /Not available/i);
  assert.match(r.detail, /2025 R1/);
  // Absence must not read as breakage — nothing depends on this endpoint.
  assert.match(r.detail, /Nothing is broken/i);
});

test("root 403 → points at granting the OData v4 role, NOT at abandoning the endpoint", () => {
  const r = interpretDacProbe(403, null);
  assert.equal(r.status, "warn");
  assert.match(r.detail, /OData v4 role/);
  assert.match(r.detail, /grant it/i);
  // Requiring a role grant is a prerequisite like MCP Access, not a dead end.
  assert.match(r.detail, /not a disqualifier/i);
  assert.doesNotMatch(r.detail, /unusable/i);
  // The per-user access model survives, because rights still come from roles.
  assert.match(r.detail, /per-user access model is preserved/i);
});

test("root 401 → inconclusive, points at token expiry first", () => {
  const r = interpretDacProbe(401, null);
  assert.equal(r.status, "warn");
  assert.match(r.headline, /inconclusive/i);
  assert.match(r.detail, /expired/i);
});

test("root 200 with no readable entity list → available but unlistable, still not a pass", () => {
  const r = interpretDacProbe(200, null);
  assert.equal(r.status, "warn");
  assert.match(r.headline, /could not be listed/i);
  // Must still credit the endpoint as existing.
  assert.match(r.detail, /exists and is reachable/i);
});

test("root 200 + entity 200 → pass, but scoped to the tested user and caveated", () => {
  const r = interpretDacProbe(200, 200, "SOOrder");
  assert.equal(r.status, "pass");
  assert.match(r.detail, /"SOOrder"/);
  // Must NOT claim an ordinary role suffices: the tested user may be an
  // Administrator, who can carry the OData v4 role implicitly.
  assert.doesNotMatch(r.headline, /normal user role suffices/i);
  assert.match(r.headline, /the user you tested/i);
  assert.match(r.detail, /NON-ADMINISTRATOR/);
  assert.match(r.detail, /OData v4/);
  // Needing the role granted is a prerequisite, not a disqualifier.
  assert.match(r.detail, /not a blocker/i);
  // A green verdict must not imply "safe to ship".
  assert.match(r.detail, /redact\.ts/);
  assert.match(r.detail, /row-level security/i);
});

test("root 200 + entity 404 → endpoint EXISTS; naming unaddressable, not reported absent", () => {
  const r = interpretDacProbe(200, 404, "SOOrder");
  assert.notEqual(r.status, "skip");
  assert.match(r.detail, /endpoint itself is available/i);
  assert.match(r.detail, /\$metadata/);
});

test("root 200 + entity 403 → per-DAC rights, distinct from the root-403 verdict", () => {
  const r = interpretDacProbe(200, 403, "SOOrder");
  assert.equal(r.status, "warn");
  assert.match(r.detail, /Per-DAC access rights/i);
  // Must NOT be conflated with the elevated-role conclusion.
  assert.doesNotMatch(r.detail, /OData v4 User/);
});

test("unexpected root status → warn, never a false pass", () => {
  for (const status of [500, 502, 503, 302]) {
    const r = interpretDacProbe(status, null);
    assert.equal(r.status, "warn", `root ${status}`);
    assert.match(r.headline, new RegExp(String(status)));
  }
});

test("only root 200 + entity 200 ever yields a pass", () => {
  const combos: Array<[number, number | null]> = [
    [404, null], [403, null], [401, null], [500, null], [200, null],
    [200, 403], [200, 404], [200, 401], [200, 500], [200, 0],
  ];
  for (const [root, entity] of combos) {
    assert.notEqual(
      interpretDacProbe(root, entity, "X").status,
      "pass",
      `root=${root} entity=${entity} must not pass`
    );
  }
  assert.equal(interpretDacProbe(200, 200, "X").status, "pass");
});
