// Copyright 2026 Hall Boys, Inc.
// SPDX-License-Identifier: Apache-2.0

import { z } from "zod";
import type { AppEnv } from "../types/acumatica";
import { AcumaticaClient, unwrapFields } from "../lib/acumatica-client";

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
    if (value === undefined || value === "") continue;
    segments.push(encodeURIComponent(value));
  }
  const path = segments.join("/");
  const query: Record<string, string> = {};
  if (spec.expand) query.$expand = spec.expand;
  const result = await client.get(path, spec.name, args as Record<string, unknown>, query);
  return unwrapFields(result);
}

// ── Registry ─────────────────────────────────────────────────────

export const GETTER_TOOLS: GetterToolSpec[] = [
  // ── Core ──────────────────────────────────────────────────────
  {
    name: "acumatica_get_customer",
    description: "Retrieve customer record by Customer ID. Returns customer name, status, billing/shipping addresses, primary contact, credit terms, and balance.",
    entity: "Customer",
    params: [{ name: "customerId", describe: "Acumatica Customer ID (e.g., 'C000001')" }],
    expand: "CreditVerificationRules,MainContact,PrimaryContact,BillingContact",
  },
  {
    name: "acumatica_get_vendor",
    description: "Retrieve vendor record by Vendor ID. Returns vendor name, status, payment terms, tax info, and primary contact.",
    entity: "Vendor",
    params: [{ name: "vendorId", describe: "Acumatica Vendor ID (e.g., 'V000001')" }],
    expand: "MainContact,PrimaryContact",
  },
  {
    name: "acumatica_get_sales_order",
    description: "Retrieve a sales order by order type and order number. Returns header info, line items, totals, shipping details, and status.",
    entity: "SalesOrder",
    params: [
      { name: "orderType", describe: "Order type (e.g., 'SO')", default: "SO" },
      { name: "orderNbr", describe: "Order number" },
    ],
    expand: "Details",
  },

  // ── Financial / Accounting ────────────────────────────────────
  {
    name: "acumatica_get_invoice",
    description: "Retrieve an AR invoice by type and reference number. Returns customer, amounts, balance, line items, tax details, due date, and status.",
    entity: "Invoice",
    params: [
      { name: "type", describe: "Document type (e.g., 'Invoice', 'Credit Memo', 'Debit Memo')", default: "Invoice" },
      { name: "referenceNbr", describe: "Invoice reference number" },
    ],
    expand: "Details,TaxDetails",
  },
  {
    name: "acumatica_get_bill",
    description: "Retrieve an AP bill by type and reference number. Returns vendor, amounts, balance, line items with PO linkage, tax details, due date, and status.",
    entity: "Bill",
    params: [
      { name: "type", describe: "Document type (e.g., 'Bill', 'Credit Adj.', 'Debit Adj.')", default: "Bill" },
      { name: "referenceNbr", describe: "Bill reference number" },
    ],
    expand: "Details,TaxDetails",
  },
  {
    name: "acumatica_get_journal_transaction",
    description: "Retrieve a GL journal transaction batch by batch number. Returns module, ledger, post period, and detail lines with account, debit/credit amounts.",
    entity: "JournalTransaction",
    params: [{ name: "batchNbr", describe: "Journal batch number" }],
  },
  {
    name: "acumatica_get_payment",
    description: "Retrieve an AR payment by type and reference number. Returns customer, payment amount, method, applied documents/orders, available balance, and status.",
    entity: "Payment",
    params: [
      { name: "type", describe: "Payment type (e.g., 'Payment', 'Prepayment', 'Refund', 'Voided Check')", default: "Payment" },
      { name: "referenceNbr", describe: "Payment reference number" },
    ],
    expand: "DocumentsToApply,OrdersToApply",
  },
  {
    name: "acumatica_get_account",
    description: "Retrieve a GL account from the chart of accounts by account code. Returns account type, class, group, description, currency, and active status.",
    entity: "Account",
    params: [{ name: "accountCD", describe: "GL account code (e.g., '10000', '40000')" }],
  },
  {
    name: "acumatica_get_check",
    description: "Retrieve an AP check (vendor payment) by type and reference number. Returns vendor, payment amount, method, cash account, unapplied balance, and status.",
    entity: "Check",
    params: [
      { name: "type", describe: "Document type (e.g., 'Check', 'Prepayment', 'Voided Check')", default: "Check" },
      { name: "referenceNbr", describe: "Check reference number" },
    ],
    expand: "Details,History",
  },

  // ── Inventory ─────────────────────────────────────────────────
  {
    name: "acumatica_get_stock_item",
    description: "Retrieve a stock item by inventory ID. Returns description, item class, pricing (default, MSRP, cost), UOMs, warehouse details with qty on hand, and vendor details.",
    entity: "StockItem",
    params: [{ name: "inventoryID", describe: "Inventory ID (e.g., 'AALEGO500')" }],
    expand: "WarehouseDetails,VendorDetails",
  },
  {
    name: "acumatica_get_non_stock_item",
    description: "Retrieve a non-stock item (service, labor, expense) by inventory ID. Returns description, item class, pricing, UOMs, and posting settings.",
    entity: "NonStockItem",
    params: [{ name: "inventoryID", describe: "Inventory ID for the non-stock item" }],
  },
  {
    name: "acumatica_get_inventory_quantity_available",
    description: "Retrieve real-time available quantity for an inventory item across all warehouses. Returns on-hand, available, and allocated quantities.",
    entity: "InventoryQuantityAvailable",
    params: [{ name: "inventoryID", describe: "Inventory ID to check availability for" }],
    expand: "Results",
  },
  {
    name: "acumatica_get_inventory_summary",
    description: "Retrieve aggregated inventory balances for an item, optionally filtered by warehouse. Returns summary rows with on-hand, available, and other quantity breakdowns.",
    entity: "InventorySummaryInquiry",
    params: [
      { name: "inventoryID", describe: "Inventory ID to summarize" },
      { name: "warehouseID", describe: "Optional warehouse ID to filter by", optional: true },
    ],
    expand: "Results",
  },
  {
    name: "acumatica_get_warehouse",
    description: "Retrieve a warehouse by ID. Returns description, active status, default locations (receiving, shipping, drop-ship), and all warehouse locations.",
    entity: "Warehouse",
    params: [{ name: "warehouseID", describe: "Warehouse ID (e.g., 'MAIN', 'WHOLESALE')" }],
    expand: "Locations",
  },
  {
    name: "acumatica_get_item_class",
    description: "Retrieve an item class by class ID. Returns item type, default UOMs, warehouse, valuation method, posting class, and availability calculation rule.",
    entity: "ItemClass",
    params: [{ name: "classID", describe: "Item class ID (e.g., 'STOCKITEM', 'INTANGIBLE')" }],
  },

  // ── Purchasing ────────────────────────────────────────────────
  {
    name: "acumatica_get_purchase_order",
    description: "Retrieve a purchase order by type and order number. Returns vendor, line items with quantities and costs, totals, terms, status, and promised date.",
    entity: "PurchaseOrder",
    params: [
      { name: "type", describe: "PO type (e.g., 'Normal', 'DropShip', 'Blanket')", default: "Normal" },
      { name: "orderNbr", describe: "Purchase order number" },
    ],
    expand: "Details",
  },
  {
    name: "acumatica_get_purchase_receipt",
    description: "Retrieve a purchase receipt by type and receipt number. Returns vendor, line items with received quantities and costs, linked PO references, and warehouse.",
    entity: "PurchaseReceipt",
    params: [
      { name: "type", describe: "Receipt type (e.g., 'Receipt', 'Return')", default: "Receipt" },
      { name: "receiptNbr", describe: "Purchase receipt number" },
    ],
    expand: "Details",
  },

  // ── Projects ──────────────────────────────────────────────────
  {
    name: "acumatica_get_project",
    description: "Retrieve a project by project ID. Returns description, status, customer, template, financials (assets, liabilities, income, expenses).",
    entity: "Project",
    params: [{ name: "projectID", describe: "Project ID" }],
  },
  {
    name: "acumatica_get_project_task",
    description: "Retrieve a project task by project ID and task ID. Returns description, status, and whether it is the default task.",
    entity: "ProjectTask",
    params: [
      { name: "projectID", describe: "Project ID" },
      { name: "projectTaskID", describe: "Project task ID" },
    ],
  },
  {
    name: "acumatica_get_project_budget",
    description: "Retrieve a project budget line by project, task, and account group. Returns original/revised budgeted amounts, actuals, committed amounts, and completion percentage.",
    entity: "ProjectBudget",
    params: [
      { name: "projectID", describe: "Project ID" },
      { name: "projectTaskID", describe: "Project task ID" },
      { name: "accountGroup", describe: "Account group" },
      { name: "inventoryID", describe: "Optional inventory ID for item-level budget", optional: true },
    ],
  },
  {
    name: "acumatica_get_project_transaction",
    description: "Retrieve a project transaction by module and reference number. Returns detail lines with account, amount, project/task, employee, and quantities.",
    entity: "ProjectTransaction",
    params: [
      { name: "module", describe: "Module (e.g., 'PM', 'AR', 'AP', 'GL')" },
      { name: "referenceNbr", describe: "Transaction reference number" },
    ],
    expand: "Details",
  },

  // ── Service & Field ───────────────────────────────────────────
  {
    name: "acumatica_get_case",
    description: "Retrieve a support case by case ID. Returns subject, status, priority, severity, business account, contact, owner, SLA, time spent, and resolution details.",
    entity: "Case",
    params: [{ name: "caseID", describe: "Case ID (e.g., 'C000001')" }],
  },
  {
    name: "acumatica_get_service_order",
    description: "Retrieve a field service order by type and number. Returns customer, status, priority, estimated/actual durations, totals, appointments, and line items.",
    entity: "ServiceOrder",
    params: [
      { name: "serviceOrderType", describe: "Service order type", default: "SL" },
      { name: "serviceOrderNbr", describe: "Service order number" },
    ],
    expand: "Details,Appointments",
  },
  {
    name: "acumatica_get_appointment",
    description: "Retrieve a field service appointment by type and number. Returns scheduled/actual dates and durations, customer, staff, services, cost, profit, and status.",
    entity: "Appointment",
    params: [
      { name: "serviceOrderType", describe: "Service order type", default: "SL" },
      { name: "appointmentNbr", describe: "Appointment number" },
    ],
    expand: "Details,Staff,Logs",
  },

  // ── Sales & CRM ───────────────────────────────────────────────
  {
    name: "acumatica_get_contact",
    description: "Retrieve a CRM contact by contact ID. Returns name, email, phone, job title, company, business account, address, status, owner, and source.",
    entity: "Contact",
    params: [{ name: "contactID", describe: "Contact ID (numeric)" }],
  },
  {
    name: "acumatica_get_business_account",
    description: "Retrieve a business account (prospect, customer, or vendor) by ID. Returns name, type, status, class, main address, main contact, parent account, and owner.",
    entity: "BusinessAccount",
    params: [{ name: "businessAccountID", describe: "Business account ID" }],
    expand: "MainContact",
  },
  {
    name: "acumatica_get_opportunity",
    description: "Retrieve a sales opportunity by ID. Returns subject, stage, status, amount, discount, total, business account, contact, products, source, and estimation date.",
    entity: "Opportunity",
    params: [{ name: "opportunityID", describe: "Opportunity ID" }],
    expand: "Products,TaxDetails",
  },
  {
    name: "acumatica_get_lead",
    description: "Retrieve a marketing lead by lead ID. Returns name, email, phone, company, status, source, class, owner, address, and qualification date.",
    entity: "Lead",
    params: [{ name: "leadID", describe: "Lead ID (numeric)" }],
  },
  {
    name: "acumatica_get_salesperson",
    description: "Retrieve a salesperson by ID. Returns name, active status, default commission percentage, and sales subaccount.",
    entity: "Salesperson",
    params: [{ name: "salespersonID", describe: "Salesperson ID" }],
  },

  // ── Shipping & Fulfillment ────────────────────────────────────
  {
    name: "acumatica_get_shipment",
    description: "Retrieve a shipment by shipment number. Returns customer, warehouse, ship via, shipped quantities/weight/volume, packages with tracking numbers, line items, and freight details.",
    entity: "Shipment",
    params: [{ name: "shipmentNbr", describe: "Shipment number" }],
    expand: "Details,Packages,Orders",
  },
  {
    name: "acumatica_get_sales_invoice",
    description: "Retrieve a sales invoice by type and reference number. Returns customer, amounts, balance, line items with SO/shipment linkage, tax details, and due date.",
    entity: "SalesInvoice",
    params: [
      { name: "type", describe: "Document type (e.g., 'Invoice', 'Credit Memo')", default: "Invoice" },
      { name: "referenceNbr", describe: "Sales invoice reference number" },
    ],
    expand: "Details,TaxDetails",
  },

  // ── HR & Payroll ──────────────────────────────────────────────
  {
    name: "acumatica_get_employee",
    description: "Retrieve an employee by employee ID. Returns name, status, contact info, employee settings, and financial settings.",
    entity: "Employee",
    params: [{ name: "employeeID", describe: "Employee ID (e.g., 'EP00000001')" }],
    expand: "ContactInfo,EmployeeSettings,FinancialSettings",
  },
  {
    name: "acumatica_get_expense_claim",
    description: "Retrieve an expense claim by reference number. Returns claimant, date, total, line items with amounts, tax details, approval status, and customer/department.",
    entity: "ExpenseClaim",
    params: [{ name: "refNbr", describe: "Expense claim reference number" }],
    expand: "Details,TaxDetails",
  },
  {
    name: "acumatica_get_time_entry",
    description: "Retrieve a time entry by ID. Returns employee, date, project/task, time spent, billable time, overtime, earning type, cost rate, and approval status.",
    entity: "TimeEntry",
    params: [{ name: "timeEntryID", describe: "Time entry ID (GUID)" }],
  },

  // ── CRM Activities ────────────────────────────────────────────
  {
    name: "acumatica_get_email",
    description: "Retrieve a CRM email activity by note ID. Returns subject, from/to/cc/bcc, body, mail status, related entity, and timestamps.",
    entity: "Email",
    params: [{ name: "noteID", describe: "Email note ID (GUID)" }],
  },
  {
    name: "acumatica_get_event",
    description: "Retrieve a CRM event by note ID. Returns summary, start/end dates, location, priority, category, attendees, related entity, and show-as status.",
    entity: "Event",
    params: [{ name: "noteID", describe: "Event note ID (GUID)" }],
    expand: "Attendees",
  },
  {
    name: "acumatica_get_activity",
    description: "Retrieve a CRM activity by note ID. Returns summary, type, status, date, owner, related entity, and body.",
    entity: "Activity",
    params: [{ name: "noteID", describe: "Activity note ID (GUID)" }],
  },
  {
    name: "acumatica_get_task",
    description: "Retrieve a CRM task by note ID. Returns summary, status, priority, due date, completion percentage, related activities/tasks, and owner.",
    entity: "Task",
    params: [{ name: "noteID", describe: "Task note ID (GUID)" }],
  },
];
