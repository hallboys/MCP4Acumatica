// Copyright 2026 Hall Boys, Inc.
// SPDX-License-Identifier: Apache-2.0

import type { StockItem, Env } from "../types/acumatica";
import { AcumaticaClient, unwrapFields } from "../lib/acumatica-client";

export async function handleGetStockItem(
  env: Env,
  acumaticaUsername: string,
  args: { inventoryID: string }
): Promise<unknown> {
  const client = new AcumaticaClient(env, acumaticaUsername);
  const item = await client.get<StockItem>(
    `StockItem/${encodeURIComponent(args.inventoryID)}`,
    "acumatica_get_stock_item",
    { inventoryID: args.inventoryID },
    { $expand: "WarehouseDetails,VendorDetails" }
  );
  return unwrapFields(item);
}
