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
