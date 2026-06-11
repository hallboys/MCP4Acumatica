# Schema Knowledge Tools

These tools help **power users build against Acumatica** — discovering entities,
fields, relationships, and Generic Inquiry structure — without sampling live records to
guess at shape. They're separate from the data-query tools: they answer from an offline
**schema index** built from your instance's own API description, or (for the GI explainer)
from XML you paste.

> These tools derive schema knowledge from **your own instance** (its `swagger.json` and live
> `$adHocSchema`), so results are always current and include your customizations — no static
> snapshots, no third-party data. Acumatica **documentation** questions are deliberately
> *not* a tool here — your AI client's web search already reaches the public Help Wiki at
> <https://help.acumatica.com/>.

## Tools

| Tool | What it does |
|------|--------------|
| `acumatica_search_schema` | Find entities by name/keyword and/or "which entities contain field X". |
| `acumatica_get_schema_entity` | Full offline schema for one entity: fields + types, actions, and `$expand` sub-entities. |
| `acumatica_list_schema_entities` | Browse/filter the entity catalog by name or module prefix. |
| `acumatica_explain_gi_xml` | Summarize a pasted Generic Inquiry definition XML (tables, joins, parameters, filters, results). No index needed. |

### Offline catalog vs. live detail

- Use **`acumatica_search_schema` / `_list_schema_entities` / `_get_schema_entity`** for
  fast, cross-entity discovery and shape — no tenant round-trip, no record sampling.
- Use **`acumatica_describe_entity`** (live `$adHocSchema`) when you need the authoritative
  current schema for one entity, e.g. to confirm a just-added custom field.

### DAC-layer questions (building customizations)

If you're working at the **DAC** (C# data-access-class) layer — e.g. writing a graph
extension and needing the field names/types/relationships *beneath* the API — there's no
MCP tool for that, by design:

- **Stock DACs** → Acumatica's public **DAC Schema Browser**, <https://help.acumatica.com/dacBrowser>
  (your AI client's web access reads it) — authoritative and zero-maintenance.
- **Your custom DACs / extensions** → read the **source code** directly (it's in your
  customization repo) — richer than any reflected index.
- **Custom fields exposed via the API** → already covered by `acumatica_search_schema` /
  `acumatica_describe_entity` above.

Same reasoning as the Help Wiki: the DAC reference is public, web-accessible, and
authoritative, and the one gap (custom DACs) is best answered from the source you already
have — so we don't reproduce it as a tool.

## Building the schema index

The schema-knowledge tools (except the GI explainer, which is stateless) read a
`schema-index.json` blob from the `INDEX_STORE` R2 bucket. It's built from your instance's
`swagger.json` — your own contract-API description, including your customizations.

```bash
# 1. Export your instance's OpenAPI spec to the repo root as swagger.json
#    (from /entity/Default/<version>/swagger.json on your Acumatica instance).
# 2. Build the index and upload it to R2:
npm run build-index          # = build-schema-index + upload-index
```

`setup.sh` runs this automatically after deploy when `swagger.json` is present. If the
index is absent, the three schema tools don't register (so they never error), and
`acumatica_explain_gi_xml` still works on its own.

Rebuild and re-upload whenever your endpoint version or customizations change, then
reconnect the MCP client so the tool list refreshes.

## Privacy / licensing posture

- The ingestion **scripts** (`scripts/build-*.mjs`) are part of the open-source repo
  (Apache-2.0) — they're our original code.
- The **generated indexes** are gitignored (`.index/`) and live only in your private R2
  bucket. `swagger.json` is your instance's API description; future DAC/GI indexes are
  built from sources you're licensed to access. Nothing third-party is redistributed.
