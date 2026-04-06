// Copyright 2026 Hall Boys, Inc.
// SPDX-License-Identifier: Apache-2.0

import type { Payment, Env } from "../types/acumatica";
import { AcumaticaClient, unwrapFields } from "../lib/acumatica-client";

export async function handleGetPayment(
  env: Env,
  acumaticaUsername: string,
  args: { type?: string; referenceNbr: string }
): Promise<unknown> {
  const type = args.type || "Payment";
  const client = new AcumaticaClient(env, acumaticaUsername);
  const payment = await client.get<Payment>(
    `Payment/${encodeURIComponent(type)}/${encodeURIComponent(args.referenceNbr)}`,
    "acumatica_get_payment",
    { type, referenceNbr: args.referenceNbr },
    { $expand: "DocumentsToApply,OrdersToApply" }
  );
  return unwrapFields(payment);
}
