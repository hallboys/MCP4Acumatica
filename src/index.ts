// Copyright 2026 Hall Boys, Inc.
// SPDX-License-Identifier: Apache-2.0

import { OAuthProvider } from "@cloudflare/workers-oauth-provider";
import { McpAgent } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Env, AuthProps } from "./types/acumatica";
import { handleGetCustomer } from "./tools/customers";
import { handleGetVendor } from "./tools/vendors";
import { handleGetSalesOrder } from "./tools/sales-orders";
import { handleGetInvoice } from "./tools/invoices";
import { handleGetBill } from "./tools/bills";
import { handleGetJournalTransaction } from "./tools/journal-transactions";
import { handleGetPayment } from "./tools/payments";
import { handleGetAccount } from "./tools/accounts";
import { handleGetCheck } from "./tools/checks";
import { handleGetStockItem } from "./tools/stock-items";
import { handleGetNonStockItem } from "./tools/non-stock-items";
import { handleGetInventoryQuantityAvailable, handleGetInventorySummary } from "./tools/inventory-availability";
import { handleGetWarehouse } from "./tools/warehouses";
import { handleGetItemClass } from "./tools/item-classes";
import { handleGetPurchaseOrder } from "./tools/purchase-orders";
import { handleGetPurchaseReceipt } from "./tools/purchase-receipts";
import { handleGetProject, handleGetProjectTask, handleGetProjectBudget, handleGetProjectTransaction } from "./tools/projects";
import { handleGetCase } from "./tools/cases";
import { handleGetServiceOrder } from "./tools/service-orders";
import { handleGetAppointment } from "./tools/appointments";
import { handleGetContact } from "./tools/contacts";
import { handleGetBusinessAccount } from "./tools/business-accounts";
import { handleGetOpportunity } from "./tools/opportunities";
import { handleGetLead } from "./tools/leads";
import { handleGetSalesperson } from "./tools/salespersons";
import { handleGetShipment } from "./tools/shipments";
import { handleGetSalesInvoice } from "./tools/sales-invoices";
import { handleGetEmployee } from "./tools/employees";
import { handleGetExpenseClaim } from "./tools/expense-claims";
import { handleGetTimeEntry } from "./tools/time-entries";
import { handleGetEmail, handleGetEvent, handleGetActivity, handleGetTask } from "./tools/crm-activities";
import { handleRunInquiry } from "./tools/generic-inquiries";
import { handleListEntities } from "./tools/entity-list";
import { handleDescribeEntity } from "./tools/entity-schema";
import { handleListGenericInquiries, handleDescribeInquiry } from "./tools/generic-inquiry-discovery";
import { handleClearCache } from "./tools/clear-cache";
import { AcumaticaApiError } from "./lib/acumatica-client";
import { RateLimitError } from "./lib/rate-limiter";
import { redactFields } from "./lib/redact";
import { logRedaction, logToolInvocation, logError, writeLogsToR2 } from "./lib/logger";
import { getConfig } from "./lib/config";
import { CloudflareKVStore } from "./platform/cloudflare-kv-store";
import { AcumaticaAuthHandler } from "./auth/acumatica-auth-handler";

export class AcumaticaMcpServer extends McpAgent<Env, Record<string, unknown>, AuthProps> {
  server = new McpServer({
    name: "mcp4acumatica",
    version: "0.25.0",
  });

  private redactPatterns?: string;
  private redactSkip?: string;

  // ── Log buffering ──────────────────────────────────────────────
  // Buffer entries in memory and flush to R2 when the buffer hits
  // a size threshold OR a DO alarm fires. The alarm is the critical
  // piece — without it, short sessions (<25 entries) sit in memory
  // until the DO is evicted and get lost. Alarms persist in storage,
  // so an idle DO will be woken up just to flush.
  private logBuffer: Record<string, unknown>[] = [];
  private alarmScheduled = false;
  private static readonly LOG_FLUSH_THRESHOLD = 25;  // entries
  private static readonly LOG_FLUSH_DELAY_MS = 15_000;

  async init() {
    // Initialize the platform-agnostic store from the Cloudflare KV binding.
    // This makes all tool handlers, config, caching, and token storage portable.
    this.env.store = new CloudflareKVStore(this.env.TOKEN_STORE);

    // Read runtime config from KV with env var fallback
    this.redactPatterns = await getConfig(this.env.store, "redact_patterns", this.env.REDACT_PATTERNS);
    this.redactSkip = await getConfig(this.env.store, "redact_skip", this.env.REDACT_SKIP);
    // Tool 1: Customer Lookup
    this.server.tool(
      "acumatica_get_customer",
      "Retrieve customer record by Customer ID. Returns customer name, status, billing/shipping addresses, primary contact, credit terms, and balance.",
      {
        customerId: z
          .string()
          .describe("Acumatica Customer ID (e.g., 'C000001')"),
      },
      async ({ customerId }) => {
        return this.callTool(() =>
          handleGetCustomer(this.env, this.props.acumaticaUsername, { customerId }),
          "acumatica_get_customer",
          { customerId }
        );
      }
    );

    // Tool 2: Vendor Lookup
    this.server.tool(
      "acumatica_get_vendor",
      "Retrieve vendor record by Vendor ID. Returns vendor name, status, payment terms, tax info, and primary contact.",
      {
        vendorId: z
          .string()
          .describe("Acumatica Vendor ID (e.g., 'V000001')"),
      },
      async ({ vendorId }) => {
        return this.callTool(() =>
          handleGetVendor(this.env, this.props.acumaticaUsername, { vendorId }),
          "acumatica_get_vendor",
          { vendorId }
        );
      }
    );

    // Tool 3: Sales Order Lookup
    this.server.tool(
      "acumatica_get_sales_order",
      "Retrieve a sales order by order type and order number. Returns header info, line items, totals, shipping details, and status.",
      {
        orderType: z
          .string()
          .default("SO")
          .describe("Order type (e.g., 'SO')"),
        orderNbr: z.string().describe("Order number"),
      },
      async ({ orderType, orderNbr }) => {
        return this.callTool(() =>
          handleGetSalesOrder(this.env, this.props.acumaticaUsername, { orderType, orderNbr }),
          "acumatica_get_sales_order",
          { orderType, orderNbr }
        );
      }
    );

    // Tool 4: AR Invoice Lookup
    this.server.tool(
      "acumatica_get_invoice",
      "Retrieve an AR invoice by type and reference number. Returns customer, amounts, balance, line items, tax details, due date, and status.",
      {
        type: z
          .string()
          .default("Invoice")
          .describe("Document type (e.g., 'Invoice', 'Credit Memo', 'Debit Memo')"),
        referenceNbr: z.string().describe("Invoice reference number"),
      },
      async ({ type, referenceNbr }) => {
        return this.callTool(() =>
          handleGetInvoice(this.env, this.props.acumaticaUsername, { type, referenceNbr }),
          "acumatica_get_invoice",
          { type, referenceNbr }
        );
      }
    );

    // Tool 5: AP Bill Lookup
    this.server.tool(
      "acumatica_get_bill",
      "Retrieve an AP bill by type and reference number. Returns vendor, amounts, balance, line items with PO linkage, tax details, due date, and status.",
      {
        type: z
          .string()
          .default("Bill")
          .describe("Document type (e.g., 'Bill', 'Credit Adj.', 'Debit Adj.')"),
        referenceNbr: z.string().describe("Bill reference number"),
      },
      async ({ type, referenceNbr }) => {
        return this.callTool(() =>
          handleGetBill(this.env, this.props.acumaticaUsername, { type, referenceNbr }),
          "acumatica_get_bill",
          { type, referenceNbr }
        );
      }
    );

    // Tool 6: GL Journal Transaction Lookup
    this.server.tool(
      "acumatica_get_journal_transaction",
      "Retrieve a GL journal transaction batch by batch number. Returns module, ledger, post period, and detail lines with account, debit/credit amounts.",
      {
        batchNbr: z.string().describe("Journal batch number"),
      },
      async ({ batchNbr }) => {
        return this.callTool(() =>
          handleGetJournalTransaction(this.env, this.props.acumaticaUsername, { batchNbr }),
          "acumatica_get_journal_transaction",
          { batchNbr }
        );
      }
    );

    // Tool 7: AR Payment Lookup
    this.server.tool(
      "acumatica_get_payment",
      "Retrieve an AR payment by type and reference number. Returns customer, payment amount, method, applied documents/orders, available balance, and status.",
      {
        type: z
          .string()
          .default("Payment")
          .describe("Payment type (e.g., 'Payment', 'Prepayment', 'Refund', 'Voided Check')"),
        referenceNbr: z.string().describe("Payment reference number"),
      },
      async ({ type, referenceNbr }) => {
        return this.callTool(() =>
          handleGetPayment(this.env, this.props.acumaticaUsername, { type, referenceNbr }),
          "acumatica_get_payment",
          { type, referenceNbr }
        );
      }
    );

    // Tool 8: GL Account Lookup
    this.server.tool(
      "acumatica_get_account",
      "Retrieve a GL account from the chart of accounts by account code. Returns account type, class, group, description, currency, and active status.",
      {
        accountCD: z
          .string()
          .describe("GL account code (e.g., '10000', '40000')"),
      },
      async ({ accountCD }) => {
        return this.callTool(() =>
          handleGetAccount(this.env, this.props.acumaticaUsername, { accountCD }),
          "acumatica_get_account",
          { accountCD }
        );
      }
    );

    // Tool 9: AP Check Lookup
    this.server.tool(
      "acumatica_get_check",
      "Retrieve an AP check (vendor payment) by type and reference number. Returns vendor, payment amount, method, cash account, unapplied balance, and status.",
      {
        type: z
          .string()
          .default("Check")
          .describe("Document type (e.g., 'Check', 'Prepayment', 'Voided Check')"),
        referenceNbr: z.string().describe("Check reference number"),
      },
      async ({ type, referenceNbr }) => {
        return this.callTool(() =>
          handleGetCheck(this.env, this.props.acumaticaUsername, { type, referenceNbr }),
          "acumatica_get_check",
          { type, referenceNbr }
        );
      }
    );

    // Tool 10: Stock Item Lookup
    this.server.tool(
      "acumatica_get_stock_item",
      "Retrieve a stock item by inventory ID. Returns description, item class, pricing (default, MSRP, cost), UOMs, warehouse details with qty on hand, and vendor details.",
      {
        inventoryID: z
          .string()
          .describe("Inventory ID (e.g., 'AALEGO500')"),
      },
      async ({ inventoryID }) => {
        return this.callTool(() =>
          handleGetStockItem(this.env, this.props.acumaticaUsername, { inventoryID }),
          "acumatica_get_stock_item",
          { inventoryID }
        );
      }
    );

    // Tool 11: Non-Stock Item Lookup
    this.server.tool(
      "acumatica_get_non_stock_item",
      "Retrieve a non-stock item (service, labor, expense) by inventory ID. Returns description, item class, pricing, UOMs, and posting settings.",
      {
        inventoryID: z
          .string()
          .describe("Inventory ID for the non-stock item"),
      },
      async ({ inventoryID }) => {
        return this.callTool(() =>
          handleGetNonStockItem(this.env, this.props.acumaticaUsername, { inventoryID }),
          "acumatica_get_non_stock_item",
          { inventoryID }
        );
      }
    );

    // Tool 12: Inventory Quantity Available
    this.server.tool(
      "acumatica_get_inventory_quantity_available",
      "Retrieve real-time available quantity for an inventory item across all warehouses. Returns on-hand, available, and allocated quantities.",
      {
        inventoryID: z
          .string()
          .describe("Inventory ID to check availability for"),
      },
      async ({ inventoryID }) => {
        return this.callTool(() =>
          handleGetInventoryQuantityAvailable(this.env, this.props.acumaticaUsername, { inventoryID }),
          "acumatica_get_inventory_quantity_available",
          { inventoryID }
        );
      }
    );

    // Tool 13: Inventory Summary Inquiry
    this.server.tool(
      "acumatica_get_inventory_summary",
      "Retrieve aggregated inventory balances for an item, optionally filtered by warehouse. Returns summary rows with on-hand, available, and other quantity breakdowns.",
      {
        inventoryID: z
          .string()
          .describe("Inventory ID to summarize"),
        warehouseID: z
          .string()
          .optional()
          .describe("Optional warehouse ID to filter by"),
      },
      async ({ inventoryID, warehouseID }) => {
        return this.callTool(() =>
          handleGetInventorySummary(this.env, this.props.acumaticaUsername, { inventoryID, warehouseID }),
          "acumatica_get_inventory_summary",
          { inventoryID, warehouseID }
        );
      }
    );

    // Tool 14: Warehouse Lookup
    this.server.tool(
      "acumatica_get_warehouse",
      "Retrieve a warehouse by ID. Returns description, active status, default locations (receiving, shipping, drop-ship), and all warehouse locations.",
      {
        warehouseID: z
          .string()
          .describe("Warehouse ID (e.g., 'MAIN', 'WHOLESALE')"),
      },
      async ({ warehouseID }) => {
        return this.callTool(() =>
          handleGetWarehouse(this.env, this.props.acumaticaUsername, { warehouseID }),
          "acumatica_get_warehouse",
          { warehouseID }
        );
      }
    );

    // Tool 15: Item Class Lookup
    this.server.tool(
      "acumatica_get_item_class",
      "Retrieve an item class by class ID. Returns item type, default UOMs, warehouse, valuation method, posting class, and availability calculation rule.",
      {
        classID: z
          .string()
          .describe("Item class ID (e.g., 'STOCKITEM', 'INTANGIBLE')"),
      },
      async ({ classID }) => {
        return this.callTool(() =>
          handleGetItemClass(this.env, this.props.acumaticaUsername, { classID }),
          "acumatica_get_item_class",
          { classID }
        );
      }
    );

    // Tool 16: Purchase Order Lookup
    this.server.tool(
      "acumatica_get_purchase_order",
      "Retrieve a purchase order by type and order number. Returns vendor, line items with quantities and costs, totals, terms, status, and promised date.",
      {
        type: z
          .string()
          .default("Normal")
          .describe("PO type (e.g., 'Normal', 'DropShip', 'Blanket')"),
        orderNbr: z.string().describe("Purchase order number"),
      },
      async ({ type, orderNbr }) => {
        return this.callTool(() =>
          handleGetPurchaseOrder(this.env, this.props.acumaticaUsername, { type, orderNbr }),
          "acumatica_get_purchase_order",
          { type, orderNbr }
        );
      }
    );

    // Tool 17: Purchase Receipt Lookup
    this.server.tool(
      "acumatica_get_purchase_receipt",
      "Retrieve a purchase receipt by type and receipt number. Returns vendor, line items with received quantities and costs, linked PO references, and warehouse.",
      {
        type: z
          .string()
          .default("Receipt")
          .describe("Receipt type (e.g., 'Receipt', 'Return')"),
        receiptNbr: z.string().describe("Purchase receipt number"),
      },
      async ({ type, receiptNbr }) => {
        return this.callTool(() =>
          handleGetPurchaseReceipt(this.env, this.props.acumaticaUsername, { type, receiptNbr }),
          "acumatica_get_purchase_receipt",
          { type, receiptNbr }
        );
      }
    );

    // Tool 18: Project Lookup
    this.server.tool(
      "acumatica_get_project",
      "Retrieve a project by project ID. Returns description, status, customer, template, financials (assets, liabilities, income, expenses).",
      {
        projectID: z
          .string()
          .describe("Project ID"),
      },
      async ({ projectID }) => {
        return this.callTool(() =>
          handleGetProject(this.env, this.props.acumaticaUsername, { projectID }),
          "acumatica_get_project",
          { projectID }
        );
      }
    );

    // Tool 19: Project Task Lookup
    this.server.tool(
      "acumatica_get_project_task",
      "Retrieve a project task by project ID and task ID. Returns description, status, and whether it is the default task.",
      {
        projectID: z.string().describe("Project ID"),
        projectTaskID: z.string().describe("Project task ID"),
      },
      async ({ projectID, projectTaskID }) => {
        return this.callTool(() =>
          handleGetProjectTask(this.env, this.props.acumaticaUsername, { projectID, projectTaskID }),
          "acumatica_get_project_task",
          { projectID, projectTaskID }
        );
      }
    );

    // Tool 20: Project Budget Lookup
    this.server.tool(
      "acumatica_get_project_budget",
      "Retrieve a project budget line by project, task, and account group. Returns original/revised budgeted amounts, actuals, committed amounts, and completion percentage.",
      {
        projectID: z.string().describe("Project ID"),
        projectTaskID: z.string().describe("Project task ID"),
        accountGroup: z.string().describe("Account group"),
        inventoryID: z
          .string()
          .optional()
          .describe("Optional inventory ID for item-level budget"),
      },
      async ({ projectID, projectTaskID, accountGroup, inventoryID }) => {
        return this.callTool(() =>
          handleGetProjectBudget(this.env, this.props.acumaticaUsername, { projectID, projectTaskID, accountGroup, inventoryID }),
          "acumatica_get_project_budget",
          { projectID, projectTaskID, accountGroup, inventoryID }
        );
      }
    );

    // Tool 21: Project Transaction Lookup
    this.server.tool(
      "acumatica_get_project_transaction",
      "Retrieve a project transaction by module and reference number. Returns detail lines with account, amount, project/task, employee, and quantities.",
      {
        module: z.string().describe("Module (e.g., 'PM', 'AR', 'AP', 'GL')"),
        referenceNbr: z.string().describe("Transaction reference number"),
      },
      async ({ module, referenceNbr }) => {
        return this.callTool(() =>
          handleGetProjectTransaction(this.env, this.props.acumaticaUsername, { module, referenceNbr }),
          "acumatica_get_project_transaction",
          { module, referenceNbr }
        );
      }
    );

    // Tool 22: Support Case Lookup
    this.server.tool(
      "acumatica_get_case",
      "Retrieve a support case by case ID. Returns subject, status, priority, severity, business account, contact, owner, SLA, time spent, and resolution details.",
      {
        caseID: z.string().describe("Case ID (e.g., 'C000001')"),
      },
      async ({ caseID }) => {
        return this.callTool(() =>
          handleGetCase(this.env, this.props.acumaticaUsername, { caseID }),
          "acumatica_get_case",
          { caseID }
        );
      }
    );

    // Tool 23: Service Order Lookup
    this.server.tool(
      "acumatica_get_service_order",
      "Retrieve a field service order by type and number. Returns customer, status, priority, estimated/actual durations, totals, appointments, and line items.",
      {
        serviceOrderType: z
          .string()
          .default("SL")
          .describe("Service order type"),
        serviceOrderNbr: z.string().describe("Service order number"),
      },
      async ({ serviceOrderType, serviceOrderNbr }) => {
        return this.callTool(() =>
          handleGetServiceOrder(this.env, this.props.acumaticaUsername, { serviceOrderType, serviceOrderNbr }),
          "acumatica_get_service_order",
          { serviceOrderType, serviceOrderNbr }
        );
      }
    );

    // Tool 24: Appointment Lookup
    this.server.tool(
      "acumatica_get_appointment",
      "Retrieve a field service appointment by type and number. Returns scheduled/actual dates and durations, customer, staff, services, cost, profit, and status.",
      {
        serviceOrderType: z
          .string()
          .default("SL")
          .describe("Service order type"),
        appointmentNbr: z.string().describe("Appointment number"),
      },
      async ({ serviceOrderType, appointmentNbr }) => {
        return this.callTool(() =>
          handleGetAppointment(this.env, this.props.acumaticaUsername, { serviceOrderType, appointmentNbr }),
          "acumatica_get_appointment",
          { serviceOrderType, appointmentNbr }
        );
      }
    );

    // Tool 25: Contact Lookup
    this.server.tool(
      "acumatica_get_contact",
      "Retrieve a CRM contact by contact ID. Returns name, email, phone, job title, company, business account, address, status, owner, and source.",
      {
        contactID: z.string().describe("Contact ID (numeric)"),
      },
      async ({ contactID }) => {
        return this.callTool(() =>
          handleGetContact(this.env, this.props.acumaticaUsername, { contactID }),
          "acumatica_get_contact",
          { contactID }
        );
      }
    );

    // Tool 26: Business Account Lookup
    this.server.tool(
      "acumatica_get_business_account",
      "Retrieve a business account (prospect, customer, or vendor) by ID. Returns name, type, status, class, main address, main contact, parent account, and owner.",
      {
        businessAccountID: z.string().describe("Business account ID"),
      },
      async ({ businessAccountID }) => {
        return this.callTool(() =>
          handleGetBusinessAccount(this.env, this.props.acumaticaUsername, { businessAccountID }),
          "acumatica_get_business_account",
          { businessAccountID }
        );
      }
    );

    // Tool 27: Opportunity Lookup
    this.server.tool(
      "acumatica_get_opportunity",
      "Retrieve a sales opportunity by ID. Returns subject, stage, status, amount, discount, total, business account, contact, products, source, and estimation date.",
      {
        opportunityID: z.string().describe("Opportunity ID"),
      },
      async ({ opportunityID }) => {
        return this.callTool(() =>
          handleGetOpportunity(this.env, this.props.acumaticaUsername, { opportunityID }),
          "acumatica_get_opportunity",
          { opportunityID }
        );
      }
    );

    // Tool 28: Lead Lookup
    this.server.tool(
      "acumatica_get_lead",
      "Retrieve a marketing lead by lead ID. Returns name, email, phone, company, status, source, class, owner, address, and qualification date.",
      {
        leadID: z.string().describe("Lead ID (numeric)"),
      },
      async ({ leadID }) => {
        return this.callTool(() =>
          handleGetLead(this.env, this.props.acumaticaUsername, { leadID }),
          "acumatica_get_lead",
          { leadID }
        );
      }
    );

    // Tool 29: Salesperson Lookup
    this.server.tool(
      "acumatica_get_salesperson",
      "Retrieve a salesperson by ID. Returns name, active status, default commission percentage, and sales subaccount.",
      {
        salespersonID: z.string().describe("Salesperson ID"),
      },
      async ({ salespersonID }) => {
        return this.callTool(() =>
          handleGetSalesperson(this.env, this.props.acumaticaUsername, { salespersonID }),
          "acumatica_get_salesperson",
          { salespersonID }
        );
      }
    );

    // Tool 30: Shipment Lookup
    this.server.tool(
      "acumatica_get_shipment",
      "Retrieve a shipment by shipment number. Returns customer, warehouse, ship via, shipped quantities/weight/volume, packages with tracking numbers, line items, and freight details.",
      {
        shipmentNbr: z.string().describe("Shipment number"),
      },
      async ({ shipmentNbr }) => {
        return this.callTool(() =>
          handleGetShipment(this.env, this.props.acumaticaUsername, { shipmentNbr }),
          "acumatica_get_shipment",
          { shipmentNbr }
        );
      }
    );

    // Tool 31: Sales Invoice Lookup
    this.server.tool(
      "acumatica_get_sales_invoice",
      "Retrieve a sales invoice by type and reference number. Returns customer, amounts, balance, line items with SO/shipment linkage, tax details, and due date.",
      {
        type: z
          .string()
          .default("Invoice")
          .describe("Document type (e.g., 'Invoice', 'Credit Memo')"),
        referenceNbr: z.string().describe("Sales invoice reference number"),
      },
      async ({ type, referenceNbr }) => {
        return this.callTool(() =>
          handleGetSalesInvoice(this.env, this.props.acumaticaUsername, { type, referenceNbr }),
          "acumatica_get_sales_invoice",
          { type, referenceNbr }
        );
      }
    );

    // Tool 32: Employee Lookup
    this.server.tool(
      "acumatica_get_employee",
      "Retrieve an employee by employee ID. Returns name, status, contact info, employee settings, and financial settings.",
      {
        employeeID: z.string().describe("Employee ID (e.g., 'EP00000001')"),
      },
      async ({ employeeID }) => {
        return this.callTool(() =>
          handleGetEmployee(this.env, this.props.acumaticaUsername, { employeeID }),
          "acumatica_get_employee",
          { employeeID }
        );
      }
    );

    // Tool 33: Expense Claim Lookup
    this.server.tool(
      "acumatica_get_expense_claim",
      "Retrieve an expense claim by reference number. Returns claimant, date, total, line items with amounts, tax details, approval status, and customer/department.",
      {
        refNbr: z.string().describe("Expense claim reference number"),
      },
      async ({ refNbr }) => {
        return this.callTool(() =>
          handleGetExpenseClaim(this.env, this.props.acumaticaUsername, { refNbr }),
          "acumatica_get_expense_claim",
          { refNbr }
        );
      }
    );

    // Tool 34: Time Entry Lookup
    this.server.tool(
      "acumatica_get_time_entry",
      "Retrieve a time entry by ID. Returns employee, date, project/task, time spent, billable time, overtime, earning type, cost rate, and approval status.",
      {
        timeEntryID: z.string().describe("Time entry ID (GUID)"),
      },
      async ({ timeEntryID }) => {
        return this.callTool(() =>
          handleGetTimeEntry(this.env, this.props.acumaticaUsername, { timeEntryID }),
          "acumatica_get_time_entry",
          { timeEntryID }
        );
      }
    );

    // Tool 35: Email Activity Lookup
    this.server.tool(
      "acumatica_get_email",
      "Retrieve a CRM email activity by note ID. Returns subject, from/to/cc/bcc, body, mail status, related entity, and timestamps.",
      {
        noteID: z.string().describe("Email note ID (GUID)"),
      },
      async ({ noteID }) => {
        return this.callTool(() =>
          handleGetEmail(this.env, this.props.acumaticaUsername, { noteID }),
          "acumatica_get_email",
          { noteID }
        );
      }
    );

    // Tool 36: Event Lookup
    this.server.tool(
      "acumatica_get_event",
      "Retrieve a CRM event by note ID. Returns summary, start/end dates, location, priority, category, attendees, related entity, and show-as status.",
      {
        noteID: z.string().describe("Event note ID (GUID)"),
      },
      async ({ noteID }) => {
        return this.callTool(() =>
          handleGetEvent(this.env, this.props.acumaticaUsername, { noteID }),
          "acumatica_get_event",
          { noteID }
        );
      }
    );

    // Tool 37: Activity Lookup
    this.server.tool(
      "acumatica_get_activity",
      "Retrieve a CRM activity by note ID. Returns summary, type, status, date, owner, related entity, and body.",
      {
        noteID: z.string().describe("Activity note ID (GUID)"),
      },
      async ({ noteID }) => {
        return this.callTool(() =>
          handleGetActivity(this.env, this.props.acumaticaUsername, { noteID }),
          "acumatica_get_activity",
          { noteID }
        );
      }
    );

    // Tool 38: Task Lookup
    this.server.tool(
      "acumatica_get_task",
      "Retrieve a CRM task by note ID. Returns summary, status, priority, due date, completion percentage, related activities/tasks, and owner.",
      {
        noteID: z.string().describe("Task note ID (GUID)"),
      },
      async ({ noteID }) => {
        return this.callTool(() =>
          handleGetTask(this.env, this.props.acumaticaUsername, { noteID }),
          "acumatica_get_task",
          { noteID }
        );
      }
    );

    // Tool 39: Generic Inquiry
    this.server.tool(
      "acumatica_run_inquiry",
      "Execute a Generic Inquiry (GI) exposed via OData in Acumatica and return filtered results. Use this for custom reports and cross-entity queries. Use acumatica_list_generic_inquiries to discover GI names and acumatica_describe_inquiry to get field schema before calling this tool.",
      {
        inquiryName: z
          .string()
          .describe("Generic Inquiry name as configured in Acumatica (e.g., 'GI000001')"),
        filterExpression: z
          .string()
          .optional()
          .describe("OData v3 $filter expression (e.g., \"BranchID eq 'BTC' and Status eq 'Open'\"). Use substringof('needle', Field) for partial match (needle comes first). Do NOT use contains() (v4 syntax) or wrap fields in toupper()/tolower() — Acumatica does not support these and returns a 500. Substring matching is case-insensitive, so pass the needle in any casing."),
        topN: z
          .coerce.number()
          .int()
          .min(1)
          .max(1000)
          .default(100)
          .describe("Maximum number of rows to return (default 100, max 1000). Do NOT paginate or make multiple calls to retrieve all records. If results are truncated, ask the user to narrow their query with filterExpression instead."),
        selectFields: z
          .string()
          .optional()
          .describe("Comma-separated field names to return (e.g., 'CustomerID,Balance')"),
      },
      async ({ inquiryName, filterExpression, topN, selectFields }) => {
        return this.callTool(() =>
          handleRunInquiry(this.env, this.props.acumaticaUsername, {
            inquiryName,
            filterExpression,
            topN,
            selectFields,
          }),
          "acumatica_run_inquiry",
          { inquiryName, filterExpression, topN, selectFields }
        );
      }
    );

    // Tool 40: List/Search Entities
    this.server.tool(
      "acumatica_list_entities",
      "List or search any Acumatica entity with filtering, sorting, and field selection. Use this to find records matching criteria (e.g., all open invoices over $10,000, customers in a state, stock items below reorder point). IMPORTANT: Always use filterExpression to scope queries. Never retrieve all records from large entities (JournalTransaction, Invoice, Bill, etc.). Do NOT paginate by making multiple calls to fetch all data — if results are truncated, help the user refine their filter. Supported entity names include: Customer, Vendor, SalesOrder, Invoice, Bill, Payment, Check, StockItem, NonStockItem, PurchaseOrder, PurchaseReceipt, Shipment, SalesInvoice, Project, Case, ServiceOrder, Appointment, Contact, BusinessAccount, Opportunity, Lead, Employee, ExpenseClaim, JournalTransaction, and more.",
      {
        entityName: z
          .string()
          .describe("Acumatica entity name (e.g., 'Customer', 'Invoice', 'SalesOrder', 'StockItem')"),
        filterExpression: z
          .string()
          .optional()
          .describe("OData v3 $filter expression (e.g., \"Status eq 'Open' and Amount gt 10000\", \"CustomerClass eq 'LOCAL'\", \"Date gt datetimeoffset'2026-01-01'\"). Use substringof('needle', Field) for partial match (needle comes first). Do NOT use contains() (v4 syntax) or wrap fields in toupper()/tolower() — Acumatica does not support these and returns a 500. Substring matching is case-insensitive, so pass the needle in any casing."),
        topN: z
          .coerce.number()
          .int()
          .min(1)
          .max(1000)
          .default(100)
          .describe("Maximum number of rows to return (default 100, max 1000). Do NOT paginate or make multiple calls to retrieve all records. If results are truncated, ask the user to narrow their query with filterExpression instead."),
        selectFields: z
          .string()
          .optional()
          .describe("Comma-separated field names to return (e.g., 'CustomerID,CustomerName,Status')"),
        orderBy: z
          .string()
          .optional()
          .describe("OData $orderby expression (e.g., 'Amount desc', 'Date asc', 'CustomerName asc')"),
        expand: z
          .string()
          .optional()
          .describe("Comma-separated sub-entities to include (e.g., 'Details', 'MainContact,BillingContact')"),
      },
      async ({ entityName, filterExpression, topN, selectFields, orderBy, expand }) => {
        return this.callTool(() =>
          handleListEntities(this.env, this.props.acumaticaUsername, {
            entityName,
            filterExpression,
            topN,
            selectFields,
            orderBy,
            expand,
          }),
          "acumatica_list_entities",
          { entityName, filterExpression, topN, selectFields, orderBy, expand }
        );
      }
    );

    // Tool 41: Describe Entity Schema
    this.server.tool(
      "acumatica_describe_entity",
      "Describe the fields and structure of any Acumatica entity. Call this before using acumatica_list_entities to discover available field names, types, and sub-entities for filtering, sorting, and selection.",
      {
        entityName: z
          .string()
          .describe("Acumatica entity name (e.g., 'Customer', 'Invoice', 'SalesOrder', 'StockItem')"),
      },
      async ({ entityName }) => {
        return this.callTool(() =>
          handleDescribeEntity(this.env, this.props.acumaticaUsername, { entityName }),
          "acumatica_describe_entity",
          { entityName }
        );
      }
    );

    // Tool 42: List Generic Inquiries (OData)
    this.server.tool(
      "acumatica_list_generic_inquiries",
      "List all Generic Inquiries (GIs) exposed via OData in Acumatica. Returns inquiry names. Use this to discover available GI names before calling acumatica_run_inquiry or acumatica_describe_inquiry.",
      {
        titleFilter: z
          .string()
          .optional()
          .describe("Optional partial name match to narrow results (case-insensitive contains)."),
        topN: z
          .coerce.number()
          .int()
          .min(1)
          .max(1000)
          .default(200)
          .describe("Maximum number of GIs to return (default 200, max 1000)"),
      },
      async ({ titleFilter, topN }) => {
        return this.callTool(() =>
          handleListGenericInquiries(this.env, this.props.acumaticaUsername, {
            titleFilter,
            topN,
          }),
          "acumatica_list_generic_inquiries",
          { titleFilter, topN }
        );
      }
    );

    // Tool 43: Describe Generic Inquiry Schema
    this.server.tool(
      "acumatica_describe_inquiry",
      "Returns the field schema for a Generic Inquiry (GI) exposed via OData — field names and inferred types. Use this before calling acumatica_run_inquiry to know which fields are available for filtering and selection.",
      {
        inquiryName: z
          .string()
          .describe("Generic Inquiry name as configured in Acumatica (e.g., 'ProjectBudgetSummary'). Use acumatica_list_generic_inquiries to discover names."),
      },
      async ({ inquiryName }) => {
        return this.callTool(() =>
          handleDescribeInquiry(this.env, this.props.acumaticaUsername, { inquiryName }),
          "acumatica_describe_inquiry",
          { inquiryName }
        );
      }
    );

    // Tool 44: Clear Metadata Cache
    this.server.tool(
      "acumatica_clear_cache",
      "Clear cached metadata (entity schemas, GI lists, GI field schemas). Use when Acumatica customizations have changed and cached schema data is stale. With no arguments, clears all cached metadata. Optionally specify a target to clear only that cache.",
      {
        target: z
          .string()
          .optional()
          .describe("What to clear: 'schema:EntityName' (one entity schema), 'schemas' (all entity schemas), 'gi' (GI list + metadata), 'gi_schema:InquiryName' (one GI schema), or omit to clear everything."),
      },
      async ({ target }) => {
        return this.callTool(() =>
          handleClearCache(this.env, target),
          "acumatica_clear_cache",
          { target }
        );
      }
    );
  }

  /** Flush buffered log entries to R2 and clear any pending alarm. */
  private async flushLogs(): Promise<void> {
    if (this.alarmScheduled) {
      await this.ctx.storage.deleteAlarm().catch(() => {});
      this.alarmScheduled = false;
    }
    if (this.logBuffer.length === 0) return;
    const entries = this.logBuffer;
    this.logBuffer = [];
    writeLogsToR2(this.env.mcp4acumatica_logs, entries).catch(() => {});
  }

  /**
   * Add log entries to the buffer. Flush immediately if the size
   * threshold is reached; otherwise ensure a DO alarm is scheduled
   * so an idle buffer still lands in R2.
   */
  private async bufferLogs(entries: Record<string, unknown>[]): Promise<void> {
    this.logBuffer.push(...entries);
    if (this.logBuffer.length >= AcumaticaMcpServer.LOG_FLUSH_THRESHOLD) {
      await this.flushLogs();
      return;
    }
    if (!this.alarmScheduled) {
      await this.ctx.storage.setAlarm(Date.now() + AcumaticaMcpServer.LOG_FLUSH_DELAY_MS);
      this.alarmScheduled = true;
    }
  }

  /** DO alarm handler — fires after LOG_FLUSH_DELAY_MS of idle to drain the buffer. */
  async alarm(): Promise<void> {
    this.alarmScheduled = false;
    if (this.logBuffer.length === 0) return;
    const entries = this.logBuffer;
    this.logBuffer = [];
    await writeLogsToR2(this.env.mcp4acumatica_logs, entries).catch(() => {});
  }

  /**
   * Wraps a tool handler, catching known errors and returning
   * MCP-formatted text content.
   */
  private async callTool(
    fn: () => Promise<unknown>,
    toolName?: string,
    params?: Record<string, unknown>
  ): Promise<{ content: Array<{ type: "text"; text: string }> }> {
    const start = Date.now();
    const r2Entries: Record<string, unknown>[] = [];
    const toolParams = params || {};

    try {
      const result = await fn();

      // Apply sensitive field redaction (uses KV config with env var fallback)
      const { data, redactedFields: redacted } = redactFields(
        result,
        this.redactPatterns,
        this.redactSkip
      );

      if (redacted.length > 0) {
        logRedaction(
          toolName || "unknown",
          this.props.acumaticaUsername,
          redacted
        );
        r2Entries.push({
          level: "info",
          type: "field_redaction",
          timestamp: new Date().toISOString(),
          tool: toolName || "unknown",
          acumaticaUsername: this.props.acumaticaUsername,
          redactedFields: redacted,
          redactedCount: redacted.length,
        });
      }

      // Log successful tool invocation
      const durationMs = Date.now() - start;
      const invocationEntry = {
        level: "info",
        type: "tool_invocation",
        timestamp: new Date().toISOString(),
        tool: toolName || "unknown",
        acumaticaUsername: this.props.acumaticaUsername,
        params: toolParams,
        status: "success",
        durationMs,
      };
      logToolInvocation({
        timestamp: invocationEntry.timestamp,
        tool: invocationEntry.tool,
        acumaticaUsername: invocationEntry.acumaticaUsername,
        params: toolParams,
        endpoint: "",
        statusCode: 200,
        durationMs,
      });
      r2Entries.push(invocationEntry);

      // Buffer log entries (flushed to R2 on threshold or delayed alarm)
      await this.bufferLogs(r2Entries);

      const content: Array<{ type: "text"; text: string }> = [
        { type: "text" as const, text: JSON.stringify(data, null, 2) },
      ];

      if (redacted.length > 0) {
        content.push({
          type: "text" as const,
          text: `[Note: ${redacted.length} sensitive field(s) were automatically redacted. Verify critical data directly in Acumatica.]`,
        });
      }

      return { content };
    } catch (error) {
      const message =
        error instanceof AcumaticaApiError
          ? error.message
          : error instanceof RateLimitError
            ? error.message
            : error instanceof Error
              ? error.message
              : "An unexpected error occurred.";

      // Log failed tool invocation
      const durationMs = Date.now() - start;
      const errorEntry = {
        level: "error",
        type: "tool_invocation",
        timestamp: new Date().toISOString(),
        tool: toolName || "unknown",
        acumaticaUsername: this.props.acumaticaUsername,
        params: toolParams,
        status: "error",
        durationMs,
        error: message,
      };
      logError(toolName || "unknown", error);
      r2Entries.push(errorEntry);

      // Buffer log entries (flushed to R2 on threshold or delayed alarm)
      await this.bufferLogs(r2Entries);

      return {
        content: [{ type: "text" as const, text: `Error: ${message}` }],
      };
    }
  }
}

// The OAuthProvider wraps the entire worker.
// - apiRoute requests (/mcp, /sse) require a valid bearer token
// - All other requests are passed to the AcumaticaAuthHandler (login flow, health, etc.)
export default new OAuthProvider({
  apiRoute: ["/mcp", "/sse"],
  apiHandler: AcumaticaMcpServer.serve("/mcp") as any,
  defaultHandler: AcumaticaAuthHandler,
  authorizeEndpoint: "/authorize",
  tokenEndpoint: "/token",
  clientRegistrationEndpoint: "/register",
  clientIdMetadataDocumentEnabled: true,
  scopesSupported: ["api"],
});
