// Copyright 2026 Hall Boys, Inc.
// SPDX-License-Identifier: Apache-2.0

import type { AppEnv } from "../types/acumatica";
import type { AcumaticaClient } from "./acumatica-client";
import { getCached, setCached } from "./metadata-cache";

const GI_METADATA_TTL_SECONDS = 3600; // 1 hour

/**
 * The GI OData `$metadata` document, cached per user for an hour.
 *
 * Returns null — never "" — when it cannot be fetched (rate-limit slot
 * timeout, 5xx, token problem). Callers deciding whether a GI takes parameters
 * must treat null as "unknown" and refuse: an empty document parses as "no GI
 * has parameters", which would send a parameterized GI to its plain entity set
 * and return unfiltered rows with no error. For the same reason an empty or
 * failed fetch is never cached.
 *
 * Per-user key: whether `$metadata` lists only the GIs the caller may read is
 * unverified, and a shared copy built from a user who cannot see a GI would
 * hide that GI's parameters from everyone else.
 */
export async function loadGiMetadata(
  env: AppEnv,
  client: AcumaticaClient,
  acumaticaUsername: string,
  toolName: string
): Promise<string | null> {
  const key = `gi_metadata:${acumaticaUsername}`;
  const cached = await getCached<string>(env.store, key);
  if (cached) return cached;
  const xml = await client.getODataMetadata(toolName).catch(() => "");
  if (!xml) return null;
  await setCached(env.store, key, xml, GI_METADATA_TTL_SECONDS);
  return xml;
}

/** Drop a user's cached `$metadata`, e.g. after a parameterized call 404s. */
export async function forgetGiMetadata(env: AppEnv, acumaticaUsername: string): Promise<void> {
  await env.store.delete(`cache:gi_metadata:${acumaticaUsername}`).catch(() => {});
}
