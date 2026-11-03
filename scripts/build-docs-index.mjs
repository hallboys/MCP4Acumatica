// Copyright 2026 Hall Boys, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * build-docs-index.mjs — produce the documentation-knowledge index consumed by
 * the acumatica_search_docs / acumatica_get_doc_section tools.
 *
 * Input:  a folder of official Acumatica documentation in Markdown, from
 *         either source:
 *           (a) Acumatica's public GitHub repo, Documentation/ directory of
 *               github.com/Acumatica/Acumatica-AI-Resources (branch per
 *               release: 2026R1, ...). DITA-converted, so it needs none of
 *               the PDF-artifact cleanup below.
 *           (b) Acumatica's Beacon Portal (https://beacon.acumatica.com/ —
 *               customer-portal login required). PDF-converted. The only
 *               source for releases predating the GitHub repo.
 *         Either way the content is LICENSED to your organization: it is
 *         never committed to this repo and never redistributed. (a) being
 *         publicly readable does not make it redistributable — that
 *         directory is excluded from the repo's GPLv3 and is all-rights-
 *         reserved. Any layout of .md files works; subfolders are walked
 *         recursively.
 * Output: ./.index/docs-index.json            — the search catalog (small):
 *                                               per-chunk heading path + Form
 *                                               IDs. Deliberately NO body
 *                                               text/snippets: the catalog is
 *                                               memoized per isolate in the
 *                                               worker, and Acumatica's
 *                                               headings are descriptive
 *                                               enough to search on. Body
 *                                               text is fetched on demand.
 *         ./.index/docs-chunks/{slug}-{n}.json — the chunk text, split into
 *                                               parts of bounded size so the
 *                                               worker never loads the whole
 *                                               corpus into memory.
 *
 * The catalog is what the worker memoizes per isolate; chunk parts are
 * fetched from R2 on demand. Upload everything with `npm run upload-index`.
 *
 * Two input layouts, detected from the median file size (override with
 * --layout): "guide" — a few dozen monolithic guides (the PDF-converted
 * Beacon sets, 2025R2), one catalog guide per file; "topic" — one help topic
 * per file (the 2026R2 Beacon export, the GitHub set), one catalog guide per
 * top-level folder.
 *
 * Usage: node scripts/build-docs-index.mjs [path/to/docs-folder] [release-label]
 *          [--out <dir>] [--layout topic|guide]
 *        default folder ./.docs-source, release label inferred from the
 *        folder's basename (e.g. ~/ClaudeCode/acumatica-docs/2025R2 → "2025R2"),
 *        output ./.index. Use --out .index/<release> to build a second
 *        release (for another worker) without overwriting the first.
 */

import { readFileSync, writeFileSync, mkdirSync, readdirSync, statSync, rmSync } from "node:fs";
import { join, basename, relative, resolve } from "node:path";

// Bounds are on cleaned text length (chars ≈ bytes for this ASCII-heavy corpus).
const MAX_CHUNK_CHARS = 7000; // split bigger sections at paragraph boundaries
const MIN_BODY_CHARS = 80; // heading-only / stub sections are not chunks
const PART_BUDGET_CHARS = 700_000; // ~700 KB of text per docs-chunks part file

// Tolerate both corpus flavors: the PDF-converted Beacon set writes bare
// "Form ID: (AP301000)", while the DITA-converted set Acumatica publishes on
// GitHub escapes the parens as "Form ID: \(AP301000\)". Without the optional
// backslashes the latter silently yields ZERO Form IDs rather than erroring.
// Report reference pages say "Report ID:" for the same kind of key, and some
// screen IDs carry letters after the module prefix (PMGI3055, AM0018DB).
const FORM_ID_DEF_RE =
  /^\s*(?:Form|Report) ID:?\s*\\?\(?([A-Z]{2}\.?[0-9A-Z]{2}\.?[0-9A-Z]{2}\.?[0-9A-Z]{2})\\?\)?/m;

// Pandoc heading attributes left by the DITA conversion:
// "# Copyright {#_c92aa4bb-… .concept}". Search matches headings, so the ids
// must not reach the breadcrumb.
const HEADING_ATTRS_RE = /\s*\{[#.][^}]*\}\s*$/;

/** Normalize a doc filename to a stable slug: strip vendor prefixes, kebab-case. */
export function guideSlug(fileName) {
  return basename(fileName, ".md")
    .replace(/^AcumaticaERP_/i, "")
    .replace(/^HelpRoot_/i, "")
    .replace(/^Acumatica_/i, "")
    .replace(/[^A-Za-z0-9]+/g, "-")
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .toLowerCase();
}

export function guideTitle(fileName) {
  return basename(fileName, ".md")
    .replace(/^AcumaticaERP_/i, "")
    .replace(/^HelpRoot_/i, "")
    .replace(/_/g, " ")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2");
}

/**
 * Strip the PDF-conversion artifacts that pollute the downloaded markdown:
 * page-break comments, running headers ("Accounts Payable Forms | 53"),
 * and dot-leader table-of-contents lines ("Vendors: General Information....12").
 */
export function cleanMarkdown(raw) {
  const lines = raw.split(/\r?\n/);
  const out = [];
  for (const line of lines) {
    if (/^\s*<!--\s*PAGE_BREAK\s*-->\s*$/.test(line)) continue;
    // Running header: short line ending in "| <page number>".
    if (/^\s*[^|]{1,80}\|\s*\d+\s*$/.test(line)) continue;
    // TOC entry: dot leader followed by a page number.
    if (/\.{4,}\s*\d+\s*$/.test(line)) continue;
    out.push(line);
  }
  return out.join("\n").replace(/\n{3,}/g, "\n\n");
}

/** Heading text: strip #'s already removed; strip bold markers + trailing space. */
function cleanHeading(text) {
  return text.replace(HEADING_ATTRS_RE, "").replace(/\*+/g, "").replace(/\s+/g, " ").trim();
}

const SKIP_HEADINGS = /^(contents|copyright|restricted rights|disclaimer|trademarks)$/i;
// Title-page noise from the PDF conversion ("# 2025 R1", "## End-User Guide"):
// never enters the breadcrumb stack — otherwise every path in a module guide
// is rooted at the release number instead of the guide's own top heading.
const NOISE_HEADINGS = /^(20\d\d\s*R\d|end-user guide|user guide|release notes)$/i;

/**
 * Split cleaned markdown into heading-scoped sections, each carrying its
 * full heading breadcrumb ("Accounts Payable Forms > Bills and Adjustments >
 * Form Toolbar"). Sections longer than MAX_CHUNK_CHARS are split at blank
 * lines; heading-only stubs (< MIN_BODY_CHARS of body) are dropped — their
 * text lives on in descendants' breadcrumbs.
 *
 * Returns [{ path, body, formId? }] in document order. `formId` is set on
 * every section of the scope whose body carries a "Form ID: (XX000000)"
 * definition line — body *mentions* of other forms deliberately don't count.
 * The scope is the nearest heading at level ≤ 2 above the definition, plus
 * everything beneath it: an H2 in the monolithic Form Reference, the H1 of a
 * per-topic file (where a form's toolbar and tabs are H2s under its title).
 */
export function chunkGuide(cleaned) {
  const lines = cleaned.split("\n");
  // heading stack: [{level, text, id}]. `id` is unique per heading occurrence:
  // Form ID scopes are keyed by it, not by breadcrumb text, because two
  // different forms can share a title within one guide (2025R2 has two
  // "Staff Schedule Rules" screens, FS202001 and FS4010PL).
  const stack = [];
  let nextId = 0;
  const sections = [];
  // Form ID per scope heading id. Collected before the stub filter, so a
  // definition in a body too short to be a chunk still counts.
  const formIdByScope = new Map();
  let body = [];

  const flush = () => {
    const text = body.join("\n").trim();
    body = [];
    if (stack.length === 0) return;
    const def = FORM_ID_DEF_RE.exec(text);
    if (def) formIdByScope.set(scopeId(), def[1].replace(/\./g, ""));
    const leaf = stack[stack.length - 1].text;
    if (SKIP_HEADINGS.test(leaf)) return;
    if (text.length < MIN_BODY_CHARS) return;
    const path = stack.map((s) => s.text).join(" > ");
    const anc = stack.map((s) => s.id);
    // Split oversized bodies at paragraph boundaries.
    if (text.length <= MAX_CHUNK_CHARS) {
      sections.push({ path, body: text, anc });
      return;
    }
    const paras = text.split(/\n\n+/);
    let buf = [];
    let bufLen = 0;
    let partNo = 1;
    const emit = () => {
      if (bufLen === 0) return;
      sections.push({
        path: partNo === 1 ? path : `${path} (cont. ${partNo})`,
        body: buf.join("\n\n"),
        anc,
      });
      partNo++;
      buf = [];
      bufLen = 0;
    };
    for (const p of paras) {
      if (bufLen > 0 && bufLen + p.length > MAX_CHUNK_CHARS) emit();
      buf.push(p);
      bufLen += p.length + 2;
    }
    emit();
  };

  // The scope a definition belongs to: the nearest heading at level <= 2.
  const scopeId = () => {
    for (let i = stack.length - 1; i >= 0; i--) {
      if (stack[i].level <= 2) return stack[i].id;
    }
    return stack[0].id;
  };

  for (const line of lines) {
    const m = /^(#{1,6})\s+(.+)$/.exec(line);
    if (!m) {
      body.push(line);
      continue;
    }
    flush();
    const level = m[1].length;
    const text = cleanHeading(m[2]);
    if (NOISE_HEADINGS.test(text)) continue;
    while (stack.length > 0 && stack[stack.length - 1].level >= level) stack.pop();
    stack.push({ level, text, id: nextId++ });
  }
  flush();

  // Form ID pass: a definition tags every section in or beneath its scope
  // (a form's toolbar/tab sections follow the definition). When scopes nest,
  // the deepest one wins; for the same scope, the last definition wins.
  return sections.map(({ path, body: b, anc }) => {
    for (let i = anc.length - 1; i >= 0; i--) {
      const formId = formIdByScope.get(anc[i]);
      if (formId) return { path, body: b, formId };
    }
    return { path, body: b };
  });
}

function walkMarkdownFiles(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    if (name.startsWith(".")) continue;
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) out.push(...walkMarkdownFiles(full));
    else if (name.endsWith(".md") && !/^(CATALOG|README)/i.test(name)) out.push(full);
  }
  return out.sort();
}

// A per-topic export has thousands of small files; a guide-per-file set has
// a few dozen large ones. The median separates them by orders of magnitude
// (2025R2 Beacon guides vs the 2026R2 per-topic export).
const TOPIC_LAYOUT_MEDIAN_BYTES = 64 * 1024;

/** "topic" when the median file is small (one help topic per file), else "guide". */
export function detectLayout(sizes) {
  if (sizes.length === 0) return "guide";
  const sorted = [...sizes].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] < TOPIC_LAYOUT_MEDIAN_BYTES ? "topic" : "guide";
}

/**
 * Group documentation files into guides, given paths relative to the input
 * folder. "guide" layout: one guide per file (the monolithic Beacon guides).
 * "topic" layout: one guide per top-level folder (UserGuide/, ReleaseNotes/,
 * …), since a guide per topic would mean thousands of guides and a useless
 * `guide` filter; files at the root are guides of their own, except the
 * export's navigation maps (index.md, index-*.md), which hold only links.
 *
 * Returns [{ slug, title, file, files }] in input order; `files` are the
 * relative paths that make up the guide.
 */
export function groupGuides(relFiles, layout) {
  const guides = [];
  const byFolder = new Map();
  for (const rel of relFiles) {
    const segs = rel.split(/[\\/]/);
    if (layout === "topic" && segs.length > 1) {
      let g = byFolder.get(segs[0]);
      if (!g) {
        g = { slug: guideSlug(segs[0]), title: guideTitle(segs[0]), file: `${segs[0]}/`, files: [] };
        byFolder.set(segs[0], g);
        guides.push(g);
      }
      g.files.push(rel);
      continue;
    }
    if (layout === "topic" && /^index(-.*)?\.md$/i.test(segs[0])) continue;
    guides.push({ slug: guideSlug(rel), title: guideTitle(rel), file: rel, files: [rel] });
  }
  // Slugs key chunk IDs and part blobs, so they must be unique.
  const seen = new Map();
  for (const g of guides) {
    const n = seen.get(g.slug) ?? 0;
    seen.set(g.slug, n + 1);
    if (n > 0) g.slug = `${g.slug}-${n + 1}`;
  }
  return guides;
}

/** Split argv into positionals and `--name value` / `--name=value` options. */
function parseArgs(argv) {
  const positional = [];
  const options = {};
  for (let i = 0; i < argv.length; i++) {
    const m = /^--([a-z-]+)(?:=(.*))?$/.exec(argv[i]);
    if (!m) positional.push(argv[i]);
    else options[m[1]] = m[2] ?? argv[++i];
  }
  return { positional, options };
}

function main() {
  const { positional, options } = parseArgs(process.argv.slice(2));
  const inputDir = resolve(positional[0] || "./.docs-source");
  const release = positional[1] || basename(inputDir);
  const outDir = options.out || "./.index";
  const chunkDir = `${outDir}/docs-chunks`;
  const files = walkMarkdownFiles(inputDir);
  if (files.length === 0) {
    console.error(`No .md files found under ${inputDir}.`);
    console.error(
      "Get the Markdown documentation set for your release either from github.com/Acumatica/Acumatica-AI-Resources (Documentation/, branch per release) or from Acumatica's Beacon Portal (https://beacon.acumatica.com/, customer portal login required), then point this script at it."
    );
    process.exit(1);
  }
  const layout = options.layout || detectLayout(files.map((f) => statSync(f).size));
  if (layout !== "topic" && layout !== "guide") {
    console.error(`--layout must be "topic" or "guide", not "${layout}".`);
    process.exit(1);
  }
  console.log(`Layout: ${layout}${options.layout ? "" : " (detected)"}`);

  // Start from an empty chunk folder: parts left over from an earlier build
  // (a different layout means different slugs) would otherwise be uploaded too.
  rmSync(chunkDir, { recursive: true, force: true });
  mkdirSync(chunkDir, { recursive: true });
  const guides = [];
  let totalChunks = 0;

  for (const unit of groupGuides(files.map((f) => relative(inputDir, f)), layout)) {
    const { slug, title, file } = unit;
    const sections = unit.files.flatMap((rel) =>
      chunkGuide(cleanMarkdown(readFileSync(join(inputDir, rel), "utf8")))
    );
    if (sections.length === 0) continue;

    // Write chunk-text parts of bounded size; catalog records part boundaries.
    const parts = [];
    let texts = [];
    let budget = 0;
    let first = 0;
    const flushPart = () => {
      if (texts.length === 0) return;
      const key = `docs-chunks/${slug}-${parts.length}.json`;
      writeFileSync(`${outDir}/${key}`, JSON.stringify({ slug, first, texts }));
      parts.push({ key, first, count: texts.length });
      first += texts.length;
      texts = [];
      budget = 0;
    };
    const chunks = [];
    for (const s of sections) {
      if (budget > 0 && budget + s.body.length > PART_BUDGET_CHARS) flushPart();
      texts.push(s.body);
      budget += s.body.length;
      const entry = { p: s.path };
      if (s.formId) entry.f = s.formId;
      chunks.push(entry);
    }
    flushPart();

    guides.push({ slug, title, file, parts, chunks });
    totalChunks += chunks.length;
    console.log(`  ${slug}: ${chunks.length} chunks, ${parts.length} part(s)`);
  }

  const catalog = {
    version: 1,
    generatedAt: new Date().toISOString(),
    generatedFrom: basename(inputDir),
    release,
    guideCount: guides.length,
    chunkCount: totalChunks,
    guides,
  };
  writeFileSync(`${outDir}/docs-index.json`, JSON.stringify(catalog));
  const kb = (s) => `${Math.round(s / 1024)} KB`;
  console.log(
    `\nWrote ${outDir}/docs-index.json (${kb(statSync(`${outDir}/docs-index.json`).size)}), ` +
      `${guides.reduce((n, g) => n + g.parts.length, 0)} chunk part file(s) in ${chunkDir}/ — ` +
      `${guides.length} guides, ${totalChunks} chunks, release ${release}.`
  );
  console.log(
    outDir === "./.index"
      ? "Upload with `npm run upload-index`."
      : `Upload with \`node scripts/upload-indexes.mjs --dir ${outDir} --bucket <bucket>\`.`
  );
}

// Run only when executed directly (the exports above are unit-tested).
if (process.argv[1] && import.meta.url === new URL(`file://${resolve(process.argv[1])}`).href) {
  main();
}
