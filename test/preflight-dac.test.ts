// Copyright 2026 Hall Boys, Inc.
// SPDX-License-Identifier: Apache-2.0

// Guards interpretDacProbe — the verdict logic behind the authenticated
// DAC-OData probe in the admin console. The two-request design exists so
// "endpoint absent" (root 404) is never confused with "entity name wrong"
// (root 200 + entity 404); these tests pin that distinction, since collapsing
// it would silently report a usable endpoint as missing.
//
// Run with:  node --test --experimental-strip-types test/preflight-dac.test.ts

import { test } from "node:test";
import assert from "node:assert";
import { interpretDacProbe, DAC_PROBE_ENTITY } from "../src/lib/preflight.ts";

test("root 404 → endpoint absent, reported as skip (not a failure)", () => {
  const r = interpretDacProbe(404, null);
  assert.equal(r.status, "skip");
  assert.match(r.headline, /Not available/i);
  assert.match(r.detail, /2025 R1/);
  // Absence must not read as breakage — nothing depends on this endpoint.
  assert.match(r.detail, /Nothing is broken/i);
});

test("root 403 → elevated-role requirement confirmed, and called unusable here", () => {
  const r = interpretDacProbe(403, null);
  assert.equal(r.status, "warn");
  assert.match(r.detail, /OData v4 User/);
  // The whole point: this outcome kills it for a per-user access model.
  assert.match(r.detail, /each user's own Acumatica role/);
});

test("root 401 → inconclusive, points at token expiry first", () => {
  const r = interpretDacProbe(401, null);
  assert.equal(r.status, "warn");
  assert.match(r.headline, /inconclusive/i);
  assert.match(r.detail, /expired/i);
});

test("root 200 + entity 200 → pass, with the redaction caveat attached", () => {
  const r = interpretDacProbe(200, 200);
  assert.equal(r.status, "pass");
  assert.match(r.headline, /normal user role suffices/i);
  assert.match(r.detail, new RegExp(DAC_PROBE_ENTITY.replace(/\./g, "\\.")));
  // A green verdict must not imply "safe to ship" — redaction is name-matched.
  assert.match(r.detail, /redact\.ts/);
});

test("root 200 + entity 404 → endpoint EXISTS; naming differs (not reported as absent)", () => {
  const r = interpretDacProbe(200, 404);
  assert.notEqual(r.status, "skip");
  assert.match(r.detail, /endpoint itself is available/i);
  assert.match(r.detail, /\$metadata/);
});

test("root 200 + entity 403 → per-DAC rights enforced, distinct from a root 403", () => {
  const r = interpretDacProbe(200, 403);
  assert.equal(r.status, "warn");
  assert.match(r.detail, /Per-DAC access rights/i);
  // Must NOT be conflated with the elevated-role verdict.
  assert.doesNotMatch(r.detail, /OData v4 User/);
});

test("unexpected root status → warn, never a false pass", () => {
  for (const status of [500, 502, 503, 302]) {
    const r = interpretDacProbe(status, null);
    assert.equal(r.status, "warn", `root ${status}`);
    assert.match(r.headline, new RegExp(String(status)));
  }
});

test("unexpected entity status → warn, and still credits the endpoint as existing", () => {
  const r = interpretDacProbe(200, 500);
  assert.equal(r.status, "warn");
  assert.match(r.detail, /endpoint exists/i);
});

test("only root 200 + entity 200 ever yields a pass", () => {
  const combos: Array<[number, number | null]> = [
    [404, null], [403, null], [401, null], [500, null],
    [200, 403], [200, 404], [200, 401], [200, 500],
  ];
  for (const [root, entity] of combos) {
    assert.notEqual(
      interpretDacProbe(root, entity).status,
      "pass",
      `root=${root} entity=${entity} must not pass`
    );
  }
  assert.equal(interpretDacProbe(200, 200).status, "pass");
});
