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
| `acumatica_run_inquiry` | Execute a GI by name via OData and return rows. A GI with parameters takes them in a `parameters` argument — see [Parameterized GIs](#parameterized-gis). |

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
3. **Silently wrong data — the dangerous one.** A GI with **parameters**, queried through its
   plain OData entity set, runs with no parameter values and returns plausible-looking rows with
   **no error**. A parameterized sales GI might return every order instead of one customer's; a
   date-bounded GI might return everything. The model cannot tell the answer is wrong.

> ⚠️ **How the server handles parameterized GIs (0.56.0).** Unless `ACUMATICA_GI_PARAMETERS` is
> `"true"`, it refuses them outright. When enabled, the server never queries a
> parameterized GI through its plain entity set. It uses the GI's `_WithParameters` OData function,
> and checks the model's parameter values *before* calling Acumatica: a call with no `parameters`
> argument is refused (the refusal lists the parameters, so the model has seen them), a **required**
> parameter must have a value, and an **unknown parameter name is refused** — Acumatica itself
> silently ignores a misspelled name and returns unfiltered rows. An optional parameter left out
> takes the GI's own default value, and the response says which defaults applied. If the server
> cannot read OData `$metadata` — so it cannot tell whether a GI takes parameters — it refuses the
> call and asks the model to retry, rather than assume the GI is parameter-free. See
> [Parameterized GIs](#parameterized-gis) below. The *other* risks above (context overload,
> wrong-shape output, exposing sensitive GIs) are only addressed by curating.

The gate flips GI visibility from **opt-out to opt-in.** Instead of "every GI is
exposed unless something hides it," a human deliberately marks the GIs that are
meaningful for an AI agent to query — having considered that *an agent may invoke
this without a person in the loop.* Everything else stays invisible to the model.

## Which GIs to expose

**Good candidates** — tag these `ExposedtoMCP`:

- **Parameter-free, or with parameters you have checked.** A parameterized GI is fine to expose
  (see [Parameterized GIs](#parameterized-gis)), provided its parameters are set up for an agent:
  anything that must be supplied for correct results is marked **Is Required**, defaults are ones
  you would accept silently, and names/display names say what the parameter means.
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
2. **Import the feed GIs.** [`acumatica/MCPGIs.xml`](../acumatica/) (one row per exposed GI),
   [`acumatica/MCPGIFields.xml`](../acumatica/) (one row per output column) and, optionally,
   [`acumatica/MCPGIParams.xml`](../acumatica/) (one row per parameter of an exposed GI — supplies
   parameter display names and default values) — import them on **Generic Inquiry (SM208000)**, all
   **Exposed via OData**. They read the step-1 fields; the registry reads their output columns (see
   [`acumatica/README.md`](../acumatica/) for the column mapping). `MCPGIs` filters to
   `UsrExposedToMCP = true` and `ExposeViaOData = true`.
3. **Grant the `MCP Access` role read access to the feed GIs** (`MCPGIs`, `MCPGIFields`, and
   `MCPGIParams` if imported). The registry is built
   lazily using whichever connected user's token is in hand (it holds only GI/field **metadata**,
   never business rows), so the feeds must be readable by the role. No service account, no scheduled
   job, no separate license.
4. **Tag the GIs** you want the assistant to see — tick **Exposed to MCP** and write an **AI
   Description** on each (and per-column AI Descriptions as desired) so the model knows what each GI
   is for.

> The [`acumatica/`](../acumatica/) bundle also includes `MCPAccess.xml`, the canary GI for the
> login **access gate** (a separate prerequisite — import it, expose it via OData, and restrict who
> can read it; assigning it to a marker `MCP Access` role is the recommended way).

`ExposedtoMCP` is **authoritative** — the `*MCP` GI-naming convention is just convention.
Until at least one GI is tagged and the feeds are readable, the gate stays inactive.

## How it behaves

- **Inactive until configured.** No registry built yet → `list_generic_inquiries` returns **no
  GIs** (discovery is suppressed — the model isn't handed an uncurated menu). `run`/`describe` still
  serve a GI named **explicitly** (with the parameter checks), so there's no hard dead period
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
- **Fixed-width keys trimmed.** Acumatica returns padded key values (`"MAIN01    "`). An equality
  filter still matches them, but they break comparisons outside Acumatica and waste context, so all GI
  output is trimmed before it reaches the model.
- **Calculated columns are guarded (0.49.0).** A `$filter` referencing a **calculated** column
  (an `=…` expression in the GI design) makes Acumatica return HTTP 200 with an *empty body* —
  no error, no rows, indistinguishable from an outage. For curated GIs the registry flags
  expression columns during its `$metadata` alignment: `describe_inquiry` marks them
  `calculated: true`, and `run_inquiry` refuses such a filter before contacting Acumatica,
  telling the model which stored columns to filter on instead. Flags are only attached where
  the column alignment succeeded — a GI whose alignment was refused carries none (a
  mis-placed flag would block filters on a perfectly filterable column).
- **If your column descriptions don't appear, caption the GI's key columns.** When
  `acumatica_describe_inquiry` returns field names and types but **no** `description` text,
  the server rejected that GI's column alignment on purpose — a mis-shifted description is
  worse than none. The usual cause is that the columns Acumatica hoists to the front of the
  OData output (the ones that are entity keys) carry no caption, so nothing determines which
  design row each one came from. The fix needs no code and no redeploy: on SM208000, set the
  **Caption** of each hoisted key column to *exactly the property name OData already reports*
  for it (e.g. `Type`, `ReferenceNbr`, `Customer`). Because a property name is derived from
  its caption, setting the caption to the name it already has is a no-op rename that pins the
  alignment permanently. Then run `acumatica_clear_cache` (`target=gi`) and re-check.
  Verified on three production GIs: the OData property lists came back byte-identical
  afterwards, and 91 previously-withheld column descriptions began delivering. **Do compare
  `$metadata` before and after** — a caption that does *not* match the current property name
  renames a live API field and will break existing queries.
- **Caching / refresh.** The registry is KV-cached (`cache:gi_registry`) with ~1-hour
  freshness and rebuilt lazily on the next request when stale. Force an immediate rebuild
  with `acumatica_clear_cache` (no argument, or `target=gi`). Registry edits take effect on
  the next Durable Object instance (minutes), like other runtime config.

## Parameterized GIs

> **Off by default.** Parameterized GIs are refused (and left out of the list) unless the server's
> `ACUMATICA_GI_PARAMETERS` setting is `"true"`. Turn it on only after one parameterized call has been
> verified on your Acumatica release — see [Upgrading Acumatica](upgrading-acumatica.md) §7. The
> behaviour below was verified on 2026 R2.

A GI with parameters (the **Parameters** tab on SM208000) is queried through its
`_WithParameters` OData function — Acumatica's documented way to pass parameter values over
OData — never through its plain entity set, which would run it with no values.

**What the model sees.** `acumatica_list_generic_inquiries` lists a parameterized GI with its
parameter names (required ones marked). `acumatica_describe_inquiry` returns each parameter's
name, type, whether it is required, and — when the `MCPGIParams` feed is imported — its display
name and default value. A GI with a required parameter is described without a sample row (field
names and types come from `$metadata`), because no honest sample exists until the values are chosen.

**What the server checks before calling Acumatica** (`acumatica_run_inquiry`):

| Model's call | Result |
|---|---|
| No `parameters` argument | Refused, listing the parameters. `{}` is the explicit "run at defaults". |
| Unknown parameter name | Refused, listing the valid names. Acumatica would ignore it and return unfiltered rows. |
| Required parameter missing or blank | Refused, naming it. |
| Value that doesn't fit the type | Refused (dates `YYYY-MM-DD` — also accepted for date-time parameters, which is how 2025 R2 declares GI dates — date-times ISO-8601 with offset, booleans `true`/`false`). |
| Optional parameter left out | Runs; the parameter takes the GI's **Default Value**, and the response lists it under `parameters.defaulted` so the model can tell the user. |
| `parameters` on a GI without parameters | Refused — the values would be ignored. |

**Where the rules come from.** Names, types and required-ness are read from OData `$metadata`
on every call: a parameter is required exactly when **Is Required** is checked on the GI's
Parameters tab (`$metadata` marks it `Nullable="false"`). The optional `MCPGIParams` feed adds
display names and default values; without it the checks still apply, the model just doesn't see
labels or defaults.

**Before tagging a parameterized GI `ExposedtoMCP`:**
- Mark every parameter that must be supplied for correct results as **Is Required**. An
  unrequired parameter can be left out, and then runs at its default — or blank.
- Check the defaults are ones you would accept being applied silently (`@QuarterStart` is fine
  for most reporting; a hard-coded branch may not be).
- Give parameters meaningful names or display names — the model chooses values from them.

`$filter`, `$select`, the row cap and `$count` all work on top of the parameters.

> **Upgrading from an older setup package:** `MCPGIs` used to exclude parameterized GIs. After you
> re-import it, any parameterized GI **already** tagged `ExposedtoMCP` becomes visible to the
> assistant (the tag previously had no effect on it). Review those GIs' parameters first.

## See also

- [Tool Reference](tool-reference.md) — exact parameters for the three GI tools.
- [OData Filtering](odata-filtering.md) — `$filter` / `$select` / `$top` syntax for `run_inquiry`.
- [Upgrading Acumatica](upgrading-acumatica.md) — the registry is an instance-derived cache to
  clear after a version/endpoint change.
