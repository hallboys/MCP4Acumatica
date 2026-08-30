// Copyright 2026 Hall Boys, Inc.
// SPDX-License-Identifier: Apache-2.0

// Guards the docs-catalog search + chunk resolution behind the
// acumatica_search_docs / acumatica_get_doc_section tools: Form ID
// normalization, heading scoring, guide filtering, and part-boundary
// resolution for multi-part guides.
//
// Run with:  node --test --experimental-strip-types test/docs-search.test.ts

import { test } from "node:test";
import assert from "node:assert";
import {
  normalizeFormId,
  formIdInText,
  searchDocs,
  resolveChunk,
  chunksForFormId,
  matchGuides,
  type DocsCatalog,
} from "../src/lib/docs-search.ts";

const catalog: DocsCatalog = {
  version: 1,
  generatedAt: "2026-08-30T00:00:00Z",
  release: "2025R2",
  guideCount: 2,
  chunkCount: 7,
  guides: [
    {
      slug: "form-reference",
      title: "Form Reference",
      file: "form-report-reference/HelpRoot_FormReference.md",
      // Two parts with a boundary at ordinal 2.
      parts: [
        { key: "docs-chunks/form-reference-0.json", first: 0, count: 2 },
        { key: "docs-chunks/form-reference-1.json", first: 2, count: 2 },
      ],
      chunks: [
        { p: "Accounts Payable Forms > Bills and Adjustments", f: "AP301000" },
        { p: "Accounts Payable Forms > Bills and Adjustments > Form Toolbar", f: "AP301000" },
        { p: "Accounts Payable Forms > Bills and Adjustments > Taxes Tab", f: "AP301000" },
        { p: "Sales Orders Forms > Sales Orders", f: "SO301000" },
      ],
    },
    {
      slug: "accounts-payable",
      title: "Accounts Payable",
      file: "documentation/AcumaticaERP_AccountsPayable.md",
      parts: [{ key: "docs-chunks/accounts-payable-0.json", first: 0, count: 3 }],
      chunks: [
        { p: "Reclassification of Expenses: General Information" },
        { p: "Reclassification of Expenses: Process Activity" },
        { p: "Managing Vendor Relations" },
      ],
    },
  ],
};

test("normalizeFormId accepts plain and dotted forms, rejects non-IDs", () => {
  assert.equal(normalizeFormId("AP301000"), "AP301000");
  assert.equal(normalizeFormId("ap.30.10.00"), "AP301000");
  assert.equal(normalizeFormId(" SO301000 "), "SO301000");
  assert.equal(normalizeFormId("AP3010"), null);
  assert.equal(normalizeFormId("release retainage"), null);
  assert.equal(normalizeFormId(undefined), null);
  assert.equal(normalizeFormId(""), null);
});

test("formIdInText finds an embedded Form ID, dotted or not", () => {
  assert.equal(formIdInText("what does AP301000 do"), "AP301000");
  assert.equal(formIdInText("the AP.30.10.00 screen"), "AP301000");
  assert.equal(formIdInText("release AP retainage"), null);
});

test("formId param returns exactly that form's chunks, ranked first", () => {
  const hits = searchDocs(catalog, { formId: "AP301000" });
  assert.equal(hits.length, 3);
  for (const h of hits) assert.equal(h.formId, "AP301000");
  assert.equal(hits[0].chunkId, "form-reference:0");
});

test("a Form ID inside the query text works like the formId param", () => {
  const hits = searchDocs(catalog, { query: "SO301000 fields" });
  assert.ok(hits.some((h) => h.formId === "SO301000"));
});

test("multi-token query ranks the full-phrase heading above partial matches", () => {
  const hits = searchDocs(catalog, { query: "reclassification of expenses" });
  assert.ok(hits.length >= 2);
  assert.ok(hits[0].path.startsWith("Reclassification of Expenses"));
});

test("guide filter narrows results; unknown guide matches nothing", () => {
  const hits = searchDocs(catalog, { query: "bills", guide: "form-reference" });
  assert.ok(hits.length > 0);
  for (const h of hits) assert.equal(h.guide, "form-reference");
  assert.equal(matchGuides(catalog, "nonexistent-guide").length, 0);
  assert.equal(matchGuides(catalog, "Accounts Payable").length, 1);
});

test("stopword-only or unmatched queries return no hits (never everything)", () => {
  assert.equal(searchDocs(catalog, { query: "how do i the" }).length, 0);
  assert.equal(searchDocs(catalog, { query: "zzzznotaword" }).length, 0);
});

test("limit caps results", () => {
  const hits = searchDocs(catalog, { query: "forms", limit: 1 });
  assert.equal(hits.length, 1);
});

test("resolveChunk finds the right part across the part boundary", () => {
  const inFirst = resolveChunk(catalog, "form-reference:1");
  assert.equal(inFirst?.part.key, "docs-chunks/form-reference-0.json");
  const inSecond = resolveChunk(catalog, "form-reference:2");
  assert.equal(inSecond?.part.key, "docs-chunks/form-reference-1.json");
  assert.equal(inSecond?.meta.p, "Accounts Payable Forms > Bills and Adjustments > Taxes Tab");
});

test("resolveChunk rejects malformed ids, unknown guides, out-of-range ordinals", () => {
  assert.equal(resolveChunk(catalog, "form-reference"), null);
  assert.equal(resolveChunk(catalog, "nope:0"), null);
  assert.equal(resolveChunk(catalog, "form-reference:99"), null);
  assert.equal(resolveChunk(catalog, "form-reference:-1"), null);
  assert.equal(resolveChunk(catalog, "form-reference:1.5"), null);
});

test("chunksForFormId returns the form's sections in document order", () => {
  const chunks = chunksForFormId(catalog, "AP301000");
  assert.deepEqual(
    chunks.map((c) => c.ordinal),
    [0, 1, 2]
  );
  assert.equal(chunksForFormId(catalog, "ZZ999999").length, 0);
});
