// Copyright 2026 Hall Boys, Inc.
// SPDX-License-Identifier: Apache-2.0

import type { Env } from "../types/acumatica";
import { getAcumaticaTokenForUser } from "../auth/acumatica-oauth";
import { withRateLimit } from "./rate-limiter";
import { logToolInvocation, logError } from "./logger";

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
  private env: Env;
  private acumaticaUsername: string;
  private baseUrl: string;

  constructor(env: Env, acumaticaUsername: string) {
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
    return withRateLimit(async () => {
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

      logToolInvocation({
        timestamp: new Date().toISOString(),
        tool: toolName,
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
    return withRateLimit(async () => {
      const start = Date.now();
      const odataBase = `${this.env.ACUMATICA_URL}/t/${this.env.ACUMATICA_COMPANY}/api/odata/gi`;
      const separator = path ? "/" : "";
      const fullUrl = new URL(`${odataBase}${separator}${path}`);
      for (const [key, value] of Object.entries(query)) {
        if (value) {
          fullUrl.searchParams.set(key, value);
        }
      }
      const url = fullUrl.toString();

      let token = await getAcumaticaTokenForUser(this.env, this.acumaticaUsername);
      let response = await this.doFetch(url, token);

      if (response.status === 401) {
        token = await getAcumaticaTokenForUser(this.env, this.acumaticaUsername);
        response = await this.doFetch(url, token);
      }

      const durationMs = Date.now() - start;
      const endpoint = `GET odata/gi${separator}${path}`;

      logToolInvocation({
        timestamp: new Date().toISOString(),
        tool: toolName,
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

  private buildUrl(path: string, query: Record<string, string>): string {
    const url = new URL(`${this.baseUrl}/${path}`);
    for (const [key, value] of Object.entries(query)) {
      if (value) {
        url.searchParams.set(key, value);
      }
    }
    return url.toString();
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
    switch (status) {
      case 400: {
        try {
          const parsed = JSON.parse(body);
          return `Validation error: ${parsed.message || parsed.exceptionMessage || body}`;
        } catch {
          return `Bad request: ${body}`;
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
          return `Acumatica internal error: ${parsed.message || parsed.exceptionMessage || body}`;
        } catch {
          return `Acumatica internal error: ${body || "No details available. Check instance status."}`;
        }
      }
      default:
        return `Acumatica API error (${status}): ${body}`;
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

  // Recurse into all properties
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    // Skip internal metadata fields
    if (key === "_links" || key === "rowNumber" || key === "custom") continue;
    result[key] = unwrapFields(value);
  }
  return result;
}
