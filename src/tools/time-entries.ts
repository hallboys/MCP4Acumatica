// Copyright 2026 Hall Boys, Inc.
// SPDX-License-Identifier: Apache-2.0

import type { TimeEntry, AppEnv } from "../types/acumatica";
import { AcumaticaClient, unwrapFields } from "../lib/acumatica-client";

export async function handleGetTimeEntry(
  env: AppEnv,
  acumaticaUsername: string,
  args: { timeEntryID: string }
): Promise<unknown> {
  const client = new AcumaticaClient(env, acumaticaUsername);
  const entry = await client.get<TimeEntry>(
    `TimeEntry/${encodeURIComponent(args.timeEntryID)}`,
    "acumatica_get_time_entry",
    { timeEntryID: args.timeEntryID }
  );
  return unwrapFields(entry);
}
