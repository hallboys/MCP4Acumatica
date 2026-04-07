// Copyright 2026 Hall Boys, Inc.
// SPDX-License-Identifier: Apache-2.0

import type { Case, Env } from "../types/acumatica";
import { AcumaticaClient, unwrapFields } from "../lib/acumatica-client";

export async function handleGetCase(
  env: Env,
  acumaticaUsername: string,
  args: { caseID: string }
): Promise<unknown> {
  const client = new AcumaticaClient(env, acumaticaUsername);
  const caseRecord = await client.get<Case>(
    `Case/${encodeURIComponent(args.caseID)}`,
    "acumatica_get_case",
    { caseID: args.caseID }
  );
  return unwrapFields(caseRecord);
}
