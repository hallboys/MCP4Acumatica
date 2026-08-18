// Copyright 2026 Hall Boys, Inc.
// SPDX-License-Identifier: Apache-2.0

// Bulk-clear target matching for acumatica_clear_cache. Import-free leaf so it
// stays unit-testable under the strip-only test runner (clear-cache.ts itself
// imports gi-registry-build and can't be loaded there).

/** Recognized top-level targets for bulk clearing. */
export const BULK_TARGETS: ReadonlySet<string> = new Set(["schemas", "gi"]);

/**
 * Whether a cache key (with the "cache:" prefix already stripped) falls under
 * the given bulk-clear target. No target means "clear everything".
 *
 * The `gi` target must cover the per-GI inferred sample caches
 * (`gi_schema:{InquiryName}`, written by acumatica_describe_inquiry) as well as
 * the shared GI artifacts — otherwise a design change clears the curated field
 * list but keeps serving a stale sampleRow with removed columns, an internally
 * inconsistent describe_inquiry response (observed live 2026-08-18).
 */
export function matchesClearTarget(shortKey: string, target?: string): boolean {
  if (!target) return true;
  if (target === "schemas") return shortKey.startsWith("schema:");
  if (target === "gi") {
    return (
      shortKey === "gi_list" ||
      shortKey === "gi_metadata" ||
      shortKey === "gi_registry" ||
      shortKey.startsWith("gi_schema:")
    );
  }
  return false;
}
