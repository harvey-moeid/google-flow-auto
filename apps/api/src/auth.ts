/**
 * Password authentication (no Cloudflare Access).
 *
 *  - Owner: POST /api/login {password} -> HttpOnly session cookie. The cookie value is an
 *    HMAC-SHA256 signed, expiring token; nothing about it is stored server-side.
 *  - Worker: `Authorization: Bearer <WORKER_TOKEN>`, accepted ONLY on /api/worker/*.
 *
 * Secrets are compared by their SHA-256 digests in constant time. Nothing in this file logs or
 * returns a secret value.
 */

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** `__Host-` pins the cookie to this exact host (Secure, Path=/, no Domain attribute). */
export const SESSION_COOKIE = "__Host-gfa_session";
export const SESSION_TTL_S = 7 * 24 * 60 * 60;
const SESSION_CONTEXT = "gfa.session.v1.";
const MAX_TOKEN_LENGTH = 512;
const CLOCK_SKEW_S = 60;
const B64URL_RE = /^[A-Za-z0-9_-]+$/;

export function bytesToB64url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Throws on invalid input; callers treat that as a malformed token. */
export function b64urlToBytes(value: string): Uint8Array {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (value.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export async function hmac(secret: string, data: string): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(data)));
}

export function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  let diff = a.length ^ b.length;
  const length = Math.max(a.length, b.length);
  for (let i = 0; i < length; i += 1) diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
  return diff === 0;
}

async function sha256(value: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(value)));
}

/** Constant-time comparison of two secrets of any length (both are hashed to a fixed size first). */
export async function secretsEqual(provided: string, expected: string): Promise<boolean> {
  const [a, b] = await Promise.all([sha256(provided), sha256(expected)]);
  return timingSafeEqual(a, b);
}

export interface SessionToken {
  token: string;
  /** Epoch milliseconds. */
  expiresAt: number;
}

export async function createSessionToken(secret: string, nowMs: number, ttlSeconds = SESSION_TTL_S): Promise<SessionToken> {
  const iat = Math.floor(nowMs / 1000);
  const exp = iat + ttlSeconds;
  const payload = bytesToB64url(encoder.encode(JSON.stringify({ v: 1, iat, exp })));
  const signature = bytesToB64url(await hmac(secret, SESSION_CONTEXT + payload));
  return { token: `${payload}.${signature}`, expiresAt: exp * 1000 };
}

export type SessionResult =
  | { ok: true; expiresAt: number }
  | { ok: false; reason: "malformed" | "bad_signature" | "expired" | "not_yet_valid" };

export async function verifySessionToken(secret: string, token: string, nowMs: number): Promise<SessionResult> {
  if (token.length === 0 || token.length > MAX_TOKEN_LENGTH) return { ok: false, reason: "malformed" };
  const parts = token.split(".");
  if (parts.length !== 2) return { ok: false, reason: "malformed" };
  const [payload, signature] = parts;
  if (!B64URL_RE.test(payload) || !B64URL_RE.test(signature)) return { ok: false, reason: "malformed" };

  let provided: Uint8Array;
  try {
    provided = b64urlToBytes(signature);
  } catch {
    return { ok: false, reason: "malformed" };
  }
  const expected = await hmac(secret, SESSION_CONTEXT + payload);
  if (!timingSafeEqual(provided, expected)) return { ok: false, reason: "bad_signature" };

  let claims: unknown;
  try {
    claims = JSON.parse(decoder.decode(b64urlToBytes(payload)));
  } catch {
    return { ok: false, reason: "malformed" };
  }
  if (claims === null || typeof claims !== "object") return { ok: false, reason: "malformed" };
  const { v, iat, exp } = claims as Record<string, unknown>;
  if (v !== 1 || !Number.isInteger(iat) || !Number.isInteger(exp)) return { ok: false, reason: "malformed" };
  const issuedAt = iat as number;
  const expiresAt = exp as number;
  if (expiresAt - issuedAt > SESSION_TTL_S) return { ok: false, reason: "malformed" };

  const now = Math.floor(nowMs / 1000);
  if (expiresAt <= now) return { ok: false, reason: "expired" };
  if (issuedAt > now + CLOCK_SKEW_S) return { ok: false, reason: "not_yet_valid" };
  return { ok: true, expiresAt: expiresAt * 1000 };
}

/** Returns the raw value of the named cookie, or null when absent or oversized. */
export function readCookie(header: string | null, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(";")) {
    const trimmed = part.trim();
    if (trimmed.startsWith(`${name}=`)) {
      const value = trimmed.slice(name.length + 1);
      return value.length > 0 && value.length <= MAX_TOKEN_LENGTH ? value : null;
    }
  }
  return null;
}

export function sessionCookie(token: string, maxAgeSeconds: number): string {
  return `${SESSION_COOKIE}=${token}; Path=/; Max-Age=${maxAgeSeconds}; HttpOnly; Secure; SameSite=Strict`;
}

export function clearSessionCookie(): string {
  return `${SESSION_COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Strict`;
}
