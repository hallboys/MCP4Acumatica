// Copyright 2026 Hall Boys, Inc.
// SPDX-License-Identifier: Apache-2.0

import type { AppEnv } from "../types/acumatica";
import { loadIndex, INDEX_KEYS } from "../lib/index-store";
import {
  searchDocs,
  resolveChunk,
  chunksForFormId,
  normalizeFormId,
  matchGuides,
  type DocsCatalog,
  type DocsPartBlob,
} from "../lib/docs-search";

/**
 * Documentation-knowledge tools, backed by the docs index built from the
 * official Acumatica Markdown documentation set (scripts/build-docs-index.mjs
 * → INDEX_STORE R2). The catalog (headings + Form IDs) is memoized per
 * isolate via loadIndex(); chunk TEXT lives in bounded docs-chunks/* blobs
 * fetched on demand here — deliberately NOT through loadIndex(), whose
 * per-isolate memo never evicts and would accumulate the whole ~40 MB corpus
 * in memory. A small FIFO cache below keeps the last few parts warm instead.
 */

const BUILD_HINT =
  "Documentation index not available. The operator can build it by downloading " +
  "the official Acumatica Markdown documentation set (documentation portal, " +
  "login required) and running `npm run build-docs-index -- <folder>` followed " +
  "by `npm run upload-index` — see /docs/documentation-tools.";

// Max characters of section text returned by one get_doc_section call.
const TEXT_BUDGET = 24_000;

// ── Bounded part-blob cache ─────────────────────────────────────
const PART_CACHE_MAX = 4;
const partCache = new Map<string, DocsPartBlob>();

async function getPart(env: AppEnv, key: string): Promise<DocsPartBlob | null> {
  const cached = partCache.get(key);
  if (cached) return cached;
  if (!env.indexStore) return null;
  let blob: DocsPartBlob;
  try {
    const raw = await env.indexStore.get(key);
    if (raw === null) return null;
    blob = JSON.parse(raw) as DocsPartBlob;
  } catch {
    return null;
  }
  if (partCache.size >= PART_CACHE_MAX) {
    const oldest = partCache.keys().next().value;
    if (oldest !== undefined) partCache.delete(oldest);
  }
  partCache.set(key, blob);
  return blob;
}

async function getCatalog(env: AppEnv): Promise<DocsCatalog | null> {
  return loadIndex<DocsCatalog>(env, INDEX_KEYS.docs);
}

// ── Search ──────────────────────────────────────────────────────

export async function handleSearchDocs(
  env: AppEnv,
  args: { query?: string; formId?: string; guide?: string; topN?: number }
): Promise<unknown> {
  const catalog = await getCatalog(env);
  if (!catalog) return { error: BUILD_HINT };

  const query = args.query?.trim();
  const formId = args.formId?.trim();
  if (!query && !formId) {
    return { error: "Provide `query` (feature/section terms) and/or `formId` (a screen ID like AP301000)." };
  }
  if (formId && !normalizeFormId(formId)) {
    return {
      error: `'${formId}' is not a Form ID. Form IDs are two letters + six digits (e.g. AP301000, SO301000). To search by words, use \`query\` instead.`,
    };
  }
  if (args.guide && matchGuides(catalog, args.guide).length === 0) {
    return {
      error: `No guide matches '${args.guide}'. Available guides: ${catalog.guides.map((g) => g.slug).join(", ")}`,
    };
  }

  const results = searchDocs(catalog, { query, formId, guide: args.guide, limit: args.topN });
  return {
    results,
    resultCount: results.length,
    release: catalog.release,
    note:
      results.length === 0
        ? "No section headings matched. Search matches SECTION HEADINGS and Form IDs, not body text — retry with the feature's name as Acumatica's documentation would title it (e.g. 'expense reclassification' rather than a full question), or pass formId for a screen."
        : "Pass a result's chunkId (or a Form ID) to acumatica_get_doc_section to read the section text.",
  };
}

// ── Get section text ────────────────────────────────────────────

export async function handleGetDocSection(
  env: AppEnv,
  args: { ref: string }
): Promise<unknown> {
  const catalog = await getCatalog(env);
  if (!catalog) return { error: BUILD_HINT };

  const ref = args.ref?.trim() ?? "";
  if (!ref) return { error: "`ref` is required — a chunkId from acumatica_search_docs (e.g. 'projects:214') or a Form ID (e.g. AP301000)." };

  const formId = normalizeFormId(ref);
  if (formId) return getFormSections(env, catalog, formId);
  return getSingleChunk(env, catalog, ref);
}

async function getSingleChunk(env: AppEnv, catalog: DocsCatalog, chunkId: string): Promise<unknown> {
  const resolved = resolveChunk(catalog, chunkId);
  if (!resolved) {
    return {
      error: `Unknown chunkId '${chunkId}'. Use a chunkId returned by acumatica_search_docs ('{guide}:{number}'), or a Form ID like AP301000.`,
    };
  }
  const { guide, ordinal, meta, part } = resolved;
  const blob = await getPart(env, part.key);
  if (!blob) return { error: `Could not load the section text blob (${part.key}). The docs index may be partially uploaded — the operator should re-run \`npm run upload-index\`.` };

  const text = blob.texts[ordinal - blob.first] ?? "";
  const neighbor = (o: number) =>
    o >= 0 && o < guide.chunks.length
      ? { chunkId: `${guide.slug}:${o}`, path: guide.chunks[o].p }
      : undefined;

  return {
    chunkId,
    guide: guide.slug,
    path: meta.p,
    ...(meta.f ? { formId: meta.f } : {}),
    text: text.length > TEXT_BUDGET ? text.slice(0, TEXT_BUDGET) + "\n[...truncated]" : text,
    prev: neighbor(ordinal - 1),
    next: neighbor(ordinal + 1),
    release: catalog.release,
  };
}

async function getFormSections(env: AppEnv, catalog: DocsCatalog, formId: string): Promise<unknown> {
  const all = chunksForFormId(catalog, formId);
  if (all.length === 0) {
    return {
      error: `No documentation sections found for Form ID ${formId}. Verify the ID (two letters + six digits), or search by the screen's name with acumatica_search_docs.`,
    };
  }

  const sections: Array<{ chunkId: string; path: string; text: string }> = [];
  let used = 0;
  let i = 0;
  for (; i < all.length; i++) {
    const c = all[i];
    const resolved = resolveChunk(catalog, c.chunkId);
    if (!resolved) continue;
    const blob = await getPart(env, resolved.part.key);
    if (!blob) continue;
    const text = blob.texts[c.ordinal - blob.first] ?? "";
    if (sections.length > 0 && used + text.length > TEXT_BUDGET) break;
    sections.push({ chunkId: c.chunkId, path: c.path, text });
    used += text.length;
  }

  const remaining = all.slice(i);
  return {
    formId,
    release: catalog.release,
    sectionCount: all.length,
    sections,
    ...(remaining.length > 0
      ? {
          truncated: true,
          remainingSections: remaining.map((c) => ({ chunkId: c.chunkId, path: c.path })),
          note: `Returned the first ${sections.length} of ${all.length} sections for ${formId} (size cap). Fetch a specific remaining section by its chunkId if needed — often the tab you need is listed in remainingSections.`,
        }
      : {}),
  };
}
