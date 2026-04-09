// Copyright 2026 Hall Boys, Inc.
// SPDX-License-Identifier: Apache-2.0

import type { Opportunity, AppEnv } from "../types/acumatica";
import { AcumaticaClient, unwrapFields } from "../lib/acumatica-client";

export async function handleGetOpportunity(
  env: AppEnv,
  acumaticaUsername: string,
  args: { opportunityID: string }
): Promise<unknown> {
  const client = new AcumaticaClient(env, acumaticaUsername);
  const opportunity = await client.get<Opportunity>(
    `Opportunity/${encodeURIComponent(args.opportunityID)}`,
    "acumatica_get_opportunity",
    { opportunityID: args.opportunityID },
    { $expand: "Products,TaxDetails" }
  );
  return unwrapFields(opportunity);
}
