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
import { AcumaticaApiError } from "./lib/acumatica-client";
import { RateLimitError } from "./lib/rate-limiter";
import { AcumaticaAuthHandler } from "./auth/acumatica-auth-handler";

export class AcumaticaMcpServer extends McpAgent<Env, Record<string, unknown>, AuthProps> {
  server = new McpServer({
    name: "acumatica-mcp-server",
    version: "0.6.0",
  });

  async init() {
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
          handleGetCustomer(this.env, this.props.acumaticaUsername, { customerId })
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
          handleGetVendor(this.env, this.props.acumaticaUsername, { vendorId })
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
          handleGetSalesOrder(this.env, this.props.acumaticaUsername, { orderType, orderNbr })
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
          handleGetInvoice(this.env, this.props.acumaticaUsername, { type, referenceNbr })
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
          handleGetBill(this.env, this.props.acumaticaUsername, { type, referenceNbr })
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
          handleGetJournalTransaction(this.env, this.props.acumaticaUsername, { batchNbr })
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
          handleGetPayment(this.env, this.props.acumaticaUsername, { type, referenceNbr })
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
          handleGetAccount(this.env, this.props.acumaticaUsername, { accountCD })
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
          handleGetCheck(this.env, this.props.acumaticaUsername, { type, referenceNbr })
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
          handleGetStockItem(this.env, this.props.acumaticaUsername, { inventoryID })
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
          handleGetNonStockItem(this.env, this.props.acumaticaUsername, { inventoryID })
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
          handleGetInventoryQuantityAvailable(this.env, this.props.acumaticaUsername, { inventoryID })
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
          handleGetInventorySummary(this.env, this.props.acumaticaUsername, { inventoryID, warehouseID })
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
          handleGetWarehouse(this.env, this.props.acumaticaUsername, { warehouseID })
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
          handleGetItemClass(this.env, this.props.acumaticaUsername, { classID })
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
          handleGetPurchaseOrder(this.env, this.props.acumaticaUsername, { type, orderNbr })
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
          handleGetPurchaseReceipt(this.env, this.props.acumaticaUsername, { type, receiptNbr })
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
          handleGetProject(this.env, this.props.acumaticaUsername, { projectID })
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
          handleGetProjectTask(this.env, this.props.acumaticaUsername, { projectID, projectTaskID })
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
          handleGetProjectBudget(this.env, this.props.acumaticaUsername, { projectID, projectTaskID, accountGroup, inventoryID })
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
          handleGetProjectTransaction(this.env, this.props.acumaticaUsername, { module, referenceNbr })
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
          handleGetCase(this.env, this.props.acumaticaUsername, { caseID })
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
          handleGetServiceOrder(this.env, this.props.acumaticaUsername, { serviceOrderType, serviceOrderNbr })
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
          handleGetAppointment(this.env, this.props.acumaticaUsername, { serviceOrderType, appointmentNbr })
        );
      }
    );
  }

  /**
   * Wraps a tool handler, catching known errors and returning
   * MCP-formatted text content.
   */
  private async callTool(
    fn: () => Promise<unknown>
  ): Promise<{ content: Array<{ type: "text"; text: string }> }> {
    try {
      const result = await fn();
      return {
        content: [
          { type: "text" as const, text: JSON.stringify(result, null, 2) },
        ],
      };
    } catch (error) {
      const message =
        error instanceof AcumaticaApiError
          ? error.message
          : error instanceof RateLimitError
            ? error.message
            : error instanceof Error
              ? error.message
              : "An unexpected error occurred.";

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
  scopesSupported: ["api"],
});
