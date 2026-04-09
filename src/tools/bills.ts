// Copyright 2026 Hall Boys, Inc.
// SPDX-License-Identifier: Apache-2.0

import type { Bill, AppEnv } from "../types/acumatica";
import { AcumaticaClient, unwrapFields } from "../lib/acumatica-client";

export async function handleGetBill(
  env: AppEnv,
  acumaticaUsername: string,
  args: { type?: string; referenceNbr: string }
): Promise<unknown> {
  const type = args.type || "Bill";
  const client = new AcumaticaClient(env, acumaticaUsername);
  const bill = await client.get<Bill>(
    `Bill/${encodeURIComponent(type)}/${encodeURIComponent(args.referenceNbr)}`,
    "acumatica_get_bill",
    { type, referenceNbr: args.referenceNbr },
    { $expand: "Details,TaxDetails" }
  );
  return unwrapFields(bill);
}
