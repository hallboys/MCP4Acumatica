// Copyright 2026 Hall Boys, Inc.
// SPDX-License-Identifier: Apache-2.0

import type { ItemClassEntity, AppEnv } from "../types/acumatica";
import { AcumaticaClient, unwrapFields } from "../lib/acumatica-client";

export async function handleGetItemClass(
  env: AppEnv,
  acumaticaUsername: string,
  args: { classID: string }
): Promise<unknown> {
  const client = new AcumaticaClient(env, acumaticaUsername);
  const itemClass = await client.get<ItemClassEntity>(
    `ItemClass/${encodeURIComponent(args.classID)}`,
    "acumatica_get_item_class",
    { classID: args.classID }
  );
  return unwrapFields(itemClass);
}
