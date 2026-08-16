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
  expectedTypeFamily,
  typeConflicts,
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
      { Name: "InventoryUsageMCP", SchemaField: "inventoryID", Caption: "Inventory ID", AIDescription: "primary item", LineNbr: 1, IsActive: true },
      { Name: "InventoryUsageMCP", SchemaField: "qty", Caption: "Quantity", AIDescription: "qty used", LineNbr: 2, IsActive: true },
      { Name: "InventoryUsageMCP", SchemaField: "inventoryID", Caption: "Inventory ID", AIDescription: "component item", LineNbr: 3, IsActive: true },
      { Name: "InventoryUsageMCP", SchemaField: "UsrAIDescription", AIDescription: "the AI note", LineNbr: 4, IsActive: true },
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

// ── Positional column alignment ───────────────────────────────────────────
//
// Property names cannot be predicted from the design (a caption is only an
// override and is NULL for most columns; SchemaField is DAC-qualified where it
// exists at all), so design rows are joined to properties by position:
//   keys hoisted to the front ++ active rows in SortOrder order ++ trailing keys

/** Assemble one GI and return its resolved fields, keyed by property name. */
function fieldsOf(edmx: string, fieldRows: object[], giName = "GI") {
  const reg = assembleRegistry({
    giRows: [{ Name: giName }],
    fieldRows: fieldRows as never,
    edmxTypes: parseEdmxTypes(edmx),
    builtAt: "2026-08-15T00:00:00Z",
  });
  const fields = reg.gis[0].fields ?? [];
  return {
    names: fields.map((f) => f.name),
    byName: Object.fromEntries(fields.map((f) => [f.name, f])),
    annotated: fields.filter((f) => f.description || f.caption).length,
  };
}

test("alignment: columns follow SortOrder, not LineNbr", () => {
  // Design rows are numbered 1,2,3 but sit in the grid as 2,3,1. Aligning by
  // LineNbr would put the captioned row on "Status" and reject the whole GI.
  const { byName, annotated } = fieldsOf(
    `<EntityType Name="GI">
       <Property Name="Builder" Type="Edm.String"/>
       <Property Name="Status" Type="Edm.String"/>
       <Property Name="Amount" Type="Edm.Decimal"/>
     </EntityType>`,
    [
      { Name: "GI", LineNbr: 1, SortOrder: 3, IsActive: true, AIDescription: "the amount" },
      { Name: "GI", LineNbr: 2, SortOrder: 1, IsActive: true, AIDescription: "who built it" },
      { Name: "GI", LineNbr: 3, SortOrder: 2, IsActive: true, Caption: "Status", AIDescription: "current status" },
    ]
  );
  assert.equal(annotated, 3, "all three rows landed");
  assert.equal(byName.Builder.description, "who built it");
  assert.equal(byName.Status.description, "current status");
  assert.equal(byName.Amount.description, "the amount");
  assert.equal(byName.Amount.type, "decimal");
});

test("alignment: inactive design rows never consume a property slot", () => {
  const { byName, annotated } = fieldsOf(
    `<EntityType Name="GI">
       <Property Name="Builder" Type="Edm.String"/>
       <Property Name="Status" Type="Edm.String"/>
     </EntityType>`,
    [
      { Name: "GI", LineNbr: 1, SortOrder: 1, IsActive: true, AIDescription: "who built it" },
      { Name: "GI", LineNbr: 2, SortOrder: 2, IsActive: false, AIDescription: "hidden column" },
      { Name: "GI", LineNbr: 3, SortOrder: 3, Caption: "Status", AIDescription: "current status" },
    ]
  );
  assert.equal(annotated, 2, "the inactive row contributes nothing");
  assert.equal(byName.Builder.description, "who built it");
  assert.equal(byName.Status.description, "current status");
});

test("alignment: IsActive accepts the wire's boolean/number/string spellings", () => {
  for (const inactive of [false, 0, "0", "false", "False"]) {
    const { byName, annotated } = fieldsOf(
      `<EntityType Name="GI"><Property Name="Status" Type="Edm.String"/></EntityType>`,
      [
        { Name: "GI", LineNbr: 1, SortOrder: 1, ColumnIsActive: inactive, AIDescription: "hidden" },
        { Name: "GI", LineNbr: 2, SortOrder: 2, IsActive: true, Caption: "Status", AIDescription: "current status" },
      ]
    );
    assert.equal(annotated, 1, `IsActive=${JSON.stringify(inactive)}`);
    assert.equal(byName.Status.description, "current status");
  }
});

test("alignment: key columns are hoisted to the front of the property list", () => {
  // ProjectID is the 3rd result column in the design but the 1st property.
  const { names, byName } = fieldsOf(
    `<EntityType Name="GI">
       <Key><PropertyRef Name="ProjectID"/></Key>
       <Property Name="ProjectID" Type="Edm.String"/>
       <Property Name="Builder" Type="Edm.String"/>
       <Property Name="Status" Type="Edm.String"/>
     </EntityType>`,
    [
      { Name: "GI", LineNbr: 1, SortOrder: 1, IsActive: true, Field: "builder", AIDescription: "who built it" },
      { Name: "GI", LineNbr: 2, SortOrder: 2, IsActive: true, Caption: "Status", AIDescription: "current status" },
      { Name: "GI", LineNbr: 3, SortOrder: 3, IsActive: true, Caption: "Project ID", AIDescription: "the project" },
    ]
  );
  assert.deepEqual(names, ["ProjectID", "Builder", "Status"]);
  assert.equal(byName.ProjectID.description, "the project");
  assert.equal(byName.Builder.description, "who built it");
  assert.equal(byName.Status.description, "current status");
});

test("alignment: keys that are not result columns are appended with no design row", () => {
  const { names, byName } = fieldsOf(
    `<EntityType Name="GI">
       <Key><PropertyRef Name="ProjectID"/><PropertyRef Name="RowNumber"/></Key>
       <Property Name="ProjectID" Type="Edm.String"/>
       <Property Name="Builder" Type="Edm.String"/>
       <Property Name="RowNumber" Type="Edm.Int32"/>
     </EntityType>`,
    [
      { Name: "GI", LineNbr: 1, SortOrder: 1, IsActive: true, Field: "builder", AIDescription: "who built it" },
      { Name: "GI", LineNbr: 2, SortOrder: 2, IsActive: true, Caption: "Project ID", AIDescription: "the project" },
    ]
  );
  assert.deepEqual(names, ["ProjectID", "Builder", "RowNumber"]);
  assert.equal(byName.ProjectID.description, "the project");
  assert.equal(byName.Builder.description, "who built it");
  // The appended key has no design row — it must not inherit a neighbour's text.
  assert.equal(byName.RowNumber.description, undefined);
  assert.equal(byName.RowNumber.caption, undefined);
  assert.equal(byName.RowNumber.type, "integer");
});

test("alignment: a misaligned captioned row rejects the whole GI's annotation", () => {
  // The two captioned rows are in the wrong order relative to $metadata: every
  // assignment misplaces one, so no description may be attached to either.
  const { names, byName, annotated } = fieldsOf(
    `<EntityType Name="GI">
       <Property Name="Amount" Type="Edm.Decimal"/>
       <Property Name="Status" Type="Edm.String"/>
     </EntityType>`,
    [
      { Name: "GI", LineNbr: 1, SortOrder: 1, Caption: "Status", AIDescription: "current status" },
      { Name: "GI", LineNbr: 2, SortOrder: 2, Caption: "Amount", AIDescription: "the amount" },
    ]
  );
  assert.equal(annotated, 0, "no description survives a rejected alignment");
  // Names and declared types are still authoritative and still returned.
  assert.deepEqual(names, ["Amount", "Status"]);
  assert.equal(byName.Amount.type, "decimal");
  assert.equal(byName.Status.type, "string");
});

test("alignment: more active rows than properties rejects rather than shifts", () => {
  const { names, annotated } = fieldsOf(
    `<EntityType Name="GI"><Property Name="Status" Type="Edm.String"/></EntityType>`,
    [
      { Name: "GI", LineNbr: 1, SortOrder: 1, Caption: "Status", AIDescription: "current status" },
      { Name: "GI", LineNbr: 2, SortOrder: 2, Caption: "Amount", AIDescription: "the amount" },
    ]
  );
  assert.equal(annotated, 0);
  assert.deepEqual(names, ["Status"]);
});

test("alignment: a caption ending in _N matches the literal property name", () => {
  // `_2` is usually a collision suffix the platform appended, but it can also
  // be typed into the caption by hand (production: IN-StockItem "ItemStatus_2").
  // Comparing only against the stripped name makes such a row unsatisfiable and
  // needlessly rejects the whole GI.
  const { byName, annotated } = fieldsOf(
    `<EntityType Name="GI">
       <Property Name="ItemStatus" Type="Edm.String"/>
       <Property Name="ItemStatus_2" Type="Edm.String"/>
     </EntityType>`,
    [
      { Name: "GI", LineNbr: 1, SortOrder: 1, IsActive: true, Caption: "ItemStatus", AIDescription: "stock status" },
      { Name: "GI", LineNbr: 2, SortOrder: 2, IsActive: true, Caption: "ItemStatus_2", AIDescription: "second status" },
    ]
  );
  assert.equal(annotated, 2);
  assert.equal(byName.ItemStatus.description, "stock status");
  assert.equal(byName.ItemStatus_2.description, "second status");
});

test("alignment: a feed with no active flag at all is refused, not aligned by LineNbr", () => {
  // A pre-0.48.0 MCPGIFields emits no IsActive, so an inactive row is
  // indistinguishable from an active one — it consumes a property slot and
  // shifts every later column. Captions do not save this: verified on
  // production PM-Projects (25 captioned columns), where dropping the flag
  // moved EndDate from line 47 onto line 45, because both neighbours were
  // uncaptioned and so neither constrained the alignment. Wrong annotations
  // are worse than none, so such a feed gets names and types only.
  const { names, annotated } = fieldsOf(
    `<EntityType Name="GI">
       <Property Name="Builder" Type="Edm.String"/>
       <Property Name="Status" Type="Edm.String"/>
     </EntityType>`,
    [
      { Name: "GI", LineNbr: 1, AIDescription: "who built it" },
      { Name: "GI", LineNbr: 2, Caption: "Status", AIDescription: "current status" },
    ]
  );
  assert.deepEqual(names, ["Builder", "Status"], "names and types still returned");
  assert.equal(annotated, 0, "no captions or descriptions attached");
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

// ── Hoist disambiguation: declared types, tie refusal, token tiebreak (0.48.2) ──

test("expectedTypeFamily classifies only what Acumatica's naming makes certain", () => {
  assert.equal(expectedTypeFamily("curyDocBal"), "numeric");
  assert.equal(expectedTypeFamily("createdDateTime"), "datetime");
  assert.equal(expectedTypeFamily("isTangible"), "boolean");
  assert.equal(expectedTypeFamily("branchID_description"), "text");
  assert.equal(expectedTypeFamily("acctCD"), "text");
  // A calculated column's result type is not derivable from its expression, and
  // an unrecognized name must not be guessed — both yield no constraint.
  assert.equal(expectedTypeFamily("=[A.Qty]-[B.Qty]"), null);
  assert.equal(expectedTypeFamily("invoiceNbr"), null);
  assert.equal(expectedTypeFamily(undefined), null);
});

test("typeConflicts treats integer as compatible with everything", () => {
  // Acumatica surfaces identifiers and line numbers as int or string depending
  // on the DAC, so `integer` can never be the thing that rejects an alignment.
  assert.equal(typeConflicts("text", "integer"), false);
  assert.equal(typeConflicts("numeric", "integer"), false);
  assert.equal(typeConflicts("numeric", "string"), true);
  assert.equal(typeConflicts("datetime", "string"), true);
  assert.equal(typeConflicts("text", "decimal"), true);
  assert.equal(typeConflicts(null, "decimal"), false);
});

test("alignment: a declared type rules out an otherwise-tied hoist", () => {
  // Production SO-Invoice in miniature. Two uncaptioned rows could be hoisted
  // onto the string key; only one is type-possible, because a `*Bal` field
  // cannot produce a string property.
  const { byName, annotated } = fieldsOf(
    `<EntityType Name="GI">
       <Key><PropertyRef Name="Customer"/></Key>
       <Property Name="Customer" Type="Edm.String"/>
       <Property Name="Status" Type="Edm.String"/>
       <Property Name="Balance" Type="Edm.Decimal"/>
     </EntityType>`,
    [
      { Name: "GI", LineNbr: 1, SortOrder: 1, IsActive: true, Field: "status", AIDescription: "doc status" },
      { Name: "GI", LineNbr: 2, SortOrder: 2, IsActive: true, Field: "acctCD", AIDescription: "customer code" },
      { Name: "GI", LineNbr: 3, SortOrder: 3, IsActive: true, Field: "curyDocBal", AIDescription: "open balance" },
    ]
  );
  assert.equal(annotated, 3);
  assert.equal(byName.Customer.description, "customer code");
  assert.equal(byName.Status.description, "doc status");
  assert.equal(byName.Balance.description, "open balance");
});

test("alignment: a genuinely tied hoist is refused rather than guessed", () => {
  // Nothing distinguishes the two string rows — same type family, no caption, no
  // name resemblance to the key. Committing to one would shift the other column.
  const { names, annotated } = fieldsOf(
    `<EntityType Name="GI">
       <Key><PropertyRef Name="Widget"/></Key>
       <Property Name="Widget" Type="Edm.String"/>
       <Property Name="Gadget" Type="Edm.String"/>
     </EntityType>`,
    [
      { Name: "GI", LineNbr: 1, SortOrder: 1, IsActive: true, Field: "alpha", AIDescription: "first" },
      { Name: "GI", LineNbr: 2, SortOrder: 2, IsActive: true, Field: "beta", AIDescription: "second" },
    ]
  );
  assert.deepEqual(names, ["Widget", "Gadget"], "names and types still returned");
  assert.equal(annotated, 0, "no annotation attached to an under-determined GI");
});

test("alignment: every hoisted row captioned is NOT a tie — all four resolve", () => {
  // Regression guard. Four captioned rows each score identically on their own
  // property; treating equal scores as ambiguity refused production
  // Velixo-ARByPeriod, which is fully determined by construction.
  const { byName, annotated } = fieldsOf(
    `<EntityType Name="GI">
       <Key><PropertyRef Name="FinPeriodID"/><PropertyRef Name="BranchID"/></Key>
       <Property Name="FinPeriodID" Type="Edm.String"/>
       <Property Name="BranchID" Type="Edm.String"/>
       <Property Name="Balance" Type="Edm.Decimal"/>
     </EntityType>`,
    [
      { Name: "GI", LineNbr: 2, SortOrder: 2, IsActive: true, Caption: "BranchID", Field: "branchCD", AIDescription: "branch" },
      { Name: "GI", LineNbr: 5, SortOrder: 5, IsActive: true, Caption: "Balance", Field: "=[H.Bal]", AIDescription: "ar balance" },
      { Name: "GI", LineNbr: 7, SortOrder: 7, IsActive: true, Caption: "FinPeriodID", Field: "finPeriodID", AIDescription: "as-of period" },
    ]
  );
  assert.equal(annotated, 3);
  assert.equal(byName.FinPeriodID.description, "as-of period");
  assert.equal(byName.BranchID.description, "branch");
  assert.equal(byName.Balance.description, "ar balance");
});

test("alignment: shared tokens break a tie the substring tiers cannot", () => {
  // Production HPL-CostCodes: `costCodeCD` and `costCodeCD_description` both
  // resemble the `CostCode` key equally, so the hoist was decided arbitrarily
  // and landed the description text on the code column. "description" is a
  // shared token with the `Description` property; "cd" is too short to count.
  const { byName, annotated } = fieldsOf(
    `<EntityType Name="GI">
       <Key><PropertyRef Name="CostCode"/></Key>
       <Property Name="CostCode" Type="Edm.String"/>
       <Property Name="PMCostCode_costCodeID" Type="Edm.Int32"/>
       <Property Name="Description" Type="Edm.String"/>
     </EntityType>`,
    [
      { Name: "GI", LineNbr: 1, SortOrder: 1, IsActive: true, Field: "costCodeID", AIDescription: "internal id" },
      { Name: "GI", LineNbr: 2, SortOrder: 2, IsActive: true, Field: "costCodeCD", AIDescription: "the code" },
      { Name: "GI", LineNbr: 3, SortOrder: 3, IsActive: true, Field: "costCodeCD_description", AIDescription: "the label" },
    ]
  );
  assert.equal(annotated, 3);
  assert.equal(byName.CostCode.description, "the code");
  assert.equal(byName.Description.description, "the label");
  assert.equal(byName.PMCostCode_costCodeID.description, "internal id");
});

// ── Expression (calculated) column flagging ────────────────────────────────
//
// A calculated column ("=…" design field) cannot be $filtered — Acumatica
// returns HTTP 200 with an empty body. resolveFields flags such columns so
// run_inquiry can refuse the filter before calling Acumatica.

test("expression columns are flagged; stored fields are not", () => {
  const { byName } = fieldsOf(
    `<EntityType Name="GI">
       <Property Name="RefNbr" Type="Edm.String"/>
       <Property Name="Amount" Type="Edm.Decimal"/>
     </EntityType>`,
    [
      { Name: "GI", LineNbr: 1, SortOrder: 1, IsActive: true, Field: "refNbr", AIDescription: "doc ref" },
      { Name: "GI", LineNbr: 2, SortOrder: 2, IsActive: true, Field: "=Switch(…)", Caption: "Amount", AIDescription: "signed amount" },
    ]
  );
  assert.equal(byName.Amount.expression, true);
  assert.equal(byName.Amount.description, "signed amount");
  assert.equal(byName.RefNbr.expression, undefined);
});

test("the no-EDMX fallback path also flags expression columns", () => {
  const reg = assembleRegistry({
    giRows: [{ Name: "SomeGI" }],
    fieldRows: [
      { Name: "SomeGI", Caption: "Balance", Field: "=[a]-[b]", LineNbr: 1 },
      { Name: "SomeGI", Caption: "RefNbr", Field: "refNbr", LineNbr: 2 },
    ],
    edmxTypes: new Map(),
    builtAt: "2026-08-16T00:00:00Z",
  });
  const f = Object.fromEntries((reg.gis[0].fields ?? []).map((x) => [x.name, x]));
  assert.equal(f.Balance.expression, true);
  assert.equal(f.RefNbr.expression, undefined);
});

test("a refused alignment withholds expression flags along with annotations", () => {
  // More active rows than properties → alignment rejected → bare names+types,
  // and NO expression flags: a flag placed by a wrong alignment would refuse
  // filters on a perfectly filterable stored column.
  const { byName } = fieldsOf(
    `<EntityType Name="GI"><Property Name="OnlyOne" Type="Edm.String"/></EntityType>`,
    [
      { Name: "GI", LineNbr: 1, SortOrder: 1, IsActive: true, Field: "=calc" },
      { Name: "GI", LineNbr: 2, SortOrder: 2, IsActive: true, Field: "stored" },
    ]
  );
  assert.equal(byName.OnlyOne.expression, undefined);
});
