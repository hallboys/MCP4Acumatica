// Copyright 2026 Hall Boys, Inc.
// SPDX-License-Identifier: Apache-2.0

// Guards parseAcumaticaJson — the fix for `Unexpected end of JSON input`
// reaching the model verbatim (279 occurrences over 95 days of production logs,
// ~14% of current tool errors, almost all from acumatica_run_inquiry).
//
// The load-bearing behaviors, in order of how much damage getting them wrong
// would do:
//   1. An empty body must NOT become "no matching records" (silent wrong data).
//   2. An empty body on a WRITE must NOT advise retrying (duplicate create).
//   3. A non-JSON body must be diagnosable, not an opaque parser message.
//
// Run with:  node --test --experimental-strip-types test/response-parse.test.ts

import { test } from "node:test";
import assert from "node:assert";
import { parseAcumaticaJson } from "../src/lib/response-parse.ts";

test("valid JSON is returned as data", () => {
  const r = parseAcumaticaJson<{ value: number[] }>(200, '{"value":[1,2]}', "GET odata/gi/X");
  assert.equal(r.ok, true);
  assert.deepEqual(r.ok && r.data, { value: [1, 2] });
});

test("a legitimately empty OData result set still parses (not confused with an empty body)", () => {
  const r = parseAcumaticaJson<{ value: unknown[] }>(200, '{"value":[]}', "GET odata/gi/X");
  assert.equal(r.ok, true);
  assert.deepEqual(r.ok && r.data, { value: [] });
});

test("JSON literals other than objects are accepted", () => {
  for (const body of ["[]", "0", "false", '""', "null"]) {
    assert.equal(parseAcumaticaJson(200, body, "ctx").ok, true, body);
  }
});

// ── Empty body: reads ────────────────────────────────────────────

test("empty body on a read fails, and explicitly denies 'no records exist'", () => {
  const r = parseAcumaticaJson(200, "", "GET odata/gi/MyInquiry");
  assert.equal(r.ok, false);
  if (r.ok) return;
  // The whole point: the model must not translate this into "nothing matched".
  assert.match(r.message, /NOT the same as "no matching records"/);
  assert.match(r.message, /do not report to the user\s+that no records exist/);
  assert.match(r.message, /GET odata\/gi\/MyInquiry/);
  assert.match(r.message, /HTTP 200/);
});

test("whitespace-only body is treated as empty", () => {
  for (const body of [" ", "\n", "\r\n\t "]) {
    const r = parseAcumaticaJson(200, body, "ctx");
    assert.equal(r.ok, false, JSON.stringify(body));
    assert.match((r as { message: string }).message, /empty response body/);
  }
});

test("the status code is carried through, not hardcoded to 200", () => {
  const r = parseAcumaticaJson(204, "", "ctx");
  assert.equal(r.ok, false);
  assert.match((r as { message: string }).message, /HTTP 204/);
});

// ── Empty body: writes ───────────────────────────────────────────

test("empty body on a WRITE forbids retrying, to avoid a duplicate create", () => {
  const r = parseAcumaticaJson(200, "", "PUT Customer", "write");
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.match(r.message, /DO NOT RETRY THIS WRITE/);
  assert.match(r.message, /duplicate/i);
  assert.match(r.message, /auto-numbered/);
  // Must say the outcome is genuinely unknown, and point at verification.
  assert.match(r.message, /may or may not have been applied/);
  assert.match(r.message, /verify the record directly in Acumatica/);
});

test("the write path never reuses the read advice to retry", () => {
  const read = parseAcumaticaJson(200, "", "GET X", "read");
  const write = parseAcumaticaJson(200, "", "PUT X", "write");
  assert.match((read as { message: string }).message, /Retry once/);
  assert.doesNotMatch((write as { message: string }).message, /Retry once/);
});

test("kind defaults to read, so an un-annotated call never gets write advice", () => {
  const r = parseAcumaticaJson(200, "", "GET X");
  assert.doesNotMatch((r as { message: string }).message, /DO NOT RETRY/);
});

// ── Non-JSON body ────────────────────────────────────────────────

test("non-JSON body reports the cause and a snippet instead of a parser error", () => {
  const html = "<!DOCTYPE html><html><head><title>Sign In</title></head><body>Login</body></html>";
  const r = parseAcumaticaJson(200, html, "GET odata/gi/X");
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.match(r.message, /not\s+valid JSON/);
  assert.match(r.message, /sign-in page/i);
  assert.match(r.message, /Sign In/);
  // Must not leak the raw V8 message that started all this.
  assert.doesNotMatch(r.message, /Unexpected end of JSON input/);
});

test("a long non-JSON body is truncated rather than echoed whole", () => {
  const r = parseAcumaticaJson(200, "x".repeat(5000), "ctx");
  assert.equal(r.ok, false);
  const msg = (r as { message: string }).message;
  assert.match(msg, /truncated/);
  assert.ok(msg.length < 600, `message should stay short, was ${msg.length}`);
});

test("whitespace in a non-JSON body is collapsed in the snippet", () => {
  const r = parseAcumaticaJson(200, "<html>\n\n   <body>\t\tbad</body>\n</html>", "ctx");
  const msg = (r as { message: string }).message;
  assert.doesNotMatch(msg, /\n/);
  assert.doesNotMatch(msg, /\t/);
});

test("truncated JSON — the exact shape that produced the original error — is handled", () => {
  const r = parseAcumaticaJson(200, '{"value":[{"Foo":', "GET odata/gi/X");
  assert.equal(r.ok, false);
  assert.match((r as { message: string }).message, /not\s+valid JSON/);
  assert.doesNotMatch((r as { message: string }).message, /Unexpected end of JSON input/);
});
