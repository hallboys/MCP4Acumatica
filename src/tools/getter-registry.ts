// Copyright 2026 Hall Boys, Inc.
// SPDX-License-Identifier: Apache-2.0

import { z } from "zod";
import type { AppEnv } from "../types/acumatica";
import { AcumaticaClient, AcumaticaApiError, unwrapFields } from "../lib/acumatica-client";
import { endpointAware404Message } from "./getter-errors";

/**
 * Registry-driven definition of the 38 "get one record" tools.
 *
 * Every per-entity getter follows the exact same pattern: build a path of
 * URL-encoded key segments under an entity name, optionally set `$expand`,
 * GET, unwrap, return. Previously this was 28 near-identical handler files
 * plus 38 near-identical `server.tool(...)` blocks in index.ts (~1500 lines
 * of boilerplate). The registry reduces that to a single table + one loop.
 *
 * Utility/discovery tools that do more than a plain GET (list/search,
 * schema describe, GI run, cache clear) remain in their own files.
 */

export interface GetterParamSpec {
  /** Argument name the model passes and we read from `args[name]`. */
  name: string;
  /** Model-facing description of the parameter. */
  describe: string;
  /**
   * If set, the parameter is optional with this default value. Used for
   * discriminator-like fields with a common default (e.g. order "type",
   * which is "SO" for sales orders, "Invoice" for AR invoices, etc.).
   */
  default?: string;
  /**
   * If set, the parameter is optional with no default. Omitted values
   * produce no path segment (useful for a trailing optional key).
   */
  optional?: boolean;
}

export interface GetterToolSpec {
  /** MCP tool name. */
  name: string;
  /** MCP tool description. */
  description: string;
  /** Acumatica entity name used as the first path segment. */
  entity: string;
  /**
   * Parameter specs in path order. Each resolved value becomes a
   * URL-encoded path segment after the entity. Omitted optional params
   * produce no segment.
   */
  params: GetterParamSpec[];
  /** Optional `$expand` query value (comma-separated sub-entity names). */
  expand?: string;
}

/** Build the Zod schema shape the MCP server registers for a tool. */
export function paramsShape(specs: GetterParamSpec[]): Record<string, z.ZodTypeAny> {
  const shape: Record<string, z.ZodTypeAny> = {};
  for (const p of specs) {
    let s: z.ZodTypeAny;
    if (p.default !== undefined) s = z.string().default(p.default);
    else if (p.optional) s = z.string().optional();
    else s = z.string();
    shape[p.name] = s.describe(p.describe);
  }
  return shape;
}

/** Execute the GET request defined by a spec. */
export async function runGetter(
  spec: GetterToolSpec,
  env: AppEnv,
  acumaticaUsername: string,
  args: Record<string, string | undefined>
): Promise<unknown> {
  const client = new AcumaticaClient(env, acumaticaUsername);
  const segments: string[] = [spec.entity];
  for (const p of spec.params) {
    const value = args[p.name];
    // A required param (no default, not optional) must be a non-empty string.
    // Without this guard an empty value would be silently skipped and the URL
    // would collapse to a list endpoint — returning the wrong shape rather
    // than failing loudly. Optional/default params are skipped when blank.
    const isRequired = !p.optional && p.default === undefined;
    if (value === undefined || value === "") {
      if (isRequired) {
        return {
          error: `Required parameter '${p.name}' must be a non-empty string for ${spec.name}.`,
        };
      }
      continue;
    }
    segments.push(encodeURIComponent(value));
  }
  const path = segments.join("/");
  const query: Record<string, string> = {};
  if (spec.expand) query.$expand = spec.expand;
  try {
    const result = await client.get(path, spec.name, args as Record<string, unknown>, query);
    return unwrapFields(result);
  } catch (err) {
    // On a custom contract endpoint a 404 may mean "this endpoint doesn't expose
    // this entity" rather than "wrong key" — Acumatica returns the same status
    // for both. Re-message so the model can distinguish. (Default endpoint: the
    // client's plain message is kept; see endpointAware404Message.)
    if (err instanceof AcumaticaApiError) {
      const enriched = endpointAware404Message(
        err.statusCode,
        env.ACUMATICA_ENDPOINT_NAME || "Default",
        spec.entity
      );
      if (enriched) throw new AcumaticaApiError(404, err.body, enriched);
    }
    throw err;
  }
}

// ── Registry ─────────────────────────────────────────────────────

export const GETTER_TOOLS: GetterToolSpec[] = [
  // ── Core ──────────────────────────────────────────────────────
  {
    name: "acumatica_get_customer",
    description: "Retrieve a customer record by Customer ID. Returns customer name, status, billing/shipping addresses, primary contact, credit terms, and balance.",
    entity: "Customer",
    params: [{ name: "customerID", describe: "Customer ID. Format depends on this Acumatica instance's numbering sequence — there is no universal format. If you only have a name, use acumatica_list_entities with entityName='Customer' and a filter on CustomerName to look up the ID." }],
    expand: "CreditVerificationRules,MainContact,PrimaryContact,BillingContact",
  },
  {
    name: "acumatica_get_vendor",
    description: "Retrieve a vendor record by Vendor ID. Returns vendor name, status, payment terms, tax info, and primary contact.",
    entity: "Vendor",
    params: [{ name: "vendorID", describe: "Vendor ID. Format is instance-specific (depends on the configured numbering sequence). If you only have a name, use acumatica_list_entities with entityName='Vendor' to look it up." }],
    expand: "MainContact,PrimaryContact",
  },
  {
    name: "acumatica_get_sales_order",
    description: "Retrieve a sales order by order type and order number. Returns header info, line items, totals, shipping details, and status.",
    entity: "SalesOrder",
    params: [
      { name: "orderType", describe: "Order type code (optional; defaults to 'SO'). Order types are configurable per instance — 'SO' is the standard out-of-the-box sales order type. Other types are defined in Sales Order Types (SO201000).", default: "SO" },
      { name: "orderNbr", describe: "Sales order number. Format is instance-specific — use acumatica_list_entities with entityName='SalesOrder' to look up." },
    ],
    expand: "Details",
  },

  // ── Financial / Accounting ────────────────────────────────────
  {
    name: "acumatica_get_invoice",
    description: "Retrieve an AR invoice by type and reference number. Returns customer, amounts, balance, line items, tax details, due date, and status.",
    entity: "Invoice",
    params: [
      { name: "type", describe: "Document type (optional; defaults to 'Invoice'). Common values: 'Invoice', 'Credit Memo', 'Debit Memo'.", default: "Invoice" },
      { name: "referenceNbr", describe: "Invoice reference number. Format is instance-specific — use acumatica_list_entities with entityName='Invoice' to look up." },
    ],
    expand: "Details,TaxDetails",
  },
  {
    name: "acumatica_get_bill",
    description: "Retrieve an AP bill by type and reference number. Returns vendor, amounts, balance, line items with PO linkage, tax details, due date, and status.",
    entity: "Bill",
    params: [
      { name: "type", describe: "Document type (optional; defaults to 'Bill'). Common values: 'Bill', 'Credit Adj.', 'Debit Adj.'.", default: "Bill" },
      { name: "referenceNbr", describe: "Bill reference number. Format is instance-specific — use acumatica_list_entities with entityName='Bill' to look up." },
    ],
    expand: "Details,TaxDetails",
  },
  {
    name: "acumatica_get_journal_transaction",
    description: "Retrieve a GL journal transaction batch by batch number. Returns module, ledger, post period, and detail lines with account, debit/credit amounts.",
    entity: "JournalTransaction",
    params: [{ name: "batchNbr", describe: "Journal batch number. Format is instance-specific — use acumatica_list_entities with entityName='JournalTransaction' to look up." }],
  },
  {
    name: "acumatica_get_payment",
    description: "Retrieve an AR payment by type and reference number. Returns customer, payment amount, method, applied documents/orders, available balance, and status.",
    entity: "Payment",
    params: [
      { name: "type", describe: "Payment type (optional; defaults to 'Payment'). Common values: 'Payment', 'Prepayment', 'Refund', 'Voided Check'.", default: "Payment" },
      { name: "referenceNbr", describe: "Payment reference number. Format is instance-specific — use acumatica_list_entities with entityName='Payment' to look up." },
    ],
    expand: "DocumentsToApply,OrdersToApply",
  },
  {
    name: "acumatica_get_account",
    description: "Retrieve a GL account from the chart of accounts by account code. Returns account type, class, group, description, currency, and active status.",
    entity: "Account",
    params: [{ name: "accountCD", describe: "GL account code (Acumatica calls this 'AccountCD'; the 'CD' suffix is its term for a user-readable code). Format depends on the chart of accounts — use acumatica_list_entities with entityName='Account' to look up." }],
  },
  {
    name: "acumatica_get_check",
    description: "Retrieve an AP check (vendor payment) by type and reference number. Returns vendor, payment amount, method, cash account, unapplied balance, and status.",
    entity: "Check",
    params: [
      { name: "type", describe: "Document type (optional; defaults to 'Check'). Common values: 'Check', 'Prepayment', 'Voided Check'.", default: "Check" },
      { name: "referenceNbr", describe: "Check reference number. Format is instance-specific — use acumatica_list_entities with entityName='Check' to look up." },
    ],
    expand: "Details,History",
  },

  // ── Inventory ─────────────────────────────────────────────────
  {
    name: "acumatica_get_stock_item",
    description: "Retrieve a stock item by inventory ID. Returns description, item class, pricing (default, MSRP, cost), UOMs, warehouse details with qty on hand, and vendor details. Response can be large for items stocked across many warehouses.",
    entity: "StockItem",
    params: [{ name: "inventoryID", describe: "Inventory ID. Format is instance-specific (depends on the item numbering sequence). If you only have a description, use acumatica_list_entities with entityName='StockItem' and a filter on Description to look up." }],
    expand: "WarehouseDetails,VendorDetails",
  },
  {
    name: "acumatica_get_non_stock_item",
    description: "Retrieve a non-stock item (service, labor, expense) by inventory ID. Returns description, item class, pricing, UOMs, and posting settings.",
    entity: "NonStockItem",
    params: [{ name: "inventoryID", describe: "Inventory ID for the non-stock item. Format is instance-specific — use acumatica_list_entities with entityName='NonStockItem' to look up." }],
  },
  {
    name: "acumatica_get_inventory_quantity_available",
    description: "Retrieve real-time available quantity for an inventory item across all warehouses. Returns on-hand, available, and allocated quantities.",
    entity: "InventoryQuantityAvailable",
    params: [{ name: "inventoryID", describe: "Inventory ID to check availability for. If unknown, use acumatica_list_entities with entityName='StockItem' to find the item first." }],
    expand: "Results",
  },
  {
    name: "acumatica_get_inventory_summary",
    description: "Retrieve aggregated inventory balances for an item, optionally filtered by warehouse. Returns summary rows with on-hand, available, and other quantity breakdowns.",
    entity: "InventorySummaryInquiry",
    params: [
      { name: "inventoryID", describe: "Inventory ID to summarize. If unknown, use acumatica_list_entities with entityName='StockItem' to find the item first." },
      { name: "warehouseID", describe: "Optional warehouse ID to filter by. Omit to return rows across all warehouses.", optional: true },
    ],
    expand: "Results",
  },
  {
    name: "acumatica_get_warehouse",
    description: "Retrieve a warehouse by ID. Returns description, active status, default locations (receiving, shipping, drop-ship), and all warehouse locations.",
    entity: "Warehouse",
    params: [{ name: "warehouseID", describe: "Warehouse ID. Codes are configured per instance — use acumatica_list_entities with entityName='Warehouse' to discover what's defined." }],
    expand: "Locations",
  },
  {
    name: "acumatica_get_item_class",
    description: "Retrieve an item class by class ID. Returns item type, default UOMs, warehouse, valuation method, posting class, and availability calculation rule.",
    entity: "ItemClass",
    params: [{ name: "classID", describe: "Item class ID. Codes are configured per instance — use acumatica_list_entities with entityName='ItemClass' to discover defined classes." }],
  },

  // ── Purchasing ────────────────────────────────────────────────
  {
    name: "acumatica_get_purchase_order",
    description: "Retrieve a purchase order by type and order number. Returns vendor, line items with quantities and costs, totals, terms, status, and promised date.",
    entity: "PurchaseOrder",
    params: [
      { name: "type", describe: "PO type (optional; defaults to 'Normal'). Common values: 'Normal', 'DropShip', 'Blanket'.", default: "Normal" },
      { name: "orderNbr", describe: "Purchase order number. Format is instance-specific — use acumatica_list_entities with entityName='PurchaseOrder' to look up." },
    ],
    expand: "Details",
  },
  {
    name: "acumatica_get_purchase_receipt",
    description: "Retrieve a purchase receipt by type and receipt number. Returns vendor, line items with received quantities and costs, linked PO references, and warehouse.",
    entity: "PurchaseReceipt",
    params: [
      { name: "type", describe: "Receipt type (optional; defaults to 'Receipt'). Common values: 'Receipt', 'Return'.", default: "Receipt" },
      { name: "receiptNbr", describe: "Purchase receipt number. Format is instance-specific — use acumatica_list_entities with entityName='PurchaseReceipt' to look up." },
    ],
    expand: "Details",
  },

  // ── Projects ──────────────────────────────────────────────────
  {
    name: "acumatica_get_project",
    description: "Retrieve a project by project ID. Returns description, status, customer, template, financials (assets, liabilities, income, expenses).",
    entity: "Project",
    params: [{ name: "projectID", describe: "Project ID. Format is instance-specific — use acumatica_list_entities with entityName='Project' to look up by description." }],
  },
  {
    name: "acumatica_get_project_task",
    description: "Retrieve a project task by project ID and task ID. Returns description, status, and whether it is the default task.",
    entity: "ProjectTask",
    params: [
      { name: "projectID", describe: "Project ID (instance-specific format)." },
      { name: "projectTaskID", describe: "Project task ID. Use acumatica_list_entities with entityName='ProjectTask' and a filter on ProjectID to enumerate tasks for a project." },
    ],
  },
  {
    name: "acumatica_get_project_budget",
    description: "Retrieve a project budget line by project, task, and account group. Returns original/revised budgeted amounts, actuals, committed amounts, and completion percentage.",
    entity: "ProjectBudget",
    params: [
      { name: "projectID", describe: "Project ID (instance-specific format)." },
      { name: "projectTaskID", describe: "Project task ID." },
      { name: "accountGroup", describe: "Account group code. Account groups are configured per instance — use acumatica_list_entities with entityName='AccountGroup' to discover defined groups." },
      { name: "inventoryID", describe: "Optional inventory ID for an item-level budget line. Omit for non-item budget lines.", optional: true },
    ],
  },
  {
    name: "acumatica_get_project_transaction",
    description: "Retrieve a project transaction by module and reference number. Returns detail lines with account, amount, project/task, employee, and quantities.",
    entity: "ProjectTransaction",
    params: [
      { name: "module", describe: "Module code. Standard Acumatica modules: 'PM' (project management), 'AR' (receivables), 'AP' (payables), 'GL' (general ledger), 'IN' (inventory), 'CA' (cash management)." },
      { name: "referenceNbr", describe: "Transaction reference number (instance-specific format)." },
    ],
    expand: "Details",
  },

  // ── Service & Field ───────────────────────────────────────────
  {
    name: "acumatica_get_case",
    description: "Retrieve a support case by case ID. Returns subject, status, priority, severity, business account, contact, owner, SLA, time spent, and resolution details.",
    entity: "Case",
    params: [{ name: "caseID", describe: "Case ID. Format is instance-specific — use acumatica_list_entities with entityName='Case' and a filter on Subject or BusinessAccount to look up." }],
  },
  {
    name: "acumatica_get_service_order",
    description: "Retrieve a field service order by type and number. Returns customer, status, priority, estimated/actual durations, totals, appointments, and line items.",
    entity: "ServiceOrder",
    params: [
      { name: "serviceOrderType", describe: "Service order type code (optional; defaults to 'SL'). Other types are configured per instance.", default: "SL" },
      { name: "serviceOrderNbr", describe: "Service order number. Format is instance-specific — use acumatica_list_entities with entityName='ServiceOrder' to look up." },
    ],
    expand: "Details,Appointments",
  },
  {
    name: "acumatica_get_appointment",
    description: "Retrieve a field service appointment by type and number. Returns scheduled/actual dates and durations, customer, staff, services, cost, profit, and status.",
    entity: "Appointment",
    params: [
      { name: "serviceOrderType", describe: "Service order type code (optional; defaults to 'SL').", default: "SL" },
      { name: "appointmentNbr", describe: "Appointment number. Format is instance-specific — use acumatica_list_entities with entityName='Appointment' to look up." },
    ],
    expand: "Details,Staff,Logs",
  },

  // ── Sales & CRM ───────────────────────────────────────────────
  {
    name: "acumatica_get_contact",
    description: "Retrieve a CRM contact by contact ID. Returns name, email, phone, job title, company, business account, address, status, owner, and source.",
    entity: "Contact",
    params: [{ name: "contactID", describe: "Contact ID — system-generated integer (passed as a string). If unknown, use acumatica_list_entities with entityName='Contact' and a filter on Email, FirstName/LastName, or BusinessAccount to look up." }],
  },
  {
    name: "acumatica_get_business_account",
    description: "Retrieve a business account (prospect, customer, or vendor) by ID. Returns name, type, status, class, main address, main contact, parent account, and owner.",
    entity: "BusinessAccount",
    params: [{ name: "businessAccountID", describe: "Business account ID. Format is instance-specific — use acumatica_list_entities with entityName='BusinessAccount' and a filter on Name to look up." }],
    expand: "MainContact",
  },
  {
    name: "acumatica_get_opportunity",
    description: "Retrieve a sales opportunity by ID. Returns subject, stage, status, amount, discount, total, business account, contact, products, source, and estimation date.",
    entity: "Opportunity",
    params: [{ name: "opportunityID", describe: "Opportunity ID. Format is instance-specific — use acumatica_list_entities with entityName='Opportunity' and a filter on Subject or BusinessAccount to look up." }],
    expand: "Products,TaxDetails",
  },
  {
    name: "acumatica_get_lead",
    description: "Retrieve a marketing lead by lead ID. Returns name, email, phone, company, status, source, class, owner, address, and qualification date.",
    entity: "Lead",
    params: [{ name: "leadID", describe: "Lead ID — system-generated integer (passed as a string). If unknown, use acumatica_list_entities with entityName='Lead' and a filter on Email, Name, or Company to look up." }],
  },
  {
    name: "acumatica_get_salesperson",
    description: "Retrieve a salesperson by ID. Returns name, active status, default commission percentage, and sales subaccount.",
    entity: "Salesperson",
    params: [{ name: "salespersonID", describe: "Salesperson ID. Format is instance-specific — use acumatica_list_entities with entityName='Salesperson' to look up by name." }],
  },

  // ── Shipping & Fulfillment ────────────────────────────────────
  {
    name: "acumatica_get_shipment",
    description: "Retrieve a shipment by shipment number. Returns customer, warehouse, ship via, shipped quantities/weight/volume, packages with tracking numbers, line items, and freight details.",
    entity: "Shipment",
    params: [{ name: "shipmentNbr", describe: "Shipment number. Format is instance-specific — use acumatica_list_entities with entityName='Shipment' to look up." }],
    expand: "Details,Packages,Orders",
  },
  {
    name: "acumatica_get_sales_invoice",
    description: "Retrieve a sales invoice by type and reference number. Returns customer, amounts, balance, line items with SO/shipment linkage, tax details, and due date.",
    entity: "SalesInvoice",
    params: [
      { name: "type", describe: "Document type (optional; defaults to 'Invoice'). Common values: 'Invoice', 'Credit Memo'.", default: "Invoice" },
      { name: "referenceNbr", describe: "Sales invoice reference number. Format is instance-specific — use acumatica_list_entities with entityName='SalesInvoice' to look up." },
    ],
    expand: "Details,TaxDetails",
  },

  // ── HR & Payroll ──────────────────────────────────────────────
  {
    name: "acumatica_get_employee",
    description: "Retrieve an employee by employee ID. Returns name, status, contact info, employee settings, and financial settings.",
    entity: "Employee",
    params: [{ name: "employeeID", describe: "Employee ID. Format is instance-specific — use acumatica_list_entities with entityName='Employee' and a filter on Name to look up." }],
    expand: "ContactInfo,EmployeeSettings,FinancialSettings",
  },
  {
    name: "acumatica_get_expense_claim",
    description: "Retrieve an expense claim by reference number. Returns claimant, date, total, line items with amounts, tax details, approval status, and customer/department.",
    entity: "ExpenseClaim",
    params: [{ name: "refNbr", describe: "Expense claim reference number. Format is instance-specific — use acumatica_list_entities with entityName='ExpenseClaim' to look up." }],
    expand: "Details,TaxDetails",
  },
  {
    name: "acumatica_get_time_entry",
    description: "Retrieve a time entry by ID. Returns employee, date, project/task, time spent, billable time, overtime, earning type, cost rate, and approval status.",
    entity: "TimeEntry",
    params: [{ name: "timeEntryID", describe: "Time entry ID — system-generated GUID (e.g. '11111111-2222-3333-4444-555555555555'). Use acumatica_list_entities with entityName='TimeEntry' and filters on EmployeeID, Date, or ProjectID to find IDs." }],
  },

  // ── CRM Activities ────────────────────────────────────────────
  {
    name: "acumatica_get_email",
    description: "Retrieve a CRM email activity by note ID. Returns subject, from/to/cc/bcc, body, mail status, related entity, and timestamps.",
    entity: "Email",
    params: [{ name: "noteID", describe: "Email note ID — system-generated GUID. Use acumatica_list_entities with entityName='Email' and a filter on Subject, From, or To to find note IDs." }],
  },
  {
    name: "acumatica_get_event",
    description: "Retrieve a CRM event by note ID. Returns summary, start/end dates, location, priority, category, attendees, related entity, and show-as status.",
    entity: "Event",
    params: [{ name: "noteID", describe: "Event note ID — system-generated GUID. Use acumatica_list_entities with entityName='Event' and a filter on Summary or StartDate to find note IDs." }],
    expand: "Attendees",
  },
  {
    name: "acumatica_get_activity",
    description: "Retrieve a CRM activity by note ID. Returns summary, type, status, date, owner, related entity, and body.",
    entity: "Activity",
    params: [{ name: "noteID", describe: "Activity note ID — system-generated GUID. Use acumatica_list_entities with entityName='Activity' to find note IDs." }],
  },
  {
    name: "acumatica_get_task",
    description: "Retrieve a CRM task by note ID. Returns summary, status, priority, due date, completion percentage, related activities/tasks, and owner.",
    entity: "Task",
    params: [{ name: "noteID", describe: "Task note ID — system-generated GUID. Use acumatica_list_entities with entityName='Task' and a filter on Summary or DueDate to find note IDs." }],
  },
];
