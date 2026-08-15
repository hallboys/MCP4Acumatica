#!/usr/bin/env node
// Condense GI design metadata into a per-GI brief you can actually write from.
//
// The single most important thing this does is render an [ON ]/[off] marker on
// every WHERE condition. A GI's design can carry conditions that are switched
// off; they are indistinguishable from live ones unless the IsActive flag is
// shown. Describing a disabled filter as enforced tells the reader the inquiry
// is narrower than it is.
//
// Usage:
//   node build_brief.mjs --cols <f> --joins <f> --where <f> [--only <f>] [--out <f>]
//
//   --cols   JSON array of result-column rows  (GIName, LineNbr, ObjectName, Field,
//                                               Caption, IsVisible, [description])
//   --joins  JSON array of join rows           (GIName, TableAlias, TableDAC,
//                                               ChildTable, JoinType, ParentField, ChildField)
//   --where  JSON array of condition rows      (GIName, LineNbr, IsActive, OpenBrackets,
//                                               DataFieldName, Condition, Value1,
//                                               Value2, CloseBrackets, Operation)
//   --only   JSON array of GI names (or objects with .name/.gi) to restrict to
//   --out    write markdown here instead of stdout
//
// All inputs are tolerant: files may be raw JSON or JSON embedded in other text,
// and any of the three may be omitted.

import fs from "node:fs";

const args = process.argv.slice(2);
if (args.includes("--help") || !args.length) {
  console.log(fs.readFileSync(new URL(import.meta.url), "utf8").split("\n")
    .filter((l) => l.startsWith("//")).map((l) => l.slice(3)).join("\n"));
  process.exit(args.length ? 0 : 1);
}
const opt = (f) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : null; };

const load = (f) => {
  if (!f) return [];
  const raw = fs.readFileSync(f, "utf8");
  const s = raw.indexOf("["), e = raw.lastIndexOf("]");
  if (s < 0) return [];
  try { return JSON.parse(raw.slice(s, e + 1)); } catch { return []; }
};
const dedupe = (rows, keyFn) => {
  const seen = new Set(), out = [];
  for (const r of rows) { const k = keyFn(r); if (seen.has(k)) continue; seen.add(k); out.push(r); }
  return out;
};

const cols  = dedupe(load(opt("--cols")),  (r) => r.GIName + "|" + r.LineNbr);
const joins = load(opt("--joins"));
const wheres = dedupe(load(opt("--where")), (r) => r.GIName + "|" + r.LineNbr);

let only = null;
if (opt("--only")) {
  only = new Set(load(opt("--only")).map((x) => (typeof x === "string" ? x : x.name || x.gi)));
}

const names = [...new Set([...cols, ...joins, ...wheres].map((r) => r.GIName))]
  .filter((n) => n && (!only || only.has(n))).sort();

const out = [];
for (const n of names) {
  // SortOrder is the result-grid order; LineNbr is not. Fall back only if absent.
  const c = cols.filter((r) => r.GIName === n)
    .sort((a, b) => (a.SortOrder ?? a.LineNbr) - (b.SortOrder ?? b.LineNbr) || a.LineNbr - b.LineNbr);
  const j = joins.filter((r) => r.GIName === n);
  const w = wheres.filter((r) => r.GIName === n).sort((a, b) => a.LineNbr - b.LineNbr);

  const dacs = [...new Set(j.map((r) => String(r.TableDAC || "").split(".").pop()).filter(Boolean))];
  const rels = [...new Set(j.filter((r) => r.ChildTable).map((r) =>
    `${r.TableAlias} ${String(r.JoinType || "?").toUpperCase()[0]}> ${r.ChildTable}` +
    (r.ParentField ? ` on ${r.ParentField}=${r.ChildField}` : "")))];

  // An inactive column does not reach OData at all; hidden ones do. Never let
  // the two look alike, and never silently drop an inactive row — seeing it is
  // what stops you inventing a duplicate that does not exist.
  const dead = (r) => r.IsActive === false || r.ColumnIsActive === false;
  const label = (r) => {
    const base = String(r.Caption || r.Field || "?");
    return (base.startsWith("=") ? "(formula)" : base) +
      (r.IsVisible === false ? " [hidden]" : "") + (dead(r) ? " [INACTIVE - not in OData]" : "");
  };

  // IsActive is the point of this script — never collapse it away.
  const conds = w.map((r) =>
    (r.IsActive === true ? "  [ON ] " : "  [off] ") +
    (r.OpenBrackets || "") + (r.DataFieldName || "") + " " + (r.Condition || "") + " " +
    (r.Value1 ?? "") + (r.Value2 != null && r.Value2 !== "" ? ` .. ${r.Value2}` : "") +
    (r.CloseBrackets || "") + "  |" + (r.Operation || ""));

  const activeCount = w.filter((r) => r.IsActive === true).length;

  out.push([
    `### ${n}`,
    `DACs: ${dacs.join(", ") || "(none)"}`,
    `joins: ${rels.slice(0, 14).join("; ") || "(none)"}`,
    `columns (${c.filter((r) => !dead(r)).length} active / ${c.length} total; ` +
      `${c.filter((r) => !dead(r) && r.IsVisible === false).length} of the active ones hidden on screen but still in OData):`,
    c.map((r) => `  ${String(r.LineNbr).padStart(3)}  ${label(r)}  <- ${r.ObjectName}.${r.Field}`).join("\n") || "  (none)",
    `conditions (${activeCount} active / ${w.length} total):`,
    conds.join("\n") || "  (none)",
  ].join("\n"));
}

const md = out.join("\n\n") + "\n";
if (opt("--out")) { fs.writeFileSync(opt("--out"), md); console.log(`briefed ${out.length} GI(s) -> ${opt("--out")}`); }
else process.stdout.write(md);
