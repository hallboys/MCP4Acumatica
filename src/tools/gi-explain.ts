// Copyright 2026 Hall Boys, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * acumatica_explain_gi_xml — stateless structural summary of a Generic Inquiry
 * definition XML (as exported from SM208000). No index, no tenant call, no
 * third-party data: it parses the XML the caller pastes and reports the tables,
 * joins, parameters, filters, and output columns so the model can reason about
 * an existing GI's shape.
 *
 * This is a knowledge aid, not a validator. The Acumatica GI export schema
 * varies across releases, so parsing is tolerant: we group start tags by name
 * and pull the recognizable attributes, surfacing the GI-design vocabulary
 * (tables / relations / parameters / sorting / grouping / results) when present.
 * Reuses the regex-on-XML approach already used in generic-inquiry-discovery.ts.
 */

const MAX_XML_LENGTH = 500_000;

interface TagInfo {
  count: number;
  samples: Record<string, string>[];
}

// Element vocabulary we surface explicitly (matched case-insensitively as a
// substring of the tag's local name). Maps to a friendly section label.
const SECTIONS: Array<{ label: string; match: RegExp }> = [
  { label: "tables", match: /table/i },
  { label: "relations", match: /relation|join/i },
  { label: "parameters", match: /parameter/i },
  { label: "filters", match: /filter|where/i },
  { label: "groupBy", match: /group/i },
  { label: "sortBy", match: /sort|order/i },
  { label: "results", match: /result|outputfield|^field$|column/i },
];

const ATTR_RE = /([\w:.-]+)\s*=\s*"([^"]*)"/g;
const TAG_RE = /<([A-Za-z_][\w:.-]*)((?:\s+[\w:.-]+\s*=\s*"[^"]*")*)\s*\/?>/g;

function localName(tag: string): string {
  const i = tag.indexOf(":");
  return i >= 0 ? tag.slice(i + 1) : tag;
}

function parseAttrs(attrStr: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  let m: RegExpExecArray | null;
  ATTR_RE.lastIndex = 0;
  while ((m = ATTR_RE.exec(attrStr)) !== null) attrs[m[1]] = m[2];
  return attrs;
}

export async function handleExplainGiXml(args: { xml: string }): Promise<unknown> {
  const xml = (args.xml ?? "").trim();
  if (!xml) return { error: "xml is required — paste the Generic Inquiry definition XML." };
  if (xml.length > MAX_XML_LENGTH) {
    return { error: `xml is too large (${xml.length} chars, max ${MAX_XML_LENGTH}).` };
  }
  if (!xml.includes("<")) return { error: "Input does not look like XML." };

  const byTag = new Map<string, TagInfo>();
  let m: RegExpExecArray | null;
  TAG_RE.lastIndex = 0;
  while ((m = TAG_RE.exec(xml)) !== null) {
    const name = localName(m[1]);
    const attrs = parseAttrs(m[2] || "");
    const info = byTag.get(name) ?? { count: 0, samples: [] };
    info.count++;
    if (info.samples.length < 8 && Object.keys(attrs).length > 0) info.samples.push(attrs);
    byTag.set(name, info);
  }

  if (byTag.size === 0) return { error: "No XML elements found to summarize." };

  // Root / title best-effort.
  const rootMatch = /<([A-Za-z_][\w:.-]*)/.exec(xml);
  const root = rootMatch ? localName(rootMatch[1]) : undefined;
  const titleAttr =
    parseAttrs(/<[A-Za-z_][\w:.-]*([^>]*)>/.exec(xml)?.[1] ?? "");
  const title = titleAttr.Title || titleAttr.Name || titleAttr.InquiryTitle;

  // Bucket tags into the GI-design sections.
  const sections: Record<string, { element: string; count: number; samples: Record<string, string>[] }[]> = {};
  const accountedFor = new Set<string>();
  for (const { label, match } of SECTIONS) {
    for (const [tag, info] of byTag) {
      if (match.test(tag)) {
        (sections[label] ??= []).push({ element: tag, count: info.count, samples: info.samples });
        accountedFor.add(tag);
      }
    }
  }

  const otherElements = [...byTag.entries()]
    .filter(([tag]) => !accountedFor.has(tag))
    .map(([tag, info]) => ({ element: tag, count: info.count }))
    .sort((a, b) => b.count - a.count);

  return {
    root,
    ...(title ? { title } : {}),
    sections,
    otherElements,
    note:
      "Best-effort structural summary of the GI definition. Element names depend on the Acumatica export schema; treat this as a reading aid, not a validated parse.",
  };
}
