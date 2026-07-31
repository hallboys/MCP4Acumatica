# OData Filtering Guide

The MCP4Acumatica uses OData query parameters for filtering, sorting, field selection, and entity expansion. This guide covers the syntax supported by the `acumatica_list_entities` and `acumatica_run_inquiry` tools.

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

## Note on the limitations above

Gotchas 5, 7, and 8 -- no `$skip`, no child-collection filtering, and the silent-`[]` /
`CannotOptimizeException` family on complex document entities -- are **not OData limitations**.
They are artifacts of the *contract-based REST API's* filter binder. A genuine OData 4.0
implementation handles all three.

Acumatica **2025 R1** added exactly that: a **DAC-based OData endpoint** at
`/t/{tenant}/api/odata/dac`, exposing data access classes directly (entities named by class,
e.g. `PX.Objects.SO.SOOrder`, with navigation properties such as `SOLineCollection`) with no
Generic Inquiry required. Per Acumatica's documentation it honors each user's existing access
rights -- *"users have access to the same data that is visible to them in the UI based on their
access rights"* -- so it does not bypass row- or field-level security.

**This server does not use it today.** Reads go through contract REST (keyed lookups, and the
one surface that also supports writes), and search rides Generic Inquiries over
`/t/{tenant}/api/odata/gi`. Two things need resolving before it could replace the search path:

1. **Does a normal user role suffice?** There are community reports that the DAC endpoint
   requires an elevated *OData v4 User* role, which the official documentation neither confirms
   nor denies. If true it is unusable here, since this server's entire access model is each
   user's own Acumatica role. **The preflight page (`/docs/admin/preflight`) can now answer this
   directly** -- the "DAC-based OData probe (authenticated)" form takes a connected user's
   Acumatica username, borrows their stored token, and reports whether the endpoint exists and
   whether an ordinary role can read it. Each run is audit-logged, and the request reaches
   Acumatica as that user.
2. **Field redaction is matched on field names.** `src/lib/redact.ts` patterns are tuned to
   contract-entity field names; DAC field names are physical and would need re-validating, or
   sensitive fields would silently stop being redacted.

Until both are closed, prefer a Generic Inquiry for any read that gotchas 7 and 8 block.

### Verified on this deployment (25R2, 2026-07-31)

The authenticated probe confirms the endpoint **works**: the service root and a read of `SOOrder`
both succeeded. What it does *not* establish is whether a non-administrator can read it -- the
test ran as an Administrator, which may carry the **OData v4** role implicitly. Acumatica has an
explicit OData v4 role, so users may need it granted. That is a setup prerequisite of the same
kind as the `MCP Access` role, not an obstacle.

**Entity sets are addressed by bare class name.** `PX.Objects.SO.SOOrder` returns 404;
`SOOrder` returns 200. Acumatica's documentation shows the namespace-qualified form, but that is
the OData *type* name, not the entity set. The service document advertises up to three aliases
per DAC -- the namespace path with underscores (`AA_Objects_Labels_ALAutoPrint`), the bare class
name (`ALAutoPrint`), and a de-prefixed variant (`AutoPrint`). Use the bare class name.

The instance advertises **4766 entity sets**, but that count is not itself an obstacle: tools
address entities *by name* -- the same way the 38 `acumatica_get_*` getters and
`acumatica_list_entities` already do -- so the catalogue is never handed to the model. (Unlike
Generic Inquiries, where `acumatica_list_generic_inquiries` puts the menu directly into context,
which is what the GI opt-in gate exists to control.) The count matters only in that `$metadata`
should never be fetched from a tool at that scale, and that a curated set of exposed entities is
still worth having for discoverability.

**What genuinely remains before a DAC read path could ship:**

1. **Redaction.** `src/lib/redact.ts` matches on field *names*, and physical DAC field names
   differ from contract-entity names. The patterns must be re-validated against real DAC output
   or sensitive fields silently stop being redacted. This is the actual blocker.
2. **Row-level security.** Acumatica's docs say access mirrors UI visibility, but a 200 for an
   Administrator proves only that the request was allowed, not that rows are filtered for a
   restricted user. Verify with a deliberately limited account.
3. **A field-name source.** The offline schema index (`scripts/build-schema-index.mjs`) is built
   from the contract API's `swagger.json` and so does not describe DAC fields. A DAC read path
   needs its own field metadata, which the same ingestion pattern could provide from `$metadata`
   offline.
