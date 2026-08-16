# Platform behaviour that shapes this workflow

Acumatica-specific constraints encountered doing bulk GI metadata work. The
companion `acumatica-gotchas` skill covers general integration tripwires; this
file is only what bites *this* task.

## Querying GI metadata over OData

**`[UNIVERSAL]` An `or` of two `startswith()` predicates can return an empty 200.**
On the OData GI endpoint, `startswith(X,'A') or startswith(X,'B')` came back with
an empty body — no error, no rows. Single predicates work; so do `ge`/`lt`
ranges. This is the same silently-wrong-answer class as an unreported truncation,
and it is easy to read as "no matching GIs".

Partition with ranges instead:

```
GIName ge 'F' and GIName lt 'P'
```

**`[UNIVERSAL]` Virtual/computed fields cannot be filtered server-side.** A
parameter *count* on a GI-of-GIs is typically computed, and filtering on it
returns `Filter on '{0}' is not allowed because it is a virtual field`. Pull and
filter locally.

**`[UNIVERSAL]` Results are unsorted**, so you cannot page by last-seen key.
Combined with a row cap and no total count, the only safe approach is
non-overlapping ranges plus a truncation audit.

**`[UNIVERSAL]` Row caps truncate silently.** No error, no flag, no count. Treat
any slice returning exactly the cap as truncated. If the consuming tool exposes a
configurable cap, raising it temporarily is far cheaper than re-slicing — but the
audit still applies.

**Practical tip.** When a tool spills large results to disk but keeps small ones
inline, selecting *more* columns pushes a result over the spill threshold and
keeps bulk data out of your context. Choosing fields that are also useful signals
(created date, last modified, entry screen) gets you both.

## Reading and writing GI design records

**`[UNIVERSAL]` `GIDesign` / `GIResult` are system DACs** and are absent from the
stock `Default` contract endpoint. Reaching them needs either a GI built over
them, or a custom Web Service Endpoint exposing `GenericInquiry`.

**`[UNIVERSAL]` HTTP 200 ≠ persisted.** Verify by reading back. See the rule in
SKILL.md.

**`[UNIVERSAL]` Check the cardinality of the result-grid detail.** If the endpoint
maps it as a single nested entity rather than a collection:
- reads return only the first row regardless of `$expand`;
- the navigation property errors;
- **writes ignore the line-number key and land on row one**, returning 200.

Test this on a disposable GI before any bulk column write. Targeting line 5 and
finding the text on line 1 is the tell.

**`[UNIVERSAL]` Filtering on a GUID field uses v3 literal syntax** on the contract
API: `DesignID eq guid'…'`. A bare quoted string raises a binary-operator type
error. Guid-keyed filters were also markedly faster than filtering on the
inquiry name.

**`[TENANT]` Some GIs cannot be saved through the API at all.** A GI referenced by
another GI raises an interactive "overwrite or save a copy?" dialog on save; the
contract API cannot answer it, so the save rolls back with an opaque 500. A GI
carrying an invalid mass-update field row fails validation with a 422 naming the
field. Both need the UI.

## Sessions and tokens

**`[UNIVERSAL]` The plain `api` scope gives one session per token.** A single slow
request blocks every subsequent contract-API call for that token — across
endpoints — and killing the client does not release it. Run sequentially.

**`[UNIVERSAL]` Never consume a stored refresh token out of band.** IdentityServer
rotates refresh tokens on use. If a server holds the authoritative copy, using it
yourself leaves that server with a stale token and can revoke the user's grant.
Trigger a refresh through the normal path instead, then re-read the stored token.

## Consuming side

**`[UNIVERSAL]` Parameterized GIs must never reach an AI menu.** Queried without
parameters they return default or unfiltered rows with no error.

**`[UNIVERSAL]` Caption → property name — but only when a caption exists.**
`GIResult.Caption` is an *override*, not the displayed label. Where it is set, the
caption becomes the OData property name, so:
- caption changes are breaking API changes;
- typos are permanent (`AREHOUSE`, `AccountiD`);
- captions with spaces or punctuation get stripped;
- duplicate captions produce `_2` suffixes.

Where it is **not** set — a clear majority of columns in practice; 57 % in one
production instance, with entire GIs at 100 % — the property name comes from the
underlying field's display name, which **no design table exposes**. `SchemaField`
is the documented fallback and is mostly `null`; where it is populated it is
DAC-qualified (`INTran.RefNbr`) and so never matches a bare property name anyway.

**There is therefore no way to predict property names from the design.** Get them
from `$metadata` and join positionally — see below.

**`[UNIVERSAL]` Fetch `$metadata` once instead of describing each GI.**
`/t/{tenant}/api/odata/gi/$metadata` returns every exposed GI's full property list
with declared types in a single request (≈450 KB / <1 s for ~300 GIs). It is the
same source a per-GI describe call reads, and it avoids pulling a sample row of
real business data per GI into context.

**`[UNIVERSAL]` Joining design rows to live properties is positional, and the
order is not `LineNbr`.** The mapping that actually holds:

1. `GIResult.SortOrder` — *not* `LineNbr` — is the result-grid order. The two
   diverge freely, and `SortOrder` values repeat where a row is inactive.
2. Drop inactive rows. The count of active rows equals the count of *result*
   properties exactly; use that equality as your check.
3. Properties that are also **entity keys are hoisted to the front** of
   `$metadata`, in key order, out of grid order. This affected 108 of 115 GIs in
   one instance, so treat it as the normal case, not an edge case.
4. Keys that are *not* result columns are **appended at the end** with no design
   row at all. They are real, queryable, and undescribable from the design.

So: `properties = [hoisted key columns] ++ [remaining active rows by SortOrder]
++ [appended non-result keys]`. Validate any alignment by checking that every
row that *does* carry a caption lands on the matching property name; if a single
captioned row misaligns, the whole mapping is wrong.

**`[UNIVERSAL]` The hoist choice is the one genuinely ambiguous part of the
mapping — sample the data before trusting it.** Once you know how many key
columns are hoisted, everything else is fixed: the remaining rows follow
`SortOrder`. So the *only* freedom is **which** rows get hoisted, and where those
rows carry no caption there is nothing to determine it. An aligner will then pick
one arbitrarily and report success.

Seen in production on `AP-Bills and Adjustments`: four keys are hoisted, one of
them the vendor code. Getting that single hoist wrong shifted every uncaptioned
column by one — `Amount` was attributed to the row holding the vendor's invoice
number, `Vendor` to the currency row — while the captioned columns near the end
still matched, so the alignment looked valid. A live sample settled it in one
query: `Vendor` returns `P-SANCHE9` and `Amount` returns `487.5`.

Name-similarity heuristics do **not** settle it. They produce false positives in
both directions: `EmployeeId ← acctCD` scores zero and is correct, while
`refNbr → ReferenceNbr` and `branchCD → BranchID` are correct but fail naive
string matching because the source field is abbreviated.

**So: before writing descriptions for a GI, query a few rows and check that each
property's values match what its design row implies** — a code where you expect a
code, an amount where you expect an amount. One query per GI, and it is the only
check that reliably catches a shifted hoist.

**`[UNIVERSAL]` An active result column can silently produce no property at all.**
Where two result columns resolve to the same property name — the same DAC field
output twice, or the same field name drawn from two different DACs — the platform
sometimes emits a `_2` variant and sometimes just **discards the later one**.
Verified: `FS-Equipment` outputs `FSEquipment.disposalDate` at line 20 (no
caption) and again at line 30 (captioned "Exp Removal Date:"); only one
`DisposalDate` property exists, and the *captioned* row is the one that vanishes —
its caption is not honoured anywhere in the output.

So active-row count does **not** always equal property count, and a column a user
can see on screen may be unreachable for every API consumer. Report these: a
description written against one is wasted, and the discrepancy is invisible from
the GI screen. Never let a "dropped" verdict absorb a row whose caption matches a
property that actually exists — that is a misalignment being rationalised, not a
drop.

**`[UNIVERSAL]` A GI whose name contains `/` is unreachable over OData.** It can
be flagged "expose via OData" and still be absent from `$metadata` and return 404
for every encoding of its name, raw or percent-encoded. Verified live. Such a GI
cannot be queried by any consumer — rename it or drop it from the menu rather
than describing it.

Describe property names as they actually are, not as they should have been.
