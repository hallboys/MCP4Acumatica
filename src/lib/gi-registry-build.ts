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
/**
 * Page cap for the feed pulls. The field feed emits one row per output column of
 * every exposed GI — a mature instance runs to several thousand, well past the
 * single-request record cap, and a silently truncated tail costs every GI after
 * it its curated descriptions (positional alignment needs the GI's full column
 * set). This is an internal metadata pull, not a model-facing query, so paging
 * is appropriate here; the anti-pagination policy is about tool responses.
 */
const FEED_MAX_PAGES = 10;
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

/**
 * Drop the per-isolate memo so the next getGiRegistry() re-reads KV and, if
 * needed, rebuilds. Called by acumatica_clear_cache: without it, clearing the
 * KV entry is a no-op for the life of the isolate, because getGiRegistry()
 * checks the memo before it ever looks at KV.
 */
export function resetGiRegistryMemo(): void {
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
  const pageSize = parsePositiveIntConfig(maxRecords, 1000);

  // The two feeds + $metadata. $metadata reuses the shared gi_metadata cache.
  const [giRows, fieldRows, metaXml] = await Promise.all([
    fetchFeed<FeedGiRow>(client, FEED_REGISTRY_GI, pageSize, "Name"),
    fetchFeed<FeedFieldRow>(client, FEED_FIELDS_GI, pageSize, "Name,LineNbr"),
    loadMetadata(client, env),
  ]);

  return assembleRegistry({
    giRows,
    fieldRows,
    edmxTypes: parseEdmxTypes(metaXml),
    builtAt: new Date().toISOString(),
    endpointVersion: env.ACUMATICA_ENDPOINT_VERSION,
  });
}

/**
 * Read a feed GI in full, paging past the per-request record cap.
 *
 * The first page is fetched exactly as before (no `$skip`); paging only starts
 * if that page comes back full. Later pages are best-effort — an endpoint that
 * rejects `$skip` degrades to "what we already have" rather than failing the
 * whole registry build.
 */
async function fetchFeed<T>(
  client: AcumaticaClient,
  giName: string,
  pageSize: number,
  orderBy: string
): Promise<T[]> {
  // $skip paging is only sound over a stable sort. GI results are otherwise
  // unordered, so a page boundary could silently repeat or omit rows — and an
  // omitted row costs a GI its column text with no error to notice. Verified
  // supported on the 25R2 GI OData endpoint.
  const first = await client.getOData<ODataValue<T>>(
    giName,
    "gi_registry_build",
    {},
    { $top: String(pageSize), $orderby: orderBy }
  );
  const rows = first.value || [];
  if (rows.length < pageSize) return rows;

  for (let page = 1; page < FEED_MAX_PAGES; page++) {
    let next: T[];
    try {
      const resp = await client.getOData<ODataValue<T>>(
        giName,
        "gi_registry_build",
        {},
        { $top: String(pageSize), $skip: String(page * pageSize), $orderby: orderBy }
      );
      next = resp.value || [];
    } catch (error) {
      logError(
        "gi_registry_build",
        `${giName}: paging stopped at ${rows.length} rows — ${error instanceof Error ? error.message : String(error)}`
      );
      return rows;
    }
    rows.push(...next);
    if (next.length < pageSize) return rows;
  }

  logError(
    "gi_registry_build",
    `${giName}: hit the ${FEED_MAX_PAGES}-page cap at ${rows.length} rows; later GIs may lose their curated column descriptions.`
  );
  return rows;
}

async function loadMetadata(client: AcumaticaClient, env: AppEnv): Promise<string> {
  const cached = await getCached<string>(env.store, "gi_metadata");
  if (cached !== null) return cached;
  const xml = await client.getODataMetadata("gi_registry_build").catch(() => "");
  if (xml) await setCached(env.store, "gi_metadata", xml, GI_METADATA_TTL_SECONDS);
  return xml;
}
