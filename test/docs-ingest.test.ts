// Copyright 2026 Hall Boys, Inc.
// SPDX-License-Identifier: Apache-2.0

// Guards the docs ingestion (scripts/build-docs-index.mjs): PDF-artifact
// cleanup, heading-scoped chunking with breadcrumbs, Form ID propagation
// within an H2 scope, and oversized-section splitting. Uses a synthetic
// mini-guide — no licensed documentation text appears in this repo.
//
// Run with:  node --test --experimental-strip-types test/docs-ingest.test.ts

import { test } from "node:test";
import assert from "node:assert";
// Plain-ESM import of the ingestion script's exported pure functions; its
// main() only runs when the script is executed directly.
// @ts-ignore -- .mjs module, not covered by tsc (tsconfig includes src/ only)
import { cleanMarkdown, chunkGuide, guideSlug, guideTitle } from "../scripts/build-docs-index.mjs";

test("guideSlug/guideTitle strip vendor prefixes and normalize", () => {
  assert.equal(guideSlug("AcumaticaERP_AccountsPayable.md"), "accounts-payable");
  assert.equal(guideSlug("HelpRoot_FormReference.md"), "form-reference");
  assert.equal(guideSlug("AcumaticaERP_Self-Service_Portal_Admin.md"), "self-service-portal-admin");
  assert.equal(guideTitle("AcumaticaERP_AccountsPayable.md"), "Accounts Payable");
});

test("cleanMarkdown strips page breaks, running headers, and TOC dot-leader lines", () => {
  const raw = [
    "## Real Heading ",
    " Real content stays.",
    "<!-- PAGE_BREAK -->",
    " Contents | 2 ",
    " Accounts Payable Forms | 53 ",
    " Vendors: General Information.........................................12 ",
    " Another real line | with a pipe but no page number",
    "",
    "",
    "",
    " Tail content.",
  ].join("\n");
  const cleaned = cleanMarkdown(raw);
  assert.ok(cleaned.includes("Real content stays."));
  assert.ok(cleaned.includes("Another real line | with a pipe but no page number"));
  assert.ok(cleaned.includes("Tail content."));
  assert.ok(!cleaned.includes("PAGE_BREAK"));
  assert.ok(!cleaned.includes("Contents | 2"));
  assert.ok(!cleaned.includes("| 53"));
  assert.ok(!cleaned.includes("General Information......"));
  assert.ok(!cleaned.includes("\n\n\n"), "blank runs collapse to one blank line");
});

const pad = (s: string, n = 120) => s + " filler-word".repeat(Math.ceil(n / 12));

test("chunkGuide produces breadcrumb paths and skips boilerplate/stub sections", () => {
  const doc = [
    "## Contents ",
    " TOC would be here.",
    "## Copyright ",
    pad(" All rights reserved."),
    "# Module Guide",
    "## Creating a Vendor",
    pad("How you create a vendor."),
    "### Vendor Locations",
    pad("About locations."),
    "### Stub",
    " tiny", // < MIN_BODY_CHARS → dropped
    "## Another Topic",
    pad("Different topic body."),
  ].join("\n");
  const sections = chunkGuide(cleanMarkdown(doc));
  const paths = sections.map((s: { path: string }) => s.path);
  assert.deepEqual(paths, [
    "Module Guide > Creating a Vendor",
    "Module Guide > Creating a Vendor > Vendor Locations",
    "Module Guide > Another Topic",
  ]);
});

test("a Form ID definition tags every section in its H2 scope, and resets at the next H2", () => {
  const doc = [
    "# Accounts Payable Forms",
    "## Bills and Adjustments ",
    pad(" Form ID: (AP301000) You use this form to enter vendor documents."),
    "### Form Toolbar",
    pad("Commands live here."),
    "### Taxes Tab",
    pad("Tax detail fields."),
    "## Vendors",
    pad(" Form ID: (AP.30.30.00) Vendor master screen."), // dotted variant normalizes
    "### Form Toolbar",
    pad("Vendor commands."),
  ].join("\n");
  const sections = chunkGuide(cleanMarkdown(doc));
  const byPath = new Map(sections.map((s: { path: string; formId?: string }) => [s.path, s.formId]));
  assert.equal(byPath.get("Accounts Payable Forms > Bills and Adjustments"), "AP301000");
  assert.equal(byPath.get("Accounts Payable Forms > Bills and Adjustments > Form Toolbar"), "AP301000");
  assert.equal(byPath.get("Accounts Payable Forms > Bills and Adjustments > Taxes Tab"), "AP301000");
  assert.equal(byPath.get("Accounts Payable Forms > Vendors"), "AP303000");
  assert.equal(byPath.get("Accounts Payable Forms > Vendors > Form Toolbar"), "AP303000");
});

test("escaped-paren Form IDs are recognized (DITA-converted corpus)", () => {
  // Acumatica's publicly published Markdown set (Acumatica-AI-Resources, branch
  // 2026R1) is DITA-converted and escapes the parens. A regex that only accepts
  // the bare form yields ZERO Form IDs on that corpus without erroring.
  const doc = [
    "## Action Executions",
    pad(" Form ID: \\(SM204007\\) You use this form to configure an action execution."),
    "### Summary Area",
    pad("Subscriber ID and Event Screen ID live here."),
  ].join("\n");
  const sections = chunkGuide(cleanMarkdown(doc));
  const byPath = new Map(sections.map((s: { path: string; formId?: string }) => [s.path, s.formId]));
  assert.equal(byPath.get("Action Executions"), "SM204007");
  assert.equal(byPath.get("Action Executions > Summary Area"), "SM204007");
});

test("body mentions of other forms do NOT tag a chunk", () => {
  const doc = [
    "## Some Topic",
    pad("Clicking Pay opens the Checks and Payments (AP302000) form for the document."),
  ].join("\n");
  const sections = chunkGuide(cleanMarkdown(doc));
  assert.equal(sections.length, 1);
  assert.equal(sections[0].formId, undefined);
});

test("oversized sections split at paragraph boundaries with (cont. N) paths", () => {
  const para = "word ".repeat(1000).trim(); // ~5000 chars
  const doc = ["## Big Section", para, "", para, "", para].join("\n");
  const sections = chunkGuide(cleanMarkdown(doc));
  assert.ok(sections.length >= 2, `expected a split, got ${sections.length} section(s)`);
  assert.equal(sections[0].path, "Big Section");
  assert.equal(sections[1].path, "Big Section (cont. 2)");
  for (const s of sections) assert.ok(s.body.length <= 7000);
});

test("heading markup (bold markers, trailing spaces) is cleaned from paths", () => {
  const doc = ["## **Approval Tab**  ", pad("Approval settings.")].join("\n");
  const sections = chunkGuide(cleanMarkdown(doc));
  assert.equal(sections[0].path, "Approval Tab");
});
