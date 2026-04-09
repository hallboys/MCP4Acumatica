// Copyright 2026 Hall Boys, Inc.
// SPDX-License-Identifier: Apache-2.0

import type { ExpenseClaim, AppEnv } from "../types/acumatica";
import { AcumaticaClient, unwrapFields } from "../lib/acumatica-client";

export async function handleGetExpenseClaim(
  env: AppEnv,
  acumaticaUsername: string,
  args: { refNbr: string }
): Promise<unknown> {
  const client = new AcumaticaClient(env, acumaticaUsername);
  const claim = await client.get<ExpenseClaim>(
    `ExpenseClaim/${encodeURIComponent(args.refNbr)}`,
    "acumatica_get_expense_claim",
    { refNbr: args.refNbr },
    { $expand: "Details,TaxDetails" }
  );
  return unwrapFields(claim);
}
