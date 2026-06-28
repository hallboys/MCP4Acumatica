# Generic Inquiries & the MCP Exposure Gate

Generic Inquiries (GIs) are Acumatica's user-defined queries (SM208000). This server
can run them on the user's behalf, but **not every GI belongs in front of an AI
agent.** This page explains the three GI tools, *why* there is an opt-in exposure
gate, how to decide which GIs to expose, and how to turn it on.

> **TL;DR for operators:** Until you build the registry, the gate is **inactive** and the model
> **cannot discover GIs** — `list_generic_inquiries` returns nothing (a user can still run a GI by
> *exact name*). Build the registry (tag GIs `ExposedToMCP` via the `MCPGIs`/`MCPGIFields` feeds) so
> the model can discover **only** the GIs you've vetted. Curation is a data-correctness control,
> not an optional nicety.

## The three GI tools

| Tool | What it does |
|------|--------------|
| `acumatica_list_generic_inquiries` | Discover GI names (the model's menu of available inquiries). |
| `acumatica_describe_inquiry` | Return a GI's field schema (names + types) so the model knows what it can filter/select. |
| `acumatica_run_inquiry` | Execute a GI by name via OData and return rows. |

These are **generic** — one set of tools that works for any GI — not one tool per GI.

## Why an exposure gate? (the problem it solves)

A mature Acumatica instance accumulates GIs over years — often **hundreds**. The
overwhelming majority are built **for human screens**: wide report-style grids,
dashboard widgets, pivot sources, and one-off ad-hoc queries. They assume a person
reading a rendered grid in the Acumatica UI — *not* an autonomous agent querying
them headlessly. Surfacing all of them to the model has two concrete costs:

1. **Context overload and bad selection.** `list_generic_inquiries` is the model's
   menu. A list of hundreds of mostly-irrelevant inquiries crowds the model's context
   window and makes it *pick the wrong GI* — or waste turns describing inquiries that
   were never meant to be queried this way. The signal (the handful of GIs that answer
   real questions) drowns in noise.
2. **Wrong-shape results.** Many screen GIs return dozens of display-only columns,
   human-formatted values, space-padded fixed-width keys, or output whose meaning
   depends on the UI rendering it. That is poor structured input for an agent even
   when it *can* be fetched.
3. **Silently wrong data — the dangerous one.** A GI with **parameters** exposed via OData
   returns *incorrect* results when queried without those parameters, which is exactly how the
   agent queries it: Acumatica computes the GI with empty/default parameters and returns
   plausible-looking rows with **no error**. A parameterized sales GI might return every order
   instead of one customer's; a date-bounded GI might return everything. The model cannot tell the
   answer is wrong. This alone is reason enough never to expose GIs without curating.

> ⚠️ **Curate — don't rely on the ungated state.** `run_inquiry` and `describe_inquiry` **refuse**
> a parameterized GI outright (regardless of gate state) rather than return its silently-wrong rows, and discovery
> excludes them — so the parameterized-GI case is guarded at the tool level. But the *other* risks
> above (context overload, wrong-shape/UI-formatted output, exposing sensitive GIs) are only
> addressed by curating. Expose only GIs you have vetted as parameter-free and correct for
> headless querying.

The gate flips GI visibility from **opt-out to opt-in.** Instead of "every GI is
exposed unless something hides it," a human deliberately marks the GIs that are
meaningful for an AI agent to query — having considered that *an agent may invoke
this without a person in the loop.* Everything else stays invisible to the model.

## Which GIs to expose

**Good candidates** — tag these `ExposedtoMCP`:

- **Parameter-free.** A parameterized GI *can* be exposed via OData, but querying it without its
  parameters returns wrong data (see the warning above) — so only expose GIs that need no
  parameters. Discovery and the `MCPGIs` feed already filter parameterized GIs out, but treat that
  as a backstop, not a license to OData-expose them.
- **Focused, stable column set** with meaningful field names — not a 40-column screen dump.
- **Answers a real question a user would ask the assistant** — e.g. "open sales orders
  by customer," "inventory usage by warehouse," "overdue projects."
- **Exposed via OData** (required for the server to query it at all).

**Leave unexposed** (do *not* tag):

- Wide screen/report grids with many display-only columns.
- Dashboard / pivot-source / KPI-tile GIs.
- Ad-hoc or one-off inquiries, or anything whose value depends on the Acumatica UI.
- Anything returning sensitive data you don't want an AI assistant to read.

## How to turn it on (operator setup)

All curation lives **in Acumatica** as GI metadata — there is no separate MCP-side list
to maintain, and admins can see the exposure flags and descriptions in Acumatica itself.

The [`acumatica/`](../acumatica/) folder bundles everything to import — see
[`acumatica/README.md`](../acumatica/) for the click-by-click version.

1. **Import the customization project.** [`acumatica/MCP4Acumatica-AIDescription.zip`](../acumatica/)
   adds the custom fields the gate reads — `GIDesign.UsrExposedToMCP` (checkbox "Exposed to MCP"),
   `GIDesign.UsrAIDescription`, and `GIResult.UsrResAIDescription` — plus the SM208000 form changes.
   These live on **system DACs**, so a customization project is the only way to add them (not the GI
   form). Import via **Customization Projects (SM204505)** and **Publish**.
2. **Import the feed GIs.** [`acumatica/MCPGIs.xml`](../acumatica/) (one row per exposed GI) and
   [`acumatica/MCPGIFields.xml`](../acumatica/) (one row per output column) — import both on **Generic
   Inquiry (SM208000)**, both **Exposed via OData**. They read the step-1 fields; the registry reads
   their output columns (`Name`, `AIDescription`, `ScreenID`, `DesignID`; and `Name`, `SchemaField`,
   `Caption`, `LineNbr`, `AIDescription`). `MCPGIs` already filters to `UsrExposedToMCP = true`,
   `ExposeViaOData = true`, and parameter-free.
3. **Grant the `MCP Access` role read access to `MCPGIs` + `MCPGIFields`.** The registry is built
   lazily using whichever connected user's token is in hand (it holds only GI/field **metadata**,
   never business rows), so the feeds must be readable by the role. No service account, no scheduled
   job, no separate license.
4. **Tag the GIs** you want the assistant to see — tick **Exposed to MCP** and write an **AI
   Description** on each (and per-column AI Descriptions as desired) so the model knows what each GI
   is for.

> The [`acumatica/`](../acumatica/) bundle also includes `MCPAccess.xml`, the canary GI for the
> login **role gate** (a separate prerequisite — import it and assign it to the `MCP Access` role).

`ExposedtoMCP` is **authoritative** — the `*MCP` GI-naming convention is just convention.
Until at least one GI is tagged and the feeds are readable, the gate stays inactive.

## How it behaves

- **Inactive until configured.** No registry built yet → `list_generic_inquiries` returns **no
  GIs** (discovery is suppressed — the model isn't handed an uncurated menu). `run`/`describe` still
  serve a GI named **explicitly** (with the parameterized-GI guard), so there's no hard dead period
  for explicit use — but the assistant can't *discover* GIs until you curate.
- **Fail-closed once active.** When a registry exists, **only** tagged GIs are reachable:
  `run_inquiry` and `describe_inquiry` reject anything else with a *"not exposed to the AI
  assistant"* error, and `list_generic_inquiries` shows only the tagged set. An empty
  registry denies all GIs; the feed GIs and the `MCPAccess` canary are **always** hidden
  (`EXCLUDED_GI_NAMES`), even while the gate is inactive. A failed rebuild serves the cached
  last-good copy rather than flapping the gate open.
- **Curated enrichment.** Exposed GIs carry your `AIDescription` text (surfaced by `list`
  and `describe`) and field **types resolved from OData `$metadata`** — more accurate than
  the single-sample inference `describe_inquiry` uses on its own (which mislabels
  whole-number money/quantity columns as `integer`). Exposure is **never** gated on having a
  description; a tagged GI with no `AIDescription` still works via inferred schema.
- **Fixed-width keys trimmed.** Acumatica returns padded key values (`"GARES     "`) that
  break equality filters; all GI output is trimmed before it reaches the model.
- **Caching / refresh.** The registry is KV-cached (`cache:gi_registry`) with ~1-hour
  freshness and rebuilt lazily on the next request when stale. Force an immediate rebuild
  with `acumatica_clear_cache` (no argument, or `target=gi`). Registry edits take effect on
  the next Durable Object instance (minutes), like other runtime config.

## See also

- [Tool Reference](tool-reference.md) — exact parameters for the three GI tools.
- [OData Filtering](odata-filtering.md) — `$filter` / `$select` / `$top` syntax for `run_inquiry`.
- [Upgrading Acumatica](upgrading-acumatica.md) — the registry is an instance-derived cache to
  clear after a version/endpoint change.
