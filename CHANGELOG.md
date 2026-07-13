# Changelog

All notable changes to MCP4Acumatica are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project follows
semantic-ish versioning. Release tags use the form `25R2-<version>` (the `25R2`
prefix tracks the targeted Acumatica release, 2025 R2).

## [0.40.0] - 2026-07-12
### Added
- **First write tool: `acumatica_create_or_update_customer`.** Creates a new Customer or updates an existing one via Acumatica's PUT-as-upsert semantics (CustomerID present = update; omitted = create with auto-number). Accepts a JSON `payload` with a curated allowlist of top-level fields (`CustomerID`, `CustomerName`, `CustomerClass`, `Status`, `Email`, `Phone1`, `MainContact`) — and, for `MainContact`, a nested allowlist (`Email`, `Phone1`, `Address1`, `Address2`, `City`, `State`, `PostalCode`, `Country`); any other field, top-level or nested, is rejected before anything is sent to Acumatica. Includes a two-phase confirmation guard: calling without `confirm: 'true'` returns a dry-run preview of the wrapped payload -- no data is changed. Disabled by default; an admin must toggle "Enable Write Tools" at `/docs/admin/settings` before any mutation reaches Acumatica.
- **Write-tool infrastructure (registry-driven, reusable for future entities).** `src/tools/writer-registry.ts` mirrors the existing `GETTER_TOOLS` registry pattern: each entry in `WRITER_TOOLS` is a spec (`name`, `description`, `entity`, `keyField?`, `expand?`, `allowedFields`, `nestedAllowedFields?`) and a shared `runWriter()` handler does all the work. Adding Vendor, SalesOrder, or action tools will be one registry entry each. `src/index.ts` registers them in a loop identical to the getter loop, so every write tool inherits `callTool()` audit logging, response redaction, error formatting, and auth-grant-revoke for free.
- **`writes_enabled` admin kill-switch.** New `CONFIG_KEYS` entry (`src/lib/config.ts`) backed by the `ACUMATICA_WRITES_ENABLED` env var; KV-overridable at runtime from `/docs/admin/settings`. Default is off. `runWriter()` checks this before any payload validation.
- **Mutation audit logging (`logMutation`), persisted to R2.** New `logMutation()` in `src/lib/logger.ts` emits `write_mutation` entries for every mutation attempt -- dry-run previews and committed writes -- including the redacted payload field values, entity, record key, and `dryRun` flag. The entries are buffered to the R2 audit trail by the DO's `callTool` (alongside `tool_invocation`), so they reach the admin console and not just `wrangler tail`. Field values are redacted using the same admin-configured `REDACT_PATTERNS`/`REDACT_SKIP` as read responses, and the redacted payload (never the raw one) is what appears in the HTTP-call log — so nested PII can't leak into logs.
- **Pure utility modules for testability.** `wrapFields`/`unwrapFields` extracted from `acumatica-client.ts` to `src/lib/field-transforms.ts` (zero imports). Pure payload validation extracted to `src/tools/writer-validation.ts` (zero imports). Both are re-exported from their original locations so no import sites change.
- **Tests.** `test/field-transforms.test.ts` (13 cases: wrapFields/unwrapFields round-trips, nested/array/idempotent/null) and `test/writer-validation.test.ts` (21 cases: size cap, JSON parse, type check, top-level + nested allowlist). Bring the test suite to 70 total tests.

## [0.39.1] - 2026-07-10
### Docs
- **Corrected drift in `docs/architecture.md`.** The main architecture diagram now shows the second Durable Object (`TOKEN_MANAGER`, per-user token-refresh serializer), the R2 buckets (`mcp4acumatica_logs`, `INDEX_STORE`), and the docs/admin surface; distinguishes the Contract-REST path from the OData GI path (access gate + GI tools); and de-hardcodes the endpoint name (`Default` is configurable via `ACUMATICA_ENDPOINT_NAME`). Rewrote **"Why Durable Objects?"** to state the real driver — remote MCP is a stateful, session-scoped protocol and a DO is Cloudflare's only stateful, consistently-addressable primitive, so the `agents` SDK's `McpAgent` *is* a DO — rather than the three secondary benefits it previously led with. Replaced the stale registry-era **File Structure** block (`customers.ts`/`vendors.ts`/"42 tools") with the current layout, corrected the `Env`/`AppEnv` section (`Env` no longer extends `AppEnv`; `init()` builds a fresh `AppEnv` and never mutates `this.env`) and the Cloudflare-adapter snippet, and reconciled tool counts (42/44 → 48). No code change.

## [0.39.0] - 2026-07-09
### Changed
- **Login gate decoupled from the role concept; canary GI name is now configurable.** The access gate never actually checked Acumatica role membership — it only checks whether a user's token can *read* the canary Generic Inquiry over OData (200 → allowed, 403 → denied). The code now says so: `checkUserRole()` → `checkAccess()` (the unused `_requiredRole` parameter is gone), the two user-facing pages no longer name a role ("your account does not have access to this AI assistant"), and the audit-log reasons `missing_role` / `role_check_misconfigured` are now `access_denied` / `access_check_misconfigured`. The hardcoded `MCPAccess` GI name is replaced by a new **`ACUMATICA_CANARY_GI`** env var (default `"MCPAccess"`, so existing deployments are unaffected), replacing the removed **`ACUMATICA_MCP_ROLE`** var (which was cosmetic — it only filled in page text and was never used in the check).
- **Docs reframe the gate as "restrict the canary GI however you like; a marker role is the recommended way"** rather than mandating a role. Updated across `README.md`, `docs/architecture.md`, `docs/generic-inquiries.md`, `docs/upgrading-acumatica.md`, and `CLAUDE.md`. No behavior change for a correctly-configured instance; the `MCPAccess` GI + `MCP Access` role setup continues to work exactly as before.

## [0.38.5] - 2026-07-06
### Fixed
- **`/authorize` returns a diagnosable error instead of an opaque 500 when a CIMD client_id can't be resolved.** `parseAuthRequest()` is now wrapped in try/catch: a metadata-document fetch failure returns **502** with a message stating it's the client's metadata endpoint that's down (not this server), a malformed/invalid `client_id` returns **400**, and both log an `authorize_parse_failed` line (client_id + error code only, no secrets) for `wrangler tail`. Surfaced by a real incident — a transient 503 outage of Claude.ai's CIMD metadata endpoints (`claude.ai/oauth/*-client-metadata`) made the server-side CIMD fetch fail, which took down every CIMD client (Claude.ai web + current Claude Desktop) with an opaque 500 while DCR clients kept working. Server and Acumatica upstream were healthy throughout; the outage was client-side and recovered on its own. Code change is defensive only — no behavior change for successful auth flows.

## [0.38.4] - 2026-06-29
### Added
- **Acumatica session & license model documented.** New "Acumatica Session & License Model" section in `docs/architecture.md` explains how the server consumes Acumatica's two independent license limits — *Max Web Services API Users* (concurrent server-side sessions; HTTP 429 at sign-in when exceeded) and *Concurrent Web Services API Requests* + requests-per-minute (throughput throttle; queues then delays) — and **when an API-user seat is released**: under the plain `api` scope each access token is a single session that Acumatica closes automatically at token expiry (~1 h), so the stateless client (no session-cookie reuse, no `/entity/auth/logout`) never leaks seats. Concurrent seats consumed ≈ distinct users active within a rolling ~1 h window, not per request. Added a load-bearing-scope warning (keep `api`, never `api:concurrent_access`) to `docs/self-hosting-guide.md` and a Key Design Decision note in CLAUDE.md. Docs-only; no code change.

## [0.38.3] - 2026-06-28
### Added
- **`describe_inquiry` refuses parameterized GIs too.** Extends the 0.38.1 `run_inquiry` guard to `acumatica_describe_inquiry`, which would otherwise sample a parameterized GI via `$top=1` and infer a field schema from default/unfiltered (wrong) data. It now refuses parameterized GIs (the shared `parameterizedGiNames()` `$metadata` check), checked **before** the schema cache so a stale pre-guard schema isn't served, and failing open if `$metadata` is unavailable. Both GI query tools are now consistent.

## [0.38.2] - 2026-06-28
### Changed
- **Inactive gate no longer enumerates GIs (behavior change).** When no GI registry is built, `acumatica_list_generic_inquiries` previously returned *every* OData-exposed GI (fail-open) — handing the model an uncurated menu that can include GIs returning silently wrong data. The inactive state now **suppresses discovery**: `list` returns no GIs (with a note on how to enable the registry), while `run_inquiry` / `describe_inquiry` still serve a GI named **explicitly**. Net inactive semantics: *no discovery; explicit-name access only.* This restores the original spec intent (registry-absent ⇒ no uncurated enumeration) and reconciles a contradiction in `docs/gi-discovery-plan.md` (§2 "deny all" vs. §3 "inactive = allow all"). Instances that relied on the model auto-discovering GIs without a configured registry will now see an empty list until they curate (or name GIs explicitly).

## [0.38.1] - 2026-06-28
### Added
- **`run_inquiry` refuses parameterized Generic Inquiries.** A GI with parameters, queried over OData without those parameters (as the agent does), returns default/unfiltered — i.e. *wrong* — rows with no error, which the model can't detect. `run_inquiry` now detects parameterized GIs (the `{Name}_WithParameters` `$metadata` check, extracted into a shared pure `parameterizedGiNames()` in `gi-registry.ts` and reused by discovery) and refuses them outright **regardless of gate state**, closing the inactive-state hole where an uncurated GI could feed the model silently-wrong data. Fails open if `$metadata` is unavailable (no false refusals).
### Changed
- **The GI exposure gate is no longer documented as "optional."** It is a data-correctness control — leaving GIs uncurated can feed the model wrong data — and is now framed as strongly recommended across the README, `docs/generic-inquiries.md`, `docs/tool-reference.md`, and CLAUDE.md. Added a prominent warning that parameterized GIs return silently wrong data over OData, and corrected a bullet that incorrectly claimed parameterized GIs "can't be queried over OData."

## [0.38.0] - 2026-06-28
### Added
- **Generic Inquiries documentation + rationale.** New `docs/generic-inquiries.md` (served at `/docs/generic-inquiries`, linked from the README) explains *why* the GI exposure gate exists — a mature instance accumulates hundreds of GIs built for human screens, and surfacing them all floods the model's context and degrades GI selection — plus which GIs to expose vs. leave unexposed, and the setup. The README gains a rationale-first "Generic Inquiry exposure to AI" section.
- **Bundled Acumatica setup package (`acumatica/`).** Import the gate's Acumatica-side prerequisites instead of hand-building them: `MCP4Acumatica-AIDescription.zip` (customization project — the `GIDesign.UsrExposedToMCP`, `GIDesign.UsrAIDescription`, and `GIResult.UsrResAIDescription` custom fields + SM208000 form changes), the `MCPGIs` / `MCPGIFields` / `MCPAccess` Generic Inquiry definitions, and an import-order README with the feed-column → code mapping.
### Changed
- **GI registry feed contract aligned to the published feed GIs.** `FeedGiRow` / `FeedFieldRow` and the `gi-registry.ts` read sites + tests now read the feeds' actual OData property names (`Name`, `ScreenID`, `DesignID`; and `Name`, `SchemaField`, `Caption`, `LineNbr`, `AIDescription`) rather than the earlier `InquiryTitle` / `EntryScreen` / `GIDesign_designID` / `DataField`, which did not match the GIs. Acumatica derives each OData property name from the result-column caption, so the captions are the contract — renaming one now requires the matching change in `gi-registry.ts` (documented in CLAUDE.md and `acumatica/README.md`). Without this alignment, an activated registry would have built empty.
### Fixed
- **Documented the customization prerequisite.** The gate's custom fields live on the system DACs `GIDesign`/`GIResult`, so they require a customization project — the docs previously implied they could be added from the GI form. Corrected the field names (`UsrExposedToMCP` casing, `UsrResAIDescription`) and the feed-column names across CLAUDE.md, README, `docs/tool-reference.md`, and `docs/generic-inquiries.md`.

## [0.37.0] - 2026-06-27
### Added
- **Generic Inquiry opt-in gate + curated registry.** Layered onto the existing GI tools (`acumatica_run_inquiry`, `acumatica_list_generic_inquiries`, `acumatica_describe_inquiry`) — no new tools, and **not** per-GI dynamic tools (that remains a deferred workstream; see `docs/gi-discovery-plan.md`). When an Acumatica admin configures the registry, only GIs explicitly flagged `ExposedtoMCP` are reachable; until then the gate stays **inactive** and all OData-exposed GIs remain available exactly as before. The REST/entity getters are unaffected.
  - **Lazy pull, no service account, no Cron.** The registry is built on demand with the requesting user's token (`getGiRegistry()`, `src/lib/gi-registry-build.ts`) when the KV cache (`cache:gi_registry`) is stale, then shared for everyone. The gate list + field schemas are global GI/field **metadata** (never business rows), so building from whoever's token is in hand is safe; execution still uses each user's own token and row-level access. Chosen after confirming `client_credentials` is disabled on the Connected App.
  - **Feeds.** Two parameter-free, OData-exposed GIs supply the data: `MCPGIs` (one row per exposed GI) and `MCPGIFields` (one row per output column). Field **types** come from OData `$metadata` (authoritative), with runtime sample inference as fallback; curated `UsrAIDescription` text is surfaced by `describe_inquiry` / `list_generic_inquiries`. Pure assembly logic (`parseEdmxTypes` / `assembleRegistry` / `checkGiGate`) lives in the unit-tested leaf `src/lib/gi-registry.ts`.
  - **Gate semantics — fail-closed once active.** No registry → inactive (no dead period during rollout). Registry present → only listed GIs allowed; an empty list denies all; feed/canary GIs (`MCPGIs`/`MCPGIFields`/`MCPAccess`) are always denied. A failed rebuild serves the cached last-good rather than flapping. Enforced in `run_inquiry` + `describe_inquiry`; `list` shows only gated GIs.
  - **Fixed-width trim.** `cleanGiRow`/`cleanGiRows` (`src/lib/gi-rows.ts`) trim space-padded fixed-width key values (e.g. `"GARES     "`, which break equality filters) and strip `@odata.*` everywhere a GI row reaches the model.
  - **Cache invalidation.** `acumatica_clear_cache` with no argument (or `target=gi`) now also clears `gi_registry`.
  - **Operator setup** (to activate): grant the `MCP Access` role read access to `MCPGIs` + `MCPGIFields`, add the `UsrExposedtoMCP` / `UsrAIDescription` extension fields, and tag the GIs to expose. See README / `CLAUDE.md` → "GI Tool Gating & Registry".
  - **Tests:** new `test/gi-registry.test.ts` covers gate semantics, row cleaning, and EDMX type parsing / registry assembly.
- **Docs:** `docs/upgrading-acumatica.md` §4 now lists the GI registry (`cache:gi_registry`) among the runtime caches to clear after an upgrade (field types track `$metadata`, so an endpoint-version change is exactly when a refresh matters). `docs/tool-reference.md` documents the gate. `docs/gi-discovery-plan.md` records the design and the deferred per-GI-tool workstream.

## [0.36.0] - 2026-06-18
### Added
- **Configurable contract-API endpoint name.** The contract base URL `/entity/{name}/{version}` previously hardcoded `Default` as the endpoint name. A new optional `ACUMATICA_ENDPOINT_NAME` env var (default `Default`) lets the server target a custom Web Service Endpoint (SM207060). Threaded through `AcumaticaClient`, the preflight endpoint probe (which now reports the configured name in its pass/fail/remediation text), and the admin diagnostics input. Existing deployments need no change — the var is optional and falls back to `Default`.
- **Endpoint-aware getter 404s.** The 38 `acumatica_get_*` tools use entity names curated for the stock `Default` endpoint. On a non-`Default` endpoint, a 404 is ambiguous — wrong key, or the endpoint simply doesn't expose that entity (Acumatica returns the same status for both). `runGetter()` now re-messages the 404 (via `endpointAware404Message()` in the import-free leaf `src/tools/getter-errors.ts`) to surface the "entity may not be exposed by this endpoint" cause and point the model at `acumatica_describe_entity` / `acumatica_search_schema`. On `Default` the plain "verify the ID" message is kept. Registration is deliberately **not** gated on a live entity catalog (the contract API needs a per-user token, so there's no auth-free way to enumerate entities at DO `init()`). New unit tests cover the re-messaging.
- **Docs:** `docs/upgrading-acumatica.md` §7 now documents how to add or extend a getter entry in `GETTER_TOOLS` (including for custom/extended entities), and §1 covers the custom-endpoint case.
### Fixed
- **Deploy-to-Cloudflare GUI no longer blocks on empty `REDACT_PATTERNS` / `REDACT_SKIP`.** These shipped in the `wrangler.jsonc` `vars` block as empty strings; the GUI deploy flow treats every declared var as required and won't let you proceed with a blank value. They're optional in code (read defensively, undefined-safe), so they've been removed from the committed template — add them later via the dashboard (`Variables and Secrets`) or the admin console (`config:redact_patterns` / `config:redact_skip`) if you want to extend/whitelist redaction.
- **GUI deploy KV-namespace guidance.** Cloudflare auto-provisioning derives a new KV namespace's title from the Worker name, so both KV bindings (`TOKEN_STORE`, `OAUTH_KV`) default to `mcp4acumatica` and collide (*"Cannot provision a KV Namespace … because it already exists"*). README now flags that the two namespaces need distinct names, how to clear the orphan left by a failed attempt, and that the terminal installer (one shared namespace) avoids the issue entirely.
- **Removed the bogus "set the scope" step from the Connected Application setup.** Acumatica's Connected Application (SM303010) has no scope field — OAuth scopes (`api openid profile email offline_access`) are sent request-side by the server in the `/authorize` URL. Corrected every reference (`README.md`, `CLAUDE.md`, `docs/upgrading-acumatica.md`, `docs/self-hosting-guide.md`, and the code comment in `acumatica-auth-handler.ts`).

## [0.35.0] - 2026-06-13
### Fixed
- **`substringof`/`startswith`/`endswith` filters silently returned `[]`.** Acumatica's contract-REST `$filter` parser returns an empty set (HTTP 200, no error) when a boolean string function is compared to a literal — `substringof('X', Field) eq true` — but works for the bare function. Models habitually append `eq true` (valid OData v3), so every partial-text/"contains" search returned zero rows. `normalizeODataFilter()` (`src/lib/odata-filter.ts`) now strips a trailing `eq true` off the three boolean functions before the request goes out, for both `acumatica_list_entities` and `acumatica_run_inquiry`. `eq false` is left verbatim — the only equivalent negation (`not substringof(...)`) is rejected by the contract API with a 500. (This was a parser quirk, not a URL-encoding bug.)
### Added
- **Structured errors for non-optimizable `$filter` queries.** Acumatica's OData filter binder 500s when it can't apply a `$filter` to a complex document entity (unbound/computed/BQL-delegate field → `CannotOptimizeException`, a child-collection field → "not a single value", a type mismatch, or an unknown field). `getFilterErrorKind()` (`src/lib/complex-entities.ts`) classifies these and `acumatica_list_entities` returns a structured, actionable error (`filterNotApplicable: true`, `filterErrorKind`, a key-field hint, and a pointer to `acumatica_describe_entity` / a Generic Inquiry) instead of an opaque "Acumatica internal error".
- **False-negative guard for complex document entities.** When `acumatica_list_entities` returns 0 rows on a non-key filter against a known complex entity (`PurchaseOrder`, `Shipment`, `PhysicalInventoryCount`), the response now includes a `possibleFalseNegative: true` warning — Acumatica can silently drop a non-optimizable filter and return `[]` even when matching records exist, so the model is told not to conclude "no such record exists" and to verify with a keyed lookup or a Generic Inquiry.
- **Tool descriptions** for `acumatica_list_entities` / `acumatica_run_inquiry` now tell the model to write boolean functions bare (no `eq true`) and call out the complex-document-entity filtering limitation.
- **Unit-test harness** — first tests in the repo (`test/`, Node's built-in `node --test` runner with TypeScript type-stripping, zero new dependencies), wired to `npm test`. Covers `normalizeODataFilter` and the filter-error classification helpers.

## [0.34.2] - 2026-06-11
### Fixed
- The OIDC-fallback `UserSecurityInfo` identity lookup in `/callback` hardcoded the contract version `25.200.001` instead of using `ACUMATICA_ENDPOINT_VERSION`. On a re-targeted instance (e.g. 26R1) that path would 404, silently dropping users to the UUID-based key fallback and breaking token reuse across sessions. Now uses the configured endpoint version like every other contract-API URL. (Originally authored by Adam Coates in the hoser-dev fork.)

## [0.34.1] - 2026-06-11
### Docs
- Documented the DAC-layer stance: DAC metadata is intentionally **not** a tool — stock DACs are covered by Acumatica's public DAC Schema Browser (`help.acumatica.com/dacBrowser`, reachable via the client's web access), custom DACs by the customization source, and API-exposed custom fields by the existing schema tools. (A DAC-via-GI customization was prototyped and dropped as redundant + high-maintenance.)
- Added a "DAC-layer questions" pointer to `/docs/schema-discovery`; removed a third-party-comparison aside and a stale "DAC index (planned)" item from the upgrade guide.

## [0.34.0] - 2026-06-11
### Added
- **Schema-knowledge tools** for power users building integrations and customizations:
  - `acumatica_search_schema` — find entities by name/keyword and/or "which entities contain field X".
  - `acumatica_get_schema_entity` — full offline schema for one entity (fields + types, actions, `$expand` sub-entities).
  - `acumatica_list_schema_entities` — browse/filter the entity catalog by name/module prefix.
  - `acumatica_explain_gi_xml` — stateless structural summary of a pasted Generic Inquiry definition XML (tables, joins, parameters, filters, results).
- These answer from an **offline schema index** built from your instance's own `swagger.json` (always current, includes your customizations, no third-party IP), instead of sampling live records to infer shape. The three index-backed tools register only when the index is present; the GI explainer is always available.
- New platform abstraction `IBlobStore` (CF impl `CloudflareR2BlobStore`) on `AppEnv.indexStore`, backed by a new `mcp4acumatica-index` R2 bucket (`INDEX_STORE`). Self-hosting story preserved.
- Open-source ingestion scripts (`scripts/build-schema-index.mjs`, `scripts/upload-indexes.mjs`) + `npm run build-index`; `setup.sh` builds/uploads the schema index automatically after deploy when `swagger.json` is present.
- New `/docs/schema-discovery` documentation page.
### Notes
- Acumatica **documentation** lookups are intentionally not a tool — the public Help Wiki (<https://help.acumatica.com/>) is reachable via the AI client's own web search. DAC metadata and GI XML example libraries are planned as later, private-index workstreams.

## [0.33.2] - 2026-06-08
### Added
- This `CHANGELOG.md` (full history reconstructed from git tags/commits) and a `/docs/changelog` page on the documentation site.
### Docs
- Commit and close-session checklists now include a changelog-update step.

## [0.33.1] - 2026-06-07
### Fixed
- **Sessions no longer die after ~1 hour of idle.** Root cause: `/authorize` never requested the `offline_access` scope, so Acumatica/IdentityServer issued no refresh token — the stored refresh token was empty and every refresh failed with `400 invalid_request`. Now requests `offline_access` (the Connected App must permit it).
- `TokenManager` `readToken()` reconciles DO storage vs KV by recency, so a failed callback seed can't pin a stale, already-rotated token.
### Added
- `token_resolve_outcome` diagnostic logging (reason on every non-ok token resolution).
- Self-hosting guide now documents the `offline_access` requirement and the `ITokenProvider` serialization step.

## [0.33.0] - 2026-06-07
### Changed
- **Per-user token-refresh serialization via a new `TokenManager` Durable Object.** All token access for a user funnels through one globally-unique DO (`idFromName(username)`), coalescing concurrent refreshes. Eliminates the cross-isolate rotation race where concurrent sessions reused a rotated refresh token and one was spuriously evicted.
- Token logic kept platform-agnostic behind a new `ITokenProvider` abstraction on `AppEnv` (CF impl `DOTokenProvider`; self-host = a distributed lock).
### Docs
- Documented that Claude.ai authenticates via CIMD (not DCR), and recorded the Claude.ai reconnect/dead-state and `/authorize`-500-on-bad-client_id findings.

## [0.32.1] - 2026-06-06
### Fixed
- Dead refresh tokens are now classified by **HTTP status** (any `4xx` → re-auth; `5xx`/`429` → transient), not by matching the `invalid_grant` string — Acumatica's `400` body doesn't reliably parse to that code, which previously made the model loop on "try again shortly" instead of re-authenticating.

## [0.32.0] - 2026-05-29
### Added
- Transparent re-auth on a dead Acumatica refresh token: a `ReauthRequiredError` revokes the user's MCP grant so the client silently re-runs OAuth instead of a manual disconnect/reconnect.

## [0.31.1] - 2026-05-10
### Docs
- Documented the Generic Inquiry "no description metadata" gap and three potential cure paths.

## [0.31.0] - 2026-05-10
### Added
- `CONTRIBUTING.md` and `SECURITY.md`; `.claude/` gitignored; anonymized the `workers.dev` hostname in tracked config.

## [0.30.1] - 2026-05-10
### Changed
- Set `preview_urls: true` in the tracked `wrangler.jsonc` so deploys don't flip it off on config drift.

## [0.30.0] - 2026-05-10
### Added
- GUI install path ("Deploy to Cloudflare" button) with `wrangler.jsonc` as the tracked deploy template; one-shot `setup.sh` and one-line `install.sh`.
- Preflight diagnostics (`/docs/admin/preflight`) and `/callback` OAuth-error mapping.
### Changed
- Tool-description rework (instance-specific ID wording, lookup pointers, expand/denylist/cache disclosures); `runGetter` empty-string guard for required path params.

## [0.29.1] - 2026-04-16
### Fixed
- Persist the DO log buffer to `ctx.storage` so a buffer flush survives DO eviction (alarm runs on a fresh instance).

## [0.29.0] - 2026-04-16
### Security
- Closed the full security-audit review (all critical/high/medium/low items).

## [0.26.1] - 2026-04-16
### Fixed
- Use a full UUID (not an 8-char slice) for R2 log filenames to avoid collisions.

## [0.26.0] - 2026-04-16
### Security
- Closed audit items M1, M2, M5, M6.

## [0.25.0] - 2026-04-16
### Security
- Closed audit criticals C1–C3 and mediums M3, M7.

## [0.24.1] - 2026-04-16
### Fixed
- Flush the audit-log buffer on a DO alarm, not only on the next log arrival.

## [0.24.0] - 2026-04-16
### Changed
- Removed the server-side pagination cooldown guard in favor of a structured pagination-refusal envelope (`truncated`, `paginationSupported: false`, `actionRequired`).
- Fixed the `acumatica_max_records` KV override and hardened `topN` coercion.

## [0.23.2] - 2026-04-16
### Changed
- Sped up the admin log viewer (streaming server-side pagination) and buffered DO logs into fewer R2 files.

## [0.23.1] - 2026-04-09
### Fixed
- DO tool logs weren't visible in the admin console — write them directly to R2 from the DO.

## [0.23.0] - 2026-04-09
### Added
- Storage abstraction layer (`IKeyValueStore` + `AppEnv`) for platform portability; self-hosting guide.

## [0.22.1] - 2026-04-09
### Docs
- Added the close-session procedure to CLAUDE.md.

## [0.22.0] - 2026-04-09
### Added
- Admin console: log viewer, settings management, and R2 Logpush.

## [0.21.0] - 2026-04-08
### Added
- Pagination guard and anti-pagination tool descriptions (later superseded by the 0.24.0 refusal envelope).

## [0.20.2] - 2026-04-08
### Docs
- Documented access control, consent, redaction, and audit logging.

## [0.20.1] - 2026-04-08
### Changed
- Renamed the project to **MCP4Acumatica**.

## [0.20.0] - 2026-04-08
### Added
- KV-backed metadata cache (entity schemas 24h; GI lists/field schemas 1h) and the `acumatica_clear_cache` tool.

## [0.19.1] - 2026-04-08
### Changed
- Clarified the `topN` max-1000 limit in tool descriptions.

## [0.19.0] - 2026-04-08
### Added
- Access controls: canary-GI role gate, consent interstitial, sensitive-field redaction, and enhanced audit logging.

## [0.18.1] - 2026-04-08
### Changed
- Filter parameterized GIs out of `acumatica_list_generic_inquiries`.

## [0.18.0] - 2026-04-08
### Changed
- Renamed `ACUMATICA_COMPANY` → `ACUMATICA_TENANT`; added a configurable record limit; restored GI tools over OData with OAuth 2.0 Bearer tokens.

## [0.17.0] - 2026-04-07
### Changed
- Removed unused code and consolidated the KV namespaces.

## [0.16.0] - 2026-04-07
### Added
- GI discovery tools: `acumatica_list_generic_inquiries`, `acumatica_describe_inquiry`.

## [0.15.0] - 2026-04-07
### Added
- CIMD support alongside DCR; OpenID Connect discovery endpoint (for ChatGPT compatibility).

## [0.14.0] - 2026-04-07
### Added
- Documentation website served from `/docs` on the same Worker.

## [0.13.0] - 2026-04-07
### Added
- Schema discovery tool: `acumatica_describe_entity`.

## [0.12.0] - 2026-04-07
### Added
- Generic list/search tool: `acumatica_list_entities`.

## [0.11.0] - 2026-04-06
### Added
- Generic Inquiry tool: `acumatica_run_inquiry`.

## [0.10.0] - 2026-04-06
### Added
- CRM Activity read-only tools: Email, Event, Activity, Task.

## [0.9.0] - 2026-04-06
### Added
- HR & Payroll read-only tools: Employee, ExpenseClaim, TimeEntry.

## [0.8.0] - 2026-04-06
### Added
- Shipping & Fulfillment read-only tools: Shipment, SalesInvoice.

## [0.7.0] - 2026-04-06
### Added
- Sales & CRM read-only tools: Contact, BusinessAccount, Opportunity, Lead, Salesperson.

## [0.6.0] - 2026-04-06
### Added
- Service & Field read-only tools: Case, ServiceOrder, Appointment.

## [0.5.0] - 2026-04-06
### Added
- Projects read-only tools: Project, ProjectTask, ProjectBudget, ProjectTransaction.

## [0.4.0] - 2026-04-06
### Added
- Purchasing read-only tools: PurchaseOrder, PurchaseReceipt.

## [0.3.0] - 2026-04-06
### Added
- Inventory & Warehouse read-only tools: StockItem, NonStockItem, availability inquiries, Warehouse, ItemClass.

## [0.2.0] - 2026-04-06
### Added
- Financial/Accounting read-only tools: Invoice, Bill, JournalTransaction, Payment, Account, Check.

## [0.1.0] - 2026-04-06
### Added
- Initial Acumatica MCP server: OAuth auth (Acumatica as sole IdP) and the first read-only tools (Customer, Vendor, SalesOrder). Microsoft Entra ID removed in favor of direct Acumatica OAuth.
