#!/usr/bin/env node
// Map GI design rows to their real OData property names.
//
// You cannot predict property names from the design. A caption is only an
// override; where it is absent (usually the majority of columns) the property
// name comes from the field's display name, which no design table exposes.
// So the join has to be positional, against $metadata.
//
// The order is not LineNbr. The rule this implements:
//
//   properties = [key columns, hoisted to the front in key order]
//             ++ [remaining ACTIVE rows in SortOrder order]
//             ++ [keys that are not result columns, appended, no design row]
//
// The count of active design rows must equal the count of result properties.
// That equality is the primary check; the secondary check is that every row
// carrying a caption lands on the property matching it. If one captioned row
// misaligns, the whole GI's mapping is rejected rather than half-trusted.
//
// Usage:
//   node align_columns.mjs --cols <f> --metadata <f.xml> [--only <f>] [--out <f>]
//                          [--report <f>] [--strict]
//
//   --cols      JSON array of design rows: GIName, LineNbr, SortOrder, IsActive,
//               Caption, ObjectName, Field
//   --metadata  the EDMX served at /t/{tenant}/api/odata/gi/$metadata
//   --only      JSON array of GI names (or objects with .name/.gi) to restrict to
//   --out       write the mapping here (default stdout)
//   --report    write a per-GI diagnostic here
//   --strict    exit non-zero if any GI fails to align
//
// Output rows: {gi, lineNbr, sortOrder, prop, type, caption, objectName, field,
//               hoisted}. GIs that fail to align emit no rows and are listed in
// the report — an unaligned GI must not be described from guesswork.

import fs from "node:fs";

const args = process.argv.slice(2);
if (args.includes("--help") || !args.length) {
  console.log(fs.readFileSync(new URL(import.meta.url), "utf8").split("\n")
    .filter((l) => l.startsWith("//")).map((l) => l.slice(3)).join("\n"));
  process.exit(args.length ? 0 : 1);
}
const opt = (f) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : null; };

const loadJson = (f) => {
  const raw = fs.readFileSync(f, "utf8");
  const s = raw.indexOf("["), e = raw.lastIndexOf("]");
  return s < 0 ? [] : JSON.parse(raw.slice(s, e + 1));
};

const norm = (s) => String(s ?? "").replace(/[^A-Za-z0-9]/g, "").toLowerCase();
const stripSuffix = (p) => String(p).replace(/_\d+$/, "");

// ---------------------------------------------------------------- $metadata
function parseEdmx(xml) {
  const types = {};
  for (const m of xml.matchAll(/<EntityType Name="([^"]+)">([\s\S]*?)<\/EntityType>/g)) {
    types[m[1]] = {
      keys: [...m[2].matchAll(/<PropertyRef Name="([^"]+)"/g)].map((k) => k[1]),
      props: [...m[2].matchAll(/<Property Name="([^"]+)" Type="([^"]+)"/g)]
        .map((p) => ({ name: p[1], type: p[2].replace(/^Edm\./, "") })),
    };
  }
  const sets = {};
  for (const s of xml.matchAll(/<EntitySet Name="([^"]+)" EntityType="([^"]+)"/g)) {
    sets[s[1]] = s[2].split(".").pop();
  }
  return { types, sets };
}

// ------------------------------------------------------------------ scoring
// A captioned row is a hard constraint: it must land on its caption's property.
const VIOLATION = -1e6;
function score(row, prop) {
  const cap = String(row.Caption ?? "").trim();
  const base = norm(stripSuffix(prop));
  // Compare against both the stripped and the full property name: a `_2` may be
  // a collision suffix the platform added OR part of a caption someone typed
  // literally (seen in the wild as `ItemStatus_2`).
  if (cap) return norm(cap) === base || norm(cap) === norm(prop) ? 100 : VIOLATION;
  // Uncaptioned: fall back to weak field-name similarity purely as a tiebreak.
  const f = norm(String(row.Field ?? "")
    .replace(/_description$/i, "").replace(/_Attributes$/i, "").replace(/^Attribute/i, ""));
  if (!f) return 0;
  if (f === base) return 10;
  if (f.length > 3 && (base.includes(f) || f.includes(base))) return 3;
  return 0;
}

// --------------------------------------------------------------- alignment
// dp[i][h][d] = best score aligning A[i..] given h rows hoisted and d dropped.
// Each row is hoisted, dropped (produces no property at all), or aligned to
// rest[i-h-d]. Dropping is real: a result column duplicating another whose
// caption collides is silently discarded by the platform and never appears in
// $metadata, so active-row count does NOT always equal property count.
function align(A, rest, hoistedProps, D, allPropNames) {
  // A row may only be treated as dropped if its caption matches NO property in
  // the entity. Without this the drop move becomes an escape hatch that lets the
  // search discard an inconvenient row and rationalise a wrong alignment around
  // it — observed dropping "Lead Status" while the property LeadStatus existed.
  const droppable = (row) => {
    const cap = String(row.Caption ?? "").trim();
    return !cap || !allPropNames.has(norm(cap));
  };
  const n = A.length, H = hoistedProps.length;
  const NEG = -Infinity;
  const mk = () => Array.from({ length: H + 1 }, () => new Array(D + 1).fill(NEG));
  const dp = Array.from({ length: n + 1 }, mk);
  const back = Array.from({ length: n + 1 }, () =>
    Array.from({ length: H + 1 }, () => new Array(D + 1).fill(null)));
  dp[n][H][D] = 0;
  for (let i = n - 1; i >= 0; i--) {
    for (let h = 0; h <= Math.min(H, i); h++) {
      for (let d = 0; d <= Math.min(D, i - h); d++) {
        const j = i - h - d;                 // index into rest
        if (j < rest.length && dp[i + 1][h][d] > NEG) {
          const v = score(A[i], rest[j].name) + dp[i + 1][h][d];
          if (v > dp[i][h][d]) { dp[i][h][d] = v; back[i][h][d] = "align"; }
        }
        if (h < H && dp[i + 1][h + 1][d] > NEG) {
          // Best any hoisted prop could do for this row; exact assignment later.
          const best = Math.max(...hoistedProps.map((p) => score(A[i], p.name)));
          const v = best + dp[i + 1][h + 1][d];
          if (v > dp[i][h][d]) { dp[i][h][d] = v; back[i][h][d] = "hoist"; }
        }
        if (d < D && droppable(A[i]) && dp[i + 1][h][d + 1] > NEG) {
          // Prefer any real placement over dropping; -1 breaks ties only.
          const v = -1 + dp[i + 1][h][d + 1];
          if (v > dp[i][h][d]) { dp[i][h][d] = v; back[i][h][d] = "drop"; }
        }
      }
    }
  }
  if (dp[0][0][0] <= VIOLATION / 2) return null;  // a captioned row could not be satisfied
  const alignedRows = [], hoistedRows = [], droppedRows = [];
  for (let i = 0, h = 0, d = 0; i < n; i++) {
    const mv = back[i][h][d];
    if (mv === "hoist") { hoistedRows.push(A[i]); h++; }
    else if (mv === "drop") { droppedRows.push(A[i]); d++; }
    else alignedRows.push([A[i], rest[i - h - d]]);
  }
  // Assign hoisted rows to hoisted props (H is small; greedy on best score).
  const pairs = [];
  const propsLeft = [...hoistedProps], rowsLeft = [...hoistedRows];
  while (propsLeft.length && rowsLeft.length) {
    let bi = 0, bj = 0, bs = -Infinity;
    for (let i = 0; i < rowsLeft.length; i++)
      for (let j = 0; j < propsLeft.length; j++) {
        const s = score(rowsLeft[i], propsLeft[j].name);
        if (s > bs) { bs = s; bi = i; bj = j; }
      }
    if (bs <= VIOLATION / 2) return null;
    pairs.push([rowsLeft[bi], propsLeft[bj]]);
    rowsLeft.splice(bi, 1); propsLeft.splice(bj, 1);
  }
  return { aligned: alignedRows, hoisted: pairs, dropped: droppedRows };
}

// -------------------------------------------------------------------- main
const { types, sets } = parseEdmx(fs.readFileSync(opt("--metadata"), "utf8"));
const rows = loadJson(opt("--cols"));
let only = null;
if (opt("--only")) only = new Set(loadJson(opt("--only")).map((x) => (typeof x === "string" ? x : x.name || x.gi)));

// Dedupe by (GI, LineNbr) — overlapping bulk pulls repeat rows.
const byGi = new Map();
for (const r of rows) {
  const gi = String(r.GIName ?? r.Name ?? "").trim();
  if (!gi || (only && !only.has(gi))) continue;
  if (!byGi.has(gi)) byGi.set(gi, new Map());
  byGi.get(gi).set(r.LineNbr, r);
}

const out = [], report = [];
for (const [gi, m] of [...byGi].sort()) {
  const all = [...m.values()];
  // Without the active flag, an inactive row is indistinguishable from one the
  // platform dropped — and the drop search will happily absorb it at the WRONG
  // position, silently shifting a description onto a neighbouring column.
  // Observed: EndDate attributed to line 45 instead of 47. Refuse instead.
  if (!all.some((r) => r.IsActive === true || r.IsActive === false ||
                       r.ColumnIsActive === true || r.ColumnIsActive === false)) {
    report.push({ gi, status: "no_active_flag", design: all.length,
      note: "pull IsActive/ColumnIsActive — without it columns cannot be safely mapped" });
    continue;
  }
  const A = all.filter((r) => r.IsActive !== false && r.ColumnIsActive !== false)
    .sort((a, b) => (a.SortOrder ?? a.LineNbr) - (b.SortOrder ?? b.LineNbr) || a.LineNbr - b.LineNbr);
  const ent = types[sets[gi]];
  if (!ent) { report.push({ gi, status: "not_in_metadata", design: all.length, note: gi.includes("/") ? "name contains '/' — unreachable over OData" : "not exposed via OData" }); continue; }
  const P = ent.props, K = new Set(ent.keys);
  const allPropNames = new Set(P.flatMap((p) => [norm(p.name), norm(stripSuffix(p.name))]));

  // How many active rows produced no property? Unknown up front, so search
  // upward from zero and take the first count that aligns. Everything past the
  // result columns must be an entity key — that is what makes the search safe
  // rather than a free parameter that can rationalise any misalignment.
  const MAX_DROPPED = 6;
  let res = null, appended = null, H = 0, D = 0;
  for (D = 0; D <= MAX_DROPPED; D++) {
    const cut = A.length - D;
    if (cut < 0 || cut > P.length) continue;
    const cand = P.slice(0, cut), app = P.slice(cut);
    if (!app.every((p) => K.has(p.name))) continue;
    let h = 0; while (h < cand.length && K.has(cand[h].name)) h++;
    const r = align(A, cand.slice(h), cand.slice(0, h), D, allPropNames);
    if (r) { res = r; appended = app; H = h; break; }
  }
  if (!res) { report.push({ gi, status: "alignment_rejected", active: A.length, props: P.length }); continue; }

  const emit = (row, prop, hoisted) => out.push({
    gi, lineNbr: row.LineNbr, sortOrder: row.SortOrder ?? null,
    prop: prop.name, type: prop.type,
    caption: (row.Caption ?? "").trim() || null,
    objectName: row.ObjectName ?? null, field: row.Field ?? null, hoisted,
  });
  for (const [row, prop] of res.hoisted) emit(row, prop, true);
  for (const [row, prop] of res.aligned) emit(row, prop, false);

  const captioned = A.filter((r) => String(r.Caption ?? "").trim()).length;
  report.push({
    gi, status: "ok", design: all.length, inactive: all.length - A.length,
    active: A.length, props: P.length, hoisted: H,
    droppedColumns: res.dropped.map((r) => ({ lineNbr: r.LineNbr, caption: (r.Caption ?? "").trim() || null, field: `${r.ObjectName}.${r.Field}` })),
    appendedKeys: appended.map((p) => p.name), captioned,
    uncaptioned: A.length - captioned,
  });
}

out.sort((a, b) => a.gi.localeCompare(b.gi) || a.lineNbr - b.lineNbr);
const ok = report.filter((r) => r.status === "ok");
const bad = report.filter((r) => r.status !== "ok");
console.error(`aligned ${ok.length} GI(s), ${out.length} column(s); ${bad.length} failed`);
for (const b of bad) console.error(`  FAIL  ${b.gi} — ${b.status}${b.note ? " (" + b.note + ")" : ""}`);
const totalAppended = ok.reduce((a, r) => a + r.appendedKeys.length, 0);
const totalInactive = ok.reduce((a, r) => a + r.inactive, 0);
console.error(`  ${totalInactive} inactive design row(s) excluded; ${totalAppended} appended key propert(ies) have no design row`);

if (opt("--report")) fs.writeFileSync(opt("--report"), JSON.stringify(report, null, 1));
if (opt("--out")) fs.writeFileSync(opt("--out"), JSON.stringify(out, null, 1));
else process.stdout.write(JSON.stringify(out, null, 1) + "\n");
if (args.includes("--strict") && bad.length) process.exit(1);
