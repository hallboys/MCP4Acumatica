# Acumatica setup package — GI exposure gate

This folder bundles everything the Acumatica side of the **GI exposure gate** needs (see
[docs/generic-inquiries.md](../docs/generic-inquiries.md) for the rationale and full setup).

| File | What it is |
|------|------------|
| `MCP4Acumatica-AIDescription.zip` | Customization project: adds the custom fields + SM208000 form changes. |
| `MCPGIs.xml` | The `MCPGIs` feed GI (one row per exposed GI). |
| `MCPGIFields.xml` | The `MCPGIFields` feed GI (one row per exposed GI's output column). |
| `MCPAccess.xml` | The `MCPAccess` canary GI used by the login **role gate** (see the README's Acumatica-side configuration). |
| `MCPGIColumnsAll.xml` | Authoring aid: one row per (GI, result column) for **every** GI in the instance. |
| `MCPGIJoinsAll.xml` | Authoring aid: one row per join condition — tables, aliases, join types. |
| `MCPGIWhereAll.xml` | Authoring aid: one row per design-time WHERE condition. |
| `MCPGIDescriptionEditor.xml` | Editor GI: edit `GIDesign.UsrAIDescription` in a grid. |
| `MCPGIColumnDescEditor.xml` | Editor GI: edit `GIResult.UsrResAIDescription` in a grid. |
**No drafted descriptions ship in this repo.** A description states what one tenant's inquiry
actually does — its document-type filters, custom fields and business rules — so it is instance
data, not project source, and this repo is public. `.gitignore` keeps
`acumatica/gi-descriptions*.csv` out of git; write yours somewhere private.

To produce your own, use the skill at `skills/acumatica-gi-descriptions/`: it covers selecting
which GIs are worth describing, pulling the design metadata, and — via
`scripts/align_columns.mjs` — mapping each design row to the OData property it actually becomes,
which cannot be predicted from the design and is the step everything else depends on.

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

**`MCPGIFields`** — same row filter as `MCPGIs` minus the parameter-free clause:
`UsrExposedToMCP = true` AND `ExposeViaOData = true`:

| OData column (caption) | Source field | Registry use |
|------------------------|--------------|--------------|
| `Name` | `GIDesign.name` | owning GI (groups columns) |
| `Caption` | `GIResult.caption` | column caption, when set — **also the alignment constraint** |
| `AIDescription` | `GIResult.UsrResAIDescription` | per-column description |
| `SortOrder` | `GIResult.sortOrder` | **grid position — the order the columns align in** |
| `IsActive` | `GIResult.isActive` | **inactive columns never reach OData; they must be dropped** |
| `LineNbr` | `GIResult.lineNbr` | row identity (dedupe); tiebreak within one `SortOrder` |
| `Field` | `GIResult.field` | weak tiebreak for uncaptioned columns during alignment |
| `SchemaField` | `GIResult.schemaField` | name guess on the degraded no-`$metadata` path only |

`SortOrder` and `IsActive` were added after the original release — **re-import
`MCPGIFields.xml` if your instance predates them.** Without both columns most curated column
descriptions cannot be attached: a column's OData property name is not predictable from the design
(a caption is only an *override* and is NULL for the majority of columns; `SchemaField` is NULL for
most rows and DAC-qualified — `INTran.RefNbr` — where present), so the registry joins design rows
to `$metadata` properties **positionally**, which requires the true grid order and the exclusion of
inactive rows. See `resolveFields` in `src/lib/gi-registry.ts`.

(`MCPGIFields` also emits `DesignID`, `ObjectName`, `FieldName` — present but not consumed by the
registry. If you change a caption here, change the matching field in `gi-registry.ts`.)

## 3. Authoring aids — reading GI *designs* to write AI descriptions

`MCPGIColumnsAll` / `MCPGIJoinsAll` / `MCPGIWhereAll` exist so descriptions can be written **from
the GI design rather than from guesswork**. A live sample row shows values but not what one row
*represents*, which filters are baked in, or why a left-joined column is null — the three things a
useful `AIDescription` has to state.

They are deliberately **separate from the `MCPGIs`/`MCPGIFields` feeds**:

- The feeds are consumed by the server at runtime and are listed in `EXCLUDED_GI_NAMES`
  (`src/lib/gi-registry.ts`), so `acumatica_run_inquiry` refuses them. These aids are not excluded,
  so they can be queried while drafting.
- The feeds are scoped to *exposed* GIs; these cover **every** GI, including ones not yet tagged
  `ExposedToMCP` and not yet exposed via OData — which is the population you pick candidates from.

There are three rather than one because a GI has a single row grain and these are three different
children of `GIDesign`: result columns, join conditions, and WHERE conditions. Merging them would
cross-product the rows.

All three ship with **`UsrExposedToMCP="1"`**, which is load-bearing and easy to get wrong. The
`MCPGIs`/`MCPGIFields` feeds work while untagged because the server's registry builder reads them
*directly*; these aids are read through `acumatica_run_inquiry`, which is **gated** — untagged, the
gate refuses them with "not exposed to the AI assistant."

> **Untag them when the authoring session is done.** While tagged they sit in the model's own GI
> menu, which is exactly the context pollution the gate exists to prevent. Clear **Exposed to MCP**
> on all three (and run `acumatica_clear_cache`) once descriptions are loaded.

> **Three field names in these files are unverified** — `GIWhere.value2`, `GIWhere.openBrackets`,
> and `GIWhere.closeBrackets` in `MCPGIWhereAll.xml`. Every other field was taken from a known-good
> export. If SM208000 rejects the import, delete those three `<GIResult>` lines and re-import; the
> only loss is bracket grouping in multi-condition filters.

## 4. Loading the descriptions

Once you have drafted text (see the file table above — none ships here), getting it into
Acumatica is the awkward step, because `GIDesign` and `GIResult` are **system DACs and are not in
the contract-based REST API** — there is no write path from this MCP server, and none from any
REST client. That leaves two routes.

**Editor GIs (shipped here).** `MCPGIDescriptionEditor` exposes `UsrAIDescription` and
`MCPGIColumnDescEditor` exposes `UsrResAIDescription`, both with record editing switched on, so the
values can be typed straight into the results grid. Both ship `ExposeViaOData="0"` and
`UsrExposedToMCP="0"` — they are human tools and must never enter the model's menu.

> **Know the limit before you start.** Acumatica's *mass update* applies **one value to many
> selected rows**; it is not a paste-a-column-of-distinct-values mechanism. Row-by-row editing is
> perfectly workable for the **116 GI-level** descriptions. It is not a realistic way to enter
> **1 788 column** descriptions — for that, an Import Scenario is the right tool.

> Two attributes on `GIMassUpdateField` (`ObjectName`, `FieldName`) were inferred rather than copied
> from a known-good export. If the **Mass Record Update** tab is empty after import, add the field
> there by hand — it is a two-click fix, and the rest of the GI is unaffected.

**Import Scenario (not shipped).** A scenario on SM208000 keyed by `Inquiry Title` (plus result
`LineNbr` for columns) is the only practical route for the column pass. It is deliberately absent:
SM208000 is the screen that *defines* every GI in the instance, and a scenario whose match-versus-
create semantics are wrong can alter GI definitions rather than just annotate them. Export any
existing scenario from SM206025 to XML first and use its envelope as the template — the same method
that made the GIs in this folder import correctly the first time.

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
