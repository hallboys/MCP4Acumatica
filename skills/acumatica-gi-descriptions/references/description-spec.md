# What to write

The reader is a model choosing an inquiry and interpreting its result. Write for
that job. Everything else is padding.

## GI-level descriptions

Cover, in roughly this order, skipping anything that does not apply:

1. **Grain** — what exactly one row represents. Lead with it.
2. **Scope** — the filters baked into the design, stated as what is *excluded*.
3. **Use for** — the questions it answers well.
4. **Choose this over** — disambiguation against near-twins and against any
   direct entity lookup that covers the same ground.
5. **Caveats** — currency basis, nullable joins, row multiplication, anything
   that would produce a wrong number.

Target 250–600 characters. Long enough to disambiguate, short enough that a
model reading a menu of them still has budget left.

**Only describe behaviour.** A switched-off condition changes nothing at runtime,
so it does not belong in the text — however interesting it is to an admin. Report
those separately.

### Example

> One row per **purchase receipt line**, joined to the item and its class and to
> the originating PO line. Use for received quantity and cost history by vendor,
> item, class, branch or date. `ExtCost` is line extended cost in base currency.
> Prefer this over the receipt getter when searching or aggregating across many
> receipts; use the getter when you already know the receipt number. No date
> filter is applied, so it spans all history — always constrain by date.

Note what it does *not* say: nothing about the tables as tables, no restatement
of the name, no hedging.

## Column-level descriptions

One or two sentences. Cover the meaning, then the gotcha if there is one:

- what the value means in business terms
- units, currency basis, or the value set for a coded field
- whether it is the column to filter/join on, or a display value
- the trap: nullable because left-joined, aggregated already, hidden, a string
  that looks like a date, a caption that disagrees with its source

Target 60–250 characters. A short precise description is better than a padded
one — "Item description. Display value only." is complete. Resist inflating it.

Prioritise: coded fields, amounts and quantities, dates, keys, anything derived
by formula, and any column whose caption you had to double-check. A column named
`VendorName` needs less help than one named `Past7`.

### Examples

> Quantity available at this location — on hand less allocations. Can be lower
> than QtyOnHand, and can go negative where over-allocated.

> COUNT of qualifying lines on that order, not a line number, despite being
> sourced from `lineNbr` — the inquiry aggregates.

> CAUTION: captioned `BranchID` but sourced from the branch CODE, not the numeric
> ID. Do not join it to the numeric `BranchID` in the GL inquiries.

## Tone

Write plainly and commit. "Null means not-yet-started, not missing data" is
useful; "may possibly indicate" is not. Where you genuinely could not determine
something from the design, say so explicitly and say what would settle it —
an honest gap is far better than a confident guess, and the reader can act on it.

Avoid restating the caption. If the description is the caption in a sentence, cut
it or find the fact worth adding.

## Consistency across a set

- Use one vocabulary for recurring concepts (grain, display value, aggregate,
  left-joined, hidden) so a reader learns it once.
- When two GIs share a trap, describe it in **both** — the reader may only see
  one.
- Cross-reference by exact GI name, since that is what the reader can act on.
