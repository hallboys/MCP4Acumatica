---
name: acumatica-gi-descriptions
description: >-
  Write AI-facing descriptions for Acumatica Generic Inquiries and their result
  columns, grounded in the GI's own design metadata (tables, joins, WHERE
  conditions, result columns) rather than guessed from names. Use this whenever
  curating which GIs an AI assistant or MCP server may query, filling
  UsrAIDescription / UsrResAIDescription fields, auditing GIs for misleading
  captions or silently-wrong filters, deciding which of several similar GIs to
  expose, or when someone asks why a model keeps picking the wrong inquiry.
  Also use when bulk-reading GI metadata over OData, when a GI query returns an
  empty result you cannot explain, or before exposing any new GI to an AI tool.
---

# Describing Generic Inquiries for AI consumption

A GI name tells a model almost nothing. `PO-Receipt` and `PO Receipt History
Analysis` are different grains of different tables; `GL-Trial Balance` may not be
a trial balance at all. When several GIs are exposed under names like these, a
model picks by vibes and answers confidently from the wrong one.

The fix is a description per GI and per result column — but a description
*invented from the name* just launders a guess into something that looks
authoritative. **Everything here exists to make descriptions fall out of the GI's
actual design.**

## Tag legend

This skill mixes platform behaviour with instance-specific observations. Keep
them apart, or you will carry one tenant's configuration into another as if it
were a rule.

- **`[UNIVERSAL]`** — Acumatica platform/API behaviour. Holds for any tenant on a
  comparable version. Safe to rely on; still confirm the release.
- **`[TENANT]`** — depends on a specific instance's configuration, customization
  or data. **Never copy the value** into another engagement — only the *lesson*.

## The pipeline

Work in this order. Each step feeds the next, and skipping the metadata pull is
what produces plausible-sounding fiction.

1. **Inventory** every GI, with parameter count and exposure flags.
2. **Select** which GIs are worth describing. Most instances have hundreds; a
   large menu is as useless to a model as an undescribed one.
3. **Pull design metadata** for the selection: result columns, joins, conditions.
4. **Build a per-GI brief** that condenses that metadata into something writable.
5. **Draft** GI-level, then column-level descriptions.
6. **Validate** mechanically before anyone reads them.
7. **Load** into Acumatica and **verify by reading back**.

`references/workflow.md` has the concrete steps, queries and slicing strategy.
Read it when you start step 1.

## The rules that actually bite

These are the ones that produce *confidently wrong* output if ignored. Each cost
real debugging time.

**`[UNIVERSAL]` Pull `IsActive` on EVERY design table, not just the one you
remembered.** `GIWhere` rows carry it, and so do `GIResult` rows — a result
column can be switched off, in which case it does not reach OData at all. An
inactive row looks identical to a live one in every export and every query unless
you select the flag. Describing a disabled condition as enforced makes the
inquiry look narrower than it is; describing an inactive column makes you invent
duplicates and collisions that do not exist.

Check each design table you query for its own active flag before writing a line
of description. Getting this right for conditions and then missing it for columns
is the easiest mistake in this whole workflow to make twice.

**`[UNIVERSAL]` Property names cannot be derived from the design. Get them from
`$metadata` and join positionally.** A caption is only an *override*; most columns
have none, and for those the property name comes from the field's display name,
which no design table exposes. Fetch `$metadata` once — it covers every exposed
GI in a single request — then align: drop inactive rows, sort by **`SortOrder`
(not `LineNbr` — they diverge)**, remember that key columns are hoisted to the
front and non-result keys appended at the end. Check the alignment by confirming
every captioned row lands on its matching property name. `references/platform.md`
gives the full rule.

Skipping this does not produce a few wrong names — it produces descriptions
attached to the wrong columns, which is worse than none.

**`[UNIVERSAL]` Hidden ≠ absent.** A result column flagged not-visible in the grid
still appears in the OData output. Visibility controls the *screen*, not the API.
Do not tell a reader a hidden column "may not be available" — verify against
`$metadata` and describe what is actually there.

**`[UNIVERSAL]` A result that is consistent with your hypothesis is not
confirmation.** Before saying "verified live", ask what result would have proved
you *wrong*. Querying a GI you believe has a hardcoded date cutoff and getting
recent rows back demonstrates nothing — recent rows arrive either way. Design a
test that can fail.

**`[UNIVERSAL]` Audit every bulk pull for silent truncation.** Row caps truncate
without an error and without a flag. A slice that returns exactly the cap is
truncated until proven otherwise. Drafting from a truncated conditions file
yields descriptions that omit real filters. `scripts/audit_truncation.mjs` checks
a directory of saved results for this.

**`[UNIVERSAL]` Verify through the consumer, not just the ERP.** A description
stored correctly in Acumatica can still never reach the model, because the
consuming tool has to match each stored description to a live property — and if
it matches by predicted name it will silently drop every column that has no
caption. Read one described GI back *through the tool the model will use* and
confirm the text is actually attached to fields. Storing 1 900 descriptions and
delivering half of them is a failure that no ERP-side read-back detects.

**`[UNIVERSAL]` On the contract API, HTTP 200 does not mean the write persisted.**
Observed on `GenericInquiry`: a `PUT` returned 200 and the value was never
stored. Verify writes by reading the record back and comparing, not by counting
successful responses.

**`[UNIVERSAL]` OData property names are derived from result-grid captions.**
Renaming a caption renames the API field, so caption edits are breaking changes,
and caption typos are permanent parts of the surface. If a caption reads
`AREHOUSE`, that is genuinely the property name — describe it as-is rather than
correcting it silently.

**`[UNIVERSAL]` Parameterized GIs return silently wrong data over OData.**
Queried without their parameters — which is how an agent queries — they return
default or unfiltered rows with no error. Exclude them from any AI-facing menu
regardless of how useful they look.

**`[UNIVERSAL]` One long request can wedge a whole session.** Under the plain
`api` scope each token is a single Acumatica session, so a slow call blocks every
subsequent contract-API call for that token. Run bulk work strictly sequentially.

More platform behaviour — filter dialects, row caps, virtual fields, detail
collections — is in `references/platform.md`. Read it before writing any bulk
query.

## What a good description contains

A description is read by a model deciding *which inquiry to use* and *how to read
the result*. It earns its place by answering questions the name cannot.

**GI level** — the grain (what one row represents), the filters baked into the
design, the questions it answers well, how to choose between it and its
near-twins, and the caveats that would otherwise produce a wrong number.

**Column level** — what the value means in business terms, its units or currency,
whether it is a key you can filter on, and the gotcha if there is one.

Full spec, worked examples and length guidance: `references/description-spec.md`.

## What to look for in the design

Most of the value is in catching things a reader would otherwise get wrong.
`references/design-signals.md` is a checklist of the patterns worth hunting —
mislabelled captions, duplicate columns, pre-aggregated values, cross-joined
calendars, INNER joins that drop rows, hardcoded IDs, hidden columns that conceal
the very measure the inquiry exists to report.

Work through it per GI. It is the difference between a description that restates
the caption and one that prevents a bad answer.

## A note on scope

Describing every GI in a large instance is usually the wrong goal. The point of
an opt-in gate is a *small, high-signal menu*; 800 well-described inquiries is
still 800 inquiries to choose between. Prefer a curated set the operator has
actually blessed, and say so if asked to describe everything.

Equally, when the design reveals a GI is broken, mislabelled or redundant, **say
so rather than describing the defect faithfully.** An accurate description of a
broken inquiry is a worse outcome than a fixed inquiry. Surface it; let the
operator decide.

## Bundled scripts

Run these rather than rewriting them — they encode the checks above.

- `scripts/audit_truncation.mjs <dir>` — flags any saved JSON result whose row
  count equals the cap, plus per-file row and distinct-GI counts.
- `scripts/build_brief.mjs` — condenses columns + joins + conditions into a
  compact per-GI brief. Renders `[ON ]`/`[off]` per condition; that marker is the
  point of the script.
- `scripts/validate_descriptions.mjs` — checks drafts against the real column
  list: unknown keys, duplicates, length limits, and descriptions that merely
  echo the name.

Each takes `--help`.
