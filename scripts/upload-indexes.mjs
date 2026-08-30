// Copyright 2026 Hall Boys, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * upload-indexes.mjs — push whichever schema-knowledge indexes exist in
 * ./.index/ to the `mcp4acumatica-index` R2 bucket (binding INDEX_STORE),
 * where the worker reads them at runtime.
 *
 * Only files that exist locally are uploaded, so this is safe to run after
 * building just the schema index (the DAC / GI indexes are optional/private).
 *
 * Requires `wrangler` (a devDependency) and Cloudflare auth (`wrangler login`).
 *
 * Usage: node scripts/upload-indexes.mjs
 */

import { existsSync, readdirSync } from "node:fs";
import { execFileSync } from "node:child_process";

const BUCKET = "mcp4acumatica-index";
const INDEXES = ["schema-index.json", "dac-index.json", "gi-examples-index.json"];

function putObject(key, file) {
  console.log(`Uploading ${file} → ${BUCKET}/${key} ...`);
  execFileSync(
    "npx",
    ["wrangler", "r2", "object", "put", `${BUCKET}/${key}`, "--file", file, "--remote"],
    { stdio: "inherit" }
  );
}

let uploaded = 0;
for (const name of INDEXES) {
  const file = `./.index/${name}`;
  if (!existsSync(file)) continue;
  putObject(name, file);
  uploaded++;
}

// Docs index: the chunk-text parts go up FIRST, the catalog LAST. The catalog
// records each part's key + chunk-ordinal boundaries, so a worker that reads
// a new catalog against old parts would misalign section text; a worker
// reading an old catalog against new parts is only wrong for guides whose
// chunking changed, and the window closes when the catalog lands.
const chunkDir = "./.index/docs-chunks";
if (existsSync(chunkDir)) {
  for (const name of readdirSync(chunkDir).filter((n) => n.endsWith(".json")).sort()) {
    putObject(`docs-chunks/${name}`, `${chunkDir}/${name}`);
    uploaded++;
  }
}
if (existsSync("./.index/docs-index.json")) {
  putObject("docs-index.json", "./.index/docs-index.json");
  uploaded++;
}

if (uploaded === 0) {
  console.error("No indexes found in ./.index/. Run `npm run build-schema-index` first.");
  process.exit(1);
}
console.log(`Done — uploaded ${uploaded} index file(s).`);
