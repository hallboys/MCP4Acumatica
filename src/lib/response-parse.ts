// Copyright 2026 Hall Boys, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Parsing of successful (2xx) Acumatica response bodies.
 *
 * Exists because `await response.json()` on an empty body throws the raw V8
 * message `Unexpected end of JSON input`, which then reached the model verbatim
 * as the entire explanation. Production logs showed 279 of these over 95 days
 * — ~14% of all current tool errors — almost all from `acumatica_run_inquiry`,
 * with nothing in the message to indicate what happened or what to do next.
 *
 * Import-free on purpose so `node --test` can load it under strip-only mode.
 */

const BODY_SNIPPET_MAX = 200;

export type ParseResult<T> =
  | { ok: true; data: T }
  | { ok: false; message: string };

function snippet(text: string): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  return collapsed.length <= BODY_SNIPPET_MAX
    ? collapsed
    : collapsed.slice(0, BODY_SNIPPET_MAX) + "… [truncated]";
}

/**
 * Whether the request was a read or a mutation. This changes the advice on an
 * empty body, and getting it wrong is dangerous: telling a model to retry a
 * write whose outcome is unknown can double-create a record when the entity is
 * auto-numbered (no key supplied), since PUT-as-upsert is only idempotent when
 * the key is present.
 */
export type RequestKind = "read" | "write";

/**
 * Parse a 2xx Acumatica body, converting the two failure modes into messages a
 * model can act on.
 *
 * An empty body is deliberately NOT treated as "no matching records" or as a
 * successful write. Standard OData returns `{"value": []}` for an empty result
 * set, so a body-less 200 is anomalous — and silently turning it into zero rows
 * is precisely the silent-wrong-data failure this codebase guards against
 * elsewhere (see the `possibleFalseNegative` warnings in complex-entities.ts).
 * For writes it is the documented "200 but nothing happened" trap, where the
 * only safe move is to verify in Acumatica rather than retry.
 *
 * `context` is a short human description of the request (e.g. `GET odata/gi/X`)
 * used to make the message specific.
 */
export function parseAcumaticaJson<T>(
  status: number,
  bodyText: string,
  context: string,
  kind: RequestKind = "read"
): ParseResult<T> {
  if (bodyText.trim() === "") {
    if (kind === "write") {
      return {
        ok: false,
        message:
          `Acumatica returned HTTP ${status} with an empty response body for ${context}, ` +
          `so the record it wrote cannot be confirmed. DO NOT RETRY THIS WRITE: a ` +
          `success response normally echoes the saved record, and retrying when the ` +
          `outcome is unknown can create a duplicate if the record was auto-numbered ` +
          `(no key supplied). The write may or may not have been applied. Tell the ` +
          `user to verify the record directly in Acumatica before any further attempt.`,
      };
    }
    return {
      ok: false,
      message:
        `Acumatica returned HTTP ${status} with an empty response body for ${context}. ` +
        `This is NOT the same as "no matching records" — a query with no results ` +
        `returns an empty list, not an empty body — so do not report to the user ` +
        `that no records exist. It usually means the request was accepted but the ` +
        `inquiry or entity produced nothing serializable (a Generic Inquiry that ` +
        `errored internally, or one whose result set could not be built). ` +
        `Retry once; if it repeats, the inquiry/entity itself needs attention in ` +
        `Acumatica — tell the user rather than retrying further or substituting a ` +
        `different query.`,
    };
  }

  try {
    return { ok: true, data: JSON.parse(bodyText) as T };
  } catch {
    return {
      ok: false,
      message:
        `Acumatica returned HTTP ${status} for ${context} with a body that is not ` +
        `valid JSON. This usually means an HTML error or sign-in page was returned ` +
        `instead of data. First ${BODY_SNIPPET_MAX} chars: ${snippet(bodyText)}`,
    };
  }
}
