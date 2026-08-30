# Documentation Knowledge Tools

Two optional tools let the AI assistant answer "how do I…", "what does this
screen/field do", and "what changed in this release" questions from the
**official Acumatica documentation** — with no tenant data access and no
round-trip to Acumatica:

| Tool | Purpose |
|---|---|
| `acumatica_search_docs` | Search the documentation by section heading and Form ID |
| `acumatica_get_doc_section` | Read a section's text — by search result, or directly by Form ID (e.g. `AP301000`) |

They register only when the documentation index is present in the
`INDEX_STORE` R2 bucket (same conditional-registration model as the
[schema-knowledge tools](/docs/schema-discovery)). A deployment without the
index simply doesn't advertise them.

## Why these exist

Acumatica's Help Wiki (`help.acumatica.com`) intermittently refuses browser
and AI-client access with bot-detection ("refused for this browser"), so "the
model can just web-search the docs" is not dependable. These tools serve the
same official content from an index you build from your own licensed download
— always available, versioned to your instance's release, and usable in every
conversation alongside the data tools (e.g. look up what the *Pre-Release*
command on Bills and Adjustments does while reviewing an actual bill).

## What the model can do with them

- **Screen reference by Form ID.** `acumatica_get_doc_section` with
  `ref: "AP301000"` returns the Bills and Adjustments reference: purpose,
  every toolbar command with its enabling conditions, then tab-by-tab field
  documentation. Large screens return the first sections plus a list of the
  remaining ones (each fetchable by `chunkId`).
- **Feature/process lookup.** `acumatica_search_docs` with
  `query: "expense reclassification"` finds the AP guide's configuration and
  process-activity sections; the model then reads them with
  `acumatica_get_doc_section` and can browse adjacent sections via the
  returned `prev`/`next` pointers.
- **Release notes.** `query: "GIQL"` lands in the developer release notes.

**Search semantics (important):** the search matches **section headings and
Form IDs, not body text**. Acumatica's headings are descriptive
("Reclassification of Expenses: Process Activity"), so feature terminology
works well; full-sentence questions don't. The tool descriptions steer the
model accordingly, and both tools state that the content is vendor
documentation for the instance's release.

Documentation output **bypasses the sensitive-field redaction** applied to
data tools: the payload is vendor documentation, not tenant records, and the
payroll/1099 guides legitimately discuss fields *named* SSN etc. — pattern
redaction would mangle the prose.

## Setup (operator)

The index is built from documentation **you** download with your own
Acumatica credentials. The content is licensed material: it never ships with
this repo, is never redistributed, and is served only to users who
authenticate against your licensed instance.

1. **Download the Markdown documentation set** for your Acumatica release
   from Acumatica's **Beacon Portal** at <https://beacon.acumatica.com/> —
   sign in with your Acumatica customer portal credentials (the downloads are
   only visible after login). You want the guide set (per-module + developer
   guides), the Form/Report Reference, and the release notes. Put the folders
   anywhere — `.docs-source/` in this repo is gitignored for the purpose.
2. **Build the index:**

   ```bash
   npm run build-docs-index -- path/to/your/docs-folder
   ```

   This cleans the PDF-conversion artifacts (page breaks, running headers,
   dot-leader TOCs), chunks every guide by heading, tags the Form Reference
   chunks with their Form IDs, and writes `.index/docs-index.json` (the
   search catalog, ~3–4 MB) plus `.index/docs-chunks/*.json` (the section
   text, ~40 MB in bounded parts). The release label is inferred from the
   folder name (e.g. `.../2025R2` → `2025R2`); pass a second argument to
   override.
3. **Upload to R2:**

   ```bash
   npm run upload-index
   ```

   Chunk parts upload before the catalog so a live worker never reads a
   catalog that references parts that haven't landed.
4. **Reconnect** the MCP server in your client (the tools register at
   session start when the index exists).

### Storage & memory design

The worker memoizes only the small catalog per isolate; section text is
fetched from R2 on demand with a small in-memory cache. This is deliberate —
the corpus is ~40 MB and must never be held in worker memory wholesale. See
`src/lib/docs-search.ts` and `src/tools/docs-tools.ts`.

### On upgrades

The index describes one release's documentation. When your instance moves to
a new Acumatica release, re-download that release's markdown set, rebuild,
and re-upload — see [Upgrading Acumatica](/docs/upgrading-acumatica). Known
quirk of the 2025 R2 download: the guide title pages read "2025 R1" (the
release notes are genuinely R2); the ingestion strips title-page headings, so
this only matters for provenance.
