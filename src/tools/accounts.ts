// Copyright 2026 Hall Boys, Inc.
// SPDX-License-Identifier: Apache-2.0

import type { Account, Env } from "../types/acumatica";
import { AcumaticaClient, unwrapFields } from "../lib/acumatica-client";

export async function handleGetAccount(
  env: Env,
  acumaticaUsername: string,
  args: { accountCD: string }
): Promise<unknown> {
  const client = new AcumaticaClient(env, acumaticaUsername);
  const account = await client.get<Account>(
    `Account/${encodeURIComponent(args.accountCD)}`,
    "acumatica_get_account",
    { accountCD: args.accountCD }
  );
  return unwrapFields(account);
}
