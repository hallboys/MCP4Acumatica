// Copyright 2026 Hall Boys, Inc.
// SPDX-License-Identifier: Apache-2.0

import type { AppEnv } from "../types/acumatica";
import { AcumaticaClient } from "./acumatica-client";
import { getCached, setCached } from "./metadata-cache";
import { getConfig, parsePositiveIntConfig } from "./config";
import { logError } from "./logger";
import {
  assembleRegistry,
  parseEdmxTypes,
  type GiRegistry,
  type FeedGiRow,
  type FeedFieldRow,
} from "./gi-registry";

/**
 * Lazy, on-demand build of the GI registry using the *requesting user's* token
 * (no background service identity — see gi-registry.ts). The registry is global
 * data, so it's built from whoever's token is in hand and cached for everyone.
 *
 * Caching:
 *  - KV key `cache:gi_registry`, written with a long TTL so the last-good copy
 *    survives well past the freshness window (durable last-good).
 *  - `builtAt` drives freshness: older than REGISTRY_FRESH_SECONDS → rebuild.
 *  - Per-isolate memo bounds work to at most one build attempt per isolate.
 *
 * Failure handling (fail-closed once active): a failed rebuild keeps serving the
 * cached last-good registry. Only a genuine absence (never built, or the build
 * fails with no cache) yields null → gate inactive.
 */

const REGISTRY_CACHE_KEY = "gi_registry";
const REGISTRY_FRESH_SECONDS = 3600; // rebuild when older than 1h
const REGISTRY_DURABLE_TTL = 7 * 24 * 3600; // last-good survives 7 days of failed/absent rebuilds
const GI_METADATA_TTL_SECONDS = 3600;

// Feed GI names (the two registry inquiries). Kept here, not in the leaf gate
// module, because only the build path queries them.
const FEED_REGISTRY_GI = "MCPGIs";
const FEED_FIELDS_GI = "MCPGIFields";

interface ODataValue<T> {
  value: T[];
}

// Per-isolate memo. `attempted` ensures at most one build attempt per isolate
// even when the result is null (gate inactive) or a stale-but-unrebuildable
// last-good.
let memo: { attempted: boolean; registry: GiRegistry | null } = {
  attempted: false,
  registry: null,
};

/** Reset the per-isolate memo. Test seam only. */
export function __resetGiRegistryMemo(): void {
  memo = { attempted: false, registry: null };
}

function isFresh(reg: GiRegistry): boolean {
  const built = Date.parse(reg.builtAt);
  if (!Number.isFinite(built)) return false;
  return Date.now() - built < REGISTRY_FRESH_SECONDS * 1000;
}

/**
 * Return the GI registry, building it lazily if stale/absent. Returns null when
 * no registry has ever been built (gate inactive). Never throws — a build
 * failure degrades to the cached last-good, or null.
 */
export async function getGiRegistry(env: AppEnv, acumaticaUsername: string): Promise<GiRegistry | null> {
  if (memo.attempted) return memo.registry;

  const cached = await getCached<GiRegistry>(env.store, REGISTRY_CACHE_KEY);
  if (cached && isFresh(cached)) {
    memo = { attempted: true, registry: cached };
    return cached;
  }

  // Stale or absent → attempt a rebuild with the caller's token.
  let built: GiRegistry | null = null;
  try {
    built = await buildRegistry(env, acumaticaUsername);
  } catch (error) {
    logError("gi_registry_build", error instanceof Error ? error.message : String(error));
  }

  if (built) {
    await setCached(env.store, REGISTRY_CACHE_KEY, built, REGISTRY_DURABLE_TTL);
    memo = { attempted: true, registry: built };
    return built;
  }

  // Build failed (or feeds not accessible). Serve the cached last-good if we
  // have one — keeps the gate enforced rather than flapping to inactive.
  memo = { attempted: true, registry: cached ?? null };
  return memo.registry;
}

async function buildRegistry(env: AppEnv, acumaticaUsername: string): Promise<GiRegistry> {
  const client = new AcumaticaClient(env, acumaticaUsername);

  const maxRecords = await getConfig(env.store, "acumatica_max_records", env.ACUMATICA_MAX_RECORDS);
  const top = String(parsePositiveIntConfig(maxRecords, 1000));

  // The two feeds + $metadata. $metadata reuses the shared gi_metadata cache.
  const [giResp, fieldResp, metaXml] = await Promise.all([
    client.getOData<ODataValue<FeedGiRow>>(FEED_REGISTRY_GI, "gi_registry_build", {}, { $top: top }),
    client.getOData<ODataValue<FeedFieldRow>>(FEED_FIELDS_GI, "gi_registry_build", {}, { $top: top }),
    loadMetadata(client, env),
  ]);

  return assembleRegistry({
    giRows: giResp.value || [],
    fieldRows: fieldResp.value || [],
    edmxTypes: parseEdmxTypes(metaXml),
    builtAt: new Date().toISOString(),
    endpointVersion: env.ACUMATICA_ENDPOINT_VERSION,
  });
}

async function loadMetadata(client: AcumaticaClient, env: AppEnv): Promise<string> {
  const cached = await getCached<string>(env.store, "gi_metadata");
  if (cached !== null) return cached;
  const xml = await client.getODataMetadata("gi_registry_build").catch(() => "");
  if (xml) await setCached(env.store, "gi_metadata", xml, GI_METADATA_TTL_SECONDS);
  return xml;
}
