// Copyright 2026 Hall Boys, Inc.
// SPDX-License-Identifier: Apache-2.0

import type { Customer, Env } from "../types/acumatica";
import { AcumaticaClient, unwrapFields } from "../lib/acumatica-client";

export async function handleGetCustomer(
  env: Env,
  acumaticaUsername: string,
  args: { customerId: string }
): Promise<unknown> {
  const client = new AcumaticaClient(env, acumaticaUsername);
  const customer = await client.get<Customer>(
    `Customer/${encodeURIComponent(args.customerId)}`,
    "acumatica_get_customer",
    { customerId: args.customerId },
    { $expand: "CreditVerificationRules,MainContact,PrimaryContact,BillingContact" }
  );
  return unwrapFields(customer);
}
