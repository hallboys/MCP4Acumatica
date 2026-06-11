# Upgrading / Changing the Acumatica Version

When the connected Acumatica instance moves to a new release (e.g. **2025 R2 → 2026 R1**),
or when you repoint the MCP server at a different instance/tenant, work through this
checklist. Items are ordered so you can do them top-to-bottom.

> Keep this page current: whenever a feature is added that depends on the Acumatica
> version (a new index built from instance data, a hardcoded entity/endpoint, a new cached
> artifact), add its upgrade step here. See the maintenance note at the bottom.

## 1. Find the new contract endpoint version

The contract REST base URL is `/entity/Default/{ACUMATICA_ENDPOINT_VERSION}` — e.g.
`/entity/Default/25.200.001`. A release upgrade usually introduces a new **Default**
endpoint version (Acumatica keeps older versions available for backward compatibility, so
nothing breaks immediately, but you want the new one to see new entities/fields).

- In Acumatica: **Integration → Web Service Endpoints (SM207060)** → the `Default` endpoint
  → note the highest version (e.g. `26.200.001`).
- Or read it from the OpenAPI doc title at
  `{ACUMATICA_URL}/entity/Default/{version}/swagger.json` (the `info.title` is
  `Default/{version}`).

## 2. Update `ACUMATICA_ENDPOINT_VERSION`

- **Production (hallboys):** edit `wrangler.jsonc` `vars.ACUMATICA_ENDPOINT_VERSION`
  (the local copy is `skip-worktree`d) and `npx wrangler deploy`. Or change it in the
  Cloudflare dashboard (**Workers & Pages → mcp4acumatica → Settings → Variables and
  Secrets**) — Cloudflare redeploys on save.
- **Adopters:** same var, via dashboard or `setup.sh` (which substitutes it).

## 3. Rebuild the schema-knowledge index

The `acumatica_search_schema` / `acumatica_get_schema_entity` /
`acumatica_list_schema_entities` tools answer from `schema-index.json`, built **offline**
from the instance's `swagger.json`. After an upgrade it is stale until rebuilt.

```bash
# Export the new spec to the repo root as swagger.json:
#   {ACUMATICA_URL}/entity/Default/{NEW_VERSION}/swagger.json
npm run build-index      # rebuilds .index/schema-index.json and uploads it to R2
```

`setup.sh` does this automatically after deploy when `swagger.json` is present. The tools
keep working through the rebuild (they just describe the old shape until the new index
lands). No redeploy is needed for an index refresh — the next Durable Object instance picks
up the new R2 object (the parsed index is memoized per isolate, so reconnect/allow idle
recycle to force a fresh read).

## 4. Clear the runtime metadata cache

Live schema (`$adHocSchema`), the GI list, and inferred GI field schemas are cached in KV
(24 h / 1 h). After an upgrade these can be stale (renamed fields, new GIs).

- Run the `acumatica_clear_cache` tool with no argument (clears everything), **or**
- Admin console → clear cache, **or**
- Targeted: `target=schema:<Entity>` / `target=gi`.

## 5. Re-run preflight

Visit `/docs/admin/preflight` and run the diagnostic (or `setup.sh` runs it automatically).
It confirms, against the new version:

- `ACUMATICA_URL` reachable + OIDC discovery,
- Connected App `client_credentials` grant,
- tenant OData path (`/t/{tenant}/...`),
- the **contract API endpoint version** resolves — this catches a wrong
  `ACUMATICA_ENDPOINT_VERSION` from step 2.

## 6. Verify access control still holds

A version upgrade does not normally touch these, but confirm:

- The **`MCP Access` role** and the **`MCPAccess` canary GI** still exist and the GI is still
  **Exposed via OData** (the role gate calls it). A 403 on the canary = users locked out;
  a 404/5xx = "Configuration Error" page.
- The **Connected Application** (SM303010) redirect URIs and scopes
  (`api openid profile email offline_access`) are intact. `offline_access` is required for
  refresh tokens — without it sessions die after ~1 h.

## 7. Spot-check entities and tools

The 38 `acumatica_get_*` tools use hardcoded entity names (`GETTER_TOOLS` in
`src/tools/getter-registry.ts`). These are stable across releases, but a new version can
add/rename/deprecate entities or change field shapes:

- `acumatica_describe_entity` on a couple of key entities (e.g. `Customer`, `SalesOrder`)
  → confirm fields resolve.
- `acumatica_search_schema` for any new entities you expect from the release.
- `acumatica_list_entities` + `acumatica_run_inquiry` smoke test (one filtered call each).
- If an entity was removed/renamed upstream, update its `GETTER_TOOLS` entry.

## 8. Update version strings & tag prefix

The release tag prefix tracks the **targeted Acumatica release**: `25R2-X.Y.Z`. Moving the
*target* to a new release changes the prefix to e.g. `26R1-X.Y.Z`, and the human-readable
"2025 R2" / "Acumatica 25R2 SaaS" references should follow. Locations:

- `CLAUDE.md` — Project Overview (Current tag), Architecture diagram ("Acumatica 25R2 SaaS")
- `README.md` — intro ("Acumatica ERP 2025 R2"), Architecture diagram, prerequisites
- `docs/architecture.md`, `docs/tool-reference.md`
- `package.json` `version`, `src/index.ts` McpServer version, `src/docs/docs-handler.ts`
  nav brand
- `CHANGELOG.md` — new entry

> Distinguish two version numbers: the **MCP server version** (`0.34.0`, bumped on every
> release) and the **targeted Acumatica release** (the `25R2`/`26R1` tag prefix, changed
> only when you re-target). They move independently.

## 9. Deploy & smoke test

`npx wrangler deploy`, then confirm the live nav brand shows the new MCP version and a
couple of tools respond. Existing Claude.ai connections may cache the old tool list —
reconnect to force a fresh `init()`.

---

## Forward-looking (update as these ship)

These steps don't exist yet but will once the corresponding workstreams land — add the
concrete commands here when they do:

- **GI XML examples (planned).** Re-export and rebuild `gi-examples-index.json` if examples
  are version-specific.
- **GI descriptions (planned, 26R1).** If the `MCPGIIndex` meta-GI is published, confirm it
  still resolves and its description columns still exist after the upgrade.
