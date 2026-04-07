// Copyright 2026 Hall Boys, Inc.
// SPDX-License-Identifier: Apache-2.0

import type { Env } from "../types/acumatica";
import { AcumaticaClient } from "../lib/acumatica-client";

export async function handleDescribeEntity(
  env: Env,
  acumaticaUsername: string,
  args: { entityName: string }
): Promise<unknown> {
  const client = new AcumaticaClient(env, acumaticaUsername);

  const schema = await client.get<Record<string, unknown>>(
    `${args.entityName}/$adHocSchema`,
    "acumatica_describe_entity",
    { entityName: args.entityName }
  );

  return schema;
}
