// Copyright 2026 Hall Boys, Inc.
// SPDX-License-Identifier: Apache-2.0

import type { NonStockItem, AppEnv } from "../types/acumatica";
import { AcumaticaClient, unwrapFields } from "../lib/acumatica-client";

export async function handleGetNonStockItem(
  env: AppEnv,
  acumaticaUsername: string,
  args: { inventoryID: string }
): Promise<unknown> {
  const client = new AcumaticaClient(env, acumaticaUsername);
  const item = await client.get<NonStockItem>(
    `NonStockItem/${encodeURIComponent(args.inventoryID)}`,
    "acumatica_get_non_stock_item",
    { inventoryID: args.inventoryID }
  );
  return unwrapFields(item);
}
