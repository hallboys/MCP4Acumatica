// Copyright 2026 Hall Boys, Inc.
// SPDX-License-Identifier: Apache-2.0

import type { Shipment, AppEnv } from "../types/acumatica";
import { AcumaticaClient, unwrapFields } from "../lib/acumatica-client";

export async function handleGetShipment(
  env: AppEnv,
  acumaticaUsername: string,
  args: { shipmentNbr: string }
): Promise<unknown> {
  const client = new AcumaticaClient(env, acumaticaUsername);
  const shipment = await client.get<Shipment>(
    `Shipment/${encodeURIComponent(args.shipmentNbr)}`,
    "acumatica_get_shipment",
    { shipmentNbr: args.shipmentNbr },
    { $expand: "Details,Packages,Orders" }
  );
  return unwrapFields(shipment);
}
