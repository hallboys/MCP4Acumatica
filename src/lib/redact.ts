// Copyright 2026 Hall Boys, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Pattern-based sensitive field redaction.
 *
 * Recursively walks objects returned from Acumatica (after unwrapFields)
 * and replaces values of fields whose names match sensitive patterns
 * with "[REDACTED]".
 *
 * Built-in patterns cover common PII / financial fields. Admins can
 * extend via REDACT_PATTERNS env var or whitelist via REDACT_SKIP.
 */

const BUILTIN_PATTERNS = [
  "SSN",
  "SocialSecurity",
  "TaxRegistrationID",
  "TaxID",
  "BankAccount",
  "RoutingNumber",
  "IBAN",
  "SWIFT",
  "CreditCard",
  "CardNumber",
  "Password",
  "Secret",
  "Salary",
  "PayRate",
  "HourlyRate",
  "AnnualRate",
  "BirthDate",
  "DateOfBirth",
  "DOB",
];

/** Cached compiled regex — built once per set of config values */
let cachedRegex: RegExp | null = null;
let cachedExtra = "";
let cachedSkip = "";

/**
 * Build (and cache) the combined regex from built-in + extra patterns,
 * minus any skip patterns.
 */
function getRedactRegex(extraPatterns?: string, skipPatterns?: string): RegExp {
  const extra = extraPatterns || "";
  const skip = skipPatterns || "";

  if (cachedRegex && cachedExtra === extra && cachedSkip === skip) {
    return cachedRegex;
  }

  let patterns = [...BUILTIN_PATTERNS];

  if (extra) {
    patterns.push(...extra.split(",").map((p) => p.trim()).filter(Boolean));
  }

  if (skip) {
    const skipSet = new Set(
      skip.split(",").map((p) => p.trim().toLowerCase()).filter(Boolean)
    );
    patterns = patterns.filter((p) => !skipSet.has(p.toLowerCase()));
  }

  // Build regex that matches any field name containing one of the patterns
  const joined = patterns.map(escapeRegex).join("|");
  cachedRegex = new RegExp(`(${joined})`, "i");
  cachedExtra = extra;
  cachedSkip = skip;
  return cachedRegex;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export interface RedactResult {
  data: unknown;
  redactedFields: string[];
}

/**
 * Recursively redact sensitive fields from an unwrapped Acumatica response.
 * Returns the redacted data and a list of field names that were redacted.
 */
export function redactFields(
  obj: unknown,
  extraPatterns?: string,
  skipPatterns?: string
): RedactResult {
  const redactedFields: string[] = [];
  const regex = getRedactRegex(extraPatterns, skipPatterns);
  const data = walkAndRedact(obj, regex, redactedFields, "");
  return { data, redactedFields };
}

function walkAndRedact(
  obj: unknown,
  regex: RegExp,
  redactedFields: string[],
  path: string
): unknown {
  if (obj === null || obj === undefined) return obj;
  if (Array.isArray(obj)) {
    return obj.map((item, i) =>
      walkAndRedact(item, regex, redactedFields, `${path}[${i}]`)
    );
  }
  if (typeof obj !== "object") return obj;

  const record = obj as Record<string, unknown>;
  const result: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(record)) {
    if (regex.test(key)) {
      result[key] = "[REDACTED]";
      redactedFields.push(path ? `${path}.${key}` : key);
    } else if (typeof value === "object" && value !== null) {
      result[key] = walkAndRedact(
        value,
        regex,
        redactedFields,
        path ? `${path}.${key}` : key
      );
    } else {
      result[key] = value;
    }
  }

  return result;
}
