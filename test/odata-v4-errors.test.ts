// Copyright 2026 Hall Boys, Inc.
// SPDX-License-Identifier: Apache-2.0

// Guards the OData v4 filter-error corrections for Generic Inquiries.
//
// Context: the GI endpoint is OData v4 while acumatica_list_entities is v3, but
// until 0.46.0 both tools carried identical v3 filter guidance — so every
// partial-match GI query was told to use substringof(), which does not exist
// there. July 2026 logs: 44 unknown-function, 43 unknown-property, 10 type
// mismatch, 2 bad literal = ~41% of all tool errors. These messages are the
// real ones observed in production (with values re-inserted).
//
// Run with:  node --test --experimental-strip-types test/odata-v4-errors.test.ts

import { test } from "node:test";
import assert from "node:assert";
import {
  classifyODataV4Error,
  buildODataV4Correction,
  V4_SUPPORTED_FUNCTIONS,
} from "../src/lib/odata-v4-errors.ts";

// ── classifyODataV4Error ─────────────────────────────────────────

test("classifies the real 'unknown function' message and extracts the name", () => {
  const msg =
    "Acumatica internal error: An unknown function with name 'substringof' was found. " +
    "This may also be a function import or a key lookup on a navigation property, which is not allowed.";
  assert.deepEqual(classifyODataV4Error(msg), { kind: "unknown_function", name: "substringof" });
});

test("classifies the real 'property not found' message with property and type", () => {
  const msg = "Acumatica internal error: Could not find a property named 'CustomerName' on type 'GI.Row'.";
  assert.deepEqual(classifyODataV4Error(msg), {
    kind: "unknown_property",
    property: "CustomerName",
    type: "GI.Row",
  });
});

test("classifies the real date-literal rejection", () => {
  const msg =
    "Acumatica internal error: Unrecognized 'Edm.String' literal 'datetimeoffset'2024-01-01'' at '13' " +
    "in 'CreatedOn gt datetimeoffset'2024-01-01''.";
  const r = classifyODataV4Error(msg);
  assert.equal(r?.kind, "unrecognized_literal");
});

test("classifies the type-mismatch message", () => {
  const msg =
    "Acumatica internal error: A binary operator with incompatible types was detected. " +
    "Found operand types 'Edm.String' and 'Edm.Decimal' for operator kind 'GreaterThan'.";
  assert.deepEqual(classifyODataV4Error(msg), { kind: "type_mismatch" });
});

test("returns null for unrelated errors so the original is preserved", () => {
  for (const msg of [
    "Acumatica internal error: An error has occurred.",
    "Record not found at Customer. Verify the ID is correct.",
    "Insufficient permissions. Check the API user's role configuration in Acumatica.",
    "",
  ]) {
    assert.equal(classifyODataV4Error(msg), null, msg.slice(0, 40));
  }
});

// ── buildODataV4Correction ───────────────────────────────────────

test("substringof correction names contains() AND the reversed argument order", () => {
  const c = buildODataV4Correction(
    { kind: "unknown_function", name: "substringof" },
    "orig",
    { inquiryName: "CS-ReasonCode", filterExpression: "substringof('BAD', Description)" }
  );
  assert.equal(c.error, "invalid_filter");
  assert.match(String(c.useInstead), /contains\(Field,'needle'\)/);
  // The argument order flips between dialects — the most likely second mistake.
  assert.match(String(c.useInstead), /reversed argument order/);
  assert.deepEqual(c.supportedFunctions, V4_SUPPORTED_FUNCTIONS);
  // Must never be read as "nothing matched" — the query never ran.
  assert.match(String(c.actionRequired), /never executed/);
});

test("every correction warns that the two tools are different dialects", () => {
  const kinds = [
    { kind: "unknown_function", name: "x" },
    { kind: "unknown_property", property: "p" },
    { kind: "unrecognized_literal", literal: "l" },
    { kind: "type_mismatch" },
  ] as const;
  for (const k of kinds) {
    const c = buildODataV4Correction(k, "orig", { inquiryName: "GI" });
    assert.match(String(c.dialect), /OData v4/, k.kind);
    assert.match(String(c.dialect), /list_entities/, k.kind);
    assert.match(String(c.actionRequired), /never executed/, k.kind);
  }
});

test("unknown-property correction hands over the real field names when known", () => {
  const c = buildODataV4Correction(
    { kind: "unknown_property", property: "CustomerName", type: "GI.Row" },
    "orig",
    { inquiryName: "CS-ReasonCode", availableFields: ["ReasonCode", "Description", "Usage"] }
  );
  assert.deepEqual(c.availableFields, ["ReasonCode", "Description", "Usage"]);
  assert.match(String(c.actionRequired), /availableFields/);
  // Explains WHY the guess failed, so the model generalizes.
  assert.match(String(c.problem), /RESULT-COLUMN CAPTIONS/);
});

test("unknown-property correction falls back to describe_inquiry with no field list", () => {
  const c = buildODataV4Correction(
    { kind: "unknown_property", property: "Nope" },
    "orig",
    { inquiryName: "CS-ReasonCode" }
  );
  assert.equal(c.availableFields, undefined);
  assert.match(String(c.actionRequired), /acumatica_describe_inquiry/);
  assert.match(String(c.actionRequired), /CS-ReasonCode/);
});

test("literal correction gives the bare ISO form and names the v3 form as wrong", () => {
  const c = buildODataV4Correction(
    { kind: "unrecognized_literal", literal: "datetimeoffset'2024-01-01'" },
    "orig",
    { inquiryName: "GI" }
  );
  assert.match(String(c.useInstead), /2024-01-01T00:00:00Z/);
  assert.match(String(c.useInstead), /no datetimeoffset prefix/);
  assert.match(String(c.problem), /v3 syntax/);
});

test("type-mismatch correction points at describe_inquiry for the column type", () => {
  const c = buildODataV4Correction({ kind: "type_mismatch" }, "orig", { inquiryName: "MyGI" });
  assert.match(String(c.actionRequired), /acumatica_describe_inquiry/);
  assert.match(String(c.actionRequired), /MyGI/);
  assert.match(String(c.problem), /quoting a number/);
});

test("the original Acumatica message is always preserved for diagnosis", () => {
  const orig = "Acumatica internal error: An unknown function with name 'substringof' was found.";
  const c = buildODataV4Correction({ kind: "unknown_function", name: "substringof" }, orig, {
    inquiryName: "GI",
  });
  assert.equal(c.acumaticaMessage, orig);
});

test("an unknown function with no known substitute still lists what IS supported", () => {
  const c = buildODataV4Correction({ kind: "unknown_function", name: "wibble" }, "orig", {
    inquiryName: "GI",
  });
  assert.equal(c.useInstead, undefined);
  assert.deepEqual(c.supportedFunctions, V4_SUPPORTED_FUNCTIONS);
  assert.match(String(c.problem), /'wibble' is not a function/);
});

test("supported-function list advertises contains and tolower, never substringof", () => {
  const joined = V4_SUPPORTED_FUNCTIONS.join(" ");
  assert.match(joined, /contains\(/);
  assert.match(joined, /tolower\(/);
  assert.doesNotMatch(joined, /substringof/);
});
