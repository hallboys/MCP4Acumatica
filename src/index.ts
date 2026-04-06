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
import { AcumaticaApiError } from "./lib/acumatica-client";
import { RateLimitError } from "./lib/rate-limiter";
import { AcumaticaAuthHandler } from "./auth/acumatica-auth-handler";

export class AcumaticaMcpServer extends McpAgent<Env, Record<string, unknown>, AuthProps> {
  server = new McpServer({
    name: "acumatica-mcp-server",
    version: "0.1.0",
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
