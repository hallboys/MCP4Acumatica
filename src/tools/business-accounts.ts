// Copyright 2026 Hall Boys, Inc.
// SPDX-License-Identifier: Apache-2.0

import type { BusinessAccount, Env } from "../types/acumatica";
import { AcumaticaClient, unwrapFields } from "../lib/acumatica-client";

export async function handleGetBusinessAccount(
  env: Env,
  acumaticaUsername: string,
  args: { businessAccountID: string }
): Promise<unknown> {
  const client = new AcumaticaClient(env, acumaticaUsername);
  const account = await client.get<BusinessAccount>(
    `BusinessAccount/${encodeURIComponent(args.businessAccountID)}`,
    "acumatica_get_business_account",
    { businessAccountID: args.businessAccountID },
    { $expand: "MainContact" }
  );
  return unwrapFields(account);
}
