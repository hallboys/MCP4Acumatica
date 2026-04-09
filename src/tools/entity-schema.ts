// Copyright 2026 Hall Boys, Inc.
// SPDX-License-Identifier: Apache-2.0

import type { AppEnv } from "../types/acumatica";
import { AcumaticaClient } from "../lib/acumatica-client";
import { getCached, setCached } from "../lib/metadata-cache";

const SCHEMA_TTL_SECONDS = 86400; // 24 hours

export async function handleDescribeEntity(
  env: AppEnv,
  acumaticaUsername: string,
  args: { entityName: string }
): Promise<unknown> {
  const cacheKey = `schema:${args.entityName}`;

  // Check KV cache first
  const cached = await getCached<Record<string, unknown>>(env.store, cacheKey);
  if (cached) {
    return cached;
  }

  const client = new AcumaticaClient(env, acumaticaUsername);

  const schema = await client.get<Record<string, unknown>>(
    `${args.entityName}/$adHocSchema`,
    "acumatica_describe_entity",
    { entityName: args.entityName }
  );

  // Store in KV for future calls
  await setCached(env.store, cacheKey, schema, SCHEMA_TTL_SECONDS);

  return schema;
}
