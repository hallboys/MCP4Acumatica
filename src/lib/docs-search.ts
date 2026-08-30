// Copyright 2026 Hall Boys, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Documentation-knowledge search over the docs catalog built from the
 * official Acumatica Markdown documentation set by
 * scripts/build-docs-index.mjs.
 *
 * The catalog deliberately holds only heading breadcrumbs + Form IDs — no
 * body text — so it stays small enough to memoize per isolate (the corpus
 * itself is ~40 MB; chunk text lives in bounded `docs-chunks/*` blobs fetched
 * on demand by the get tool). Search therefore matches section headings and
 * Form IDs, not body text; Acumatica's headings are descriptive enough that
 * this covers most lookups, and a Vectorize-backed semantic search can be
 * added behind the same functions later without changing the handlers.
 *
 * Import-free leaf on purpose — unit-testable under `node --test`
 * (see the testability constraint note in CLAUDE.md).
 */

export interface DocsChunkMeta {
  /** Heading breadcrumb, e.g. "Accounts Payable Forms > Bills and Adjustments > Form Toolbar". */
  p: string;
  /** Form ID (screen ID) this chunk documents, e.g. "AP301000" — set only in the form/report references. */
  f?: string;
}

export interface DocsPart {
  /** Blob key, e.g. "docs-chunks/form-reference-3.json". */
  key: string;
  /** Ordinal of the first chunk stored in this part. */
  first: number;
  count: number;
}

export interface DocsGuide {
  slug: string;
  title: string;
  file: string;
  parts: DocsPart[];
  chunks: DocsChunkMeta[];
}

export interface DocsCatalog {
  version: number;
  generatedAt: string;
  release: string;
  guideCount: number;
  chunkCount: number;
  guides: DocsGuide[];
}

/** Contents of one docs-chunks part blob. */
export interface DocsPartBlob {
  slug: string;
  first: number;
  texts: string[];
}

export interface DocsSearchHit {
  /** "{guideSlug}:{ordinal}" — pass to acumatica_get_doc_section. */
  chunkId: string;
  guide: string;
  path: string;
  formId?: string;
  matchedOn: string[];
}

const FORM_ID_RE = /^[A-Za-z]{2}\.?\d{2}\.?\d{2}\.?\d{2}$/;
const FORM_ID_IN_TEXT_RE = /\b([A-Za-z]{2})\.?(\d{2})\.?(\d{2})\.?(\d{2})\b/;

const STOPWORDS = new Set([
  "the", "a", "an", "of", "to", "in", "on", "for", "and", "or", "is", "are",
  "how", "do", "does", "i", "you", "what", "when", "with", "by", "at", "it",
  "form", "screen", "tab", "acumatica",
]);

/** Normalize a Form ID: "ap.30.10.00" → "AP301000". Null if not one. */
export function normalizeFormId(raw: string | undefined): string | null {
  const t = raw?.trim() ?? "";
  if (!FORM_ID_RE.test(t)) return null;
  return t.replace(/\./g, "").toUpperCase();
}

/** Extract a Form ID mentioned anywhere in free text (e.g. a search query). */
export function formIdInText(text: string): string | null {
  const m = FORM_ID_IN_TEXT_RE.exec(text);
  return m ? (m[1] + m[2] + m[3] + m[4]).toUpperCase() : null;
}

function tokenize(query: string): string[] {
  return [
    ...new Set(
      query
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter((t) => t.length >= 2 && !STOPWORDS.has(t))
    ),
  ];
}

/** Guides whose slug or title contains the filter (case-insensitive). */
export function matchGuides(catalog: DocsCatalog, guideFilter: string): DocsGuide[] {
  const needle = guideFilter.trim().toLowerCase();
  if (!needle) return catalog.guides;
  return catalog.guides.filter(
    (g) => g.slug.includes(needle.replace(/\s+/g, "-")) || g.title.toLowerCase().includes(needle)
  );
}

export function searchDocs(
  catalog: DocsCatalog,
  args: { query?: string; formId?: string; guide?: string; limit?: number }
): DocsSearchHit[] {
  const limit = Math.max(1, Math.min(args.limit ?? 20, 100));
  const wantedFormId =
    normalizeFormId(args.formId) ?? (args.query ? formIdInText(args.query) : null);
  const rawQuery = (args.query ?? "").trim().toLowerCase();
  const tokens = rawQuery ? tokenize(rawQuery) : [];
  const phrase = tokens.length >= 2 ? rawQuery : null;
  const guides = args.guide ? matchGuides(catalog, args.guide) : catalog.guides;

  const scored: Array<{ score: number; hit: DocsSearchHit }> = [];
  for (const g of guides) {
    const titleLower = g.title.toLowerCase();
    const titleTokenHits = tokens.filter((t) => titleLower.includes(t)).length;
    for (let i = 0; i < g.chunks.length; i++) {
      const c = g.chunks[i];
      let score = 0;
      const matchedOn: string[] = [];

      if (wantedFormId && c.f === wantedFormId) {
        score += 100;
        matchedOn.push(`form ${wantedFormId}`);
      }
      if (tokens.length > 0) {
        const pathLower = c.p.toLowerCase();
        if (phrase && pathLower.includes(phrase)) {
          score += 40;
          matchedOn.push(`heading contains "${rawQuery}"`);
        }
        let pathHits = 0;
        for (const t of tokens) {
          if (pathLower.includes(t)) {
            pathHits++;
            score += 10;
          }
        }
        if (pathHits === tokens.length && tokens.length > 1) score += 15;
        if (pathHits > 0) {
          matchedOn.push(
            `heading matches ${pathHits}/${tokens.length} term(s)`
          );
        } else if (titleTokenHits > 0 && score > 0) {
          // Guide-title hits alone don't rank a chunk; they only nudge
          // chunks that already matched on formId.
          score += titleTokenHits;
          matchedOn.push(`guide "${g.title}"`);
        }
      }

      if (score > 0 && matchedOn.length > 0) {
        const hit: DocsSearchHit = {
          chunkId: `${g.slug}:${i}`,
          guide: g.slug,
          path: c.p,
          matchedOn,
        };
        if (c.f) hit.formId = c.f;
        scored.push({ score, hit });
      }
    }
  }

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit).map((s) => s.hit);
}

export interface ResolvedChunk {
  guide: DocsGuide;
  ordinal: number;
  meta: DocsChunkMeta;
  part: DocsPart;
}

/** Resolve "{slug}:{ordinal}" to its guide, metadata, and containing part blob. */
export function resolveChunk(catalog: DocsCatalog, chunkId: string): ResolvedChunk | null {
  const sep = chunkId.lastIndexOf(":");
  if (sep <= 0) return null;
  const slug = chunkId.slice(0, sep);
  const ordinal = Number(chunkId.slice(sep + 1));
  if (!Number.isInteger(ordinal) || ordinal < 0) return null;
  const guide = catalog.guides.find((g) => g.slug === slug);
  if (!guide || ordinal >= guide.chunks.length) return null;
  const part = guide.parts.find((p) => ordinal >= p.first && ordinal < p.first + p.count);
  if (!part) return null;
  return { guide, ordinal, meta: guide.chunks[ordinal], part };
}

/** All chunks documenting a Form ID, in document order (a form's overview, toolbar, tabs...). */
export function chunksForFormId(
  catalog: DocsCatalog,
  formId: string
): Array<{ chunkId: string; guide: string; ordinal: number; path: string }> {
  const out: Array<{ chunkId: string; guide: string; ordinal: number; path: string }> = [];
  for (const g of catalog.guides) {
    for (let i = 0; i < g.chunks.length; i++) {
      if (g.chunks[i].f === formId) {
        out.push({ chunkId: `${g.slug}:${i}`, guide: g.slug, ordinal: i, path: g.chunks[i].p });
      }
    }
  }
  return out;
}
