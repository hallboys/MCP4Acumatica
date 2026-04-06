// Copyright 2026 Hall Boys, Inc.
// SPDX-License-Identifier: Apache-2.0

import type { JournalTransaction, Env } from "../types/acumatica";
import { AcumaticaClient, unwrapFields } from "../lib/acumatica-client";

export async function handleGetJournalTransaction(
  env: Env,
  acumaticaUsername: string,
  args: { batchNbr: string }
): Promise<unknown> {
  const client = new AcumaticaClient(env, acumaticaUsername);
  const batch = await client.get<JournalTransaction>(
    `JournalTransaction/${encodeURIComponent(args.batchNbr)}`,
    "acumatica_get_journal_transaction",
    { batchNbr: args.batchNbr },
    { $expand: "Details" }
  );
  return unwrapFields(batch);
}
