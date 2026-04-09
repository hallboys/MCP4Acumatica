// Copyright 2026 Hall Boys, Inc.
// SPDX-License-Identifier: Apache-2.0

import type { PurchaseOrder, AppEnv } from "../types/acumatica";
import { AcumaticaClient, unwrapFields } from "../lib/acumatica-client";

export async function handleGetPurchaseOrder(
  env: AppEnv,
  acumaticaUsername: string,
  args: { type?: string; orderNbr: string }
): Promise<unknown> {
  const type = args.type || "Normal";
  const client = new AcumaticaClient(env, acumaticaUsername);
  const po = await client.get<PurchaseOrder>(
    `PurchaseOrder/${encodeURIComponent(type)}/${encodeURIComponent(args.orderNbr)}`,
    "acumatica_get_purchase_order",
    { type, orderNbr: args.orderNbr },
    { $expand: "Details" }
  );
  return unwrapFields(po);
}
