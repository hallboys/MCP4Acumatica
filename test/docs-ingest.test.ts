// Copyright 2026 Hall Boys, Inc.
// SPDX-License-Identifier: Apache-2.0

// Guards the docs ingestion (scripts/build-docs-index.mjs): PDF-artifact
// cleanup, heading-scoped chunking with breadcrumbs, Form ID propagation
// within a form's scope (an H2 in a monolithic guide, the H1 of a per-topic
// file), oversized-section splitting, and guide grouping for both input
// layouts. Uses synthetic mini-guides — no licensed documentation text
// appears in this repo.
//
// Run with:  node --test --experimental-strip-types test/docs-ingest.test.ts

import { test } from "node:test";
import assert from "node:assert";
// Plain-ESM import of the ingestion script's exported pure functions; its
// main() only runs when the script is executed directly.
// @ts-ignore -- .mjs module, not covered by tsc (tsconfig includes src/ only)
import {
  cleanMarkdown,
  chunkGuide,
  guideSlug,
  guideTitle,
  detectLayout,
  groupGuides,
} from "../scripts/build-docs-index.mjs";

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

// ── Per-topic layout (2026R2 Beacon export, Acumatica's GitHub set) ──

test("a Form ID under a topic's H1 tags the H2 toolbar/tab sections beneath it", () => {
  // One screen per file: the form is the H1, its toolbar and tabs are H2s.
  const doc = [
    "# Bills and Adjustments",
    "",
    "Form ID: \\(AP301000\\)",
    "",
    pad("You use this form to enter vendor documents."),
    "## Form Toolbar",
    pad("Commands live here."),
    "## Summary Area",
    pad("Header fields."),
  ].join("\n");
  const sections = chunkGuide(cleanMarkdown(doc));
  assert.deepEqual(
    sections.map((s: { path: string; formId?: string }) => [s.path, s.formId]),
    [
      ["Bills and Adjustments", "AP301000"],
      ["Bills and Adjustments > Form Toolbar", "AP301000"],
      ["Bills and Adjustments > Summary Area", "AP301000"],
    ]
  );
});

test("a definition in a body too short to be a chunk still tags the sections beneath it", () => {
  const doc = ["# Shipping Zones", "Form ID: (CS207510)", "## Form Toolbar", pad("Commands.")].join("\n");
  const sections = chunkGuide(cleanMarkdown(doc));
  assert.equal(sections.length, 1, "the H1 body is a stub and is not a chunk");
  assert.equal(sections[0].formId, "CS207510");
});

test("two forms sharing a title in one guide keep their own Form IDs", () => {
  // 2025R2's Form Reference has two "Employee Time Cards" screens (EP305000
  // and EP406000). Scopes keyed by breadcrumb text collided and the second
  // definition relabelled the first screen's sections.
  const doc = [
    "# Time and Expenses Forms",
    "## Employee Time Cards",
    pad(" Form ID: (EP305000) Entry form."),
    "### Details Tab",
    pad("Entry form details."),
    "## Employee Time Cards",
    pad(" Form ID: (EP406000) List of time cards."),
    "### Table",
    pad("List columns."),
  ].join("\n");
  const sections = chunkGuide(cleanMarkdown(doc));
  assert.deepEqual(
    sections.map((s: { formId?: string }) => s.formId),
    ["EP305000", "EP305000", "EP406000", "EP406000"]
  );
});

test("Report ID definitions and alphanumeric IDs are recognized", () => {
  const doc = [
    "## AP Aging by Project",
    pad(" Report ID: (AP631200) Aging by project."),
    "## Cost Projections by Date",
    pad(" Form ID: \\(PMGI3055\\) Inquiry."),
  ].join("\n");
  const sections = chunkGuide(cleanMarkdown(doc));
  assert.deepEqual(
    sections.map((s: { formId?: string }) => s.formId),
    ["AP631200", "PMGI3055"]
  );
});

test("Pandoc heading attributes are stripped from paths, so boilerplate headings are still skipped", () => {
  const doc = [
    "# Copyright {#_c92aa4bb-857d .concept}",
    pad("All rights reserved."),
    "# Workflow API {#concept_vdx_fdb_mhb .concept}",
    pad("Workflow changes."),
  ].join("\n");
  const sections = chunkGuide(cleanMarkdown(doc));
  assert.deepEqual(
    sections.map((s: { path: string }) => s.path),
    ["Workflow API"]
  );
});

test("detectLayout tells per-topic exports from monolithic guides by median file size", () => {
  assert.equal(detectLayout([4_000, 9_000, 12_000, 2_000_000]), "topic");
  assert.equal(detectLayout([900_000, 2_500_000, 5_000_000, 3_000]), "guide");
  assert.equal(detectLayout([]), "guide");
});

test("groupGuides: topic layout groups by top-level folder and skips root navigation maps", () => {
  const guides = groupGuides(
    [
      "AcumaticaERP_2026R2_ReleaseNotes_for_Developers.md",
      "ReleaseNotes/RN_2026_R2_A.md",
      "UserGuide/AP_30_10_00.md",
      "UserGuide/PM_30_10_00.md",
      "index-form-report-reference.md",
      "index.md",
    ],
    "topic"
  );
  assert.deepEqual(
    guides.map((g: { slug: string; files: string[] }) => [g.slug, g.files.length]),
    [
      ["2026-r2-release-notes-for-developers", 1],
      ["release-notes", 1],
      ["user-guide", 2],
    ]
  );
  assert.equal(guides[2].title, "User Guide");
});

test("groupGuides: guide layout keeps one guide per file and de-duplicates slugs", () => {
  const guides = groupGuides(
    ["documentation/AcumaticaERP_Projects.md", "release-notes/AcumaticaERP_Projects.md", "index.md"],
    "guide"
  );
  assert.deepEqual(
    guides.map((g: { slug: string }) => g.slug),
    ["projects", "projects-2", "index"]
  );
});
