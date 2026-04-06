// Copyright 2026 Hall Boys, Inc.
// SPDX-License-Identifier: Apache-2.0

import type { PurchaseReceipt, Env } from "../types/acumatica";
import { AcumaticaClient, unwrapFields } from "../lib/acumatica-client";

export async function handleGetPurchaseReceipt(
  env: Env,
  acumaticaUsername: string,
  args: { type?: string; receiptNbr: string }
): Promise<unknown> {
  const type = args.type || "Receipt";
  const client = new AcumaticaClient(env, acumaticaUsername);
  const receipt = await client.get<PurchaseReceipt>(
    `PurchaseReceipt/${encodeURIComponent(type)}/${encodeURIComponent(args.receiptNbr)}`,
    "acumatica_get_purchase_receipt",
    { type, receiptNbr: args.receiptNbr },
    { $expand: "Details" }
  );
  return unwrapFields(receipt);
}
