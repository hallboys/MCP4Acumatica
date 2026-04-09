// Copyright 2026 Hall Boys, Inc.
// SPDX-License-Identifier: Apache-2.0

import type { Lead, AppEnv } from "../types/acumatica";
import { AcumaticaClient, unwrapFields } from "../lib/acumatica-client";

export async function handleGetLead(
  env: AppEnv,
  acumaticaUsername: string,
  args: { leadID: string }
): Promise<unknown> {
  const client = new AcumaticaClient(env, acumaticaUsername);
  const lead = await client.get<Lead>(
    `Lead/${encodeURIComponent(args.leadID)}`,
    "acumatica_get_lead",
    { leadID: args.leadID }
  );
  return unwrapFields(lead);
}
