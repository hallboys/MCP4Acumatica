// Copyright 2026 Hall Boys, Inc.
// SPDX-License-Identifier: Apache-2.0

// Guards the GI opt-in gate decision and GI row cleaning.
//
// Run with:  node --test --experimental-strip-types test/gi-registry.test.ts

import { test } from "node:test";
import assert from "node:assert";
import {
  checkGiGate,
  EXCLUDED_GI_NAMES,
  parameterizedGiNames,
  parseEdmxTypes,
  edmTypeToSimple,
  assembleRegistry,
  type GiRegistry,
} from "../src/lib/gi-registry.ts";
import { cleanGiRow, cleanGiRows } from "../src/lib/gi-rows.ts";

const registry: GiRegistry = {
  builtAt: "2026-06-20T00:00:00Z",
  gis: [
    { giName: "InventoryUsageMCP" },
    { giName: "HPL Material Adjustments MCP" },
  ],
};

test("gate inactive (no registry): any GI allowed, flagged inactive", () => {
  const d = checkGiGate(null, "AnythingGoes");
  assert.equal(d.allowed, true);
  assert.equal(d.allowed === true && d.inactive, true);
});

test("gate inactive still denies feed/canary GIs", () => {
  for (const name of EXCLUDED_GI_NAMES) {
    const d = checkGiGate(null, name);
    assert.equal(d.allowed, false, name);
  }
});

test("gate active: listed GI allowed, returns its entry", () => {
  const d = checkGiGate(registry, "InventoryUsageMCP");
  assert.equal(d.allowed, true);
  assert.equal(d.allowed === true && d.inactive, false);
  assert.equal(d.allowed === true && d.entry?.giName, "InventoryUsageMCP");
});

test("gate active: GI with spaces in name matches", () => {
  assert.equal(checkGiGate(registry, "HPL Material Adjustments MCP").allowed, true);
});

test("gate active: unlisted GI denied with actionable reason", () => {
  const d = checkGiGate(registry, "SomeOtherGI");
  assert.equal(d.allowed, false);
  assert.match(d.allowed === false ? d.reason : "", /ExposedtoMCP/);
});

test("gate active: empty registry denies everything (fail closed)", () => {
  const empty: GiRegistry = { builtAt: "x", gis: [] };
  assert.equal(checkGiGate(empty, "InventoryUsageMCP").allowed, false);
});

test("gate active: feed/canary denied even if somehow listed", () => {
  const sneaky: GiRegistry = { builtAt: "x", gis: [{ giName: "MCPGIs" }] };
  assert.equal(checkGiGate(sneaky, "MCPGIs").allowed, false);
});

test("gate trims the incoming name before matching", () => {
  assert.equal(checkGiGate(registry, "  InventoryUsageMCP  ").allowed, true);
});

test("cleanGiRow trims space-padded keys and drops @odata fields", () => {
  const cleaned = cleanGiRow({
    "@odata.etag": "W/123",
    WarehouseID: "GARES     ",
    InventoryID: "1212WHTACCESS                 ",
    Quantity: 3,
    GAStockedItem: true,
    Date: "2024-02-01T00:00:00Z",
    ReasonCode: null,
  });
  assert.deepEqual(cleaned, {
    WarehouseID: "GARES",
    InventoryID: "1212WHTACCESS",
    Quantity: 3,
    GAStockedItem: true,
    Date: "2024-02-01T00:00:00Z",
    ReasonCode: null,
  });
});

test("cleanGiRow leaves non-string values untouched (no type coercion)", () => {
  const cleaned = cleanGiRow({ n: 0, b: false, z: null });
  assert.strictEqual(cleaned.n, 0);
  assert.strictEqual(cleaned.b, false);
  assert.strictEqual(cleaned.z, null);
});

test("cleanGiRows maps every row", () => {
  const out = cleanGiRows([{ A: "x  " }, { A: "  y" }]);
  assert.deepEqual(out, [{ A: "x" }, { A: "y" }]);
});

// ── EDMX parsing + registry assembly ──────────────────────────────────────

test("edmTypeToSimple maps the Edm vocabulary", () => {
  assert.equal(edmTypeToSimple("Edm.Decimal"), "decimal");
  assert.equal(edmTypeToSimple("Edm.Double"), "decimal");
  assert.equal(edmTypeToSimple("Edm.Int32"), "integer");
  assert.equal(edmTypeToSimple("Edm.Boolean"), "boolean");
  assert.equal(edmTypeToSimple("Edm.DateTimeOffset"), "datetime");
  assert.equal(edmTypeToSimple("Edm.String"), "string");
  assert.equal(edmTypeToSimple("Edm.Guid"), "guid");
});

test("parseEdmxTypes extracts ordered props + types keyed by normalized name", () => {
  const xml = `
    <EntityType Name="InventoryUsageMCP">
      <Property Name="InventoryID" Type="Edm.String" Nullable="true"/>
      <Property Name="Quantity" Type="Edm.Decimal" Nullable="true"/>
    </EntityType>`;
  const parsed = parseEdmxTypes(xml);
  const e = parsed.get("inventoryusagemcp");
  assert.ok(e);
  assert.deepEqual(e!.order, ["InventoryID", "Quantity"]);
  assert.equal(e!.types.get("Quantity"), "Edm.Decimal");
});

// Acceptance: collision case (InventoryID/_2, Warehouse/_2), Usr-strip of a
// captionless custom field, and Path-A decimal typing of a whole-number qty.
const EDMX = `
  <EntityType Name="InventoryUsageMCP">
    <Property Name="InventoryID" Type="Edm.String"/>
    <Property Name="Quantity" Type="Edm.Decimal"/>
    <Property Name="InventoryID_2" Type="Edm.String"/>
    <Property Name="AIDescription" Type="Edm.String"/>
  </EntityType>`;

test("assembleRegistry: $metadata wins, collisions resolve by LineNbr order, Usr-strip + decimal typing", () => {
  const reg = assembleRegistry({
    giRows: [
      { Name: "InventoryUsageMCP", AIDescription: "usage by item" },
      { Name: "MCPGIs" }, // feed GI must be dropped
    ],
    fieldRows: [
      { Name: "InventoryUsageMCP", SchemaField: "inventoryID", Caption: "Inventory ID", AIDescription: "primary item", LineNbr: 1 },
      { Name: "InventoryUsageMCP", SchemaField: "qty", Caption: "Quantity", AIDescription: "qty used", LineNbr: 2 },
      { Name: "InventoryUsageMCP", SchemaField: "inventoryID", Caption: "Inventory ID", AIDescription: "component item", LineNbr: 3 },
      { Name: "InventoryUsageMCP", SchemaField: "UsrAIDescription", AIDescription: "the AI note", LineNbr: 4 },
    ],
    edmxTypes: parseEdmxTypes(EDMX),
    builtAt: "2026-06-20T00:00:00Z",
    endpointVersion: "25.200.001",
  });

  assert.equal(reg.gis.length, 1, "feed GI dropped");
  const gi = reg.gis[0];
  assert.equal(gi.giName, "InventoryUsageMCP");
  assert.equal(gi.description, "usage by item");

  const f = Object.fromEntries((gi.fields ?? []).map((x) => [x.name, x]));
  // Authoritative names + order from $metadata.
  assert.deepEqual((gi.fields ?? []).map((x) => x.name), ["InventoryID", "Quantity", "InventoryID_2", "AIDescription"]);
  // Path A: whole-number quantity is decimal, not integer.
  assert.equal(f.Quantity.type, "decimal");
  // Collision descriptions line up in LineNbr order.
  assert.equal(f.InventoryID.description, "primary item");
  assert.equal(f.InventoryID_2.description, "component item");
  // Captionless Usr-field resolves to AIDescription.
  assert.equal(f.AIDescription.description, "the AI note");
});

test("assembleRegistry: no EDMX for a GI → fields fall back to feed rows, no declared types", () => {
  const reg = assembleRegistry({
    giRows: [{ Name: "SomeGI" }],
    fieldRows: [
      { Name: "SomeGI", SchemaField: "acctName", Caption: "Account Name", AIDescription: "the name", LineNbr: 1 },
    ],
    edmxTypes: new Map(),
    builtAt: "2026-06-20T00:00:00Z",
  });
  const gi = reg.gis[0];
  assert.equal(gi.fields?.[0].name, "AccountName");
  assert.equal(gi.fields?.[0].type, undefined);
  assert.equal(gi.fields?.[0].description, "the name");
});

// ── Parameterized-GI detection (run_inquiry guard + discovery exclusion) ──

test("parameterizedGiNames extracts {Name}_WithParameters function imports", () => {
  const xml = `
    <EntityContainer Name="Default">
      <EntitySet Name="OpenSalesByCustomer" EntityType="x"/>
      <FunctionImport Name="OpenSalesByCustomer_WithParameters" ReturnType="y"/>
      <FunctionImport Name="ARAgedByCustomer_WithParameters"/>
    </EntityContainer>`;
  const names = parameterizedGiNames(xml);
  assert.ok(names.has("OpenSalesByCustomer"));
  assert.ok(names.has("ARAgedByCustomer"));
  assert.equal(names.has("SomeParameterFreeGI"), false);
});

test("parameterizedGiNames returns empty set for empty/absent metadata", () => {
  assert.equal(parameterizedGiNames("").size, 0);
  assert.equal(parameterizedGiNames("<edmx:Edmx/>").size, 0);
});
