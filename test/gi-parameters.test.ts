// Copyright 2026 Hall Boys, Inc.
// SPDX-License-Identifier: Apache-2.0

// Guards parameterized-GI handling: $metadata parsing, the pre-flight checks
// that stand in for Acumatica's silent behaviors (a misspelled parameter name
// is ignored and returns unfiltered rows), and the aliased function URL.
//
// Run with:  node --test --experimental-strip-types test/gi-parameters.test.ts

import { test } from "node:test";
import assert from "node:assert";
import {
  parseEdmxFunctions,
  enrichParams,
  overlayParams,
  formatODataLiteral,
  validateGiParameters,
  findGiFunction,
  resolveGiRouting,
  planGiRequest,
  hasParameterValues,
  type GiFunction,
} from "../src/lib/gi-parameters.ts";

const METADATA = `
<edmx:Edmx Version="4.0"><edmx:DataServices><Schema Namespace="GenericInquiry">
  <Function Name="DB-StorageDetails">
    <Parameter Name="Warehouse" Type="Edm.String" />
    <ReturnType Type="Collection(GenericInquiry.DBStorageDetails)" Nullable="false" />
  </Function>
  <Function Name="AR-Sales &amp; Returns">
    <Parameter Name="StartDate" Type="Edm.Date" Nullable="false" />
    <Parameter Name="FromStamp" Type="Edm.DateTimeOffset" />
    <Parameter Name="Paid" Type="Edm.Boolean" />
    <Parameter Name="Branch" Type="Edm.String" Nullable="false" />
    <ReturnType Type="Collection(GenericInquiry.ARSalesReturns)" Nullable="false" />
  </Function>
  <EntityContainer Name="Default">
    <EntitySet Name="DB-StorageDetails" EntityType="GenericInquiry.DBStorageDetails" />
    <FunctionImport Name="DBStorageDetails_WithParameters" Function="GenericInquiry.DB-StorageDetails" EntitySet="DB-StorageDetails" />
    <FunctionImport Name="ARSalesReturns_WithParameters" Function="GenericInquiry.AR-Sales &amp; Returns" EntitySet="AR-Sales  Returns" />
    <FunctionImport Name="Orphan_WithParameters" Function="GenericInquiry.Missing" EntitySet="Missing" />
  </EntityContainer>
</Schema></edmx:DataServices></edmx:Edmx>`;

const fns = parseEdmxFunctions(METADATA);
const sales = fns.get("AR-Sales & Returns")!;
const storage = fns.get("DB-StorageDetails")!;

test("parseEdmxFunctions maps FunctionImport → Function, decodes entities, reads Nullable", () => {
  assert.equal(fns.size, 3);
  assert.equal(fns.get("Missing")?.unparsed, true, "an import whose Function is missing is kept and flagged");
  assert.equal(storage.functionImport, "DBStorageDetails_WithParameters");
  assert.deepEqual(storage.params, [{ name: "Warehouse", edmType: "Edm.String", required: false }]);
  assert.equal(sales.giName, "AR-Sales & Returns");
  assert.deepEqual(
    sales.params.map((p) => [p.name, p.required]),
    [["StartDate", true], ["FromStamp", false], ["Paid", false], ["Branch", true]]
  );
});

test("parseEdmxFunctions on empty metadata", () => {
  assert.equal(parseEdmxFunctions("").size, 0);
});

test("enrichParams attaches labels/defaults by normalized name, active rows only", () => {
  const out = enrichParams(sales.params, [
    { Name: "AR-Sales & Returns", ParamName: "startdate", DisplayName: "Old", IsActive: false },
    { Name: "AR-Sales & Returns", ParamName: "StartDate", DisplayName: "Start Date", DefaultValue: "@QuarterStart", IsActive: true },
    { Name: "AR-Sales & Returns", ParamName: "Branch", DisplayName: "Branch", IsRequired: false },
  ]);
  assert.equal(out[0].displayName, "Start Date");
  assert.equal(out[0].defaultValue, "@QuarterStart");
  assert.equal(out[3].required, true, "$metadata stays authoritative on required-ness");
  assert.equal(out[1].displayName, undefined);
  const inactiveOnly = enrichParams(sales.params, [
    { Name: "x", ParamName: "Paid", DisplayName: "Old label", DefaultValue: "true", IsActive: false },
  ]);
  assert.equal(inactiveOnly[2].displayName, undefined, "an inactive row's label/default is not shown");
});

test("overlayParams keeps live metadata and adds cached labels", () => {
  const live = [{ name: "Warehouse", edmType: "Edm.String", required: true }];
  const out = overlayParams(live, [{ name: "warehouse", edmType: "Edm.Int32", required: false, displayName: "Warehouse" }]);
  assert.deepEqual(out, [{ name: "Warehouse", edmType: "Edm.String", required: true, displayName: "Warehouse" }]);
});

test("formatODataLiteral per type", () => {
  assert.deepEqual(formatODataLiteral("Edm.String", "O'Brien"), { ok: true, literal: "'O''Brien'" });
  assert.deepEqual(formatODataLiteral("Edm.String", 42), { ok: true, literal: "'42'" });
  assert.deepEqual(formatODataLiteral("Edm.Date", "2026-10-01"), { ok: true, literal: "2026-10-01" });
  assert.equal(formatODataLiteral("Edm.Date", "10/01/2026").ok, false);
  assert.deepEqual(formatODataLiteral("Edm.DateTimeOffset", "2026-10-01T00:00:00Z"), { ok: true, literal: "2026-10-01T00:00:00Z" });
  assert.deepEqual(
    formatODataLiteral("Edm.DateTimeOffset", "2026-10-01"),
    { ok: true, literal: "2026-10-01" },
    "25R2 declares GI date parameters as DateTimeOffset and accepts a plain date"
  );
  assert.equal(formatODataLiteral("Edm.DateTimeOffset", "2026-10-01T00:00").ok, false, "a time without an offset is ambiguous");
  assert.deepEqual(formatODataLiteral("Edm.Boolean", true), { ok: true, literal: "true" });
  assert.deepEqual(formatODataLiteral("Edm.Boolean", "FALSE"), { ok: true, literal: "false" });
  assert.equal(formatODataLiteral("Edm.Boolean", "yes").ok, false);
  assert.equal(formatODataLiteral("Edm.Date", "2026-13-45").ok, false, "shape alone is not enough");
  assert.equal(formatODataLiteral("Edm.Date", "2026-02-30").ok, false);
  assert.deepEqual(formatODataLiteral("Edm.Int32", "7"), { ok: true, literal: "7" });
  assert.equal(formatODataLiteral("Edm.Int32", "7.5").ok, false);
  assert.equal(formatODataLiteral("Edm.Int32", "").ok, false);
  assert.equal(formatODataLiteral("Edm.Int32", "0x1F").ok, false, "Number() would accept hex");
  assert.equal(formatODataLiteral("Edm.Int32", true).ok, false);
  assert.deepEqual(
    formatODataLiteral("Edm.Int64", "9007199254740993"),
    { ok: true, literal: "9007199254740993" },
    "passed through, not rounded past 2^53"
  );
  assert.deepEqual(formatODataLiteral("Edm.Decimal", 1.5), { ok: true, literal: "1.5" });
  assert.deepEqual(
    formatODataLiteral("Edm.Decimal", "12345678901234567.89"),
    { ok: true, literal: "12345678901234567.89" }
  );
  assert.equal(formatODataLiteral("Edm.Decimal", 1e21).ok, false, "no exponent notation");
  assert.equal(formatODataLiteral("Edm.Guid", "x").ok, false);
});

function errorCode(v: ReturnType<typeof validateGiParameters>): string | undefined {
  return v.ok ? undefined : (v.error.error as string);
}

test("absent parameters argument is refused, listing the parameters", () => {
  const v = validateGiParameters("DB-StorageDetails", storage, undefined);
  assert.equal(errorCode(v), "parameters_required");
  assert.ok(!v.ok && Array.isArray(v.error.parameters));
});

test("{} runs an all-optional GI at its defaults", () => {
  const v = validateGiParameters("DB-StorageDetails", storage, "{}");
  assert.ok(v.ok);
  assert.equal(v.ok && v.path, "DBStorageDetails_WithParameters()");
  assert.deepEqual(v.ok && v.defaulted.map((p) => p.name), ["Warehouse"]);
});

test("unknown (misspelled) parameter name is refused — Acumatica would ignore it", () => {
  assert.equal(errorCode(validateGiParameters("DB-StorageDetails", storage, '{"Warehose":"WHOLESALE"}')), "unknown_parameter");
});

test("names resolve case-insensitively to the canonical spelling", () => {
  const v = validateGiParameters("DB-StorageDetails", storage, '{"warehouse":"WHOLESALE"}');
  assert.ok(v.ok);
  assert.equal(v.ok && v.path, "DBStorageDetails_WithParameters(Warehouse=@p1)");
  assert.deepEqual(v.ok && v.aliases, { "@p1": "'WHOLESALE'" });
});

test("a blank optional value takes the default instead of becoming '' (which matches nothing)", () => {
  const v = validateGiParameters("DB-StorageDetails", storage, '{"Warehouse":" "}');
  assert.ok(v.ok);
  assert.equal(v.ok && v.path, "DBStorageDetails_WithParameters()");
  assert.deepEqual(v.ok && v.defaulted.map((p) => p.name), ["Warehouse"]);
});

test("missing, null or blank required parameters are refused", () => {
  const f: GiFunction = sales;
  assert.equal(errorCode(validateGiParameters("x", f, '{"StartDate":"2026-10-01"}')), "missing_required_parameters");
  assert.equal(errorCode(validateGiParameters("x", f, '{"StartDate":"2026-10-01","Branch":null}')), "missing_required_parameters");
  assert.equal(errorCode(validateGiParameters("x", f, '{"StartDate":"2026-10-01","Branch":"  "}')), "missing_required_parameters");
});

test("malformed arguments are refused", () => {
  assert.equal(errorCode(validateGiParameters("x", storage, "not json")), "invalid_parameters");
  assert.equal(errorCode(validateGiParameters("x", storage, "[1]")), "invalid_parameters");
  assert.equal(errorCode(validateGiParameters("x", storage, '{"Warehouse":["A"]}')), "invalid_parameters");
  assert.equal(errorCode(validateGiParameters("x", storage, '{"Warehouse":"A","warehouse":"B"}')), "invalid_parameters");
  assert.equal(errorCode(validateGiParameters("x", storage, '{"Warehouse":null,"warehouse":"B"}')), "invalid_parameters");
});

test("a value that does not fit its type is refused", () => {
  assert.equal(
    errorCode(validateGiParameters("x", sales, '{"StartDate":"Oct 1","Branch":"MAIN"}')),
    "invalid_parameter_value"
  );
});

test("full call: every value aliased in declaration order, optionals left out", () => {
  const v = validateGiParameters(
    "AR-Sales & Returns",
    sales,
    '{"Branch":"MAIN","StartDate":"2026-10-01","FromStamp":"2026-10-01T00:00:00Z"}'
  );
  assert.ok(v.ok);
  if (!v.ok) return;
  assert.equal(v.path, "ARSalesReturns_WithParameters(StartDate=@p1,FromStamp=@p2,Branch=@p3)");
  assert.deepEqual(v.aliases, { "@p1": "2026-10-01", "@p2": "2026-10-01T00:00:00Z", "@p3": "'MAIN'" });
  assert.deepEqual(v.defaulted.map((p) => p.name), ["Paid"]);
});

// ── Routing: fail closed whenever "parameter-free" is not certain ──

function code(r: { kind: string; error?: Record<string, unknown> }): string {
  return r.kind === "refuse" ? (r.error!.error as string) : r.kind;
}

test("findGiFunction: exact first, normalized only when unique", () => {
  assert.equal(findGiFunction(fns, "DB-StorageDetails"), storage);
  assert.equal(findGiFunction(fns, "DB StorageDetails"), storage, "entity-set spelling");
  assert.equal(findGiFunction(fns, "Unrelated"), undefined);
  const twins = parseEdmxFunctions(METADATA.replace(
    "</EntityContainer>",
    '<FunctionImport Name="DBStorageDetails2_WithParameters" Function="GenericInquiry.DB Storage Details" />' +
      '</EntityContainer>'
  ).replace("<EntityContainer", '<Function Name="DB Storage Details"><Parameter Name="X" Type="Edm.String" /></Function><EntityContainer'));
  const exact = findGiFunction(twins, "DB-StorageDetails");
  assert.equal(exact !== "ambiguous" && exact?.giName, "DB-StorageDetails", "exact wins over a twin");
  assert.equal(findGiFunction(twins, "dbstoragedetails"), "ambiguous");
});

test("resolveGiRouting fails closed", () => {
  assert.equal(code(resolveGiRouting(null, "Anything")), "metadata_unavailable", "no $metadata ≠ no parameters");
  assert.equal(code(resolveGiRouting(fns, "Missing")), "parameters_unreadable");
  assert.equal(
    code(resolveGiRouting(fns, "OpenSales", [{ name: "P", edmType: "Edm.String", required: true }])),
    "metadata_mismatch",
    "registry says parameterized, live $metadata disagrees"
  );
  for (const bad of ["X_WithParameters(Wrhs=@p1)", "../../entity/Default", "A?$top=1", "A#b", "A/B"]) {
    assert.equal(code(resolveGiRouting(fns, bad)), "unaddressable_inquiry_name", bad);
  }
  assert.equal(code(resolveGiRouting(fns, "Open Sales - Monthly")), "plain");
  assert.equal(code(resolveGiRouting(fns, "DB-StorageDetails")), "function");
});

test("hasParameterValues ignores {} however it is written", () => {
  assert.equal(hasParameterValues(undefined), false);
  assert.equal(hasParameterValues("  "), false);
  assert.equal(hasParameterValues("{ }"), false);
  assert.equal(hasParameterValues('{"a":1}'), true);
  assert.equal(hasParameterValues("oops"), true);
});

test("planGiRequest: plain GI passes through; parameters on it are refused", () => {
  assert.deepEqual(planGiRequest(fns, "Open Sales", undefined), { kind: "plain", path: "Open Sales" });
  assert.deepEqual(planGiRequest(fns, "Open Sales", "{ }"), { kind: "plain", path: "Open Sales" });
  assert.equal(code(planGiRequest(fns, "Open Sales", '{"a":"b"}')), "not_parameterized");
});

test("planGiRequest: parameterized GI is validated, overlaid, and routed to its function", () => {
  assert.equal(code(planGiRequest(fns, "DB-StorageDetails", undefined)), "parameters_required");
  const p = planGiRequest(fns, "DB-StorageDetails", '{"Warehouse":"WHOLESALE"}', [
    { name: "Warehouse", edmType: "Edm.String", required: false, displayName: "Warehouse", defaultValue: "MAIN" },
  ]);
  assert.equal(p.kind, "function");
  if (p.kind !== "function") return;
  assert.equal(p.path, "DBStorageDetails_WithParameters(Warehouse=@p1)");
  assert.equal(p.fn.params[0].defaultValue, "MAIN", "registry labels/defaults overlaid");
});

test("ACUMATICA_GI_PARAMETERS off: every parameterized GI is refused, plain GIs are not", () => {
  assert.equal(code(resolveGiRouting(fns, "DB-StorageDetails", undefined, false)), "parameterized_not_supported");
  assert.equal(
    code(planGiRequest(fns, "DB-StorageDetails", '{"Warehouse":"WHOLESALE"}', undefined, false)),
    "parameterized_not_supported",
    "valid parameters do not override the switch"
  );
  assert.equal(
    code(resolveGiRouting(fns, "Open Sales", [{ name: "P", edmType: "Edm.String", required: false }], false)),
    "parameterized_not_supported",
    "registry-known parameters are refused too"
  );
  assert.equal(code(resolveGiRouting(fns, "Open Sales", undefined, false)), "plain");
  assert.equal(code(resolveGiRouting(null, "Open Sales", undefined, false)), "metadata_unavailable", "still fails closed");
});
