# Acumatica setup package — GI exposure gate

This folder bundles everything the Acumatica side of the **GI exposure gate** needs (see
[docs/generic-inquiries.md](../docs/generic-inquiries.md) for the rationale and full setup).

| File | What it is |
|------|------------|
| `MCP4Acumatica-AIDescription.zip` | Customization project: adds the custom fields + SM208000 form changes. |
| `MCPGIs.xml` | The `MCPGIs` feed GI (one row per exposed GI). |
| `MCPGIFields.xml` | The `MCPGIFields` feed GI (one row per exposed GI's output column). |
| `MCPAccess.xml` | The `MCPAccess` canary GI used by the login **role gate** (see the README's Acumatica-side configuration). |

> The customization is built on Acumatica **2025 R2** (`product-version 25.201`). The
> `AIDescription` fields are a stopgap until native support lands in **26R1+**.

## 1. Customization project — what it adds

| DAC | Field | Type | Form label (SM208000) |
|-----|-------|------|------------------------|
| `GIDesign` | `UsrExposedToMCP` | bool | **Exposed to MCP** (checkbox, GI header) |
| `GIDesign` | `UsrAIDescription` | string(2000) | **AI Description** (GI header) |
| `GIResult` | `UsrResAIDescription` | string(1000) | **AI Description** (Results grid column) |

Plus the **SM208000** screen changes that surface these fields, so an admin can tick the box and
write descriptions without a developer. (`project.xml` = DAC field defs + screen-edit metadata;
one generated SM208000 screen extension.)

## 2. Feed + canary GIs — and how their columns map to the code

`MCPGIs` / `MCPGIFields` are read by the server when it builds the registry. Acumatica derives
each OData property name from the **result-column caption**, so the captions below *are* the
property names — they must match what `src/lib/gi-registry.ts` reads:

**`MCPGIs`** — row filter: `UsrExposedToMCP = true` AND `ExposeViaOData = true` AND parameter-free
(`GIFilter.LineNbr IS NULL`):

| OData column (caption) | Source field | Registry use |
|------------------------|--------------|--------------|
| `Name` | `GIDesign.name` | GI name / OData entity (`giName`) |
| `AIDescription` | `GIDesign.UsrAIDescription` | GI-level description |
| `ScreenID` | `GIDesign.primaryScreenID` | entry screen (informational) |
| `DesignID` | `GIDesign.designID` | traceability |

**`MCPGIFields`**:

| OData column (caption) | Source field | Registry use |
|------------------------|--------------|--------------|
| `Name` | `GIDesign.name` | owning GI (groups columns) |
| `SchemaField` | `GIResult.schemaField` | DAC field — prop-name fallback when a column has no caption |
| `Caption` | `GIResult.caption` | column caption → predicted prop name |
| `AIDescription` | `GIResult.UsrResAIDescription` | per-column description |
| `LineNbr` | `GIResult.lineNbr` | orders columns for collision disambiguation |

(`MCPGIFields` also emits `DesignID`, `ObjectName`, `Field`, `FieldName` — present but not consumed
by the registry. If you change a caption here, change the matching field in `gi-registry.ts`.)

## Import order

1. **Customization Projects (SM204505)** → **Import** → upload `MCP4Acumatica-AIDescription.zip` →
   open it and **Publish**. Verify on **Generic Inquiry (SM208000)**: the **Exposed to MCP**
   checkbox + **AI Description** box on the header, and an **AI Description** column on Results.
2. **Generic Inquiry (SM208000)** → import `MCPGIs.xml`, `MCPGIFields.xml`, and `MCPAccess.xml`
   (these are SM208000 GI exports). Confirm all three are **Exposed via OData**.
3. **Access Rights:** grant the `MCP Access` role **read access to `MCPGIs` + `MCPGIFields`**, and
   assign the `MCPAccess` canary GI to the `MCP Access` role (role-gate prerequisite).
4. **Tag the GIs** you want the assistant to see: set **Exposed to MCP** and write an **AI
   Description** on each (and per-column AI Descriptions as desired).

Until at least one GI is tagged and the feeds are readable, the gate stays **inactive** (all
OData-exposed GIs remain available, exactly as before).

## Upgrades

The custom fields live on system DACs (`GIDesign`/`GIResult`). They should carry forward across
Acumatica releases, but re-validate (and re-publish) after a version upgrade — and drop the
customization once a release ships native AI-description metadata. See
[docs/upgrading-acumatica.md](../docs/upgrading-acumatica.md).

---

Copyright 2026 Hall Boys, Inc. · Apache-2.0 (same license as the rest of this repository).
