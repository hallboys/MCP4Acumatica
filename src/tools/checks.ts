// Copyright 2026 Hall Boys, Inc.
// SPDX-License-Identifier: Apache-2.0

import type { Check, AppEnv } from "../types/acumatica";
import { AcumaticaClient, unwrapFields } from "../lib/acumatica-client";

export async function handleGetCheck(
  env: AppEnv,
  acumaticaUsername: string,
  args: { type?: string; referenceNbr: string }
): Promise<unknown> {
  const type = args.type || "Check";
  const client = new AcumaticaClient(env, acumaticaUsername);
  const check = await client.get<Check>(
    `Check/${encodeURIComponent(type)}/${encodeURIComponent(args.referenceNbr)}`,
    "acumatica_get_check",
    { type, referenceNbr: args.referenceNbr },
    { $expand: "Details,History" }
  );
  return unwrapFields(check);
}
