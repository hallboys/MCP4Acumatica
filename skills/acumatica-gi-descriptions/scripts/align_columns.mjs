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
// Two more rejection rules (in sync with the server's resolveFields, 0.48.2 —
// keep them matched or this script will bless alignments the server rejects):
//   - a pairing whose DECLARED $metadata type contradicts the type family the
//     design row's field NAME implies is impossible (a string `invoiceNbr` can
//     never be the decimal `Amount`);
//   - a TIED optimum is refused, not guessed. Ambiguity means the chosen row
//     scores equally on another property (or the chosen property equally with
//     another row) — nothing in the data picks, and committing silently
//     mis-shifts every column after the disagreement.
// A refusing GI is made determinate with no code change by captioning its
// hoisted key columns with exactly the property names OData already reports.
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

// Coarse type family implied by a design row's source field NAME (server:
// expectedTypeFamily). Deliberately conservative — a false positive rejects a
// CORRECT alignment — so only patterns unambiguous in Acumatica's naming
// conventions classify. Calculated columns (`=…`) are always null.
function expectedTypeFamily(field) {
  const raw = String(field ?? "").trim();
  if (!raw || raw.startsWith("=")) return null;
  if (/_description$/i.test(raw)) return "text";
  const n = raw.toLowerCase();
  if (/^(is|has)[a-z]/.test(n) || /^(released|voided|prebooked|opendoc|depreciable|active|approved|printed|emailed)$/.test(n)) {
    return "boolean";
  }
  if (/(datetime|date)$/.test(n) && !/(update|dateid)$/.test(n)) return "datetime";
  if (/(amt|amount|balance|bal|cost|price|qty|quantity|total|discount|profit|percent|rate)$/.test(n)) {
    return "numeric";
  }
  if (/(descr|description|name|cd|code|status)$/.test(n)) return "text";
  return null;
}

// Simplified declared type of a property (server: edmTypeToSimple; the parse
// above strips the `Edm.` prefix already).
function simpleType(t) {
  if (!t) return undefined;
  const x = String(t).replace(/^Edm\./, "");
  if (x === "Decimal" || x === "Double" || x === "Single") return "decimal";
  if (x === "Byte" || x === "SByte" || x === "Int16" || x === "Int32" || x === "Int64") return "integer";
  if (x === "Boolean") return "boolean";
  if (x === "DateTime" || x === "DateTimeOffset" || x === "Date" || x === "Time") return "datetime";
  return x.toLowerCase();
}

// Whether the implied family is impossible for the declared type (server:
// typeConflicts). `integer` is compatible with everything — Acumatica surfaces
// identifiers and line numbers as int or string depending on the DAC.
function typeConflicts(family, simple) {
  if (!family || !simple || simple === "integer") return false;
  switch (family) {
    case "datetime": return simple !== "datetime";
    case "boolean": return simple !== "boolean";
    case "numeric": return simple !== "decimal";
    case "text": return simple === "decimal" || simple === "boolean" || simple === "datetime";
  }
}

// camelCase/underscore tokens of length >= 4, lower-cased (server: tokens).
function tokens(s) {
  return new Set(String(s)
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[^A-Za-z0-9]+/)
    .map((t) => t.toLowerCase())
    .filter((t) => t.length >= 4));
}

function score(row, prop, propType) {
  const cap = String(row.Caption ?? "").trim();
  const base = norm(stripSuffix(prop));
  // Compare against both the stripped and the full property name: a `_2` may be
  // a collision suffix the platform added OR part of a caption someone typed
  // literally (seen in the wild as `ItemStatus_2`).
  if (cap) return norm(cap) === base || norm(cap) === norm(prop) ? 100 : VIOLATION;
  // Uncaptioned: a declared-type contradiction is a hard reject; otherwise fall
  // back to weak field-name similarity purely as a tiebreak.
  const rawField = String(row.Field ?? "").trim();
  if (typeConflicts(expectedTypeFamily(rawField), simpleType(propType))) return VIOLATION;
  const f = norm(rawField
    .replace(/_description$/i, "").replace(/_Attributes$/i, "").replace(/^Attribute/i, ""));
  if (!f) return 0;
  if (f === base) return 10;
  if (f.length > 3 && (base.includes(f) || f.includes(base))) return 3;
  // Weak shared-token signal, below the substring tiers so it never outranks
  // them (`finPeriodID`→`PostPeriod` shares "period").
  const shared = [...tokens(rawField)].filter((t) => tokens(prop).has(t)).length;
  return shared > 0 ? 1 : 0;
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
  const sc = (row, prop) => score(row, prop.name, prop.type);
  const n = A.length, H = hoistedProps.length;
  const NEG = -Infinity;
  const mk = (fill) => Array.from({ length: H + 1 }, () => new Array(D + 1).fill(fill));
  const dp = Array.from({ length: n + 1 }, () => mk(NEG));
  // cnt[i][h][d] = distinct optimal move sequences (saturating at 2). A tied
  // optimum means the data does not determine the alignment — refuse it.
  const cnt = Array.from({ length: n + 1 }, () => mk(0));
  const back = Array.from({ length: n + 1 }, () => mk(null));
  dp[n][H][D] = 0;
  cnt[n][H][D] = 1;
  for (let i = n - 1; i >= 0; i--) {
    for (let h = 0; h <= Math.min(H, i); h++) {
      for (let d = 0; d <= Math.min(D, i - h); d++) {
        const relax = (v, ways, how) => {
          if (v > dp[i][h][d]) { dp[i][h][d] = v; cnt[i][h][d] = ways; back[i][h][d] = how; }
          else if (v === dp[i][h][d] && v > NEG) cnt[i][h][d] = Math.min(2, cnt[i][h][d] + ways);
        };
        const j = i - h - d;                 // index into rest
        if (j < rest.length && dp[i + 1][h][d] > NEG) {
          relax(sc(A[i], rest[j]) + dp[i + 1][h][d], cnt[i + 1][h][d], "align");
        }
        if (h < H && dp[i + 1][h + 1][d] > NEG) {
          // Best any hoisted prop could do for this row; exact assignment later.
          const best = Math.max(...hoistedProps.map((p) => sc(A[i], p)));
          relax(best + dp[i + 1][h + 1][d], cnt[i + 1][h + 1][d], "hoist");
        }
        if (d < D && droppable(A[i]) && dp[i + 1][h][d + 1] > NEG) {
          // Prefer any real placement over dropping; -1 breaks ties only.
          relax(-1 + dp[i + 1][h][d + 1], cnt[i + 1][h][d + 1], "drop");
        }
      }
    }
  }
  if (dp[0][0][0] <= VIOLATION / 2) return null;  // a captioned row could not be satisfied
  if (cnt[0][0][0] > 1) return { status: "tie" }; // under-determined: refuse, don't guess
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
        const s = sc(rowsLeft[i], propsLeft[j]);
        if (s > bs) { bs = s; bi = i; bj = j; }
      }
    if (bs <= VIOLATION / 2) return null;
    // Ambiguity is NOT "several pairs share the best score" — four captioned
    // rows each scoring 100 on their own property tie at 100 and resolve
    // perfectly. It is the chosen row being equally happy on another property,
    // or the chosen property equally happy with another row: nothing in the
    // data picks, so refuse rather than swap two key columns' descriptions.
    const rowAmbiguous = propsLeft.some((p, j) => j !== bj && sc(rowsLeft[bi], p) === bs);
    const propAmbiguous = rowsLeft.some((r, i) => i !== bi && sc(r, propsLeft[bj]) === bs);
    if (rowAmbiguous || propAmbiguous) return { status: "tie" };
    pairs.push([rowsLeft[bi], propsLeft[bj]]);
    rowsLeft.splice(bi, 1); propsLeft.splice(bj, 1);
  }
  // Final sweep: no captioned row on a property it doesn't name, and no row on
  // a property whose declared type its source field contradicts.
  for (const [row, prop] of [...pairs, ...alignedRows]) {
    if (sc(row, prop) <= VIOLATION / 2) return null;
  }
  return { status: "ok", aligned: alignedRows, hoisted: pairs, dropped: droppedRows };
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
  let res = null, appended = null, H = 0, D = 0, tied = false;
  for (D = 0; D <= MAX_DROPPED; D++) {
    const cut = A.length - D;
    if (cut < 0 || cut > P.length) continue;
    const cand = P.slice(0, cut), app = P.slice(cut);
    if (!app.every((p) => K.has(p.name))) continue;
    let h = 0; while (h < cand.length && K.has(cand[h].name)) h++;
    const r = align(A, cand.slice(h), cand.slice(0, h), D, allPropNames);
    // A tie is an ambiguity at this structural hypothesis — STOP rather than
    // escalate D past it: a higher drop count that happens to align is exactly
    // the free parameter rationalising a wrong mapping.
    if (r && r.status === "tie") { tied = true; break; }
    if (r) { res = r; appended = app; H = h; break; }
  }
  if (tied) {
    report.push({ gi, status: "alignment_ambiguous", active: A.length, props: P.length,
      note: "tied optimum — caption the hoisted key columns with the property names OData already reports to pin it" });
    continue;
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

// Which hoists did the search actually have evidence for? A hoisted row with no
// caption and no name resemblance was chosen arbitrarily — the alignment is
// under-determined there and may be shifted, silently. This is the one failure
// mode a clean run still hides, so say so loudly rather than implying success.
for (const r of report) {
  if (r.status !== "ok") continue;
  r.unjustifiedHoists = out
    .filter((c) => c.gi === r.gi && c.hoisted)
    .filter((c) => {
      const p = norm(stripSuffix(c.prop));
      if (c.caption && norm(c.caption) === p) return false;
      const f = norm(String(c.field).replace(/_description$/i, "").replace(/^cury/i, ""));
      return !(f && (f === p || (f.length > 3 && p.length > 3 && (f.includes(p) || p.includes(f)))));
    })
    .map((c) => `${c.lineNbr}:${c.prop}<-${c.field}`);
}

out.sort((a, b) => a.gi.localeCompare(b.gi) || a.lineNbr - b.lineNbr);
const ok = report.filter((r) => r.status === "ok");
const bad = report.filter((r) => r.status !== "ok");
console.error(`aligned ${ok.length} GI(s), ${out.length} column(s); ${bad.length} failed`);
for (const b of bad) console.error(`  FAIL  ${b.gi} — ${b.status}${b.note ? " (" + b.note + ")" : ""}`);
const totalAppended = ok.reduce((a, r) => a + r.appendedKeys.length, 0);
const totalInactive = ok.reduce((a, r) => a + r.inactive, 0);
console.error(`  ${totalInactive} inactive design row(s) excluded; ${totalAppended} appended key propert(ies) have no design row`);

const shaky = ok.filter((r) => r.unjustifiedHoists.length);
if (shaky.length) {
  console.error(`\n  ${shaky.length} GI(s) have a hoisted column chosen with NO evidence — these alignments`);
  console.error(`  are UNDER-DETERMINED and may be shifted. An aligned result is not a verified one:`);
  console.error(`  query a few rows of each and confirm every property returns the kind of value its`);
  console.error(`  design row implies BEFORE writing any description.`);
  for (const r of shaky.slice(0, 12)) console.error(`     ${r.gi}  (${r.unjustifiedHoists.join(", ")})`);
  if (shaky.length > 12) console.error(`     … and ${shaky.length - 12} more (see --report)`);
  console.error(`  Note both directions of false positive: EmployeeId<-acctCD is fine, and`);
  console.error(`  refNbr->ReferenceNbr is fine — this flags what to CHECK, not what is wrong.`);
}

if (opt("--report")) fs.writeFileSync(opt("--report"), JSON.stringify(report, null, 1));
if (opt("--out")) fs.writeFileSync(opt("--out"), JSON.stringify(out, null, 1));
else process.stdout.write(JSON.stringify(out, null, 1) + "\n");
if (args.includes("--strict") && bad.length) process.exit(1);
