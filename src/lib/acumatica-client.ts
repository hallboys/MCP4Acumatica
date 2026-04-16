// Copyright 2026 Hall Boys, Inc.
// SPDX-License-Identifier: Apache-2.0

import type { AppEnv } from "../types/acumatica";
import { getAcumaticaTokenForUser } from "../auth/acumatica-oauth";
import { withRateLimit } from "./rate-limiter";
import { logHttpCall, logError } from "./logger";

const ERROR_BODY_MAX_CHARS = 400;

/**
 * Prepare an Acumatica error body for inclusion in a user-facing error
 * message: normalize whitespace, then truncate to a fixed cap. Keeps the
 * response informative without relaying arbitrary instance-side content
 * back through the tool output channel.
 */
function trimForError(s: string): string {
  const collapsed = s.replace(/\s+/g, " ").trim();
  if (collapsed.length <= ERROR_BODY_MAX_CHARS) return collapsed;
  return collapsed.slice(0, ERROR_BODY_MAX_CHARS) + "… [truncated]";
}

/**
 * Build a URL string from a base URL and a flat query map. Empty-string
 * values are skipped (matches the original `if (value) { ... }` guard, so
 * callers can use `query.foo = args.foo ?? ""` for optional params).
 */
function buildQueryUrl(base: string, query: Record<string, string>): string {
  const url = new URL(base);
  for (const [key, value] of Object.entries(query)) {
    if (value) url.searchParams.set(key, value);
  }
  return url.toString();
}

export class AcumaticaApiError extends Error {
  constructor(
    public statusCode: number,
    public body: string,
    message: string
  ) {
    super(message);
    this.name = "AcumaticaApiError";
  }
}

export class AcumaticaClient {
  private env: AppEnv;
  private acumaticaUsername: string;
  private baseUrl: string;

  constructor(env: AppEnv, acumaticaUsername: string) {
    this.env = env;
    this.acumaticaUsername = acumaticaUsername;
    this.baseUrl = `${env.ACUMATICA_URL}/entity/Default/${env.ACUMATICA_ENDPOINT_VERSION}`;
  }

  /**
   * Make a GET request to the Acumatica contract-based REST API.
   * Uses the per-user token for the authenticated MCP user.
   * Handles token acquisition, rate limiting, retry on 401, and audit logging.
   */
  async get<T>(
    path: string,
    toolName: string,
    params: Record<string, unknown> = {},
    query: Record<string, string> = {}
  ): Promise<T> {
    return withRateLimit(this.env.store, this.acumaticaUsername, async () => {
      const start = Date.now();
      const url = this.buildUrl(path, query);

      let token = await getAcumaticaTokenForUser(this.env, this.acumaticaUsername);
      let response = await this.doFetch(url, token);

      // Retry once on 401 (token may have just expired)
      if (response.status === 401) {
        token = await getAcumaticaTokenForUser(this.env, this.acumaticaUsername);
        response = await this.doFetch(url, token);
      }

      const durationMs = Date.now() - start;
      const endpoint = `GET ${path}`;

      logHttpCall({
        timestamp: new Date().toISOString(),
        tool: toolName,
        acumaticaUsername: this.acumaticaUsername,
        params,
        endpoint,
        statusCode: response.status,
        durationMs,
      });

      if (!response.ok) {
        const body = await response.text();
        const message = this.friendlyError(response.status, body, path);
        logError(toolName, message);
        throw new AcumaticaApiError(response.status, body, message);
      }

      return (await response.json()) as T;
    });
  }

  /**
   * Make a GET request to the Acumatica OData GI endpoint.
   * Uses /t/{COMPANY}/api/odata/gi/{path} instead of the contract-based REST path.
   * OAuth 2.0 Bearer tokens are supported per Acumatica documentation.
   * OData responses do NOT use {value: X} wrapping — do not run unwrapFields().
   */
  async getOData<T>(
    path: string,
    toolName: string,
    params: Record<string, unknown> = {},
    query: Record<string, string> = {}
  ): Promise<T> {
    return withRateLimit(this.env.store, this.acumaticaUsername, async () => {
      const start = Date.now();
      const odataBase = `${this.env.ACUMATICA_URL}/t/${this.env.ACUMATICA_TENANT}/api/odata/gi`;
      const separator = path ? "/" : "";
      const url = buildQueryUrl(`${odataBase}${separator}${path}`, query);

      let token = await getAcumaticaTokenForUser(this.env, this.acumaticaUsername);
      let response = await this.doFetch(url, token);

      if (response.status === 401) {
        token = await getAcumaticaTokenForUser(this.env, this.acumaticaUsername);
        response = await this.doFetch(url, token);
      }

      const durationMs = Date.now() - start;
      const endpoint = `GET odata/gi${separator}${path}`;

      logHttpCall({
        timestamp: new Date().toISOString(),
        tool: toolName,
        acumaticaUsername: this.acumaticaUsername,
        params,
        endpoint,
        statusCode: response.status,
        durationMs,
      });

      if (!response.ok) {
        const body = await response.text();
        const message = this.friendlyError(response.status, body, `odata/gi${separator}${path}`);
        logError(toolName, message);
        throw new AcumaticaApiError(response.status, body, message);
      }

      return (await response.json()) as T;
    });
  }

  /**
   * Fetch the OData GI $metadata document as raw XML text.
   */
  async getODataMetadata(toolName: string): Promise<string> {
    return withRateLimit(this.env.store, this.acumaticaUsername, async () => {
      const start = Date.now();
      const url = `${this.env.ACUMATICA_URL}/t/${this.env.ACUMATICA_TENANT}/api/odata/gi/$metadata`;

      let token = await getAcumaticaTokenForUser(this.env, this.acumaticaUsername);
      let response = await this.doFetch(url, token);

      if (response.status === 401) {
        token = await getAcumaticaTokenForUser(this.env, this.acumaticaUsername);
        response = await this.doFetch(url, token);
      }

      const durationMs = Date.now() - start;
      logHttpCall({
        timestamp: new Date().toISOString(),
        tool: toolName,
        acumaticaUsername: this.acumaticaUsername,
        params: {},
        endpoint: "GET odata/gi/$metadata",
        statusCode: response.status,
        durationMs,
      });

      if (!response.ok) {
        const body = await response.text();
        const message = this.friendlyError(response.status, body, "odata/gi/$metadata");
        logError(toolName, message);
        throw new AcumaticaApiError(response.status, body, message);
      }

      return response.text();
    });
  }

  private buildUrl(path: string, query: Record<string, string>): string {
    return buildQueryUrl(`${this.baseUrl}/${path}`, query);
  }

  private async doFetch(url: string, token: string): Promise<Response> {
    return fetch(url, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
      },
    });
  }

  private friendlyError(status: number, body: string, path: string): string {
    // Acumatica error responses sometimes echo the submitted query back,
    // which can include the caller's filter expression and any needles in
    // it (customer IDs, SSN-shaped strings, etc.). We surface just enough
    // of the response to be useful without piping arbitrary user-supplied
    // content back to the model through the error channel.
    const safe = (s: string) => trimForError(s);
    switch (status) {
      case 400: {
        try {
          const parsed = JSON.parse(body);
          const msg = parsed.message || parsed.exceptionMessage;
          return `Validation error: ${safe(msg || body)}`;
        } catch {
          return `Bad request: ${safe(body)}`;
        }
      }
      case 401:
        return "Authentication failed. The Acumatica token may be invalid or the API user lacks permissions.";
      case 403:
        return "Insufficient permissions. Check the API user's role configuration in Acumatica.";
      case 404:
        return `Record not found at ${path}. Verify the ID or reference number is correct.`;
      case 429:
        return "Acumatica rate limit exceeded. Please wait a moment and try again.";
      case 500: {
        try {
          const parsed = JSON.parse(body);
          const msg = parsed.message || parsed.exceptionMessage;
          return `Acumatica internal error: ${safe(msg || body)}`;
        } catch {
          return `Acumatica internal error: ${body ? safe(body) : "No details available. Check instance status."}`;
        }
      }
      default:
        return `Acumatica API error (${status}): ${safe(body)}`;
    }
  }
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
