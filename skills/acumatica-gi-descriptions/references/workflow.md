# Workflow: inventory → select → pull → brief → draft → validate → load

Concrete steps. Read `platform.md` alongside this — the slicing strategy below
exists because of constraints documented there.

## 1. Inventory

You need every GI with its parameter count and exposure flags. Two routes:

**`[TENANT]` A meta-GI over `GIDesign`.** Many instances already have one (look
for a GI named something like `GenericInquiries`). Ideal columns: inquiry name,
`ExposeViaOData`, the AI-exposure flag, a parameter count, entry screen,
`DesignID`, created-by and created-date.

**`[UNIVERSAL]` Build one.** `GIDesign` is a system DAC, so it is reachable only
through a GI over itself or a custom contract endpoint — not the stock `Default`
endpoint. The `acumatica/` folder of this repo ships importable examples.

Watch for:
- **A parameter count derived by formula is often a virtual field**, and virtual
  fields cannot be filtered server-side. Pull everything and filter locally.
- **Results are not sorted**, so keyset pagination is impossible. Partition with
  range predicates on the name (`ge` / `lt`), not with `or`-ed prefixes.

## 2. Select

Score candidates on signals you can compute, then have the operator approve. What
worked well:

| Signal | Why it matters |
|---|---|
| Already exposed via OData | someone intended machine access |
| Tied to an entry screen | usually a maintained, business-relevant inquiry |
| Recently created or modified | abandoned analyst work is the bulk of most instances |
| Already tagged for AI | existing curation, worth honouring |

Exclude by class, not one by one:
- **Parameterized** — returns silently wrong data over OData. Non-negotiable.
- **Business-event triggers** — names ending `BE`, or containing `Notification`,
  `Auto-Send`, `Automatically Create`, `on Pending Approval`. These *fire
  automation*; they are not query targets.
- **Junk** — `…-DELETE`, `test …`, scratch names, obvious duplicates.
- **Integration feeds for other products** `[TENANT]` — prefixes belonging to
  middleware or mobile apps. Confirm with the operator; some (reporting-tool
  extracts built for OData) are genuinely useful and should stay.

Give the operator the full scored list plus a recommendation. They know which
inquiries are load-bearing; the score does not.

## 3. Pull design metadata

Three grains, so three queries per selection — a GI has one row grain, and
columns, joins and conditions are different children of `GIDesign`:

- **Result columns** — `GIResult`: line number, object/alias, field, caption,
  visibility, and the AI-description field.
- **Joins** — `GITable` + `GIRelation` + `GIOn`: aliases, DAC names, join types,
  and the on-conditions.
- **Conditions** — `GIWhere`: line number, **`IsActive`**, brackets, data field,
  condition, values, and the and/or operator.

Slice with range predicates sized so nothing hits the cap, then audit:

```
node scripts/audit_truncation.mjs <results-dir>
```

Anything at exactly the cap gets re-sliced. Condition and column rows are far
denser per GI than intuition suggests — expect to re-slice more than once.

## 4. Build the brief

Raw metadata is too voluminous to write from directly. Condense to one block per
GI: DAC list, join summary, column list with source fields, and conditions **with
their on/off marker**.

```
node scripts/build_brief.mjs --cols <f> --joins <f> --where <f> --out brief.md
```

Read the brief, not the raw rows.

## 5. Draft

GI level first — the grain and the baked-in filters are what the column
descriptions hang off. Then columns, one GI at a time.

Work through `design-signals.md` per GI as you go. Format and length guidance is
in `description-spec.md`.

## 6. Validate

```
node scripts/validate_descriptions.mjs --drafts <f> --cols <f>
```

Checks that every draft targets a real column, that none are duplicated or
missing, that lengths fit the field, and that nothing merely restates the name.

The field limits `[TENANT]` depend on how the custom fields were defined — commonly
2000 characters for the GI-level field and 1000 for the column-level one. Confirm
against the customization rather than assuming.

## 7. Load, then verify

`[UNIVERSAL]` `GIDesign` and `GIResult` are not in the stock contract endpoint, so
there is no REST write path by default. Options, best first:

1. **Expose `GenericInquiry` on a custom contract endpoint.** Gives a real API.
   Confirm the entity exposes the description field, the exposure flags *and* a
   human-readable name; and check whether the result-grid detail is mapped as a
   **collection** rather than a single nested entity — if it is a single entity,
   reads return only the first row and writes silently target it regardless of
   the line number you supply.
2. **An Import Scenario on the GI screen.** Keyed by inquiry name plus result
   line number. Viable for bulk, but it writes to the screen that *defines* every
   GI — get the match-versus-create semantics right before running it.
3. **In-grid editing via an editor GI.** Fine for tens of GI-level descriptions;
   impractical for thousands of columns, since mass update sets one value across
   many rows rather than pasting distinct values.

Then verify by reading every record back and comparing to intent. A run log of
successful responses is not evidence.

Expect a residue that cannot be written by API `[TENANT]`: a GI referenced by
another GI raises a save-time dialog the contract API cannot answer, and a GI
carrying an invalid mass-update field fails validation. Hand those to the
operator with the text ready to paste.

## 8. Tidy up

- Untag any meta-GIs you exposed to read metadata — they are infrastructure and
  should not sit in the model's menu.
- Clear whatever registry cache the consuming tool keeps, then confirm the new
  descriptions are actually being served.
- Record which GIs need fixing rather than describing (see the closing note in
  SKILL.md).
