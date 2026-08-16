# OData Filtering Guide

The MCP4Acumatica uses OData query parameters for filtering, sorting, field selection, and entity expansion.

> ## ⚠️ Two tools, two OData dialects
>
> **`acumatica_list_entities`** queries the contract-based REST API, which is **OData v3**.
> **`acumatica_run_inquiry`** queries Generic Inquiries over `/api/odata/gi`, which is **OData v4**.
> Filter syntax is **not** portable between them. Everything below documents **v3** unless a
> section says otherwise; see [Generic Inquiries use OData v4](#generic-inquiries-use-odata-v4)
> for the differences.
>
> | | `list_entities` (v3) | `run_inquiry` (v4) |
> |---|---|---|
> | Partial match | `substringof('n', Field)` | `contains(Field, 'n')` |
> | `substringof` | ✅ | ❌ *unknown function* |
> | `contains` | ❌ 500 | ✅ |
> | `startswith` / `endswith` | ✅ | ✅ |
> | `tolower` / `toupper` | ❌ 500 | ✅ |
> | Date literal | `datetimeoffset'2026-01-01'` | `2026-01-01T00:00:00Z` |
>
> *All rows verified live against a 25R2 instance, 2026-07-31.*

## Table of Contents

- [$filter -- Filtering Records](#filter----filtering-records)
- [$orderby -- Sorting Results](#orderby----sorting-results)
- [$select -- Field Selection](#select----field-selection)
- [$expand -- Including Sub-Entities](#expand----including-sub-entities)
- [$top -- Limiting Results](#top----limiting-results)
- [Common Patterns](#common-patterns)
- [Tips and Gotchas](#tips-and-gotchas)

---

## $filter -- Filtering Records

The `filterExpression` parameter maps to OData `$filter`. Use it to return only records matching specific criteria.

### Comparison Operators

| Operator | Description | Example |
|----------|-------------|---------|
| `eq` | Equal | `Status eq 'Open'` |
| `ne` | Not equal | `Status ne 'Cancelled'` |
| `gt` | Greater than | `Amount gt 10000` |
| `ge` | Greater than or equal | `Amount ge 5000` |
| `lt` | Less than | `Balance lt 100` |
| `le` | Less than or equal | `Quantity le 0` |

### Logical Operators

| Operator | Description | Example |
|----------|-------------|---------|
| `and` | Logical AND | `Status eq 'Open' and Amount gt 1000` |
| `or` | Logical OR | `Status eq 'Open' or Status eq 'Pending'` |
| `not` | Logical NOT | `not Status eq 'Cancelled'` |

### String Functions

| Function | Description | Example |
|----------|-------------|---------|
| `startswith(field, 'value')` | Starts with | `startswith(CustomerName, 'Acme')` |
| `endswith(field, 'value')` | Ends with | `endswith(Email, '@gmail.com')` |
| `substringof('value', field)` | Contains (case-insensitive). **Note the reversed argument order — needle first.** | `substringof('widget', Description)` |

> **Write the boolean functions BARE — do not append `eq true`:**
> Use `substringof('widget', Description)`, **not** `substringof('widget', Description) eq true`. Acumatica's contract-REST parser silently returns an empty set (HTTP 200, no error) for the compared form, even though it's valid OData v3. The MCP normalizes this for you — it strips a trailing `eq true` off `substringof`/`startswith`/`endswith` before sending — but pass the bare form to be safe. `eq false` is left as-is: the only equivalent negation (`not substringof(...)`) is rejected by Acumatica with a 500, so there is no reliable "does not contain" filter on the contract API.

> **Unsupported — these return a 500:**
> - `contains(field, 'value')` — this is OData v4 syntax. Acumatica's contract-based REST API is v3. Use `substringof` instead.
> - `tolower(field)` / `toupper(field)` — Acumatica's filter parser rejects these whether used standalone (`toupper(Status) eq 'OPEN'`) or nested inside other functions (`substringof('X', toupper(CustomerName))`). **`substringof` is already case-insensitive, so no casing helper is needed** — pass the needle in any casing and it will match.

### Date Filtering

Dates use the `datetimeoffset` format:

```
Date gt datetimeoffset'2026-01-01'
Date ge datetimeoffset'2026-01-01T00:00:00' and Date lt datetimeoffset'2026-02-01T00:00:00'
```

### Null Checks

```
ShipDate eq null
ShipDate ne null
```

### Compound Filters

Use parentheses for complex logic:

```
(Status eq 'Open' or Status eq 'Pending') and Amount gt 5000
CustomerClass eq 'LOCAL' and (Balance gt 0 or CreditHold eq true)
```

---

## $orderby -- Sorting Results

The `orderBy` parameter maps to OData `$orderby`. Sort results by one or more fields.

### Syntax

```
FieldName asc         -- ascending (default)
FieldName desc        -- descending
```

### Multiple Fields

Comma-separated, applied in order:

```
Status asc, Amount desc
CustomerName asc, Date desc
```

### Examples

| Expression | Description |
|------------|-------------|
| `Amount desc` | Largest amounts first |
| `Date asc` | Oldest first |
| `CustomerName asc` | Alphabetical by name |
| `Status asc, Amount desc` | Group by status, then largest first within each |

---

## $select -- Field Selection

The `selectFields` parameter maps to OData `$select`. Return only specific fields to reduce response size.

### Syntax

Comma-separated field names:

```
CustomerID,CustomerName,Status,Balance
```

### Examples

| Entity | Fields | Use Case |
|--------|--------|----------|
| `Customer` | `CustomerID,CustomerName,Balance` | Quick balance overview |
| `Invoice` | `ReferenceNbr,CustomerID,Amount,Status,Date` | Invoice summary list |
| `StockItem` | `InventoryID,Description,DefaultPrice` | Item catalog |
| `SalesOrder` | `OrderNbr,CustomerID,OrderTotal,Status` | Order pipeline |

### Discovering Field Names

Use `acumatica_describe_entity` to see all available field names for an entity:

```
acumatica_describe_entity(entityName: "Customer")
```

---

## $expand -- Including Sub-Entities

The `expand` parameter maps to OData `$expand`. Include related/nested records in the response.

### Syntax

Comma-separated sub-entity names:

```
Details,MainContact
```

### Common Expand Values by Entity

| Entity | Sub-Entities | Description |
|--------|--------------|-------------|
| `Customer` | `MainContact`, `BillingContact`, `ShippingContact` | Contact details |
| `SalesOrder` | `Details`, `ShippingSettings` | Line items, shipping |
| `Invoice` | `Details`, `TaxDetails` | Line items, taxes |
| `Bill` | `Details`, `TaxDetails` | Line items, taxes |
| `StockItem` | `WarehouseDetails`, `VendorDetails` | Warehouse qty, vendors |
| `PurchaseOrder` | `Details` | Line items |
| `Shipment` | `Details`, `Packages` | Line items, packages/tracking |
| `Employee` | `Contact`, `EmployeeSettings`, `FinancialSettings` | Full employee info |
| `ServiceOrder` | `Details`, `Appointments` | Line items, appointments |
| `Appointment` | `Services`, `Staff` | Service lines, assigned staff |
| `Opportunity` | `Products` | Opportunity products |
| `Event` | `Attendees` | Event attendees |
| `Task` | `RelatedActivities`, `RelatedTasks` | Linked CRM records |
| `Check` | `Details`, `History` | Payment lines, history |
| `Payment` | `DocumentsToApply`, `OrdersToApply` | Applied docs/orders |

---

## $top -- Limiting Results

The `topN` parameter maps to OData `$top`. Controls the maximum number of records returned.

- **Default:** `100`
- **Minimum:** `1`
- **Maximum:** Configurable via `ACUMATICA_MAX_RECORDS` (default `1000`, enforced server-side)

When results hit the limit, the response includes a note indicating there may be more records. Use `filterExpression` to narrow your query.

### Examples

| Value | Use Case |
|-------|----------|
| `5` | Quick sample / spot check |
| `20` | Top N analysis |
| `100` | Standard listing (default) |
| `1000` | Maximum (default server limit) |

---

## Common Patterns

### Find all open records of a type

```
entityName: "Invoice"
filterExpression: "Status eq 'Open'"
```

### Date range query

```
entityName: "SalesOrder"
filterExpression: "Date ge datetimeoffset'2026-01-01' and Date lt datetimeoffset'2026-04-01'"
```

### Top N by value

```
entityName: "Customer"
orderBy: "Balance desc"
topN: "10"
selectFields: "CustomerID,CustomerName,Balance"
```

### Search by name pattern

```
entityName: "Contact"
filterExpression: "startswith(LastName, 'Smith')"
```

### Multi-status filter

```
entityName: "SalesOrder"
filterExpression: "(Status eq 'Open' or Status eq 'BackOrder') and OrderTotal gt 1000"
orderBy: "OrderTotal desc"
```

### Include nested data

```
entityName: "SalesOrder"
filterExpression: "CustomerID eq '<customer-id — look up via acumatica_list_entities>'"
expand: "Details"
```

---

## Tips and Gotchas

1. **String values must be quoted** with single quotes: `Status eq 'Open'` (not `Status eq Open`)

2. **Field names are case-sensitive.** Use `acumatica_describe_entity` to get exact field names.

3. **Date format** must use `datetimeoffset'...'` syntax. Plain date strings won't work.

4. **Null comparisons** use `eq null` / `ne null`, not `is null`.

5. **No `$skip` support.** Acumatica's contract-based REST API does not support `$skip` for pagination. Use `$filter` with a key-based cursor pattern if you need to page through large result sets.

6. **`$top` is capped server-side** (default 1000). Requests for more are silently clamped. When results hit the limit, a note is returned. Use `$filter` and `$select` to keep queries focused.

7. **Sub-entity / child-collection fields** cannot be filtered directly in `$filter` — filter on header-level fields only. A filter that reaches into a child collection (e.g. `StockItem` by `CrossReferences/AlternateID`) errors; the MCP returns a structured `filterErrorKind: "child_collection"` message pointing you to a Generic Inquiry.

8. **Some complex document entities cannot be server-side `$filtered` except by their key field.** On `PurchaseOrder`, `Shipment`, and `PhysicalInventoryCount`, a broad/non-key filter (including `substringof`) on an unbound/computed/BQL-delegate field either errors (`CannotOptimizeException` and friends — surfaced as a `filterNotApplicable` message) **or silently returns `[]` even when matching records exist**. For these, filter on the key field for a single record (`OrderNbr`/`ShipmentNbr eq '<value>'`, `topN: 1`), and use a Generic Inquiry (`acumatica_run_inquiry`) for any broad search. When one of these returns 0 rows on a non-key filter, the MCP adds a `possibleFalseNegative` warning — don't read 0 as "no such record."

8. **Boolean values** use `true`/`false` (lowercase): `CreditHold eq true`

9. **Numeric values** don't use quotes: `Amount gt 10000` (not `Amount gt '10000'`)

10. **The `substringof` function** has reversed parameter order compared to other OData implementations: `substringof('search', FieldName)` (the search value comes first).

---

## Generic Inquiries use OData v4

`acumatica_run_inquiry` goes to `/t/{tenant}/api/odata/gi`, which is an **OData v4** endpoint. Its
parser errors are Microsoft.OData.Core wording (`An unknown function with name '...' was found`,
`Could not find a property named '...' on type '...'`), distinct from the contract API's
`CannotOptimizeException` family. Differences that matter:

**Partial match uses `contains`, with the field first:**

```
contains(Description, 'BAD')        -- correct on a GI
substringof('BAD', Description)     -- v3 syntax; fails with "unknown function 'substringof'"
```

**Dates are bare ISO-8601 instants** — no `datetimeoffset` prefix, no quotes:

```
CreatedOn gt 2024-01-01T00:00:00Z              -- correct on a GI
CreatedOn gt datetimeoffset'2024-01-01'        -- v3 syntax; "Unrecognized 'Edm.String' literal"
```

**`tolower` / `toupper` work here** (they 500 on `list_entities`), so case-insensitive matching can
be explicit: `contains(tolower(Description),'bad')`.

**`startswith` / `endswith` are identical in both dialects**, so those are safe to carry across.

**Property names are the inquiry's result-column captions**, not the underlying entity's field
names, and they are case-sensitive. Use `acumatica_describe_inquiry` to get the exact names — its
schema comes from the GI registry's `$metadata` resolution, so it is authoritative including any
`_N` collision suffixes.

**Calculated columns cannot be filtered — the inquiry fails with an empty body.** Many GI columns
are expressions rather than stored fields (a sign-normalized `Amount`, a `Balance` computed from two
history columns, a reformatted period). A `$filter` that references one makes Acumatica return
HTTP 200 with an *empty response body* — not an error, and not an empty list. Verified on
`Velixo-AP-Aging`:

```
AgingFinPeriodID eq '092026'                        -- works
AgingFinPeriodID eq '092026' and Amount ne 0        -- HTTP 200, empty body
```

Filter on stored columns (keys, dates, statuses, codes) and do the arithmetic on the returned rows.
For curated GIs the server knows which columns are expressions (the GI registry flags them during
its `$metadata` alignment): `acumatica_describe_inquiry` marks them `calculated: true`, and
`acumatica_run_inquiry` refuses a filter that references one *before* calling Acumatica, returning
an `invalid_filter` envelope that names the offending columns and lists the stored
(`filterableFields`) alternatives. On an uncurated GI (gate inactive, or a GI whose column
alignment was refused) no flags exist — there, if a filter that looks correct produces the
empty-body error, suspect the numeric/derived column first.

**Dropdown fields return display labels, not internal codes.** A GI projects the *label* Acumatica
shows on screen, and the filter is matched against that label:

```
DocType eq 'Bill'      -- matches
DocType eq 'BIL'       -- returns [] with no error, even though BIL is the stored code
```

The same applies to `Status` (`'Open'`, `'Closed'`) and to document types like `'Debit Adj.'` and
`'Credit Memo'`. When in doubt, run the inquiry once with no filter and read the actual values.

**Don't filter on appended key columns.** The trailing key columns a GI exposes (`Ord`, `LineNbr`,
`ReferenceNbr_2`, and similar) are internal join keys with no result column of their own. Filtering
them can return rows that do not exist in the unfiltered result: on `Velixo-AP-Aging`, a document
appears once per aging period with `Ord = 1`, yet `Ord eq 0` returns a parallel set of rows for the
same documents. Treat these columns as read-only output.

When a filter is rejected for one of these reasons, the tool no longer returns the bare Acumatica
message: it returns a structured `{ error: "invalid_filter", problem, useInstead, supportedFunctions
| availableFields, actionRequired }` envelope naming the correct syntax or the real column names, so
the next attempt can succeed. Importantly it also states that the query never executed — a rejected
filter must never be reported to the user as "no records matched".

---

## Note on the limitations above

Gotchas 5, 7, and 8 -- no `$skip`, no child-collection filtering, and the silent-`[]` /
`CannotOptimizeException` family on complex document entities -- are **not OData limitations**.
They are artifacts of the *contract-based REST API's* filter binder.

### DAC-based OData: evaluated 2026-07-31, not adopted

Acumatica **2025 R1+** exposes data access classes directly over OData 4.0 at
`/t/{tenant}/api/odata/dac`, which would sidestep that whole family. It was evaluated against this
deployment and **declined**. Recording the findings so the evaluation is not repeated:

- **It works.** The service root and a read of `SOOrder` both returned 200 with an ordinary user's
  token. Per-DAC access rights are enforced -- `Users`, `UsersInRoles`, and
  `CustomerPaymentMethodDetail` returned 403.
- **Entity sets are addressed by bare class name.** `SOOrder` works; `PX.Objects.SO.SOOrder`
  404s (the qualified form is the OData *type* name). Up to three aliases per DAC are advertised:
  underscored namespace path, bare class name, and a de-prefixed variant. 4766 sets in total.
- **No speed case at our scale.** Production latency over 95 days showed contract-REST and
  GI-OData medians within 5% (891 ms vs 941 ms). The claimed 2--10x advantage applies to bulk
  reads; these tools default to 100 rows, cap at 1000, and refuse pagination.
- **No rate-limit case.** Zero Acumatica 429s in 95 days -- the only limiter that binds is this
  server's own, which is self-imposed and configurable.
- **Redaction was not the obstacle it looked like.** Physical DAC field names match contract-entity
  names for PII (`DateOfBirth`, `TaxRegistrationID`), so the existing patterns fire unchanged.
- **The tempting win did not materialize.** `Users`/`UsersInRoles` are 403, so the login access gate
  still needs the canary GI rather than a direct role-membership query.

**What would change the decision:** a bulk workload -- export, reconciliation, a nightly sync.
There OData is the right surface and this evaluation does not apply.

Until then, prefer a Generic Inquiry for any read that gotchas 7 and 8 block.
