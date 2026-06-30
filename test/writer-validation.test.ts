// Copyright 2026 Hall Boys, Inc.
// SPDX-License-Identifier: Apache-2.0

// Tests for validateWriterPayload in src/tools/writer-validation.ts.
// Pure function with no imports, runs cleanly under
// `node --test --experimental-strip-types`.
//
// Run with:  node --test --experimental-strip-types test/writer-validation.test.ts

import { test } from "node:test";
import assert from "node:assert";
import { validateWriterPayload } from "../src/tools/writer-validation.ts";

const ALLOWED: readonly string[] = ["CustomerName", "CustomerClass", "Status", "Email", "Phone1", "MainContact"];
const MAX = 8_000;

// ── Happy path ────────────────────────────────────────────────────────────────

test("valid payload with a subset of allowed fields returns ok", () => {
  const result = validateWriterPayload(
    JSON.stringify({ CustomerName: "Acme", Status: "Active" }),
    ALLOWED,
    MAX
  );
  assert.ok(result.ok);
  if (result.ok) {
    assert.strictEqual(result.data.CustomerName, "Acme");
    assert.strictEqual(result.data.Status, "Active");
  }
});

test("valid payload with all allowed fields returns ok", () => {
  const payload = { CustomerName: "X", CustomerClass: "DEFAULT", Status: "Active", Email: "a@b.com", Phone1: "555", MainContact: {} };
  const result = validateWriterPayload(JSON.stringify(payload), ALLOWED, MAX);
  assert.ok(result.ok);
});

test("empty object payload is valid (no required fields at this layer)", () => {
  const result = validateWriterPayload("{}", ALLOWED, MAX);
  assert.ok(result.ok);
  if (result.ok) assert.deepStrictEqual(result.data, {});
});

// ── Size cap ──────────────────────────────────────────────────────────────────

test("payload at exactly maxChars is accepted", () => {
  // Build a string that is exactly maxChars long
  const base = '{"CustomerName":"';
  const padding = "A".repeat(MAX - base.length - 2); // 2 for closing `"}`
  const payload = base + padding + '"}';
  assert.strictEqual(payload.length, MAX);
  const result = validateWriterPayload(payload, ALLOWED, MAX);
  assert.ok(result.ok);
});

test("payload one char over maxChars is rejected", () => {
  const base = '{"CustomerName":"';
  const padding = "A".repeat(MAX - base.length - 2 + 1);
  const payload = base + padding + '"}';
  assert.strictEqual(payload.length, MAX + 1);
  const result = validateWriterPayload(payload, ALLOWED, MAX);
  assert.ok(!result.ok);
  if (!result.ok) assert.match(result.error, /too long/);
});

// ── JSON parse errors ─────────────────────────────────────────────────────────

test("malformed JSON is rejected with a clear error", () => {
  const result = validateWriterPayload("{not valid json}", ALLOWED, MAX);
  assert.ok(!result.ok);
  if (!result.ok) assert.match(result.error, /valid JSON/);
});

test("empty string is rejected (not valid JSON)", () => {
  const result = validateWriterPayload("", ALLOWED, MAX);
  assert.ok(!result.ok);
  if (!result.ok) assert.match(result.error, /valid JSON/);
});

// ── Type check ────────────────────────────────────────────────────────────────

test("JSON array is rejected", () => {
  const result = validateWriterPayload('[{"CustomerName":"Acme"}]', ALLOWED, MAX);
  assert.ok(!result.ok);
  if (!result.ok) assert.match(result.error, /JSON object/);
});

test("JSON string primitive is rejected", () => {
  const result = validateWriterPayload('"hello"', ALLOWED, MAX);
  assert.ok(!result.ok);
  if (!result.ok) assert.match(result.error, /JSON object/);
});

test("JSON number is rejected", () => {
  const result = validateWriterPayload("42", ALLOWED, MAX);
  assert.ok(!result.ok);
  if (!result.ok) assert.match(result.error, /JSON object/);
});

test("JSON null is rejected", () => {
  const result = validateWriterPayload("null", ALLOWED, MAX);
  assert.ok(!result.ok);
  if (!result.ok) assert.match(result.error, /JSON object/);
});

// ── Field allowlist ───────────────────────────────────────────────────────────

test("unknown field is rejected", () => {
  const result = validateWriterPayload(
    JSON.stringify({ CustomerName: "Acme", Salary: 999999 }),
    ALLOWED,
    MAX
  );
  assert.ok(!result.ok);
  if (!result.ok) {
    assert.match(result.error, /disallowed/);
    assert.match(result.error, /Salary/);
  }
});

test("multiple unknown fields are all named in the error", () => {
  const result = validateWriterPayload(
    JSON.stringify({ CustomerName: "Acme", Salary: 1, SSN: "123" }),
    ALLOWED,
    MAX
  );
  assert.ok(!result.ok);
  if (!result.ok) {
    assert.match(result.error, /Salary/);
    assert.match(result.error, /SSN/);
  }
});

test("field name that is a prefix of an allowed name is still rejected", () => {
  // "Customer" is not in the allowlist even though "CustomerName" is
  const result = validateWriterPayload(
    JSON.stringify({ Customer: "Acme" }),
    ALLOWED,
    MAX
  );
  assert.ok(!result.ok);
  if (!result.ok) assert.match(result.error, /Customer/);
});

test("mixed allowed + disallowed fields: disallowed fields are rejected", () => {
  const result = validateWriterPayload(
    JSON.stringify({ CustomerName: "Acme", __proto__: "bad", constructor: "bad" }),
    ALLOWED,
    MAX
  );
  assert.ok(!result.ok);
  if (!result.ok) assert.match(result.error, /disallowed/);
});
