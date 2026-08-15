#!/usr/bin/env node
// Validate drafted descriptions against the real column list before anyone reads them.
//
// Catches the mistakes that are invisible on inspection: a description keyed to
// a line number that does not exist (result grids skip numbers freely), a GI
// silently missed, text that will not fit the field, and descriptions that just
// restate the name.
//
// Usage:
//   node validate_descriptions.mjs --drafts <f> --cols <f> [--max 1000] [--csv <f>]
//   node validate_descriptions.mjs --drafts <f> --gi-level [--max 2000] [--csv <f>]
//
//   --drafts    JSON array. Column level: {gi, line, desc}. GI level: {gi, desc}.
//   --cols      JSON array of real column rows (GIName, LineNbr, ...). Column level only.
//   --gi-level  validate GI-level drafts (no line numbers, no column cross-check)
//   --max       field character limit (default 1000 column / 2000 GI level)
//   --csv       also emit a load-ready CSV here
//
// Exits non-zero if anything fails, so it can gate a load.

import fs from "node:fs";

const args = process.argv.slice(2);
if (args.includes("--help") || !args.length) {
  console.log(fs.readFileSync(new URL(import.meta.url), "utf8").split("\n")
    .filter((l) => l.startsWith("//")).map((l) => l.slice(3)).join("\n"));
  process.exit(args.length ? 0 : 1);
}
const opt = (f) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : null; };
const has = (f) => args.includes(f);

const load = (f) => {
  const raw = fs.readFileSync(f, "utf8");
  const s = raw.indexOf("["), e = raw.lastIndexOf("]");
  return JSON.parse(raw.slice(s, e + 1));
};

const giLevel = has("--gi-level");
const MAX = Number(opt("--max") || (giLevel ? 2000 : 1000));
const drafts = load(opt("--drafts"));
let problems = 0;
const fail = (label, items) => {
  if (!items.length) { console.log(`  ok    ${label}`); return; }
  problems += items.length;
  console.log(`  FAIL  ${label}: ${items.length}`);
  for (const i of items.slice(0, 25)) console.log(`          ${i}`);
  if (items.length > 25) console.log(`          … and ${items.length - 25} more`);
};

const key = (d) => (giLevel ? d.gi : `${d.gi}|${d.line}`);
console.log(`Validating ${drafts.length} ${giLevel ? "GI-level" : "column"} description(s), limit ${MAX} chars\n`);

// Duplicates
const seen = new Set(), dupes = [];
for (const d of drafts) { const k = key(d); if (seen.has(k)) dupes.push(k); seen.add(k); }
fail("duplicate targets", dupes);

// Length
fail(`over ${MAX} characters`,
  drafts.filter((d) => (d.desc || "").length > MAX).map((d) => `${key(d)} (${d.desc.length})`));

// Empty
fail("empty descriptions", drafts.filter((d) => !String(d.desc || "").trim()).map(key));

// Name echo — a description that just restates the caption adds nothing
const norm = (s) => String(s).toLowerCase().replace(/[^a-z0-9]/g, "");
fail("description merely echoes the name",
  drafts.filter((d) => d.desc && norm(d.desc) === norm(d.gi)).map(key));

// Suspiciously terse — not a failure, but worth eyeballing
const terse = drafts.filter((d) => (d.desc || "").length < 30).map((d) => `${key(d)} (${d.desc.length})`);
if (terse.length) {
  console.log(`  note  under 30 characters: ${terse.length} — fine for simple lookups, check they carry a fact`);
  for (const t of terse.slice(0, 10)) console.log(`          ${t}`);
}

// Cross-check against the real column list
if (!giLevel) {
  if (!opt("--cols")) { console.log("\n  FAIL  --cols is required unless --gi-level"); process.exit(1); }
  const real = new Set(), byGi = new Map();
  for (const r of load(opt("--cols"))) {
    real.add(`${r.GIName}|${r.LineNbr}`);
    (byGi.get(r.GIName) ?? byGi.set(r.GIName, new Set()).get(r.GIName)).add(r.LineNbr);
  }
  fail("target does not exist in the column list", drafts.filter((d) => !real.has(key(d))).map(key));

  const covered = new Set(drafts.map(key));
  const missing = [];
  for (const [gi, lines] of byGi) {
    if (!drafts.some((d) => d.gi === gi)) continue;   // GI not in scope yet
    for (const ln of lines) if (!covered.has(`${gi}|${ln}`)) missing.push(`${gi}|${ln}`);
  }
  fail("columns in a described GI with no description", missing);
}

// Optional CSV
if (opt("--csv")) {
  const q = (s) => '"' + String(s ?? "").replace(/"/g, '""') + '"';
  const rows = drafts.slice().sort((a, b) =>
    a.gi.localeCompare(b.gi) || (giLevel ? 0 : a.line - b.line));
  const csv = giLevel
    ? ["GIName,AIDescription", ...rows.map((d) => `${q(d.gi)},${q(d.desc)}`)]
    : ["GIName,LineNbr,AIDescription", ...rows.map((d) => `${q(d.gi)},${d.line},${q(d.desc)}`)];
  fs.writeFileSync(opt("--csv"), csv.join("\n") + "\n");
  console.log(`\nwrote ${opt("--csv")} (${rows.length} rows)`);
}

console.log(problems ? `\n${problems} problem(s) — fix before loading.` : "\nAll checks passed.");
process.exit(problems ? 1 : 0);
