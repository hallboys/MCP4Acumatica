// Copyright 2026 Hall Boys, Inc.
// SPDX-License-Identifier: Apache-2.0

import type { ServiceOrder, Env } from "../types/acumatica";
import { AcumaticaClient, unwrapFields } from "../lib/acumatica-client";

export async function handleGetServiceOrder(
  env: Env,
  acumaticaUsername: string,
  args: { serviceOrderType?: string; serviceOrderNbr: string }
): Promise<unknown> {
  const type = args.serviceOrderType || "SL";
  const client = new AcumaticaClient(env, acumaticaUsername);
  const order = await client.get<ServiceOrder>(
    `ServiceOrder/${encodeURIComponent(type)}/${encodeURIComponent(args.serviceOrderNbr)}`,
    "acumatica_get_service_order",
    { serviceOrderType: type, serviceOrderNbr: args.serviceOrderNbr },
    { $expand: "Details,Appointments" }
  );
  return unwrapFields(order);
}
