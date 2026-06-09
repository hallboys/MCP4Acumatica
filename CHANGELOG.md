# Changelog

All notable changes to MCP4Acumatica are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project follows
semantic-ish versioning. Release tags use the form `25R2-<version>` (the `25R2`
prefix tracks the targeted Acumatica release, 2025 R2).

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
