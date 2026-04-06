// Copyright 2026 Hall Boys, Inc.
// SPDX-License-Identifier: Apache-2.0

import type { Warehouse, Env } from "../types/acumatica";
import { AcumaticaClient, unwrapFields } from "../lib/acumatica-client";

export async function handleGetWarehouse(
  env: Env,
  acumaticaUsername: string,
  args: { warehouseID: string }
): Promise<unknown> {
  const client = new AcumaticaClient(env, acumaticaUsername);
  const warehouse = await client.get<Warehouse>(
    `Warehouse/${encodeURIComponent(args.warehouseID)}`,
    "acumatica_get_warehouse",
    { warehouseID: args.warehouseID },
    { $expand: "Locations" }
  );
  return unwrapFields(warehouse);
}
