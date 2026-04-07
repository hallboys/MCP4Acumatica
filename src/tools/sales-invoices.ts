// Copyright 2026 Hall Boys, Inc.
// SPDX-License-Identifier: Apache-2.0

import type { SalesInvoice, Env } from "../types/acumatica";
import { AcumaticaClient, unwrapFields } from "../lib/acumatica-client";

export async function handleGetSalesInvoice(
  env: Env,
  acumaticaUsername: string,
  args: { type?: string; referenceNbr: string }
): Promise<unknown> {
  const type = args.type || "Invoice";
  const client = new AcumaticaClient(env, acumaticaUsername);
  const invoice = await client.get<SalesInvoice>(
    `SalesInvoice/${encodeURIComponent(type)}/${encodeURIComponent(args.referenceNbr)}`,
    "acumatica_get_sales_invoice",
    { type, referenceNbr: args.referenceNbr },
    { $expand: "Details,TaxDetails" }
  );
  return unwrapFields(invoice);
}
