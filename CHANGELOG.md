# Changelog

All notable changes to MCP4Acumatica are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project follows
semantic-ish versioning. Release tags use the form `25R2-<version>` (the `25R2`
prefix tracks the targeted Acumatica release, 2025 R2).

## [0.49.0] - 2026-08-16
### Added
- **Filters on calculated GI columns are refused before reaching Acumatica.** A `$filter` that references a **calculated** column (an `=…` expression in the GI design) makes Acumatica return HTTP 200 with an *empty body* — not an error, not an empty list. This was the single largest remaining error class: production logs attribute 279 empty-body occurrences (~14% of tool errors) almost entirely to `acumatica_run_inquiry`, and the cause was reproduced live three times (a filter on a stored column works; adding `and <ExpressionColumn> ne 0` fails with the empty body).
  - The GI registry now flags expression columns (`GiFieldMeta.expression`), set during the positional alignment from the design row's `Field` starting with `=`. Flags are attached only where a design row was actually aligned to the property — a GI whose alignment was refused carries none, because a mis-placed flag would refuse filters on a perfectly filterable stored column.
  - `acumatica_run_inquiry` pre-flights `filterExpression` with `filterReferencedColumns()` (`src/lib/odata-v4-errors.ts` — string-literal-safe, case-sensitive identifier match, unit-tested) and returns a `buildCalculatedColumnRefusal()` envelope **without contacting Acumatica**: names the offending columns, lists the stored `filterableFields` to rewrite against, and states the query never executed so a refusal can't be reported as "no records matched".
  - `acumatica_describe_inquiry` marks such fields `calculated: true` and warns in its `note` that they cannot be filtered; both tools' descriptions carry the same guidance.
  - Uncurated GIs (gate inactive, or a refused alignment) still hit the raw empty body; `parseAcumaticaJson()`'s anomaly report (0.44.0) remains the backstop there.
### Changed
- **`align_columns.mjs` brought back in sync with the server aligner.** The skill script (`skills/acumatica-gi-descriptions/scripts/align_columns.mjs`) now carries the 0.48.2 rejection rules — declared-type constraint (`expectedTypeFamily`/`typeConflicts`), the weak shared-token tiebreak, DP optimal-solution counting, hoist-assignment ambiguity refusal, and the final pair sweep — so it no longer reports success on alignments the server rejects. A tied optimum stops the dropped-column search rather than escalating it (a higher drop count that happens to align is a free parameter rationalising a wrong mapping) and reports `alignment_ambiguous` with the caption-pinning remedy. Verified against the production feed: reproduces the hand-checked hoists on `AP-Bills and Adjustments` ({1,2,6,33}) and `SO-Invoice` ({1,2,6,22}, `Amount ← curyOrigDocAmt`), and refuses the same under-determined GIs the server does.

## [0.48.2] - 2026-08-16
### Fixed
- **The column aligner committed to an arbitrary hoist on lightly-captioned GIs, mis-shifting descriptions by one.** A caption is a hard constraint, but most columns have none, and `columnScore()` scored an uncaptioned row purely on field-name resemblance — so on a GI with few captions every candidate scored 0, the DP tied, and the tie was broken by iteration order. Caught on production `SO-Invoice` by reading the GI back through `acumatica_describe_inquiry`: six columns each carried the *previous* column's description, because the aligner had hoisted the `curyDocBal` row onto the string key `Customer`. Note this is invisible to an ERP-side read-back — the stored `GIResult.UsrResAIDescription` values were correct; only the delivery mapping was wrong.
  - `columnScore()` now rejects a pairing whose declared `$metadata` type contradicts the type family implied by the design row's source field (`expectedTypeFamily()` / `typeConflicts()`, both exported and unit-tested). Deliberately conservative: only unambiguous naming conventions are classified, calculated columns (`=…`) yield no constraint, and `integer` is compatible with everything because Acumatica surfaces identifiers as int or string depending on the DAC.
  - A surviving tie is now **refused**. `alignRows()` counts optimal hoist sets and returns null when more than one exists, and the hoisted-row assignment refuses when the chosen row scores equally on another property (or the chosen property scores equally with another row). Ambiguity is *not* merely "several pairs share the best score" — four captioned rows each scoring 100 on their own property tie and resolve perfectly.
  - Added a weak shared-token signal, scored below the substring tiers, to separate candidates the existing tiers rank identically (`finPeriodID`→`PostPeriod` shares "period"; `acctCD`→`PostPeriod` shares nothing).
  - Measured against the production feed (112 gated GIs): 95 unchanged, **4 mappings corrected** (`HPL-Appt_NamePhoneSearch`, `HPL-ProjectForecast_JobLevel`, `HPL-ProjectForecast_WHLevel`, `HPL-CostCodes` — one of which had a decimal `qty` column landing on the string `ProjectID`), and 13 now refuse annotation instead of guessing. Refusal keeps names and declared types; only captions and descriptions are withheld.

### Notes
- A GI that refuses can be made determinate without any code change: set `GIResult.Caption` on its hoisted key columns to **exactly the property name OData already reports**. That pins the alignment permanently and is a no-op rename, since the property name is derived from the caption.

## [0.48.1] - 2026-08-15
### Fixed
- **`acumatica_clear_cache` now actually clears the GI registry.** The registry is memoized per isolate and `getGiRegistry()` checks that memo *before* it reads KV, so deleting the KV entry did nothing for the life of the isolate: the tool reported `cleared` and kept serving the stale registry. An operator who tagged a GI, edited a description, or re-imported a feed and then cleared the cache to check saw no change and reasonably concluded the Acumatica-side edit had not taken. `handleClearCache` now calls `resetGiRegistryMemo()` whenever the clear could cover the registry (no target, `gi`, or `gi_registry`); the function was previously exported as a test-only seam.

### Added
- `align_columns.mjs` (skill) now reports which GIs have a hoisted column chosen with **no evidence**. Alignment's only ambiguous step is which key columns are hoisted to the front; where those rows carry no caption nothing determines the choice, so the script previously reported plain success on an under-determined result. Verified failure on `AP-Bills and Adjustments`, where one wrong hoist shifted every uncaptioned column by one while the captioned columns still matched. The flag has false positives in both directions and is a check list, not a verdict — the reliable test is querying a few rows per GI.

### Changed
- `.gitignore` excludes `acumatica/gi-descriptions*.csv` and `.gi-work/`. Drafted descriptions and the instance metadata pulls behind them describe one tenant's inquiries and cannot ship in a public repo.

## [0.48.0] - 2026-08-15
### Fixed
- **Curated GI column descriptions now actually reach the model.** `resolveFields` (`src/lib/gi-registry.ts`) matched `MCPGIFields` design rows to `$metadata` properties by *predicting* the property name from `Caption` → `Usr`-stripped `SchemaField`. Verified live on 25R2 (2026-08-15), neither input supports that: `GIResult.Caption` is only an **override** — 1 079 of 1 907 result columns across the 115 curated GIs have a NULL caption, and 16 GIs (`CS-ReasonCode`, `GL-Journal Transactions`, `IN-NonStock`, `FA-Fixed Assets`, …) have none at all — while `GIResult.SchemaField` is NULL for most rows and **DAC-qualified** where present (`INTran.RefNbr`), which can never equal the bare property `RefNbr`. A row that predicted nothing was skipped, so the majority of column descriptions were silently dropped: `acumatica_describe_inquiry` on `CS-ReasonCode` returned the GI-level description but every field as bare `{fieldName, dataType}`.
- The join is now **positional**, reproducing Acumatica's actual projection: `[result columns that are also entity keys, hoisted to the FRONT in key order] ++ [remaining ACTIVE design rows in SortOrder order] ++ [keys that are not result columns, appended at the END with no design row]`. The order is **`SortOrder`, not `LineNbr`** (they diverge: in `PM-Projects`, `Builder` is LineNbr 4 but grid position 2), inactive rows are excluded (they never reach OData, so counting one shifts every later column), and key hoisting is the normal case (108 of 115 GIs). Ported from the tested `skills/acumatica-gi-descriptions/scripts/align_columns.mjs`.
- **Rejects rather than mis-shifts.** Alignment is a DP in which a captioned row is a *hard constraint* — it must land on the property its caption names. If one captioned row can't be satisfied, or there are more active rows than properties, that GI's annotation is dropped wholesale: field names and declared types are still returned, but no caption or description is attached. Attaching a description to the wrong column is worse than attaching none.
- 8 alignment tests in `test/gi-registry.test.ts` (SortOrder ≠ LineNbr, inactive exclusion, key hoisting, appended non-result keys, misalignment rejection, count-mismatch rejection, and the pre-0.48.0 feed shape).

### Changed
- **`acumatica/MCPGIFields.xml` — re-import required.** Two output columns added, `SortOrder` (`GIResult.sortOrder`) and `IsActive` (`GIResult.isActive`); positional alignment cannot work without them. Also given the row filter `UsrExposedToMCP = true AND ExposeViaOData = true` — it previously returned every result column of every GI in the instance, most of them irrelevant and enough to blow past the record cap on their own.
- **The registry build pages both feeds** (`fetchFeed`, cap 10 pages). The field feed emits one row per output column of every exposed GI — ~1 900 on this instance, past the 1 000-row default cap — and a truncated tail cost every GI after it its column descriptions. The first page is fetched exactly as before; paging starts only if it comes back full, and a `$skip` failure degrades to the rows already in hand rather than failing the build. This is an internal metadata pull, not a model-facing response, so the anti-pagination policy doesn't apply.
- `EdmxEntity` now carries `keys` (parsed from `<Key><PropertyRef>`), needed to detect hoisted key columns. `predictPropertyName` remains only for the degraded no-`$metadata` path.
- **A feed emitting no `IsActive` at all is now refused rather than aligned by `LineNbr`.** This reverses a deliberate back-compat allowance, because it is the one path that yields *wrong* annotations instead of none: without the flag an inactive row is indistinguishable from an active one, so it consumes a property slot and shifts every later column. Captions do not save it — verified on production `PM-Projects`, which has 25 captioned columns and still moved `EndDate` from line 47 onto line 45, both neighbours being uncaptioned and so unconstrained. Two curated GIs (`InventoryAttachmentsMCP`, `IN-HWPItems`) are fully uncaptioned *and* carry inactive rows, so nothing at all would have caught the shift. Operators on a pre-0.48.0 `MCPGIFields` keep field names and declared types until they re-import — the documented degradation, now guaranteed by construction rather than by luck.
- **A caption ending in `_N` is matched against the literal property name too.** `_2` is normally a collision suffix the platform appends, but it also gets typed into captions by hand (`IN-StockItem` → `ItemStatus_2`); comparing only against the collision-stripped name made such a row unsatisfiable and rejected the whole GI's annotation.
- **Feed paging is now ordered** (`$orderby=Name` / `Name,LineNbr`). `$skip` is only sound over a stable sort, and GI results are otherwise unordered, so a page boundary could silently repeat or omit rows — an omitted row costs a GI its column text with no error. Verified supported on the 25R2 GI OData endpoint; a two-page pull of 2 000 rows returned zero duplicates and zero overlap.

## [0.47.0] - 2026-07-31
### Removed
- **The DAC-based OData probe.** Evaluated against this deployment and declined, so the code came out rather than sitting as dead surface every operator sees. Deleted `checkDacODataEndpoint` (an informational row on every preflight run), `probeDacAuthenticated`, `interpretDacProbe`, `parseODataServiceDocument`, `pickProbeEntitySets`, the entity-set sample UI, and the 12 DAC-specific tests. Net −250 lines.
- Rationale, recorded in `docs/odata-filtering.md` and CLAUDE.md so the evaluation is not repeated: the endpoint **works** (service root + `SOOrder` read → 200 with an ordinary user's token; per-DAC rights enforced — `Users`, `UsersInRoles`, `CustomerPaymentMethodDetail` → 403), and entity sets are addressed by **bare class name** (4766 sets, up to three aliases each). But no speed case at our scale (production medians within 5%: 891 ms contract-REST vs 941 ms GI-OData; the 2–10x claim concerns bulk reads, while these tools default to 100 rows, cap at 1000, and refuse pagination), no rate-limit case (**zero** Acumatica 429s in 95 days — the only binding limiter is our own), and the tempting win didn't materialize (`UsersInRoles` → 403, so the login gate still needs the canary GI). Redaction turned out *not* to be a blocker: physical DAC field names match contract-entity names for PII, so existing patterns fire unchanged. **A bulk workload would flip this decision.**

### Changed
- **The authenticated-checks form is kept and is now named for what it does.** Its justification no longer rests on the DAC probe but on tenant + contract-endpoint-version verification — the only thing that can catch a typo'd `ACUMATICA_TENANT` or `ACUMATICA_ENDPOINT_VERSION`, since Acumatica 401s every unauthenticated path. Route renamed `/docs/admin/preflight/dac-probe` → `/docs/admin/preflight/authed-checks`; `DacProbeResult` → `AuthedVerdict`; page copy no longer mentions DAC.
- `test/preflight-dac.test.ts` → `test/preflight-authed.test.ts`, retaining the 6 tenant/endpoint verdict tests.

### Notes
- Untouched by this cleanup: the 0.45.0 false-pass fix, the 0.46.0 OData v3/v4 dialect split, and the v4 filter-error corrections. The v3/v4 comparison table and the "Generic Inquiries use OData v4" section in `docs/odata-filtering.md` remain in full — that dialect distinction is live behavior, not part of the declined evaluation.

## [0.46.0] - 2026-07-31
### Fixed
- **The Generic Inquiry tool was documented with the wrong OData dialect — the single largest source of tool errors.** `acumatica_run_inquiry` queries `/api/odata/gi`, which is **OData v4**, while `acumatica_list_entities` queries the contract API, which is **v3**. Both tools carried *byte-identical v3 filter guidance*, so every partial-match GI query was told to use `substringof()` — which does not exist in v4 — and explicitly forbidden from using `contains()`, the function it should have used. Verified live against a 25R2 instance: `substringof('BAD', Description)` fails with *"An unknown function with name 'substringof' was found"*, `contains(Description,'BAD')` works, `startswith`/`endswith` work in both dialects, `tolower()`/`toupper()` work on v4 despite 500ing on contract REST, and `CreatedOn gt datetimeoffset'2024-01-01'` is rejected where bare `2024-01-01T00:00:00Z` succeeds. July 2026 logs attribute **97 of 242 tool errors (~41%)** to this class: 44 unknown-function, 43 unknown-property, 10 operator type-mismatch.
- `acumatica_run_inquiry`'s `filterExpression` description now documents v4 and warns explicitly not to carry syntax over from `acumatica_list_entities`. `acumatica_list_entities` keeps its v3 guidance unchanged.
- `docs/odata-filtering.md` no longer presents one dialect as covering both tools. It opens with a verified side-by-side comparison table and gains a **"Generic Inquiries use OData v4"** section.

### Added
- **Self-correcting filter errors for Generic Inquiries.** `src/lib/odata-v4-errors.ts` (import-free leaf) classifies the four v4 parser errors, and `handleRunInquiry` now returns a correction instead of the bare Acumatica message: `{ error: "invalid_filter", problem, useInstead, supportedFunctions | availableFields, actionRequired }`. A `substringof` rejection names `contains()` *and* its reversed argument order; a bad property name returns the **actual** column names, taken from the GI registry's `$metadata`-resolved fields (no extra round-trip); a bad date literal gives the bare ISO-8601 form. Every correction states the query **never executed**, so a rejected filter can never be reported to the user as "no records matched".
- `test/odata-v4-errors.test.ts` — 14 tests built from the real production error strings, including that the supported-function list never advertises `substringof`, and that every correction carries both the dialect warning and the "never executed" clause.

### Notes
- `normalizeODataFilter()` is a v3-motivated workaround that still runs on the GI path. It is harmless under v4 (a bare boolean function is equally valid there) and was deliberately left in place rather than silently changing behavior for filters already in use; the misleading "identical to list_entities" comment was corrected.

## [0.45.0] - 2026-07-31
### Fixed
- **Preflight no longer reports a wrong tenant or endpoint version as `pass`.** `checkTenantPath` and `checkEndpointVersion` treated a 401 as "the path exists" and reserved `fail` for a 404 — but Acumatica SaaS authenticates *before* routing, so an unauthenticated request returns **401 for every path**, including ones that do not exist. Verified live on 25R2: `/t/NotARealTenant/api/odata/gi/` → 401 and `/entity/Default/99.999.999` → 401, both previously reported as passing. A typo'd `ACUMATICA_TENANT` or `ACUMATICA_ENDPOINT_VERSION` therefore sailed through the diagnostic that exists to catch exactly that. Both rows now return **`warn`** on a 401, stating plainly that the value cannot be confirmed without a token, and reserve `pass` for a genuine 200.
- **`docs/upgrading-acumatica.md` §5 corrected.** It claimed preflight "catches a wrong `ACUMATICA_ENDPOINT_VERSION` from step 2", which was false for the same reason. The step now explains why the unauthenticated checks cannot confirm the tenant or version, and directs operators to the authenticated form — which is no longer optional after a version change.

### Added
- **Tenant and contract-endpoint verification moved into the authenticated checks.** The admin console's form (renamed from "DAC-based OData probe" to **Authenticated checks**) now runs three checks with a borrowed user token, where a 404 finally means what it should: **tenant**, **contract API endpoint version**, and the existing DAC capability probe. `interpretTenantAuthed()` and `interpretEndpointAuthed()` are pure and unit-tested — `pass` only on 200, `fail` on 404 (with the specific env var and SM207060 named), 403 distinguished from 401 so "the tenant is real but this user lacks rights" is never confused with "expired token, re-run".
- 6 tests covering the new verdicts, including that neither check can ever turn a 404 into a `pass`.

### Changed
- The admin probe route now returns an array of results and logs `admin_action` as `authenticated_checks` with a per-check outcome summary.

## [0.44.0] - 2026-07-31
### Fixed
- **`Unexpected end of JSON input` no longer reaches the model.** `await response.json()` on an empty Acumatica response body threw the raw V8 parser message, which was surfaced as the entire explanation — no indication of what happened or what to do. Log analysis over 95 days (4734 R2 objects, 13 292 tool invocations) counted **279 occurrences**, roughly **14% of all current tool errors**, almost entirely from `acumatica_run_inquiry` (259) with the remainder from `acumatica_describe_inquiry` (20). All three 2xx-body parse sites in `acumatica-client.ts` now go through `parseAcumaticaJson()`.
- **An empty body is never reported as "no matching records."** Standard OData returns `{"value": []}` for an empty result set, so a body-less 200 is anomalous. Translating it into zero rows would be the same silent-wrong-data failure the `possibleFalseNegative` warnings exist to prevent, so the error states explicitly that this is *not* the same as nothing matching and that the user must not be told no records exist.
- **An empty body on a write now forbids retrying.** A successful write normally echoes the saved record, so an empty body means the outcome is genuinely unknown. Retrying could duplicate an auto-numbered record, since PUT-as-upsert is only idempotent when the key is supplied. The `put()` path passes `kind: "write"` and the message says do not retry and to verify the record directly in Acumatica — the opposite of the read path's "retry once".
- **Non-JSON bodies are now diagnosable.** Instead of a parser message, the error names the likely cause (an HTML error or sign-in page returned instead of data) and includes a whitespace-collapsed 200-character snippet.

### Added
- `src/lib/response-parse.ts` — `parseAcumaticaJson()`, an import-free leaf so it is loadable under `node --test` strip-only mode.
- `test/response-parse.test.ts` — 13 tests, including that a legitimate `{"value":[]}` still parses (not conflated with an empty body), that the write path never inherits the read path's retry advice, that `kind` defaults to `read` so an un-annotated call can't get write advice, and that the raw `Unexpected end of JSON input` string never appears in any message.

### Notes
- The same log analysis found **1120 token-refresh errors before 2026-06-08 and zero after** — the `TokenManager` Durable Object (0.33.0, deployed 06-07) eliminated that failure class completely, confirmed across 7+ weeks of production traffic.
- It also showed the largest current error category is the model emitting invalid OData: unknown functions (44), unknown property names (43), and operator type mismatches (10) — 97 of 242 July errors. That is a schema-discovery problem, not an API defect, and is not addressed here.
- `acumatica_http_call` entries (which carry per-HTTP-call `durationMs`) are **not** persisted to R2: `logHttpCall()` only calls `console.log`, and Logpush does not capture Durable Object traces. Only `tool_invocation` durations are queryable from the log store. Documented here because the admin log viewer offers an `acumatica_http_call` filter that will always return nothing.

## [0.43.0] - 2026-07-31
### Added
- **Authenticated DAC-OData probe in the admin console.** The 0.42.0 preflight row could only tell you the question was unanswerable, since Acumatica 401s every unauthenticated path and preflight has no token of its own. `/docs/admin/preflight` now has a **"DAC-based OData probe (authenticated)"** form: enter a connected user's Acumatica username and it borrows their stored token via the same `TokenManager` DO the MCP tools use, then reports a real verdict — is the endpoint present, and does an ordinary user's role suffice? Removes the need to extract a bearer token by hand.
- **`admin_action` audit log type** (`logAdminAction()`). The probe reaches Acumatica **as the named user** and therefore appears in Acumatica's own audit trail under their name, so every run is recorded on our side with the target username and outcome. The admin handler runs on the Worker request path, where `console.log` is captured by Logpush, so no explicit R2 write is needed.
- **`test/preflight-dac.test.ts`** — 9 tests pinning `interpretDacProbe`, including the distinction that motivated the two-request design and a guard that root 200 + entity 200 is the *only* combination yielding a pass.

### Changed
- The probe issues **two** requests — service root, then `PX.Objects.SO.SOOrder` — because one entity GET cannot distinguish "the DAC endpoint doesn't exist" from "the entity name was guessed wrong": both return 404. The root settles existence and reachability; the entity read settles whether data actually comes back. Neither response body is read (`body.cancel()`), since the DAC service document enumerates every data access class on the instance and can be megabytes. Only status codes cross the boundary — no Acumatica record data is returned or stored.
- Verdict logic lives in a pure, unit-tested `interpretDacProbe()` rather than inline in the route, matching the existing `interpretTokenError()` split. A `pass` verdict explicitly carries the redaction caveat: `redact.ts` matches on field *names*, so DAC physical names must be re-validated before any DAC read path ships or sensitive fields silently stop being redacted.
- The unauthenticated preflight row now defers to the form instead of printing a `curl` for the operator to run.

### Security
- The probe route is POST + CSRF-protected (not a GET that could be triggered by a link), requires an admin session like every other admin route, validates and length-caps the username, and maps `TokenResult` failures to actionable text without echoing the provider's internal message.

## [0.42.0] - 2026-07-30
### Added
- **Preflight row for the DAC-based OData endpoint.** Acumatica **2025 R1+** exposes data access classes directly over OData 4.0 at `/t/{tenant}/api/odata/dac` — entities named by class (`PX.Objects.SO.SOOrder`), navigation properties (`SOLineCollection`, `BAccountByCustomerID`), no Generic Inquiry required. This server does not use it (reads are contract REST; GI OData serves search and the login gate), but it is the strongest candidate fix for the contract-API `$filter` failure family, so `/docs/admin/preflight` now surfaces it. Per Acumatica's docs it honors each user's existing rights ("users have access to the same data that is visible to them in the UI based on their access rights"), so it does not bypass row- or field-level security.
- **`docs/odata-filtering.md` now states which of its gotchas are not OData's fault.** No `$skip`, no child-collection filtering, and the silent-`[]` / `CannotOptimizeException` family are artifacts of the *contract-based REST API's filter binder*, not of OData. The doc names the two things that must be resolved before the DAC endpoint could replace the search path: whether a normal user role suffices, and re-validating `redact.ts` field-name patterns against physical DAC field names.

### Fixed
- Nothing user-visible; see the note below for a pre-existing defect this work uncovered.

### Notes
- **Acumatica SaaS authenticates before routing, so no anonymous probe can confirm a path exists.** Verified live on 25R2: `/api/odata/dac/`, `/api/odata/gi/`, `/api/odata/nonsense/`, `/t/NotARealTenant/api/odata/gi/`, and `/entity/Default/99.999.999` **all return 401**. The DAC row was therefore built as a no-request `skip` carrying the authenticated `curl` an operator needs, rather than inferring availability from a 401 — which would have manufactured a green row out of noise.
- ⚠️ **Pre-existing defect, not yet fixed:** the same behavior means `checkTenantPath` and `checkEndpointVersion` — which assume "404 = wrong tenant / wrong version" — cannot detect a wrong value. A typo'd `ACUMATICA_TENANT` or `ACUMATICA_ENDPOINT_VERSION` returns 401 and is reported as **pass**, and `docs/upgrading-acumatica.md`'s claim that preflight "flags a wrong value" for the endpoint version does not hold. Real verification comes from a successful login or tool call. Left unfixed here because the honest correction downgrades two long-green rows for every operator, which deserves a deliberate decision rather than being folded into an unrelated change.

## [0.41.0] - 2026-07-30
### Added
- **Rate limits are now runtime-configurable from the admin console.** The per-user concurrency cap and per-minute cap were hardcoded module constants requiring a code edit and redeploy to change. Both are now `CONFIG_KEYS` entries at `/docs/admin/settings` — "Max Concurrent Requests Per User" (`config:rate_limit_max_concurrent`, env `ACUMATICA_MAX_CONCURRENT`, default 3) and "Max Requests Per Minute Per User" (`config:rate_limit_max_per_minute`, env `ACUMATICA_MAX_PER_MINUTE`, default 40). Validated at write time (positive integer, ≤ 20 and ≤ 1000 respectively); a zero or non-numeric value falls back to the built-in default rather than locking every user out. Resolved once per session in the DO's `init()` via `resolveRateLimits()` and stashed on `AppEnv.rateLimits`, so the hot path takes no extra KV read — changes apply when the next DO instance starts, the same as every other runtime setting.
- **Bounded wait for a concurrency slot instead of instant rejection.** New "Concurrency Queue Wait (ms)" setting (`config:rate_limit_queue_wait_ms`, env `ACUMATICA_RATE_LIMIT_QUEUE_WAIT_MS`, default 2000, max 10 000). A model firing several tool calls at once is the normal case, not abuse, and a typical Acumatica round-trip finishes well under a second — so a request that finds every slot busy now polls for up to this long before being rejected, turning the most common false-positive rejection into a brief delay. Set to `0` to restore the previous reject-immediately behavior.
- **`rate_limit_hit` audit log event.** Rate-limit rejections were previously indistinguishable from genuine Acumatica failures in the `tool_error` stream, leaving no data to tune the caps against. Each rejection now emits its own entry (tool, username, which cap, its configured value, `retryAfterSeconds`, and `waitedMs` for concurrency), persisted to R2 and filterable in the admin log viewer. `write_mutation` was also added to that filter's type list, where it had been missing.
- **`allowImportingTsExtensions`** in `tsconfig.json`, so a module under unit test can import a sibling with an explicit `.ts` specifier. `npm test` runs TypeScript in strip-only mode, which cannot resolve the extensionless specifiers used across `src/` — previously only dependency-free leaf modules were testable.
- **`test/rate-limiter.test.ts`** — 17 tests covering config precedence (KV → env → built-in), the zero/garbage-cap fallback, the bounded slot wait (admits on free, still rejects on timeout), slot release on a thrown call, per-user scoping, per-minute bucket enforcement and its retry-after bound, fail-open on a KV read error, the token-accounting order, and the envelope contents.

### Changed
- **A rate-limit rejection now returns a structured envelope instead of a bare error string.** `Error: Concurrent request limit reached (3). Please retry shortly.` invited the model to retry instantly, reword the request, or substitute a different tool — the last two waste the remaining budget, and a throttle was easy to misreport to the user as an Acumatica outage. The response is now `{ error: "rate_limited", limit, limitValue, retryAfterSeconds, cause, actionRequired }` (the same pattern as the pagination-refusal envelope): `cause` states that Acumatica was never contacted and nothing is wrong with the request, and `actionRequired` says to wait the stated interval and retry the *same* request without rewording, substituting, or looping. `retryAfterSeconds` is exact for the per-minute cap — bucket keys are per calendar minute, so it is the time to the next boundary and never exceeds 60 s.
- **A concurrency rejection no longer spends a per-minute token.** The slot is acquired before the minute bucket is read, so a burst turned away on concurrency doesn't also eat the user's minute budget. (A call that reaches Acumatica and then fails still spends its token — throttling retry storms is the point of the cap.)
- **Settings page shows built-in defaults as input placeholders.** A setting with no KV override and no env var rendered as an empty box, which reads as "unset/zero" rather than "the built-in applies." `ConfigKeyDef` gained an optional `defaultValue` used as the placeholder; populated for the three rate-limit settings plus Max Records and Enable Write Tools.
- `RateLimitError` declares its fields explicitly rather than via constructor parameter properties, which strip-only mode rejects. `src/lib/rate-limiter.ts` is kept free of runtime imports for the same reason — `resolveRateLimits()` therefore lives in `src/lib/config.ts` alongside the other config helpers.

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
