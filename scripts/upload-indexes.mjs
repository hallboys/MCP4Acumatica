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

import { existsSync } from "node:fs";
import { execFileSync } from "node:child_process";

const BUCKET = "mcp4acumatica-index";
const INDEXES = ["schema-index.json", "dac-index.json", "gi-examples-index.json"];

let uploaded = 0;
for (const name of INDEXES) {
  const file = `./.index/${name}`;
  if (!existsSync(file)) continue;
  console.log(`Uploading ${file} → ${BUCKET}/${name} ...`);
  execFileSync(
    "npx",
    ["wrangler", "r2", "object", "put", `${BUCKET}/${name}`, "--file", file, "--remote"],
    { stdio: "inherit" }
  );
  uploaded++;
}

if (uploaded === 0) {
  console.error("No indexes found in ./.index/. Run `npm run build-schema-index` first.");
  process.exit(1);
}
console.log(`Done — uploaded ${uploaded} index file(s).`);
