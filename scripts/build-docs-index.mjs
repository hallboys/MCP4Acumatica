// Copyright 2026 Hall Boys, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * build-docs-index.mjs — produce the documentation-knowledge index consumed by
 * the acumatica_search_docs / acumatica_get_doc_section tools.
 *
 * Input:  a folder of official Acumatica documentation in Markdown, as
 *         downloaded from Acumatica's Beacon Portal
 *         (https://beacon.acumatica.com/ — sign in with your Acumatica
 *         customer portal credentials; the content is licensed to YOUR
 *         organization, is never committed to this repo, and is never
 *         redistributed). Any layout of .md files works; subfolders are
 *         walked recursively.
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
 * Usage: node scripts/build-docs-index.mjs [path/to/docs-folder] [release-label]
 *        default folder ./.docs-source, release label inferred from the
 *        folder's basename (e.g. ~/ClaudeCode/acumatica-docs/2025R2 → "2025R2").
 */

import { readFileSync, writeFileSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { join, basename, relative, resolve } from "node:path";

const OUT_DIR = "./.index";
const CHUNK_DIR = `${OUT_DIR}/docs-chunks`;
// Bounds are on cleaned text length (chars ≈ bytes for this ASCII-heavy corpus).
const MAX_CHUNK_CHARS = 7000; // split bigger sections at paragraph boundaries
const MIN_BODY_CHARS = 80; // heading-only / stub sections are not chunks
const PART_BUDGET_CHARS = 700_000; // ~700 KB of text per docs-chunks part file

const FORM_ID_DEF_RE = /^\s*Form ID:?\s*\(?([A-Z]{2}\.?\d{2}\.?\d{2}\.?\d{2})\)?/m;

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
  return text.replace(/\*+/g, "").replace(/\s+/g, " ").trim();
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
 * every section belonging to a form's H2 scope in the Form Reference (the
 * scope whose body carries a "Form ID: (XX000000)" definition line) — body
 * *mentions* of other forms deliberately don't count.
 */
export function chunkGuide(cleaned) {
  const lines = cleaned.split("\n");
  // heading stack: [{level, text}]
  const stack = [];
  const sections = [];
  let body = [];

  const flush = () => {
    const text = body.join("\n").trim();
    body = [];
    if (stack.length === 0) return;
    const leaf = stack[stack.length - 1].text;
    if (SKIP_HEADINGS.test(leaf)) return;
    if (text.length < MIN_BODY_CHARS) return;
    const path = stack.map((s) => s.text).join(" > ");
    // Split oversized bodies at paragraph boundaries.
    if (text.length <= MAX_CHUNK_CHARS) {
      sections.push({ path, body: text, h2: currentH2() });
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
        h2: currentH2(),
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

  const currentH2 = () => {
    for (let i = stack.length - 1; i >= 0; i--) {
      if (stack[i].level <= 2) return stack.map((s) => s.text).slice(0, i + 1).join(" > ");
    }
    return stack.length ? stack[0].text : "";
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
    stack.push({ level, text });
  }
  flush();

  // Form ID pass: a definition in any section of an H2 scope tags every
  // section of that scope (a form's toolbar/tab sections follow the
  // definition under the same H2 in the Form Reference).
  const formIdByH2 = new Map();
  for (const s of sections) {
    const def = FORM_ID_DEF_RE.exec(s.body);
    if (def) formIdByH2.set(s.h2, def[1].replace(/\./g, ""));
  }
  return sections.map(({ path, body: b, h2 }) => {
    const formId = formIdByH2.get(h2);
    return formId ? { path, body: b, formId } : { path, body: b };
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

function main() {
  const inputDir = resolve(process.argv[2] || "./.docs-source");
  const release = process.argv[3] || basename(inputDir);
  const files = walkMarkdownFiles(inputDir);
  if (files.length === 0) {
    console.error(`No .md files found under ${inputDir}.`);
    console.error(
      "Download the Markdown documentation set for your release from Acumatica's Beacon Portal (https://beacon.acumatica.com/, customer portal login required) and point this script at it."
    );
    process.exit(1);
  }

  mkdirSync(CHUNK_DIR, { recursive: true });
  const guides = [];
  let totalChunks = 0;

  for (const file of files) {
    const slug = guideSlug(file);
    const title = guideTitle(file);
    const sections = chunkGuide(cleanMarkdown(readFileSync(file, "utf8")));
    if (sections.length === 0) continue;

    // Write chunk-text parts of bounded size; catalog records part boundaries.
    const parts = [];
    let texts = [];
    let budget = 0;
    let first = 0;
    const flushPart = () => {
      if (texts.length === 0) return;
      const key = `docs-chunks/${slug}-${parts.length}.json`;
      writeFileSync(`${OUT_DIR}/${key}`, JSON.stringify({ slug, first, texts }));
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

    guides.push({ slug, title, file: relative(inputDir, file), parts, chunks });
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
  writeFileSync(`${OUT_DIR}/docs-index.json`, JSON.stringify(catalog));
  const kb = (s) => `${Math.round(s / 1024)} KB`;
  console.log(
    `\nWrote ${OUT_DIR}/docs-index.json (${kb(statSync(`${OUT_DIR}/docs-index.json`).size)}), ` +
      `${guides.reduce((n, g) => n + g.parts.length, 0)} chunk part file(s) in ${CHUNK_DIR}/ — ` +
      `${guides.length} guides, ${totalChunks} chunks, release ${release}.`
  );
  console.log("Upload with `npm run upload-index`.");
}

// Run only when executed directly (the exports above are unit-tested).
if (process.argv[1] && import.meta.url === new URL(`file://${resolve(process.argv[1])}`).href) {
  main();
}
