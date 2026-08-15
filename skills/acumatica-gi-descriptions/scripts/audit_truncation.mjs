#!/usr/bin/env node
// Flag bulk query results that were silently truncated at a row cap.
//
// Row caps truncate without an error and without a flag, so a slice returning
// exactly the cap is truncated until proven otherwise. Drafting from a
// truncated conditions or columns file produces descriptions that omit real
// filters — which is the failure this whole workflow exists to prevent.
//
// Usage:
//   node audit_truncation.mjs <dir> [--cap 1000] [--key GIName]
//
// Scans every file in <dir>, extracts the first JSON array it can find (tool
// output is often wrapped in prose), and reports row counts. Exits non-zero if
// anything looks truncated, so it can gate a pipeline.

import fs from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
if (!args.length || args.includes("--help")) {
  console.log("usage: node audit_truncation.mjs <dir> [--cap 1000] [--key GIName]");
  process.exit(args.length ? 0 : 1);
}
const dir = args[0];
const num = (flag, dflt) => {
  const i = args.indexOf(flag);
  return i >= 0 ? Number(args[i + 1]) : dflt;
};
const str = (flag, dflt) => {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : dflt;
};
const CAP = num("--cap", 1000);
const KEY = str("--key", "GIName");

let truncated = 0, scanned = 0;
const rows = [];

for (const name of fs.readdirSync(dir).sort()) {
  const full = path.join(dir, name);
  if (!fs.statSync(full).isFile()) continue;
  const raw = fs.readFileSync(full, "utf8");
  const s = raw.indexOf("["), e = raw.lastIndexOf("]");
  if (s < 0 || e < s) continue;
  let data;
  try { data = JSON.parse(raw.slice(s, e + 1)); } catch { continue; }
  if (!Array.isArray(data)) continue;
  scanned++;

  const keys = data.length ? Object.keys(data[0]) : [];
  const distinct = new Set(data.map((r) => r?.[KEY]).filter(Boolean)).size;
  const isTrunc = data.length === CAP;
  if (isTrunc) truncated++;
  rows.push({ name, count: data.length, distinct, isTrunc, shape: keys.slice(0, 4).join(",") });
}

const w = Math.max(12, ...rows.map((r) => r.name.length));
for (const r of rows) {
  console.log(
    r.name.padEnd(w) +
    "  rows=" + String(r.count).padStart(6) +
    (r.isTrunc ? "  *** AT CAP — ASSUME TRUNCATED ***" : "") +
    "  distinct" + KEY + "=" + String(r.distinct).padStart(5) +
    "  [" + r.shape + "]"
  );
}
console.log(`\nscanned ${scanned} result file(s); ${truncated} at the ${CAP}-row cap.`);
if (truncated) {
  console.log("Re-slice those ranges into smaller partitions and re-run before drafting.");
  process.exit(1);
}
