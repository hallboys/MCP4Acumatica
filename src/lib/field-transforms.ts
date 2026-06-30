// Copyright 2026 Hall Boys, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Pure field-transformation utilities for Acumatica's {value: X} wire format.
 * No imports — kept in a separate module so unit tests can import it without
 * pulling in Cloudflare-specific dependencies.
 */

/**
 * Wrap plain values into Acumatica's {value: ...} field format.
 * This is the inverse of unwrapFields — use it to build PUT/POST request bodies.
 *
 * Rules:
 *   - Already-wrapped {value: X} objects are left untouched (idempotent).
 *   - Scalar fields become {value: X}, including null.
 *   - Nested sub-entity objects (e.g. MainContact) are recursed into so their
 *     own scalar fields get wrapped.
 *   - Arrays (e.g. detail lines) have each element recursively wrapped.
 */
export function wrapFields(obj: unknown): unknown {
  if (obj === null || obj === undefined) return obj;
  if (Array.isArray(obj)) return obj.map(wrapFields);
  if (typeof obj !== "object") return { value: obj };

  const record = obj as Record<string, unknown>;
  const keys = Object.keys(record);

  // Already wrapped in {value: X} form — leave idempotent.
  if (keys.includes("value") && keys.every((k) => k === "value" || k === "error")) {
    return obj;
  }

  // Plain field container: wrap each scalar value; recurse into nested objects.
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    if (Array.isArray(value)) {
      result[key] = value.map(wrapFields);
    } else if (value !== null && typeof value === "object") {
      result[key] = wrapFields(value);
    } else {
      result[key] = { value: value };
    }
  }
  return result;
}

/**
 * Unwrap Acumatica's {value: ...} field wrapper pattern.
 * Recursively walks an object and replaces {value: X} with X.
 */
export function unwrapFields(obj: unknown): unknown {
  if (obj === null || obj === undefined) return obj;
  if (Array.isArray(obj)) return obj.map(unwrapFields);
  if (typeof obj !== "object") return obj;

  const record = obj as Record<string, unknown>;

  // Check if this is a value-wrapper object: has "value" key and at most "value" + "error"
  const keys = Object.keys(record);
  if (
    keys.includes("value") &&
    keys.every((k) => k === "value" || k === "error")
  ) {
    return record.value;
  }

  // Recurse into all properties, dropping:
  //   - `_links`: HATEOAS navigation URLs (not user data)
  //   - `rowNumber`: Acumatica row identifier (not user data)
  //   - `custom`: Acumatica user-defined extension fields. This is user
  //     data, but the wire format is a deeply nested type-tagged map
  //     (e.g. `{"Document": {"UsrField": {"type": "CustomStringField",
  //     "value": "foo"}}}`) that's noisy for the model and often empty.
  //     Surfacing them would require per-entity flattening; for now we
  //     strip them. If a workflow needs custom fields, the direct
  //     `acumatica_get_*` tools can be extended to fetch them via
  //     `$expand=custom` and flatten before return.
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    if (key === "_links" || key === "rowNumber" || key === "custom") continue;
    result[key] = unwrapFields(value);
  }
  return result;
}
