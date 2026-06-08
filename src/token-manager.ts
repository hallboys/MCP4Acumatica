// Copyright 2026 Hall Boys, Inc.
// SPDX-License-Identifier: Apache-2.0

import { DurableObject } from "cloudflare:workers";
import type { Env, StoredToken } from "./types/acumatica";
import type { TokenResult } from "./lib/token-provider";
import {
  refreshAcumaticaToken,
  USER_TOKEN_TTL_SECONDS,
} from "./auth/acumatica-oauth";
import { decryptString, encryptString } from "./lib/crypto";

const STORAGE_KEY = "token";

/**
 * Per-user Acumatica token owner. One instance per user (the namespace is
 * keyed by `idFromName(acumaticaUsername)`), so EVERY token request for a user
 * — across all of their concurrent MCP sessions / isolates — funnels through
 * this single, globally-consistent Durable Object.
 *
 * Why this exists: IdentityServer rotates the refresh token on every use. With
 * the old per-isolate coalescing, two separate session DOs could each read the
 * same stored refresh token and POST it concurrently; one won and rotated it,
 * the other got a 4xx and (as of 0.32.0) had its grant revoked — a spurious
 * "session dead" on an otherwise-healthy account. Serializing all refreshes
 * through one DO makes that race structurally impossible.
 *
 * Storage model: the DO's own (strongly-consistent) storage is authoritative.
 * KV (`user_token:{username}`) is kept as a write-through backup and as the
 * adoption source for users who authenticated before this DO existed.
 */
export class TokenManager extends DurableObject<Env> {
  // Coalesces concurrent getAccessToken() calls into one refresh. Because
  // there is exactly one DO instance per user globally, this is a global lock,
  // not the per-isolate best-effort the old inflightLookups map provided.
  private inflight: Promise<TokenResult> | null = null;

  /** Resolve a valid access token, refreshing (once, serialized) if needed. */
  async getAccessToken(username: string): Promise<TokenResult> {
    if (this.inflight) return this.inflight;
    const p = this.resolve(username);
    this.inflight = p;
    p.finally(() => {
      if (this.inflight === p) this.inflight = null;
    });
    return p;
  }

  /**
   * Seed the authoritative token from the OAuth callback after a fresh login.
   * Ensures the DO has the new token immediately, so there is no KV
   * eventual-consistency window where the DO would read a stale (expired)
   * record right after the user re-authenticated. `stored.refresh_token` is
   * already encrypted by the caller.
   */
  async setToken(stored: StoredToken): Promise<void> {
    await this.ctx.storage.put(STORAGE_KEY, stored);
    // Drop any in-flight refresh racing against this fresh token.
    this.inflight = null;
  }

  private async resolve(username: string): Promise<TokenResult> {
    let stored: StoredToken | undefined;
    try {
      stored = await this.readToken(username);
    } catch (e) {
      this.logOutcome(username, "transient", "storage_read_error");
      return { status: "transient", message: e instanceof Error ? e.message : "storage error" };
    }

    if (!stored) {
      this.logOutcome(username, "reauth", "no_token");
      return {
        status: "reauth",
        message:
          "No Acumatica token found for your account. Please reconnect to re-authorize with Acumatica.",
      };
    }

    // Still has at least 60s of life — use it as-is.
    if (stored.expires_at > Date.now() + 60_000) {
      return { status: "ok", accessToken: stored.access_token };
    }

    if (!stored.refresh_token) {
      this.logOutcome(username, "reauth", "no_refresh_token");
      return {
        status: "reauth",
        message:
          "Your Acumatica session has expired and no refresh token is available. Please reconnect to re-authorize.",
      };
    }

    let refreshToken: string;
    try {
      refreshToken = await decryptString(stored.refresh_token, this.env.COOKIE_ENCRYPTION_KEY);
    } catch {
      // Corrupt record or rotated COOKIE_ENCRYPTION_KEY — unrecoverable.
      this.logOutcome(username, "reauth", "decrypt_failed");
      return {
        status: "reauth",
        message: "Your stored Acumatica credentials could not be read. Please reconnect to re-authorize.",
      };
    }

    const outcome = await refreshAcumaticaToken(
      {
        url: this.env.ACUMATICA_URL,
        clientId: this.env.ACUMATICA_CLIENT_ID,
        clientSecret: this.env.ACUMATICA_CLIENT_SECRET,
      },
      refreshToken,
      username
    );

    if (outcome.status === "ok") {
      const encryptedRefresh = await encryptString(
        outcome.refresh_token,
        this.env.COOKIE_ENCRYPTION_KEY
      );
      const next: StoredToken = {
        access_token: outcome.access_token,
        refresh_token: encryptedRefresh,
        expires_at: Date.now() + outcome.expires_in * 1000,
      };
      await this.writeToken(username, next);
      return { status: "ok", accessToken: outcome.access_token };
    }

    if (outcome.status === "reauth") {
      this.logOutcome(username, "reauth", "refresh_4xx");
      return {
        status: "reauth",
        message:
          "Your Acumatica session has expired. Re-authorizing — reconnect the MCP server if you are not prompted automatically.",
      };
    }

    this.logOutcome(username, "transient", `refresh_${outcome.detail}`);
    return {
      status: "transient",
      message: `Acumatica token refresh failed (${outcome.detail}). Please try again shortly.`,
    };
  }

  /** Structured diagnostic for any non-ok token resolution, so the cause of a
   *  revoke is visible in `wrangler tail` / R2 logs. Never logs token material. */
  private logOutcome(username: string, status: string, reason: string): void {
    console.log(
      JSON.stringify({
        level: "warn",
        type: "token_resolve_outcome",
        timestamp: new Date().toISOString(),
        acumaticaUsername: username,
        status,
        reason,
      })
    );
  }

  /**
   * Read the authoritative token, reconciling DO storage with KV by recency.
   *
   * The DO's storage is normally authoritative, BUT `/callback` writes a fresh
   * token to KV and seeds the DO separately (`setToken`), and that seed is
   * best-effort. If it ever fails — or the DO is otherwise holding a token from
   * before a reconnect — blindly preferring DO storage would make the DO serve
   * a stale, already-rotated refresh token forever and 4xx (→ revoke) on every
   * refresh. So we take whichever record has the later `expires_at`: a fresh
   * login (newer KV) always wins over a stale DO copy, and a just-refreshed DO
   * copy wins over a lagging KV backup. When KV wins, we adopt it into storage.
   */
  private async readToken(username: string): Promise<StoredToken | undefined> {
    const fromDo = await this.ctx.storage.get<StoredToken>(STORAGE_KEY);
    const raw = await this.env.TOKEN_STORE.get(`user_token:${username}`);
    const fromKv = raw ? (JSON.parse(raw) as StoredToken) : undefined;

    if (fromDo && fromKv) {
      if (fromKv.expires_at > fromDo.expires_at) {
        await this.ctx.storage.put(STORAGE_KEY, fromKv);
        return fromKv;
      }
      return fromDo;
    }

    const chosen = fromDo ?? fromKv;
    if (chosen && !fromDo) await this.ctx.storage.put(STORAGE_KEY, chosen);
    return chosen;
  }

  /** Write-through: DO storage (authoritative) + KV (warm backup, TTL'd). */
  private async writeToken(username: string, stored: StoredToken): Promise<void> {
    await this.ctx.storage.put(STORAGE_KEY, stored);
    await this.env.TOKEN_STORE.put(`user_token:${username}`, JSON.stringify(stored), {
      expirationTtl: USER_TOKEN_TTL_SECONDS,
    });
  }
}
