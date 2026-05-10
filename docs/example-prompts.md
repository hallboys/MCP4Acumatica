# MCP4Acumatica -- Example Prompts

Example prompts for Claude (or any MCP client) using the MCP4Acumatica. Each example shows the prompt and which tools Claude will invoke.

> **Note on IDs:** Specific IDs in these examples (e.g. `C000042`, `AALEGO500`, `MAIN`, `EP00000001`, `40000`) are illustrative only. Acumatica numbering sequences are configured per instance — your customer/inventory/warehouse/employee/account codes will follow whatever format your administrator set up.

## Table of Contents

- [Getting Started](#getting-started)
- [Customer & Sales](#customer--sales)
- [Financial / Accounting](#financial--accounting)
- [Inventory & Warehouse](#inventory--warehouse)
- [Purchasing](#purchasing)
- [Projects](#projects)
- [Service & Field](#service--field)
- [CRM](#crm)
- [HR & Payroll](#hr--payroll)
- [Data Analysis Workflows](#data-analysis-workflows)
- [Generic Inquiries](#generic-inquiries)

---

## Getting Started

### Discover what fields an entity has

> "What fields are available on the Customer entity?"

**Tools invoked:** `acumatica_describe_entity` (entityName: `Customer`)

### Find records matching criteria

> "Show me all customers in California"

**Tools invoked:**
1. `acumatica_describe_entity` (entityName: `Customer`) -- to discover field names
2. `acumatica_list_entities` (entityName: `Customer`, filterExpression: `State eq 'CA'`)

---

## Customer & Sales

### Look up a specific customer

> "Get me the details for customer C000042"

**Tools invoked:** `acumatica_get_customer` (customerID: `C000042`)

### Find customers with overdue balances

> "List all customers with a balance over $10,000"

**Tools invoked:** `acumatica_list_entities` (entityName: `Customer`, filterExpression: `Balance gt 10000`, orderBy: `Balance desc`)

### Look up a sales order

> "Show me sales order SO-005432"

**Tools invoked:** `acumatica_get_sales_order` (orderType: `SO`, orderNbr: `005432`)

### Find open sales orders for a customer

> "What open sales orders does customer C000042 have?"

**Tools invoked:** `acumatica_list_entities` (entityName: `SalesOrder`, filterExpression: `CustomerID eq 'C000042' and Status eq 'Open'`)

### Recent large sales orders

> "Show me the 10 largest sales orders from the last 30 days"

**Tools invoked:** `acumatica_list_entities` (entityName: `SalesOrder`, filterExpression: `Date gt datetimeoffset'2026-03-08'`, orderBy: `OrderTotal desc`, topN: `10`)

---

## Financial / Accounting

### Look up an invoice

> "Get invoice INV-001234"

**Tools invoked:** `acumatica_get_invoice` (type: `Invoice`, referenceNbr: `001234`)

### Find unpaid invoices

> "Show all open invoices over $5,000 sorted by amount"

**Tools invoked:** `acumatica_list_entities` (entityName: `Invoice`, filterExpression: `Status eq 'Open' and Amount gt 5000`, orderBy: `Amount desc`)

### Look up an AP bill

> "Show me bill BL-000789"

**Tools invoked:** `acumatica_get_bill` (type: `Bill`, referenceNbr: `000789`)

### GL journal entry details

> "Show me the journal entry for batch GL-000123"

**Tools invoked:** `acumatica_get_journal_transaction` (batchNbr: `GL-000123`)

### Chart of accounts lookup

> "What is GL account 40000?"

**Tools invoked:** `acumatica_get_account` (accountCD: `40000`)

### AP check details

> "Show me check CHK-005678"

**Tools invoked:** `acumatica_get_check` (type: `Check`, referenceNbr: `005678`)

### AR payment details

> "Get the details on payment PMT-001111"

**Tools invoked:** `acumatica_get_payment` (type: `Payment`, referenceNbr: `001111`)

---

## Inventory & Warehouse

### Stock item details

> "Tell me about stock item AALEGO500"

**Tools invoked:** `acumatica_get_stock_item` (inventoryID: `AALEGO500`)

### Check inventory availability

> "How much of AALEGO500 do we have available?"

**Tools invoked:** `acumatica_get_inventory_quantity_available` (inventoryID: `AALEGO500`)

### Inventory by warehouse

> "Show me inventory summary for AALEGO500 in the MAIN warehouse"

**Tools invoked:** `acumatica_get_inventory_summary` (inventoryID: `AALEGO500`, warehouseID: `MAIN`)

### Find low-stock items

> "Which stock items have less than 10 units on hand?"

**Tools invoked:** `acumatica_list_entities` (entityName: `StockItem`, filterExpression: `DefaultPrice gt 0`, selectFields: `InventoryID,Description,DefaultPrice`)

> *Note: Quantity on hand is typically checked via the InventoryQuantityAvailable entity or a Generic Inquiry configured for low-stock alerts.*

### Warehouse details

> "Show me the MAIN warehouse details and locations"

**Tools invoked:** `acumatica_get_warehouse` (warehouseID: `MAIN`)

---

## Purchasing

### Purchase order details

> "Show me PO-001234"

**Tools invoked:** `acumatica_get_purchase_order` (type: `Normal`, orderNbr: `001234`)

### Find open purchase orders

> "List all open purchase orders sorted by total descending"

**Tools invoked:** `acumatica_list_entities` (entityName: `PurchaseOrder`, filterExpression: `Status eq 'Open'`, orderBy: `OrderTotal desc`)

### Purchase receipt

> "Show receipt RC-000456"

**Tools invoked:** `acumatica_get_purchase_receipt` (type: `Receipt`, receiptNbr: `000456`)

---

## Projects

### Project overview

> "Give me the details on project PROJ-001"

**Tools invoked:** `acumatica_get_project` (projectID: `PROJ-001`)

### Project budget vs actuals

> "Show me the budget for project PROJ-001, task PHASE1, account group LABOR"

**Tools invoked:** `acumatica_get_project_budget` (projectID: `PROJ-001`, projectTaskID: `PHASE1`, accountGroup: `LABOR`)

### Find active projects

> "List all active projects"

**Tools invoked:** `acumatica_list_entities` (entityName: `Project`, filterExpression: `Status eq 'Active'`)

### Project transactions

> "Show me the PM transactions for reference PMT-000123"

**Tools invoked:** `acumatica_get_project_transaction` (module: `PM`, referenceNbr: `PMT-000123`)

---

## Service & Field

### Support case details

> "Show me case C000001"

**Tools invoked:** `acumatica_get_case` (caseID: `C000001`)

### Find open high-priority cases

> "List all open cases with high priority"

**Tools invoked:** `acumatica_list_entities` (entityName: `Case`, filterExpression: `Status eq 'Open' and Priority eq 'High'`)

### Service order details

> "Show service order SL-000789"

**Tools invoked:** `acumatica_get_service_order` (serviceOrderType: `SL`, serviceOrderNbr: `000789`)

### Appointment details

> "Show me appointment APT-001234"

**Tools invoked:** `acumatica_get_appointment` (serviceOrderType: `SL`, appointmentNbr: `001234`)

---

## CRM

### Contact lookup

> "Show me contact 12345"

**Tools invoked:** `acumatica_get_contact` (contactID: `12345`)

### Find leads by source

> "Show all leads from the Web source"

**Tools invoked:** `acumatica_list_entities` (entityName: `Lead`, filterExpression: `Source eq 'Web'`)

### Opportunity pipeline

> "List all open opportunities over $50,000 sorted by amount"

**Tools invoked:** `acumatica_list_entities` (entityName: `Opportunity`, filterExpression: `Status eq 'Open' and Amount gt 50000`, orderBy: `Amount desc`)

### Business account lookup

> "Show me business account ACME"

**Tools invoked:** `acumatica_get_business_account` (businessAccountID: `ACME`)

### Recent emails for a contact

> "Show me recent email activities"

**Tools invoked:** `acumatica_list_entities` (entityName: `Email`, orderBy: `Date desc`, topN: `20`)

---

## HR & Payroll

### Employee lookup

> "Get employee EP00000001"

**Tools invoked:** `acumatica_get_employee` (employeeID: `EP00000001`)

### Expense claim details

> "Show me expense claim EC-000123"

**Tools invoked:** `acumatica_get_expense_claim` (refNbr: `EC-000123`)

### Find pending expense claims

> "List all expense claims pending approval"

**Tools invoked:** `acumatica_list_entities` (entityName: `ExpenseClaim`, filterExpression: `Status eq 'Pending'`)

---

## Data Analysis Workflows

These examples show multi-step workflows where Claude chains multiple tools together.

### Customer aging analysis

> "Analyze our top 20 customers by outstanding balance and show me their overdue invoices"

**Tools invoked (multi-step):**
1. `acumatica_list_entities` (entityName: `Customer`, orderBy: `Balance desc`, topN: `20`, selectFields: `CustomerID,CustomerName,Balance`)
2. For each top customer: `acumatica_list_entities` (entityName: `Invoice`, filterExpression: `CustomerID eq '{id}' and Status eq 'Open'`)

### Vendor spending report

> "Show me our top 10 vendors by purchase order volume this quarter"

**Tools invoked (multi-step):**
1. `acumatica_list_entities` (entityName: `PurchaseOrder`, filterExpression: `Date gt datetimeoffset'2026-01-01' and Status ne 'Cancelled'`, orderBy: `OrderTotal desc`, selectFields: `VendorID,OrderTotal,Status,Date`)
2. Claude aggregates and summarizes the data

### Schema-driven exploration

> "I want to analyze sales invoices but I don't know what fields are available. Help me explore."

**Tools invoked (multi-step):**
1. `acumatica_describe_entity` (entityName: `SalesInvoice`) -- discover fields
2. `acumatica_list_entities` (entityName: `SalesInvoice`, topN: `5`) -- sample data
3. `acumatica_list_entities` with refined filters based on discovered fields

### Cross-entity comparison

> "Compare open sales orders against available inventory for the top 10 items by order volume"

**Tools invoked (multi-step):**
1. `acumatica_list_entities` (entityName: `SalesOrder`, filterExpression: `Status eq 'Open'`, expand: `Details`)
2. For top items: `acumatica_get_inventory_quantity_available` (inventoryID: `{each item}`)
3. Claude compares demand vs availability

---

## Generic Inquiries

### Discover available GIs

> "What Generic Inquiries are available in Acumatica?"

**Tools invoked:** `acumatica_list_generic_inquiries`

### Find GIs by topic

> "Are there any Generic Inquiries related to projects?"

**Tools invoked:** `acumatica_list_generic_inquiries` (titleFilter: `project`)

### Understand a GI before running it

> "What fields does the AR-Aging inquiry return?"

**Tools invoked:** `acumatica_describe_inquiry` (inquiryName: `AR-Aging`)

### Full GI discovery workflow

> "I need to run a report on open AP bills. Help me find the right GI and run it."

**Tools invoked (multi-step):**
1. `acumatica_list_generic_inquiries` (titleFilter: `AP`) -- discover relevant GIs
2. `acumatica_describe_inquiry` (inquiryName: `OpenAPBills`) -- learn available fields
3. `acumatica_run_inquiry` (inquiryName: `OpenAPBills`, filterExpression: `Status eq 'Open'`)

### Run a custom report

> "Run the AR Aging inquiry filtered to branch BTC"

**Tools invoked:** `acumatica_run_inquiry` (inquiryName: `AR-Aging`, filterExpression: `BranchID eq 'BTC'`)

### Filtered inquiry with field selection

> "Run the open orders inquiry and just show me CustomerID, OrderTotal, and Status"

**Tools invoked:** `acumatica_run_inquiry` (inquiryName: `OpenOrders`, selectFields: `CustomerID,OrderTotal,Status`)

> **Tip:** Use `acumatica_list_generic_inquiries` to discover available GI names and `acumatica_describe_inquiry` to see what fields each GI returns before querying it.
