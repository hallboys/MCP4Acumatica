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

// ── Value-shaped PII patterns ────────────────────────────────────
// Applied to every string value regardless of its field name — catches
// PII that landed under innocuous keys (custom fields, nested objects,
// free-form notes) where name-based matching would miss it.

// US SSN: 3-2-4 digit pattern with optional `-` or ` ` separators.
// Anchored to word boundaries so we don't clobber longer numeric IDs.
const SSN_RE = /\b\d{3}[- ]?\d{2}[- ]?\d{4}\b/g;

// Payment card: 13–19 digits, allowing common ` ` or `-` separators
// between 4-digit groups. Stripped digits must also pass Luhn so we
// don't false-positive on purchase order numbers, GL account codes,
// stock keys, and other long numeric strings that are not cards.
const CARD_RE = /\b(?:\d[ -]?){13,19}\b/g;

function luhnValid(digits: string): boolean {
  let sum = 0;
  let alt = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let n = digits.charCodeAt(i) - 48;
    if (alt) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    sum += n;
    alt = !alt;
  }
  return sum > 0 && sum % 10 === 0;
}

function redactValuePatterns(value: string): { value: string; hits: string[] } {
  const hits: string[] = [];
  let out = value;

  if (SSN_RE.test(out)) {
    SSN_RE.lastIndex = 0;
    out = out.replace(SSN_RE, () => {
      hits.push("ssn_shape");
      return "[REDACTED_SSN]";
    });
  }
  SSN_RE.lastIndex = 0;

  out = out.replace(CARD_RE, (match) => {
    const digits = match.replace(/[^\d]/g, "");
    if (digits.length < 13 || digits.length > 19) return match;
    if (!luhnValid(digits)) return match;
    hits.push("card_shape");
    return "[REDACTED_CARD]";
  });

  return { value: out, hits };
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
    const childPath = path ? `${path}.${key}` : key;
    if (regex.test(key)) {
      result[key] = "[REDACTED]";
      redactedFields.push(childPath);
    } else if (typeof value === "object" && value !== null) {
      result[key] = walkAndRedact(value, regex, redactedFields, childPath);
    } else if (typeof value === "string") {
      const { value: scrubbed, hits } = redactValuePatterns(value);
      if (hits.length > 0) {
        redactedFields.push(`${childPath} (${hits.join(",")})`);
      }
      result[key] = scrubbed;
    } else {
      result[key] = value;
    }
  }

  return result;
}
