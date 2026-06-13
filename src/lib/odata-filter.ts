// Copyright 2026 Hall Boys, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Acumatica's contract-REST `$filter` parser silently returns an EMPTY result
 * set (HTTP 200, no error) when a boolean string function is compared to a
 * literal — `substringof('LENNAR', CustomerName) eq true`. The *bare* function
 * form, `substringof('LENNAR', CustomerName)`, works correctly and returns the
 * matching rows. (Verified live against StockItem/Vendor master entities: the
 * `eq true` form → `[]`; the bare form → the expected rows.)
 *
 * Models habitually append `eq true` because `substringof` returns an
 * Edm.Boolean and `f(...) eq true` is textbook-correct OData v3 — so the tool
 * descriptions alone aren't enough to prevent it. We normalize the expression
 * server-side: strip the `eq true` comparison off the three boolean string
 * functions.
 *
 * We do NOT touch `eq false`. Acumatica's contract-REST grammar rejects the
 * only equivalent negation (`not substringof(...)`) with a 500 — verified live
 * — so rewriting it would replace a silent empty result with a hard error.
 * `substringof(...) eq false` is a rare, awkward predicate ("rows NOT
 * containing X") that the contract API has no reliable way to express, so we
 * leave it verbatim rather than pretend to support it.
 *
 * The rewrite is deliberately narrow — it only fires when `eq true` immediately
 * follows the closing paren of `substringof` / `startswith` / `endswith`. A
 * plain boolean *field* comparison like `IsActive eq true` has no such
 * preceding function call and is left untouched.
 *
 * Lives in its own dependency-free module so the regression test can import it
 * under Node's TypeScript type-stripping without pulling in the
 * Cloudflare/agents import graph.
 */

// `[^()]*` for the argument list deliberately refuses nested parentheses. The
// only nesting would come from toupper()/tolower(), which Acumatica rejects
// outright (500) — so a non-match there leaves an already-doomed filter alone
// rather than silently mangling it.
const BOOL_FUNC_EQ_TRUE = /\b(substringof|startswith|endswith)\(([^()]*)\)\s+eq\s+true\b/gi;

export function normalizeODataFilter(filter: string | undefined): string | undefined {
  if (!filter) return filter;
  return filter.replace(BOOL_FUNC_EQ_TRUE, "$1($2)");
}
