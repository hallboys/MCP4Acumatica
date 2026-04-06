// Copyright 2026 Hall Boys, Inc.
// SPDX-License-Identifier: Apache-2.0

import type { SalesOrder, Env } from "../types/acumatica";
import { AcumaticaClient, unwrapFields } from "../lib/acumatica-client";

export async function handleGetSalesOrder(
  env: Env,
  acumaticaUsername: string,
  args: { orderType?: string; orderNbr: string }
): Promise<unknown> {
  const orderType = args.orderType || "SO";
  const client = new AcumaticaClient(env, acumaticaUsername);
  const salesOrder = await client.get<SalesOrder>(
    `SalesOrder/${encodeURIComponent(orderType)}/${encodeURIComponent(args.orderNbr)}`,
    "acumatica_get_sales_order",
    { orderType, orderNbr: args.orderNbr },
    { $expand: "Details" }
  );
  return unwrapFields(salesOrder);
}
