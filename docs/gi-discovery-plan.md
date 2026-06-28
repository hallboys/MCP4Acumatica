# Plan: GI-Driven Dynamic Tool Discovery

Status: **Phases 1–2 shipped in 0.37.0** (fail-closed gate + lazy registry + curated enrichment); Phases 3–4 (usage-driven per-GI tool promotion, admin-console governance) deferred. Source spec: `mcp-gi-discovery-spec.md` (operator-supplied).
This plan reconciles that spec against the actual codebase and records the decisions taken.

> Scope: this touches **only** the Generic-Inquiry tool path. The REST/entity getter tools
> (`acumatica_get_*`, `acumatica_list_entities`, etc.) are unaffected.

## 1. How the repo actually works today (corrects the spec's "current state")

The spec assumes each GI is already registered as its own dynamic MCP tool with a per-GI
inferred schema, ungated. **That is not this codebase.** There are three generic GI tools:

- `acumatica_run_inquiry` — one tool; executes *any* GI by name via OData (`handleRunInquiry`, `src/tools/generic-inquiries.ts`).
- `acumatica_list_generic_inquiries` — discovery list (`src/tools/generic-inquiry-discovery.ts`).
- `acumatica_describe_inquiry` — top-1 sample-row schema **inference** for one GI (same file).

Already in place that the spec asks for:
- Parameterized GIs are excluded by scanning `$metadata` for `FunctionImport Name="..._WithParameters"` — **not** the spec's `GIFilter` anti-join. Keep the existing mechanism; drop the anti-join.
- `$metadata` is already fetched over the per-user auth path: `AcumaticaClient.getODataMetadata()` (`src/lib/acumatica-client.ts`). Spec open-Q #2 is answered — no new client work for metadata.
- Conditional-registration precedent: schema-knowledge tools register only `if (await indexExists(...))` (`src/index.ts`), reading a blob from the `INDEX_STORE` R2 bucket. The GI registry reuses this exact shape.

## 2. Decisions (operator, 2026-06-20)

| Question | Decision |
|---|---|
| Tool model | **Hybrid + usage-driven promotion.** Enrich the generic path (gate + curated descriptions/types, inference fallback). On a schedule, promote a small frequently-used subset (top-N by usage) to full per-GI tools. |
| Gate scope | **Enforce everywhere.** `run_inquiry` and `describe_inquiry` reject GIs not in the registry — not just discovery. |
| Cutover | **Fail closed for discovery** (refined from the original hard "deny all"). Registry absent ⇒ `list` enumerates **nothing**; an explicitly-named GI may still be run (no hard dead period for explicit use, but the model is never handed an uncurated menu). Rationale: GI authors must opt in via `ExposedtoMCP` knowing an agent may invoke; stops the model flailing across irrelevant GIs. |

Fail-closed flap risk is designed out: the registry is a **static blob** built by the scheduled
job and served from per-isolate cache, so "unreadable" effectively only means "never built"
(true bootstrap), where deny-all is the intended behavior.

## 3. Architecture

**Lazy TTL pull — no background identity, no service account, no Cron** (chosen over the
service-account/Cron design; faithful to spec §5.6's pull model). The registry is built
on-demand with the *requesting user's* token during a normal MCP request when the cache is
stale, then cached in KV for everyone. The gate list + field schemas are global data
(identical for every user), so building from whoever's token is in hand is safe; execution
still uses each user's own token with their row-level access, and the registry holds only
GI/field metadata — never business rows.

```
MCP request (any user)
  getGiRegistry(env, user)  ── KV cache fresh? ──► serve cached
        │ stale/absent
        ▼  build with the caller's token:
     MCPGIs       (gate list + AIDescription + designID + entryScreen)
     MCPGIFields  (per-column Caption/AIDescription, LineNbr)
     /api/odata/gi/$metadata  (authoritative property names + types)
   ⇒ assembleRegistry() ⇒ write KV cache:gi_registry (durable last-good)

run_inquiry / describe_inquiry / list → checkGiGate(registry, name)
  registry null  → gate INACTIVE: list enumerates nothing; run/describe allow an explicit name
  registry present → fail-closed: name ∈ registry, else reject
```

**The only Acumatica-side requirement** (replaces the service-account requirement): grant the
`MCP Access` role **read access to the two feed GIs** `MCPGIs` + `MCPGIFields` so any connected
user's token can build the registry. No new account, no license, no token seeding.

- **Enrichment-only:** for Path A types/names, a gated GI must appear in the building user's
  `$metadata`; regular users already have access to the GIs they use, and any GI not resolved
  degrades gracefully to runtime inference (never denied).
- **Failure handling:** a failed rebuild serves the cached last-good (gate stays enforced);
  only a true never-built state yields inactive.

**Promotion without a Cron:** the usage-ranked `gi_promoted` list is recomputed opportunistically
during the lazy build (read recent R2 do-logs), and `init()` reads `gi_promoted` to register the
per-GI tools. Hysteresis spans rebuilds.

## 4. Phases

### Phase 0 — Verify (mostly done)
- [x] Type inference is unreliable — reproduced: whole-number decimal/qty columns infer as `integer`; null samples infer `unknown`.
- [x] Serialization fidelity — wire returns native JSON numbers/booleans + ISO-8601 dates (not string-flattened) ⇒ **Path A (`$metadata` declared types) is viable.**
- [x] Space-padded fixed-width keys returned untrimmed today (`"GARES     "`).
- [x] Collision suffixes confirmed (`InventoryUsageMCP` → `InventoryID_2`, `Warehouse_2`).
- [x] Feed GIs `MCPGIs`/`MCPGIFields` + canary `MCPAccess` currently OData-exposed; fail-closed hides them automatically (untagged).
- [x] `client_credentials` is **disabled** on the Connected App (`unauthorized_client`). Resolved by the lazy-pull pivot — no app/service token needed; build uses the requesting user's token.
- [ ] Confirm `$metadata` distinguishes `Edm.Decimal` from `Edm.Int32` for a whole-number column — **deferred, non-blocking.** Inspected when the lazy build first fetches `$metadata`. Path A viability already established by serialization evidence; `parseEdmxTypes` degrades to inference if the EDMX shape differs.

### Phase 1 — Registry + fail-closed gate ✅ DONE
- [x] `src/lib/gi-registry.ts` — pure leaf: types, `EXCLUDED_GI_NAMES`, `checkGiGate`, and the EDMX/assembly helpers (`parseEdmxTypes`, `edmTypeToSimple`, `assembleRegistry`, name matcher).
- [x] `src/lib/gi-registry-build.ts` — lazy `getGiRegistry(env, user)`: KV cache (`cache:gi_registry`, durable last-good + `builtAt` freshness), build from `MCPGIs`/`MCPGIFields` + `$metadata`, per-isolate memo, fail-closed degradation.
- [x] Gate enforced in `run_inquiry` + `describe_inquiry`; `list` shows only gated GIs (+ descriptions); feeds/canary always hidden.
- [x] Kept the `_WithParameters` `$metadata` exclusion (dropped the spec's `GIFilter` anti-join).
- [x] Unit tests: gate (inactive/active/empty/collision-name/feed) + assembly (collision order, Usr-strip, Path-A decimal, fallback) + parameterized-GI detection. 36/36 pass.
- Operator-side (not code): grant `MCP Access` role read access to `MCPGIs`/`MCPGIFields`; tag in-use GIs `ExposedtoMCP` before relying on the gate. `ExposedtoMCP` is authoritative; the `*MCP` naming is convention only.

### Phase 2 — Enrichment overlay ✅ DONE
- [x] Matcher in `assembleRegistry`: caption-strip → `Usr`-strip → field name; `_N` collisions by `LineNbr`; `$metadata` wins.
- [x] Types from Path A; **mandatory inference fallback** per field; exposure never gated on description presence.
- [x] `describe_inquiry` overlays curated names/types/descriptions onto inference (curated needs no live sample); `list` surfaces GI-level descriptions.
- [x] Space-padded trim (`cleanGiRow`/`cleanGiRows`) in the generic path.
- [x] No `z.number()` on tool inputs.

### Phase 3 — Usage-driven promotion (pending)
- Recompute `gi_promoted` during the lazy build from R2 `do-logs` (`run_inquiry` counts over a trailing window); **no Cron**.
- Promote top-N (start 5–8) with **hysteresis** (hold rank across two builds) to avoid aggravating the documented Claude.ai tool-list caching issue.
- `init()` reads `gi_promoted` and registers promoted per-GI tools: stable sanitized name + reverse map + collision suffixing; `$filter`/`$top`/`$select` inputs (GIs are parameter-free); call straight into `handleRunInquiry`.
- ⚠️ Most invasive remaining piece — modifies `init()` tool registration (the live tool list for all users).

### Phase 4 — Governance + docs (docs ✅ / governance pending)
- [ ] Admin console: surface registry (gated GIs, promotion list, last build time); restrict feed-field edits + log (HBH-IT-POL-001).
- [x] Updated CLAUDE.md, tool-reference, README prerequisites (the `MCP Access`→feed-GI read grant) and added a dedicated operator/user doc **`docs/generic-inquiries.md`** (served at `/docs/generic-inquiries`) that leads with the context-overload rationale — why most screen-built GIs don't belong in front of an agent — and the GI selection guidance.
- [x] **Added the registry to `docs/upgrading-acumatica.md`** as a version-coupled, instance-derived artifact (standing maintenance rule in CLAUDE.md).

## 5. Acceptance criteria (from spec §7)
- Tagging a GI registers a tool after refresh; untagging removes it.
- A tagged GI that is parameterized / not OData-exposed is rejected and logged.
- Field descriptions attach to correct properties incl. the collision case (`InventoryUsageMCP`).
- Captionless custom field resolves (`UsrAIDescription` → `AIDescription`).
- A gated-in GI with no `AIDescription` is still exposed via inferred schema.
- Money/quantity fields declared decimal/number, not integer.
- Space-padded key values trimmed in output.
- `MCPGIs`/`MCPGIFields` never exposed as tools (satisfied for free by fail-closed gate).
