// Copyright 2026 Hall Boys, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Shared crypto helpers backed by Web Crypto (`crypto.subtle`).
 *
 * - HMAC-SHA256 for cookie signing (admin session, OAuth state binding)
 * - AES-256-GCM for at-rest encryption of refresh tokens
 * - Constant-time string compare
 * - Cookie header parsing
 */

const encoder = new TextEncoder();
const decoder = new TextDecoder();

// ── Base64 helpers (URL-safe for ciphertext, standard for HMAC sig) ──

function b64encode(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes));
}

function b64decode(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function hexToBytes(hex: string): Uint8Array {
  if (hex.length % 2 !== 0) throw new Error("hex length must be even");
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(hex.substr(i * 2, 2), 16);
  }
  return out;
}

// ── Constant-time compare ──

export function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  const aBytes = encoder.encode(a);
  const bBytes = encoder.encode(b);
  let diff = 0;
  for (let i = 0; i < aBytes.length; i++) diff |= aBytes[i] ^ bBytes[i];
  return diff === 0;
}

// ── HMAC-SHA256 ──

export async function hmacSign(payload: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, encoder.encode(payload));
  return b64encode(new Uint8Array(sig));
}

export async function hmacVerify(
  payload: string,
  signature: string,
  secret: string
): Promise<boolean> {
  const expected = await hmacSign(payload, secret);
  return constantTimeEqual(expected, signature);
}

// ── AES-256-GCM at-rest encryption ──
//
// Key material is expected as a 64-char hex string (the existing
// `COOKIE_ENCRYPTION_KEY` secret is already a 256-bit hex value).
// Output format is `v1:<iv_b64>:<ct_b64>` — the `v1:` prefix lets us
// distinguish encrypted values from legacy plaintext during migration.

const ENCRYPTION_VERSION = "v1";

async function importAesKey(keyHex: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    hexToBytes(keyHex),
    { name: "AES-GCM" },
    false,
    ["encrypt", "decrypt"]
  );
}

export async function encryptString(plaintext: string, keyHex: string): Promise<string> {
  const key = await importAesKey(keyHex);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    encoder.encode(plaintext)
  );
  return `${ENCRYPTION_VERSION}:${b64encode(iv)}:${b64encode(new Uint8Array(ct))}`;
}

/**
 * Decrypt a value produced by `encryptString`. If the value does not
 * start with the version prefix, it is returned unchanged — this lets
 * callers transparently read legacy plaintext records and re-encrypt
 * them on the next write without a migration script.
 */
export async function decryptString(value: string, keyHex: string): Promise<string> {
  if (!value.startsWith(`${ENCRYPTION_VERSION}:`)) return value;
  const parts = value.split(":");
  if (parts.length !== 3) throw new Error("invalid ciphertext format");
  const iv = b64decode(parts[1]);
  const ct = b64decode(parts[2]);
  const key = await importAesKey(keyHex);
  const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ct);
  return decoder.decode(pt);
}

// ── Cookie header parsing ──

export function parseCookies(header: string | undefined): Record<string, string> {
  if (!header) return {};
  const cookies: Record<string, string> = {};
  for (const pair of header.split(";")) {
    const [name, ...rest] = pair.trim().split("=");
    if (name) cookies[name.trim()] = rest.join("=").trim();
  }
  return cookies;
}
