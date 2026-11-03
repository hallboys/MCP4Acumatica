# Plan: Parameterized Generic Inquiries

Status: **Shipped in 0.56.0** (behind `ACUMATICA_GI_PARAMETERS`, off by default; verified on 2026 R2 and on 2025 R2 production). Registry stores labels/defaults on `GiRegistryEntry.parameters`; the FunctionImport name is read from live `$metadata` on each call rather than stored. Replaces the blanket refusal of parameterized GIs with
"accept parameters, enforce the required ones". Touches only the GI tool path
(`acumatica_run_inquiry`, `acumatica_describe_inquiry`, `acumatica_list_generic_inquiries`) and
the GI registry; the entity tools are unaffected.

## 1. Why the refusal exists, and why it can go

Today a GI with parameters is kept out of discovery and refused by `run_inquiry` /
`describe_inquiry` (`parameterizedGiNames`, `src/lib/gi-registry.ts`). The reason is data
correctness: queried through its plain entity set, a parameterized GI runs with no parameter
values and returns plausible but unfiltered rows, with no error.

Acumatica documents a way to pass the values (*Reporting Tools* → "Retrieving the Results of a
Generic Inquiry with Parameters", present in the 2025 R2 docs):

```
/t/{tenant}/api/odata/gi/{FunctionImportName}(Param1='value',Param2=@p2)?@p2='value'
```

The `FunctionImport` element in `$metadata` names the function (`{GI name with punctuation
removed}_WithParameters`) and points at a `Function` element that lists each parameter with its
Edm type. Once the model can see and supply parameters, the refusal is no longer needed — the
remaining risk is the model *leaving out* or *misspelling* a parameter, which the server can
check before calling Acumatica.

Acumatica's own MCP server (2026 R2) exposes parameters as tool inputs but does not mark them
required, and runs the inquiry with blank values when they are omitted. This design is
stricter on purpose.

## 2. Verified behaviour (live probe, 2026 R2 sandbox, 2026-11-03)

| Question | Result |
|---|---|
| `$filter`, `$select`, `$top`, `$count` on the function URL | All work, alone and combined with parameter values. |
| Empty parentheses `Name_WithParameters()` | Runs with no values supplied; optional parameters take their defaults (see below). On a GI with no defaults it returned the same total as Acumatica's own MCP server run without parameters. |
| Which parameters are required | `$metadata` marks a parameter `Nullable="false"` exactly when **Is Required** is checked on the GI's Parameters tab (SM208000). Checked both ways. |
| Required parameter omitted | HTTP 404 ("Record not found") — loud, not silent. Passing `''` is accepted and returns no rows. |
| Optional parameter omitted | Takes the GI's **Default Value** (e.g. `@QuarterStart`). Confirmed: with the dates omitted the GI returned the current quarter's rows; an explicit, wider range returned about ten times as many, so omitted ≠ unbounded. |
| **Misspelled parameter name** | **Silently ignored** — the inquiry runs as if the parameter were absent and returns unfiltered rows. The server must validate names. |
| Literal formats | Strings single-quoted. `Edm.Date` bare (`2026-10-01`) or quoted. `Edm.Boolean` bare `true`/`false`. `Edm.DateTimeOffset` **cannot go in the path** — the `:` is rejected by ASP.NET request validation ("potentially dangerous Request.Path value") — so it must be passed as an alias (`(FromDate=@p1)?@p1=2026-10-01T00:00:00Z`), which works. |
| Lookup parameters | A parameter whose schema field is a surrogate-keyed inventory ID accepted the human-readable item code. |

Not yet verified: see §7.

## 3. Design

### 3.1 Parameter metadata

Two sources, merged in the registry build:

1. **`$metadata`** (already fetched and cached as `gi_metadata`) — authoritative for parameter
   **names, Edm types and required-ness**, and for the FunctionImport name. A new pure parser
   `parseEdmxFunctions(xml)` returns
   `Map<normalizedGiName, { functionImport: string; params: { name, edmType, required }[] }>`,
   keyed the same way `parseEdmxTypes` keys entity types (the `Function Name` is the GI name;
   XML entities such as `&amp;` must be decoded).
2. **New feed GI `MCPGIParams`** (`acumatica/MCPGIParams.xml`) — one row per `GIFilter` row of an
   exposed GI: `Name` (GI), `ParamName` (`GIFilter.Name`), `DisplayName`, `IsRequired`,
   `DefaultValue`, `IsActive`, `SchemaField`. Supplies what `$metadata` lacks: the human label and
   the **default value**, so the model can tell the user "this used the current quarter". Joined
   to the `$metadata` parameters by `normalizeName`; unmatched rows are dropped, and `$metadata`
   wins on required-ness if the two disagree.

The feed is optional: without it (older setup package, or gate inactive) the server still has
names, types and required-ness from `$metadata` and only loses labels and defaults.

`GiRegistryEntry` gains:

```ts
parameters?: GiParamMeta[];   // absent → not parameterized
functionImport?: string;      // e.g. "DBStorageDetails_WithParameters"

interface GiParamMeta {
  name: string;               // $metadata parameter name — what goes in the URL
  type: string;               // edmTypeToSimple(edmType)
  edmType: string;            // kept for literal formatting
  required: boolean;          // Nullable="false"
  displayName?: string;       // feed
  defaultValue?: string;      // feed, raw (e.g. "@QuarterStart")
}
```

### 3.2 Feeds and the gate

- **`MCPGIs`** drops its parameter-free clause (`GIFilter.LineNbr IS NULL`). Exposure stays
  opt-in through `ExposedToMCP`; the operator now vets a parameterized GI's parameters when
  tagging it.
- **Rollout safety:** an instance that does not re-import `MCPGIs` keeps parameterized GIs out
  of the registry, so with the gate active nothing changes until the operator acts. One thing to
  call out in the release notes: any parameterized GI *already* tagged `ExposedToMCP` becomes
  exposed on re-import, because the tag previously had no effect on it.
- `EXCLUDED_GI_NAMES` gains `MCPGIParams`.

### 3.3 `acumatica_run_inquiry`

New optional argument `parameters`: a JSON object **as a string** (tool schemas must stay simple
types — see the Zod constraint in CLAUDE.md), e.g. `{"Warehouse":"WHOLESALE"}`.

Checks, all before Acumatica is contacted:

1. **Not parameterized but `parameters` given** → refuse (the values would be dropped).
2. **Parameterized but `parameters` absent** → refuse, returning the parameter list (name, type,
   required, display name, default). This replaces today's refusal and costs one round-trip; it
   guarantees the model has *seen* the parameters before any run. `{}` is a valid explicit answer
   ("run with defaults") when no parameter is required.
3. **Unknown name** → refuse, listing the valid names. Matching is case-insensitive and resolves
   to the canonical `$metadata` spelling. This is the guard against the silent-ignore behaviour.
4. **Required parameter missing or empty** → refuse, naming it.
5. **Value does not fit the type** (`Edm.Date` not `YYYY-MM-DD`, `Edm.DateTimeOffset` not ISO-8601,
   `Edm.Boolean` not true/false, numeric not a number, object/array anywhere) → refuse.

Then build the URL with **every value as an alias** — one code path that is immune to the
path-validation problem and to characters such as `/` and `#` in values:

```
{functionImport}(P1=@p1,P2=@p2)?@p1='O''Brien'&@p2=2026-10-01T00:00:00Z&$filter=…&$top=…
```

Strings are single-quoted with `'` doubled. Omitted optional parameters are left out of the
parentheses (they take the GI default).

Response: the existing result/envelope logic is reused, wrapped with a `parameters` block so the
model can report what actually filtered the data:

```json
{
  "results": [...],
  "parameters": {
    "applied": { "Warehouse": "WHOLESALE" },
    "defaulted": [{ "name": "StartDate", "displayName": "Start Date", "defaultValue": "@QuarterStart" }]
  }
}
```

`$filter` still applies on top; the calculated-column pre-flight and the v4 filter-error
correction work unchanged (they key off `gate.entry.fields`). A 404 from a `_WithParameters`
URL is re-messaged as "a required parameter was missing or a value matched nothing" rather than
"record not found".

Pure helpers go in a new import-free leaf, `src/lib/gi-parameters.ts`
(`validateGiParameters`, `formatODataLiteral`, `buildFunctionPath`), unit-tested like
`odata-v4-errors.ts`.

### 3.4 `acumatica_describe_inquiry`

Returns `parameters` (the `GiParamMeta` list) alongside `fields`. Sampling a row:
- no required parameters → sample through `Name_WithParameters()` (defaults apply) and say so;
- required parameters → skip the sample; field names and types still come from `$metadata`.

The `gi_schema:{name}` sample cache must record that the sample used defaults.

### 3.5 `acumatica_list_generic_inquiries`

Parameterized GIs are listed with a short `parameters` summary (names, required flag). The
"Excluded N parameterized GI(s)" note goes away. With the gate inactive, discovery is still
suppressed as today.

### 3.6 Gate inactive

An explicitly named parameterized GI goes through the same checks using `$metadata` alone (no
labels or defaults). The response's `defaulted` list then says only that omitted optional
parameters use the GI's default, which may filter the results.

## 4. What does not change

- Opt-in exposure via `ExposedToMCP`, fail-closed gate semantics, feed/canary exclusion.
- Column alignment (`resolveFields`): a parameterized GI's `EntityType` is shaped like any
  other's.
- Redaction and audit logging. Parameter values are logged with the other tool arguments, the
  same as `filterExpression`.

## 5. Tool-description changes

`run_inquiry` gains a `parameters` description that states: call `describe_inquiry` first for a
parameterized GI; required parameters must be supplied; names are exact `$metadata` names;
dates are `YYYY-MM-DD`, date-times ISO-8601; omitted optional parameters take the GI's default,
which can silently narrow results, so tell the user which defaults applied.

## 6. Docs, setup package, upgrade guide

- `acumatica/MCPGIParams.xml` + `acumatica/README.md` (column → code mapping, import order).
- `docs/generic-inquiries.md` (operator guidance: vetting parameters, Is Required, defaults),
  `docs/tool-reference.md`, CLAUDE.md "GI Tool Gating & Registry".
- `docs/upgrading-acumatica.md`: `MCPGIParams` is a published meta-GI → re-verify after upgrade
  (standing maintenance instruction).
- Optional later: a `GIFilter.UsrParAIDescription` field in the customization project for
  per-parameter descriptions. 2026 R2 has a built-in parameter description, but it is visible only
  with an AI Studio license, so it cannot be the default source.

## 7. Open questions — verify before or during implementation

1. **2025 R2 production.** All probes ran on 2026 R2. The 2025 R2 docs describe the same URL
   form, but run one parameterized call on production before enabling there.
2. **`GIFilter` fields readable over OData.** `IsRequired`, `DefaultValue` and `DisplayName` must
   be stored fields; `GIResult.fieldName` turned out to be virtual (always NULL). Check when
   building `MCPGIParams`.
3. **Inactive parameters.** Does an inactive `GIFilter` row appear in `$metadata`? The name join
   tolerates either answer, but required-ness should come from an active row only.
4. **Name case-sensitivity** in the function URL. The server resolves to the canonical spelling
   anyway; confirm a wrong-case name is ignored rather than accepted.
5. **Quote escaping** (`'` → `''`) and non-ASCII values through aliases.
6. **Multi-value / list parameters.** Not seen on this instance; decide whether to refuse them.

## 8. Tests

- `parseEdmxFunctions`: Nullable handling, `&amp;` decoding, FunctionImport ↔ Function mapping.
- `validateGiParameters`: unknown name, case-insensitive resolution, missing/empty required,
  type checks per Edm type, "parameterized but no `parameters` argument".
- `buildFunctionPath` / `formatODataLiteral`: alias form, quote doubling, date and boolean
  literals, omitted optionals absent from the parentheses.
- `assembleRegistry`: feed join by normalized name, `$metadata` wins on required-ness, feed-less
  build still yields parameters.
