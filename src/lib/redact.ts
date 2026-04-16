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

/**
 * Build the combined field-name regex from built-in + extra patterns,
 * minus any skip patterns. Construction is cheap; we deliberately do NOT
 * cache a module-scope RegExp instance because concurrent redactions with
 * different REDACT_PATTERNS values could otherwise thrash the cache and
 * hand one call the other's compiled regex.
 */
function getRedactRegex(extraPatterns?: string, skipPatterns?: string): RegExp {
  let patterns = [...BUILTIN_PATTERNS];

  if (extraPatterns) {
    patterns.push(...extraPatterns.split(",").map((p) => p.trim()).filter(Boolean));
  }

  if (skipPatterns) {
    const skipSet = new Set(
      skipPatterns.split(",").map((p) => p.trim().toLowerCase()).filter(Boolean)
    );
    patterns = patterns.filter((p) => !skipSet.has(p.toLowerCase()));
  }

  // Match if any pattern appears anywhere in the field name. No `g` flag —
  // we only use `test()` against keys, so lastIndex never comes into play.
  const joined = patterns.map(escapeRegex).join("|");
  return new RegExp(`(${joined})`, "i");
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// ── Value-shaped PII patterns ────────────────────────────────────
// Applied to every string value regardless of its field name — catches
// PII that landed under innocuous keys (custom fields, nested objects,
// free-form notes) where name-based matching would miss it.
//
// Regex instances are constructed per-call rather than cached at module
// scope. Global-flag regexes carry mutable `lastIndex`; a cached instance
// shared between concurrent redactions could see interleaved test/replace
// calls and skip matches or double-match. Construction cost is trivial
// compared to the walk itself.

// US SSN: 3-2-4 digit pattern with optional `-` or ` ` separators.
// Anchored to word boundaries so we don't clobber longer numeric IDs.
const SSN_SOURCE = String.raw`\b\d{3}[- ]?\d{2}[- ]?\d{4}\b`;

// Payment card: 13–19 digits, allowing common ` ` or `-` separators
// between 4-digit groups. Stripped digits must also pass Luhn so we
// don't false-positive on purchase order numbers, GL account codes,
// stock keys, and other long numeric strings that are not cards.
const CARD_SOURCE = String.raw`\b(?:\d[ -]?){13,19}\b`;

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

  // Fresh regex instances each call — see note above about concurrent
  // state on module-scoped global-flag regexes.
  const ssnRe = new RegExp(SSN_SOURCE, "g");
  const cardRe = new RegExp(CARD_SOURCE, "g");

  let out = value.replace(ssnRe, () => {
    hits.push("ssn_shape");
    return "[REDACTED_SSN]";
  });

  out = out.replace(cardRe, (match) => {
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
 * Apply the value-shape redactors (SSN, card) to every string leaf in a
 * shallow object — used to scrub tool-call parameter records before they
 * land in the audit log. The model can pass anything as a filter
 * expression ("substringof('123-45-6789', Notes)"), so we apply the same
 * defense we apply to responses. Name-based redaction is NOT applied
 * here — param keys like `filterExpression` aren't PII on their own, and
 * we don't want to obscure the parameter structure.
 */
export function redactParamsForLog(
  params: Record<string, unknown>
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(params)) {
    if (typeof value === "string") {
      out[key] = redactValuePatterns(value).value;
    } else {
      out[key] = value;
    }
  }
  return out;
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
