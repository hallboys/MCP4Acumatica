// Copyright 2026 Hall Boys, Inc.
// SPDX-License-Identifier: Apache-2.0

import type { Salesperson, Env } from "../types/acumatica";
import { AcumaticaClient, unwrapFields } from "../lib/acumatica-client";

export async function handleGetSalesperson(
  env: Env,
  acumaticaUsername: string,
  args: { salespersonID: string }
): Promise<unknown> {
  const client = new AcumaticaClient(env, acumaticaUsername);
  const salesperson = await client.get<Salesperson>(
    `Salesperson/${encodeURIComponent(args.salespersonID)}`,
    "acumatica_get_salesperson",
    { salespersonID: args.salespersonID }
  );
  return unwrapFields(salesperson);
}
