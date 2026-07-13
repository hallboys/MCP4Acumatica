// Copyright 2026 Hall Boys, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Pure writer-payload validation logic.
 * No imports — kept in a separate module so unit tests can import it without
 * pulling in Cloudflare-specific dependencies.
 */

export type ValidationOk = { ok: true; data: Record<string, unknown> };
export type ValidationErr = { ok: false; error: string };
export type ValidationResult = ValidationOk | ValidationErr;

/**
 * Validate a raw JSON-string payload for a write tool.
 *
 * Checks (in order):
 * 1. Size cap — rejects payloads over maxChars characters.
 * 2. JSON parse — rejects malformed JSON.
 * 3. Type check — rejects non-object values (arrays, primitives, null).
 * 4. Field allowlist — rejects any top-level key not in allowedFields.
 * 5. Nested allowlist — for each top-level key that has a nested allowlist,
 *    the value must be a plain object and every inner key must be allowed.
 *
 * Returns `{ ok: true, data }` on success or `{ ok: false, error }` on the
 * first failure. The caller is responsible for the writes-enabled kill-switch
 * and the dry-run gate (both require async context or runtime state).
 */
export function validateWriterPayload(
  payload: string,
  allowedFields: readonly string[],
  maxChars: number,
  nestedAllowedFields?: Readonly<Record<string, readonly string[]>>
): ValidationResult {
  // 1. Size cap
  if (payload.length > maxChars) {
    return {
      ok: false,
      error: `payload is too long (${payload.length} chars, max ${maxChars}).`,
    };
  }

  // 2. JSON parse
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch {
    return { ok: false, error: "payload must be valid JSON." };
  }

  // 3. Type check
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return {
      ok: false,
      error: "payload must be a JSON object (not an array or primitive).",
    };
  }
  const payloadObj = parsed as Record<string, unknown>;

  // 4. Field allowlist
  const disallowed = Object.keys(payloadObj).filter(
    (k) => !(allowedFields as readonly string[]).includes(k)
  );
  if (disallowed.length > 0) {
    return {
      ok: false,
      error:
        `Payload contains disallowed field(s): ${disallowed.join(", ")}. ` +
        `Allowed fields: ${allowedFields.join(", ")}.`,
    };
  }

  // 5. Nested allowlist — validate inner keys of sub-entity objects.
  if (nestedAllowedFields) {
    for (const [key, innerAllowed] of Object.entries(nestedAllowedFields)) {
      const value = payloadObj[key];
      if (value === undefined) continue; // sub-entity not supplied — nothing to check
      if (value === null || typeof value !== "object" || Array.isArray(value)) {
        return {
          ok: false,
          error: `Field '${key}' must be a JSON object with nested fields (not an array or primitive).`,
        };
      }
      const innerDisallowed = Object.keys(value as Record<string, unknown>).filter(
        (k) => !(innerAllowed as readonly string[]).includes(k)
      );
      if (innerDisallowed.length > 0) {
        return {
          ok: false,
          error:
            `Field '${key}' contains disallowed nested field(s): ${innerDisallowed.join(", ")}. ` +
            `Allowed nested fields for '${key}': ${innerAllowed.join(", ")}.`,
        };
      }
    }
  }

  return { ok: true, data: payloadObj };
}
