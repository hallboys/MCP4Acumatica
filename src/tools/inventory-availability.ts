// Copyright 2026 Hall Boys, Inc.
// SPDX-License-Identifier: Apache-2.0

import type { Env } from "../types/acumatica";
import { AcumaticaClient, unwrapFields } from "../lib/acumatica-client";

export async function handleGetInventoryQuantityAvailable(
  env: Env,
  acumaticaUsername: string,
  args: { inventoryID: string }
): Promise<unknown> {
  const client = new AcumaticaClient(env, acumaticaUsername);
  const result = await client.get(
    `InventoryQuantityAvailable/${encodeURIComponent(args.inventoryID)}`,
    "acumatica_get_inventory_quantity_available",
    { inventoryID: args.inventoryID },
    { $expand: "Results" }
  );
  return unwrapFields(result);
}

export async function handleGetInventorySummary(
  env: Env,
  acumaticaUsername: string,
  args: { inventoryID: string; warehouseID?: string }
): Promise<unknown> {
  const client = new AcumaticaClient(env, acumaticaUsername);
  const params: Record<string, string> = { $expand: "Results" };
  const path = args.warehouseID
    ? `InventorySummaryInquiry/${encodeURIComponent(args.inventoryID)}/${encodeURIComponent(args.warehouseID)}`
    : `InventorySummaryInquiry/${encodeURIComponent(args.inventoryID)}`;
  const result = await client.get(
    path,
    "acumatica_get_inventory_summary",
    { inventoryID: args.inventoryID, warehouseID: args.warehouseID },
    params
  );
  return unwrapFields(result);
}
