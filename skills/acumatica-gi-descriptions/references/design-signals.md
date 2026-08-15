# Design signals: what to hunt for in GI metadata

Work through this per GI. Each pattern below was found in real production
inquiries and each one, undescribed, produces a confidently wrong answer.

The examples are `[TENANT]` — they come from one instance. The *patterns* are
`[UNIVERSAL]`; you will find local equivalents of nearly all of them.

## Captions that name the wrong thing

The single richest source of findings. Compare every caption against its source
field and flag any divergence.

Real examples:
- A column captioned `Past7` that is `IIf(hour > 18,'Late','Ok')` — an
  after-6pm flag, nothing to do with seven days.
- `Trim Date` that is the scheduled start of *any* appointment, because no task
  filter exists.
- `Task ID Code` that is a *cost code* ID cast to an integer.
- `ProjectCD` sourced from a *location* code.
- `Created By Screen` sourced from `createdByID` — the user, not a screen.
- `Builder` holding an account *code* while the readable name sits in a hidden
  column.
- `BranchCD` holding a numeric branch *ID*.
- `BranchID` / `SubID` / `AccountiD` all holding *codes*, not IDs.
- `LineCount` sourced from `lineNbr` — a count, not a line number.

Watch especially for `*ID` captions on code fields and vice versa: they invite
joins that silently match nothing.

## The same caption meaning different things across GIs

Two sibling inquiries using one caption for different fields is worse than either
being wrong alone, because it invites a join. Seen: `EmployeeRef` as an account
reference in one GI and an employee *class* in another; `Owner Name` resolving to
a name in one feed and a raw ID in its twin.

When you spot one, say so in **both** descriptions.

## Duplicate columns

The same field output twice surfaces in OData as a `_2` variant, and a reader
reasonably infers two different measures. Note which pair is redundant and that
the values are identical.

Also watch for two columns with the *same caption* drawn from *different* tables
— those genuinely can disagree, and the description should say which is which.

## Pre-aggregated values

Count functions, ratios and figures pulled from nested sub-inquiries are already
rolled up. Re-summing them inflates everything. Flag:
- aggregate functions in the result grid,
- ratio columns (a ratio of sums cannot be averaged across groups),
- values sourced from another GI used as a table.

## Grain hazards

- **Cross-joined calendars.** An aging inquiry that joins the period calendar
  repeats every document once per period. Any `SUM` without pinning one period
  multiplies the answer. This is the highest-severity grain trap.
- **LEFT joins to child tables** repeat the parent — count distinct keys.
- **INNER joins to optional data** silently *drop* rows. An employee roster that
  inner-joins position records omits anyone without one, and the count looks
  plausible.
- **Order-level and line-level measures side by side.** Order totals repeat on
  every line; summing them multiplies by the line count.

## Filters that are not what they seem

- **Disabled conditions** (`IsActive = false`) — see the rule in SKILL.md.
- **`@me` / `@branch` style conditions** make results *user-dependent*. Two people
  get different answers and nobody sees the tenant.
- **Relative dates** (`@Today`, quarter-start, a computed fiscal-year start) mean
  the inquiry can only ever answer about now.
- **Hardcoded dates** silently stop meaning what the name says. One inquiry named
  "…CurrentYear" hardcoded a fixed start date.
- **Hardcoded IDs** in phase/label formulas yield a *blank* for anything
  unmapped, which reads as "no value" rather than "not in the formula".
- **A single-item or single-branch filter** left in from testing turns a general
  inquiry into a one-off.

## Currency

Where a field exists in both base and transaction currency, check which one each
caption actually points at. One inquiry named the *project-currency* column
plainly and the base-currency one explicitly — the reverse of every sibling.
Mixing them corrupts totals silently in a multi-currency tenant.

## Hidden columns — and the difference from inactive ones

**Hidden is not absent.** A column flagged not-visible still appears in the OData
output; visibility governs the *screen*. An **inactive** column (`IsActive`
false on the `GIResult` row) is the one that genuinely does not reach the API.
Confusing the two produces confident nonsense in both directions — phantom
columns described as real, and real columns dismissed as unavailable.

Verify against `$metadata` rather than reasoning from the visibility flag.

What hidden columns are still worth flagging:
1. **Does the inquiry hide the measure it exists to report?** SLA inquiries that
   hide their computed elapsed-time columns are awkward to use from the screen,
   even though the data is reachable over the API.
2. **Does it hide something a reader must respect?** Marketing consent flags
   hidden on a lead feed will never be seen by someone building a list from the
   screen. Describe those as consent controls, not plumbing.

## Types that are not what they look like

- **Attribute-backed fields are free text.** Dates and booleans held as
  user-defined attributes are strings; filtering them as dates misbehaves.
- **Concatenated "dates".** A column built by string concatenation into
  `M/D/YYYY` cannot be sorted or compared chronologically.
- **Constants.** A column returning a literal on every row is layout scaffolding,
  not data. Say so, so nobody reads meaning into it.
- **Magic values.** A formula that blanks one specific ID is encoding "none" —
  worth stating, since the raw value means something else.

## Structural smells worth reporting

These are not description material so much as things to escalate:

- **Sparse line numbering** (5 → 12 → … → 87 for 40 columns) indicates heavy
  editing; treat other assumptions about that GI with suspicion.
- **Two GIs identical field-for-field.** Verify by comparing the deduplicated
  column lists before claiming it — overlapping metadata pulls will otherwise
  make identical GIs look different.
- **Near-twins differing in one condition.** Document the actual difference; it
  is usually the only reason to choose one.
- **A GI returning HTTP 200 with an empty body** is broken, not empty. Do not
  describe it as though it works.
