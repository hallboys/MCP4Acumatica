// Copyright 2026 Hall Boys, Inc.
// SPDX-License-Identifier: Apache-2.0

// Guards the authenticated preflight verdicts.
//
// Run with:  node --test --experimental-strip-types test/preflight-authed.test.ts

import { test } from "node:test";
import assert from "node:assert";
import { interpretTenantAuthed, interpretEndpointAuthed } from "../src/lib/preflight.ts";

// ── Authenticated tenant / endpoint checks ───────────────────────
//
// These exist because the UNauthenticated checks cannot decide: Acumatica 401s
// every path, so a bogus tenant and a bogus endpoint version both returned 401
// and were reported as `pass` (verified live on 25R2). With a real token a 404
// finally means "does not exist", which is the only way preflight can catch a
// typo'd ACUMATICA_TENANT / ACUMATICA_ENDPOINT_VERSION.

test("authenticated tenant: 200 confirms it, 404 is a hard fail", () => {
  const ok = interpretTenantAuthed(200, "Production");
  assert.equal(ok.status, "pass");
  assert.match(ok.headline, /"Production" confirmed/);

  const bad = interpretTenantAuthed(404, "Typo");
  assert.equal(bad.status, "fail");
  assert.match(bad.headline, /does not exist/);
  assert.match(bad.detail, /case-sensitive/);
  // Explains why the unauthenticated row can't see this.
  assert.match(bad.detail, /401s a bad tenant/);
});

test("authenticated tenant: 403 still proves the tenant is real", () => {
  const r = interpretTenantAuthed(403, "Production");
  assert.equal(r.status, "warn");
  assert.notEqual(r.status, "fail");
  assert.match(r.detail, /the tenant is real/i);
});

test("authenticated tenant: 401 means expired token, not a bad tenant", () => {
  const r = interpretTenantAuthed(401, "Production");
  assert.equal(r.status, "warn");
  assert.match(r.detail, /expired/i);
});

test("authenticated endpoint: 200 confirms, 404 fails and names both vars", () => {
  const ok = interpretEndpointAuthed(200, "Default", "25.200.001");
  assert.equal(ok.status, "pass");
  assert.match(ok.detail, /ACUMATICA_ENDPOINT_NAME/);
  assert.match(ok.detail, /ACUMATICA_ENDPOINT_VERSION/);

  const bad = interpretEndpointAuthed(404, "Default", "99.999.999");
  assert.equal(bad.status, "fail");
  assert.match(bad.headline, /"Default\/99\.999\.999" does not exist/);
  assert.match(bad.detail, /SM207060/);
  assert.match(bad.detail, /401s a bogus version/);
});

test("authenticated checks never turn a 404 into a pass", () => {
  assert.notEqual(interpretTenantAuthed(404, "X").status, "pass");
  assert.notEqual(interpretEndpointAuthed(404, "Default", "1.0").status, "pass");
});

test("only 200 yields a pass for either authenticated check", () => {
  for (const s of [401, 403, 404, 500, 302]) {
    assert.notEqual(interpretTenantAuthed(s, "X").status, "pass", `tenant ${s}`);
    assert.notEqual(interpretEndpointAuthed(s, "Default", "1.0").status, "pass", `endpoint ${s}`);
  }
});
