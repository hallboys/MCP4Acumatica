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
import { AcumaticaApiError } from "./lib/acumatica-client";
import { RateLimitError } from "./lib/rate-limiter";
import { AcumaticaAuthHandler } from "./auth/acumatica-auth-handler";

export class AcumaticaMcpServer extends McpAgent<Env, Record<string, unknown>, AuthProps> {
  server = new McpServer({
    name: "acumatica-mcp-server",
    version: "0.2.0",
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
