# Upgrading / Changing the Acumatica Version

When the connected Acumatica instance moves to a new release (e.g. **2025 R2 → 2026 R1**),
or when you repoint the MCP server at a different instance/tenant, work through this
checklist. Items are ordered so you can do them top-to-bottom.

> Keep this page current: whenever a feature is added that depends on the Acumatica
> version (a new index built from instance data, a hardcoded entity/endpoint, a new cached
> artifact), add its upgrade step here. See the maintenance note at the bottom.

## 1. Find the new contract endpoint version

The contract REST base URL is `/entity/{ACUMATICA_ENDPOINT_NAME}/{ACUMATICA_ENDPOINT_VERSION}`
— e.g. `/entity/Default/25.200.001`. `ACUMATICA_ENDPOINT_NAME` defaults to `Default`
(Acumatica's stock system endpoint) and rarely changes; a release upgrade usually introduces
a new **version** under the same endpoint name (Acumatica keeps older versions available for
backward compatibility, so nothing breaks immediately, but you want the new one to see new
entities/fields).

- In Acumatica: **Integration → Web Service Endpoints (SM207060)** → the `Default` endpoint
  → note the highest version (e.g. `26.200.001`).
- Or read it from the OpenAPI doc title at
  `{ACUMATICA_URL}/entity/Default/{version}/swagger.json` (the `info.title` is
  `Default/{version}`).

> **Custom endpoint?** If you target a custom Web Service Endpoint instead of `Default`, set
> `ACUMATICA_ENDPOINT_NAME` to that endpoint's name. Be aware a custom endpoint can rename or
> reshape entities, so the hardcoded names in `GETTER_TOOLS` (`src/tools/getter-registry.ts`)
> are only guaranteed against `Default`. The getters are endpoint-aware: on a non-`Default`
> endpoint, a 404 from a getter is re-messaged to tell the model the entity may not be exposed
> by that endpoint (vs. just a wrong key), pointing it at `acumatica_describe_entity` /
> `acumatica_search_schema`. Still spot-check and adjust entries if your custom endpoint
> differs. See **§7** for how to add/extend registry entries.

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

Live schema (`$adHocSchema`), the GI list, inferred GI field schemas, **and the GI tool
registry** (`cache:gi_registry`) are cached in KV (24 h / 1 h / ~1 h freshness). After an
upgrade these can be stale (renamed fields, new GIs, changed `$metadata` types).

- Run the `acumatica_clear_cache` tool with no argument (clears everything), **or**
- Admin console → clear cache, **or**
- Targeted: `target=schema:<Entity>` / `target=gi`.

The GI registry (gate list + curated descriptions + `$metadata`-declared field types) is built
lazily from the `MCPGIs`/`MCPGIFields` feeds + OData `$metadata` and self-refreshes within ~1 h
of its `builtAt`; clearing the cache forces an immediate rebuild on the next GI request. Because
the field **types** come from `$metadata`, an endpoint-version change is exactly when a refresh
matters — clear it so curated tools don't describe the old shape.

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

- The **`MCPAccess` canary GI** (name configurable via `ACUMATICA_CANARY_GI`) still exists and is
  still **Exposed via OData** (the login access gate reads it), and read access is still restricted
  to permitted users (a marker `MCP Access` role is the recommended way). A 403 on the canary =
  users locked out; a 404/5xx = "Configuration Error" page.
- The **Connected Application** (SM303010) redirect URIs are intact. (Scopes aren't
  configured on the app — the server sends `api openid profile email offline_access` in the
  authorization request. `offline_access` is required for refresh tokens — without it sessions
  die after ~1 h.)

## 7. Spot-check entities and tools

The 38 `acumatica_get_*` tools use hardcoded entity names (`GETTER_TOOLS` in
`src/tools/getter-registry.ts`). These are stable across releases, but a new version can
add/rename/deprecate entities or change field shapes:

- `acumatica_describe_entity` on a couple of key entities (e.g. `Customer`, `SalesOrder`)
  → confirm fields resolve.
- `acumatica_search_schema` for any new entities you expect from the release.
- `acumatica_list_entities` + `acumatica_run_inquiry` smoke test (one filtered call each).
- If an entity was removed/renamed upstream, update its `GETTER_TOOLS` entry.
- Re-verify the hardcoded **complex-document-entity list** in `src/lib/complex-entities.ts`
  (`PurchaseOrder`, `Shipment`, `PhysicalInventoryCount` + their key fields `OrderNbr`/`ShipmentNbr`).
  These drive the "can't server-side `$filter` on a non-key field" structured error and the
  `possibleFalseNegative` warning. If a release renames one of these entities or its key field,
  or makes a previously-unfilterable field optimizable, update the list. The mode-A 500 classifier
  (`getFilterErrorKind`) is body-based and entity-agnostic, so it needs no per-release change.

### Adding or extending a getter entry

You only need to touch the registry to add a *dedicated* `acumatica_get_<entity>` tool. Any
entity the endpoint exposes is **already reachable** without code via `acumatica_list_entities`
(filter + `$top`) and `acumatica_describe_entity` (live schema) — add a getter only when an
entity is queried often enough to deserve a first-class, well-described tool. Extended/custom
entities (from a customization or a custom Web Service Endpoint) are added the exact same way.

A getter is a data entry in `GETTER_TOOLS` (`src/tools/getter-registry.ts`) — no handler file,
no `server.tool(...)` block. `src/index.ts` loops the registry and wires each entry through the
shared `runGetter()` handler. To add one:

1. **Confirm the entity name and its key fields.** Run `acumatica_describe_entity` (or
   `acumatica_search_schema`) against the live instance. The entity name is the first path
   segment; the keys are the path segments after it, **in order**. For a custom endpoint, make
   sure the entity actually exists *in the endpoint you set via `ACUMATICA_ENDPOINT_NAME`* — a
   custom endpoint may expose, rename, or hide entities differently from `Default`.
2. **Add the entry.** Append to `GETTER_TOOLS`:

   ```ts
   {
     name: "acumatica_get_widget",            // MCP tool name (snake_case, acumatica_get_ prefix)
     description: "Retrieve a widget by Widget ID. Returns ...",  // model-facing
     entity: "Widget",                         // first path segment — the Acumatica entity name
     params: [
       // path segments after the entity, in order. Each becomes a URL-encoded segment.
       { name: "widgetID", describe: "Widget ID. Format is instance-specific — use acumatica_list_entities with entityName='Widget' to look it up." },
       // Discriminator-style leading keys take a default:
       //   { name: "type", describe: "...", default: "Normal" },
       // A trailing key that may be omitted:
       //   { name: "revision", describe: "...", optional: true },
     ],
     expand: "Details,Attributes",             // optional $expand (comma-separated nav properties)
   },
   ```

   - **Required** param: no `default`, no `optional` → must be a non-empty string or `runGetter`
     returns a loud error (an empty value would otherwise collapse the URL to a list endpoint).
   - **`default`**: optional param with a fallback (e.g. `orderType` → `"SO"`). Good for the
     discriminator key that leads a compound key.
   - **`optional`**: optional param with no default; omitted → no path segment.
   - **`expand`**: only the nav properties you want inlined. `custom` is intentionally dropped by
     `unwrapFields()` — see the note in `src/lib/acumatica-client.ts` if you need extension fields.
3. **Keep Zod simple.** Parameter schemas may only use `z.string()` / `.optional()` / `.default()`
   — the registry builds these for you. Numeric or complex Zod types break MCP JSON-Schema
   serialization (the tool silently won't appear in client discovery).
4. **Update the tool count.** The docs say "48 tools" in several places — bump them if you add a
   tool: `docs/tool-reference.md`, `src/docs/docs-handler.ts` nav brand, the architecture diagram
   in `CLAUDE.md`, and this guide's tool tallies. Add a `CHANGELOG.md` entry.
5. **Type-check and smoke test.** `npx tsc --noEmit`, deploy, then call the new tool once and
   reconnect the Claude.ai connector if the tool list looks stale (it caches per DO session).

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
