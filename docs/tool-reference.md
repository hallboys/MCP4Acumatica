# MCP4Acumatica -- Tool Reference

Complete specification for all 44 tools available in the MCP4Acumatica (v0.25.0).

## Table of Contents

- [Utility / Discovery Tools](#utility--discovery-tools)
- [Core](#core)
- [Financial / Accounting](#financial--accounting)
- [Inventory & Warehouse](#inventory--warehouse)
- [Purchasing](#purchasing)
- [Projects](#projects)
- [Service & Field](#service--field)
- [Sales & CRM](#sales--crm)
- [Shipping & Fulfillment](#shipping--fulfillment)
- [HR & Payroll](#hr--payroll)
- [CRM Activities](#crm-activities)

---

## Utility / Discovery Tools

### `acumatica_describe_entity`

Discover the fields, types, and sub-entities for any Acumatica entity. Use this before `acumatica_list_entities` to learn what fields are available for filtering, sorting, and selection.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `entityName` | string | Yes | Acumatica entity name (e.g., `Customer`, `Invoice`, `SalesOrder`) |

**Endpoint:** `GET /entity/Default/25.200.001/{entityName}/$adHocSchema`

---

### `acumatica_list_entities`

List or search any Acumatica entity with OData filtering, sorting, and field selection. Works with all entities in the Default endpoint. Always use `filterExpression` to scope queries — do not retrieve all records from large entities.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `entityName` | string | Yes | -- | Entity name (e.g., `Customer`, `Invoice`, `StockItem`) |
| `filterExpression` | string | No | -- | OData `$filter` expression (e.g., `Status eq 'Open'`) |
| `topN` | string | No | `"100"` | Maximum rows to return (max 1000). If truncated, refine filters — do not paginate. |
| `selectFields` | string | No | -- | Comma-separated field names (e.g., `CustomerID,CustomerName`) |
| `orderBy` | string | No | -- | OData `$orderby` expression (e.g., `Amount desc`) |
| `expand` | string | No | -- | Comma-separated sub-entities (e.g., `Details,MainContact`) |

**Endpoint:** `GET /entity/Default/25.200.001/{entityName}?$filter=...&$top=...&$select=...&$orderby=...&$expand=...`

> **Truncation semantics:** When the result set hits the per-query max (`ACUMATICA_MAX_RECORDS`, default 1000, runtime-overridable via the admin console), the response is wrapped as `{ results, truncated: true, paginationSupported: false, actionRequired: "..." }`. The model is instructed to stop and ask the user for a narrower `filterExpression` rather than calling the tool again.

---

### `acumatica_run_inquiry`

Execute any configured Generic Inquiry (GI) in Acumatica. Use this for custom reports and cross-entity queries configured by your Acumatica administrator. Use `acumatica_list_generic_inquiries` to discover GI names and `acumatica_describe_inquiry` to get field schema before calling this tool.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `inquiryName` | string | Yes | -- | Generic Inquiry name as configured in Acumatica |
| `filterExpression` | string | No | -- | OData `$filter` expression |
| `topN` | string | No | `"100"` | Maximum rows to return (max 1000). If truncated, refine filters — do not paginate. |
| `selectFields` | string | No | -- | Comma-separated field names to return |

**Endpoint:** `GET /t/{Company}/api/odata/gi/{inquiryName}?$filter=...&$top=...&$select=...`

> **Truncation semantics:** Same as `acumatica_list_entities` — when results hit the max, the response includes `truncated: true`, `paginationSupported: false`, and `actionRequired` text telling the model to ask the user for a narrower filter rather than calling again.

---

### `acumatica_list_generic_inquiries`

List all Generic Inquiries (GIs) exposed via OData in Acumatica. Returns inquiry names. Use this to discover available GI names before calling `acumatica_run_inquiry`.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `titleFilter` | string | No | -- | Partial name match to narrow results (case-insensitive contains) |
| `topN` | string | No | `"200"` | Maximum number of GIs to return |

**Endpoint:** `GET /t/{Company}/api/odata/gi` (OData service document)

**Returns:** Array of `{ inquiryName, url }` for each OData-exposed GI. Client-side name filtering is applied when `titleFilter` is provided.

---

### `acumatica_describe_inquiry`

Returns the field schema for a Generic Inquiry (GI) exposed via OData — field names and inferred types. Use this before calling `acumatica_run_inquiry` to know which fields are available for filtering and selection.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `inquiryName` | string | Yes | GI name. Use `acumatica_list_generic_inquiries` to discover names. |

**Endpoint:** `GET /t/{Company}/api/odata/gi/{inquiryName}?$top=1`

**Approach:** Probes the GI via OData with `$top=1` to retrieve a sample row and infers field names and data types from the response.

**Returns:** `{ inquiryName, fields: [{ fieldName, dataType }], sampleRow, note }`.

**Error handling:**
- GI not found (404): returns descriptive error suggesting `acumatica_list_generic_inquiries`
- GI requires filters (400): returns guidance to use `acumatica_run_inquiry` with a filter
- Empty results: returns empty field list with a note

---

### `acumatica_clear_cache`

Clear cached metadata (entity schemas, GI lists, GI field schemas). Use when Acumatica customizations have changed and cached schema data is stale. With no arguments, clears all cached metadata.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `target` | string | No | What to clear: `schema:EntityName` (one entity schema), `schemas` (all entity schemas), `gi` (GI list + metadata), `gi_schema:InquiryName` (one GI schema), or omit to clear everything |

**Caching details:** Entity schemas are cached for 24 hours. GI lists, GI metadata, and GI field schemas are cached for 1 hour. Cache is stored in KV with `cache:` key prefix.

**Returns:** `{ cleared: [...] }` listing the cache keys that were removed.

---

## Core

### `acumatica_get_customer`

Retrieve a customer record by Customer ID.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `customerId` | string | Yes | Customer ID (e.g., `C000001`) |

**Endpoint:** `GET /entity/Default/25.200.001/Customer/{customerId}`
**Expands:** `MainContact`, `BillingContact`, `ShippingContact`

**Returns:** Customer name, status, billing/shipping addresses, primary contact, credit terms, and balance.

---

### `acumatica_get_vendor`

Retrieve a vendor record by Vendor ID.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `vendorId` | string | Yes | Vendor ID (e.g., `V000001`) |

**Endpoint:** `GET /entity/Default/25.200.001/Vendor/{vendorId}`
**Expands:** `MainContact`

**Returns:** Vendor name, status, payment terms, tax info, and primary contact.

---

### `acumatica_get_sales_order`

Retrieve a sales order by order type and order number.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `orderType` | string | No | `SO` | Order type (e.g., `SO`) |
| `orderNbr` | string | Yes | -- | Order number |

**Endpoint:** `GET /entity/Default/25.200.001/SalesOrder/{orderType}/{orderNbr}`
**Expands:** `Details`, `ShippingSettings`

**Returns:** Header info, line items, totals, shipping details, and status.

---

## Financial / Accounting

### `acumatica_get_invoice`

Retrieve an AR invoice by type and reference number.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `type` | string | No | `Invoice` | Document type (`Invoice`, `Credit Memo`, `Debit Memo`) |
| `referenceNbr` | string | Yes | -- | Invoice reference number |

**Endpoint:** `GET /entity/Default/25.200.001/Invoice/{type}/{referenceNbr}`
**Expands:** `Details`, `TaxDetails`

**Returns:** Customer, amounts, balance, line items, tax details, due date, and status.

---

### `acumatica_get_bill`

Retrieve an AP bill by type and reference number.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `type` | string | No | `Bill` | Document type (`Bill`, `Credit Adj.`, `Debit Adj.`) |
| `referenceNbr` | string | Yes | -- | Bill reference number |

**Endpoint:** `GET /entity/Default/25.200.001/Bill/{type}/{referenceNbr}`
**Expands:** `Details`, `TaxDetails`

**Returns:** Vendor, amounts, balance, line items with PO linkage, tax details, due date, and status.

---

### `acumatica_get_journal_transaction`

Retrieve a GL journal transaction batch by batch number.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `batchNbr` | string | Yes | Journal batch number |

**Endpoint:** `GET /entity/Default/25.200.001/JournalTransaction/{batchNbr}`
**Expands:** `Details`

**Returns:** Module, ledger, post period, and detail lines with account, debit/credit amounts.

---

### `acumatica_get_payment`

Retrieve an AR payment by type and reference number.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `type` | string | No | `Payment` | Payment type (`Payment`, `Prepayment`, `Refund`, `Voided Check`) |
| `referenceNbr` | string | Yes | -- | Payment reference number |

**Endpoint:** `GET /entity/Default/25.200.001/Payment/{type}/{referenceNbr}`
**Expands:** `DocumentsToApply`, `OrdersToApply`

**Returns:** Customer, payment amount, method, applied documents/orders, available balance, and status.

---

### `acumatica_get_account`

Retrieve a GL account from the chart of accounts.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `accountCD` | string | Yes | GL account code (e.g., `10000`, `40000`) |

**Endpoint:** `GET /entity/Default/25.200.001/Account/{accountCD}`

**Returns:** Account type, class, group, description, currency, and active status.

---

### `acumatica_get_check`

Retrieve an AP check (vendor payment) by type and reference number.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `type` | string | No | `Check` | Document type (`Check`, `Prepayment`, `Voided Check`) |
| `referenceNbr` | string | Yes | -- | Check reference number |

**Endpoint:** `GET /entity/Default/25.200.001/Check/{type}/{referenceNbr}`
**Expands:** `Details`, `History`

**Returns:** Vendor, payment amount, method, cash account, unapplied balance, and status.

---

## Inventory & Warehouse

### `acumatica_get_stock_item`

Retrieve a stock item by inventory ID.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `inventoryID` | string | Yes | Inventory ID (e.g., `AALEGO500`) |

**Endpoint:** `GET /entity/Default/25.200.001/StockItem/{inventoryID}`
**Expands:** `WarehouseDetails`, `VendorDetails`

**Returns:** Description, item class, pricing (default, MSRP, cost), UOMs, warehouse details with qty on hand, and vendor details.

---

### `acumatica_get_non_stock_item`

Retrieve a non-stock item (service, labor, expense) by inventory ID.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `inventoryID` | string | Yes | Inventory ID for the non-stock item |

**Endpoint:** `GET /entity/Default/25.200.001/NonStockItem/{inventoryID}`

**Returns:** Description, item class, pricing, UOMs, and posting settings.

---

### `acumatica_get_inventory_quantity_available`

Retrieve real-time available quantity for an inventory item across all warehouses.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `inventoryID` | string | Yes | Inventory ID to check availability for |

**Endpoint:** `GET /entity/Default/25.200.001/InventoryQuantityAvailable/{inventoryID}`

**Returns:** On-hand, available, and allocated quantities.

---

### `acumatica_get_inventory_summary`

Retrieve aggregated inventory balances for an item, optionally filtered by warehouse.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `inventoryID` | string | Yes | Inventory ID to summarize |
| `warehouseID` | string | No | Optional warehouse ID to filter by |

**Endpoint:** `GET /entity/Default/25.200.001/InventorySummaryInquiry/{inventoryID}` (with optional warehouse filter)

**Returns:** Summary rows with on-hand, available, and other quantity breakdowns.

---

### `acumatica_get_warehouse`

Retrieve a warehouse by ID.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `warehouseID` | string | Yes | Warehouse ID (e.g., `MAIN`, `WHOLESALE`) |

**Endpoint:** `GET /entity/Default/25.200.001/Warehouse/{warehouseID}`
**Expands:** `Locations`

**Returns:** Description, active status, default locations, and all warehouse locations.

---

### `acumatica_get_item_class`

Retrieve an item class by class ID.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `classID` | string | Yes | Item class ID (e.g., `STOCKITEM`, `INTANGIBLE`) |

**Endpoint:** `GET /entity/Default/25.200.001/ItemClass/{classID}`

**Returns:** Item type, default UOMs, warehouse, valuation method, posting class, and availability calculation rule.

---

## Purchasing

### `acumatica_get_purchase_order`

Retrieve a purchase order by type and order number.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `type` | string | No | `Normal` | PO type (`Normal`, `DropShip`, `Blanket`) |
| `orderNbr` | string | Yes | -- | Purchase order number |

**Endpoint:** `GET /entity/Default/25.200.001/PurchaseOrder/{type}/{orderNbr}`
**Expands:** `Details`

**Returns:** Vendor, line items with quantities and costs, totals, terms, status, and promised date.

---

### `acumatica_get_purchase_receipt`

Retrieve a purchase receipt by type and receipt number.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `type` | string | No | `Receipt` | Receipt type (`Receipt`, `Return`) |
| `receiptNbr` | string | Yes | -- | Purchase receipt number |

**Endpoint:** `GET /entity/Default/25.200.001/PurchaseReceipt/{type}/{receiptNbr}`
**Expands:** `Details`

**Returns:** Vendor, line items with received quantities and costs, linked PO references, and warehouse.

---

## Projects

### `acumatica_get_project`

Retrieve a project by project ID.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `projectID` | string | Yes | Project ID |

**Endpoint:** `GET /entity/Default/25.200.001/Project/{projectID}`

**Returns:** Description, status, customer, template, financials (assets, liabilities, income, expenses).

---

### `acumatica_get_project_task`

Retrieve a project task by project ID and task ID.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `projectID` | string | Yes | Project ID |
| `projectTaskID` | string | Yes | Project task ID |

**Endpoint:** `GET /entity/Default/25.200.001/ProjectTask/{projectID}/{projectTaskID}`

**Returns:** Description, status, and whether it is the default task.

---

### `acumatica_get_project_budget`

Retrieve a project budget line by project, task, and account group.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `projectID` | string | Yes | Project ID |
| `projectTaskID` | string | Yes | Project task ID |
| `accountGroup` | string | Yes | Account group |
| `inventoryID` | string | No | Optional inventory ID for item-level budget |

**Endpoint:** `GET /entity/Default/25.200.001/ProjectBudget/{projectID}/{projectTaskID}/{accountGroup}`

**Returns:** Original/revised budgeted amounts, actuals, committed amounts, and completion percentage.

---

### `acumatica_get_project_transaction`

Retrieve a project transaction by module and reference number.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `module` | string | Yes | Module (e.g., `PM`, `AR`, `AP`, `GL`) |
| `referenceNbr` | string | Yes | Transaction reference number |

**Endpoint:** `GET /entity/Default/25.200.001/ProjectTransaction/{module}/{referenceNbr}`
**Expands:** `Details`

**Returns:** Detail lines with account, amount, project/task, employee, and quantities.

---

## Service & Field

### `acumatica_get_case`

Retrieve a support case by case ID.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `caseID` | string | Yes | Case ID (e.g., `C000001`) |

**Endpoint:** `GET /entity/Default/25.200.001/Case/{caseID}`

**Returns:** Subject, status, priority, severity, business account, contact, owner, SLA, time spent, and resolution details.

---

### `acumatica_get_service_order`

Retrieve a field service order by type and number.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `serviceOrderType` | string | No | `SL` | Service order type |
| `serviceOrderNbr` | string | Yes | -- | Service order number |

**Endpoint:** `GET /entity/Default/25.200.001/ServiceOrder/{serviceOrderType}/{serviceOrderNbr}`
**Expands:** `Details`, `Appointments`

**Returns:** Customer, status, priority, estimated/actual durations, totals, appointments, and line items.

---

### `acumatica_get_appointment`

Retrieve a field service appointment by type and number.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `serviceOrderType` | string | No | `SL` | Service order type |
| `appointmentNbr` | string | Yes | -- | Appointment number |

**Endpoint:** `GET /entity/Default/25.200.001/Appointment/{serviceOrderType}/{appointmentNbr}`
**Expands:** `Services`, `Staff`

**Returns:** Scheduled/actual dates and durations, customer, staff, services, cost, profit, and status.

---

## Sales & CRM

### `acumatica_get_contact`

Retrieve a CRM contact by contact ID.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `contactID` | string | Yes | Contact ID (numeric) |

**Endpoint:** `GET /entity/Default/25.200.001/Contact/{contactID}`

**Returns:** Name, email, phone, job title, company, business account, address, status, owner, and source.

---

### `acumatica_get_business_account`

Retrieve a business account (prospect, customer, or vendor) by ID.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `businessAccountID` | string | Yes | Business account ID |

**Endpoint:** `GET /entity/Default/25.200.001/BusinessAccount/{businessAccountID}`
**Expands:** `MainContact`

**Returns:** Name, type, status, class, main address, main contact, parent account, and owner.

---

### `acumatica_get_opportunity`

Retrieve a sales opportunity by ID.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `opportunityID` | string | Yes | Opportunity ID |

**Endpoint:** `GET /entity/Default/25.200.001/Opportunity/{opportunityID}`
**Expands:** `Products`

**Returns:** Subject, stage, status, amount, discount, total, business account, contact, products, source, and estimation date.

---

### `acumatica_get_lead`

Retrieve a marketing lead by lead ID.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `leadID` | string | Yes | Lead ID (numeric) |

**Endpoint:** `GET /entity/Default/25.200.001/Lead/{leadID}`

**Returns:** Name, email, phone, company, status, source, class, owner, address, and qualification date.

---

### `acumatica_get_salesperson`

Retrieve a salesperson by ID.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `salespersonID` | string | Yes | Salesperson ID |

**Endpoint:** `GET /entity/Default/25.200.001/Salesperson/{salespersonID}`

**Returns:** Name, active status, default commission percentage, and sales subaccount.

---

## Shipping & Fulfillment

### `acumatica_get_shipment`

Retrieve a shipment by shipment number.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `shipmentNbr` | string | Yes | Shipment number |

**Endpoint:** `GET /entity/Default/25.200.001/Shipment/{shipmentNbr}`
**Expands:** `Details`, `Packages`

**Returns:** Customer, warehouse, ship via, shipped quantities/weight/volume, packages with tracking numbers, line items, and freight details.

---

### `acumatica_get_sales_invoice`

Retrieve a sales invoice by type and reference number.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `type` | string | No | `Invoice` | Document type (`Invoice`, `Credit Memo`) |
| `referenceNbr` | string | Yes | -- | Sales invoice reference number |

**Endpoint:** `GET /entity/Default/25.200.001/SalesInvoice/{type}/{referenceNbr}`
**Expands:** `Details`, `TaxDetails`

**Returns:** Customer, amounts, balance, line items with SO/shipment linkage, tax details, and due date.

---

## HR & Payroll

### `acumatica_get_employee`

Retrieve an employee by employee ID.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `employeeID` | string | Yes | Employee ID (e.g., `EP00000001`) |

**Endpoint:** `GET /entity/Default/25.200.001/Employee/{employeeID}`
**Expands:** `Contact`, `EmployeeSettings`, `FinancialSettings`

**Returns:** Name, status, contact info, employee settings, and financial settings.

---

### `acumatica_get_expense_claim`

Retrieve an expense claim by reference number.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `refNbr` | string | Yes | Expense claim reference number |

**Endpoint:** `GET /entity/Default/25.200.001/ExpenseClaim/{refNbr}`
**Expands:** `Details`, `TaxDetails`

**Returns:** Claimant, date, total, line items with amounts, tax details, approval status, and customer/department.

---

### `acumatica_get_time_entry`

Retrieve a time entry by ID.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `timeEntryID` | string | Yes | Time entry ID (GUID) |

**Endpoint:** `GET /entity/Default/25.200.001/TimeEntry/{timeEntryID}`

**Returns:** Employee, date, project/task, time spent, billable time, overtime, earning type, cost rate, and approval status.

---

## CRM Activities

### `acumatica_get_email`

Retrieve a CRM email activity by note ID.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `noteID` | string | Yes | Email note ID (GUID) |

**Endpoint:** `GET /entity/Default/25.200.001/Email/{noteID}`

**Returns:** Subject, from/to/cc/bcc, body, mail status, related entity, and timestamps.

---

### `acumatica_get_event`

Retrieve a CRM event by note ID.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `noteID` | string | Yes | Event note ID (GUID) |

**Endpoint:** `GET /entity/Default/25.200.001/Event/{noteID}`
**Expands:** `Attendees`

**Returns:** Summary, start/end dates, location, priority, category, attendees, related entity, and show-as status.

---

### `acumatica_get_activity`

Retrieve a CRM activity by note ID.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `noteID` | string | Yes | Activity note ID (GUID) |

**Endpoint:** `GET /entity/Default/25.200.001/Activity/{noteID}`

**Returns:** Summary, type, status, date, owner, related entity, and body.

---

### `acumatica_get_task`

Retrieve a CRM task by note ID.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `noteID` | string | Yes | Task note ID (GUID) |

**Endpoint:** `GET /entity/Default/25.200.001/Task/{noteID}`
**Expands:** `RelatedActivities`, `RelatedTasks`

**Returns:** Summary, status, priority, due date, completion percentage, related activities/tasks, and owner.
