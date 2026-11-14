import { SERVICE_ID_RE } from "./config.ts";
import { b64urlToBytes } from "./encoding.ts";
import type { Deps } from "./types.ts";

const JWKS_TTL_MS = 60 * 60 * 1000; // refresh keys hourly
const JWKS_MIN_REFRESH_MS = 60 * 1000; // never refetch more often than this (unknown-kid floods)
const JWKS_MAX_STALE_MS = 24 * 60 * 60 * 1000; // tolerate a JWKS outage for at most a day
const CLOCK_LEEWAY_S = 60;
const MAX_TOKEN_LENGTH = 8192;

export type VerifyFailure =
  | "malformed_token"
  | "bad_algorithm"
  | "unknown_key"
  | "bad_signature"
  | "bad_issuer"
  | "bad_audience"
  | "expired"
  | "not_yet_valid"
  | "missing_email"
  | "jwks_unavailable";

/**
 * A verified token is either a human (has an `email` claim) or an Access service token
 * (no email; the Client ID is in `common_name`). Callers decide what each kind may do.
 */
export type VerifyResult =
  | { ok: true; kind: "owner"; email: string }
  | { ok: true; kind: "service"; clientId: string }
  | { ok: false; reason: VerifyFailure };

interface Jwk {
  kty?: unknown;
  kid?: unknown;
  n?: unknown;
  e?: unknown;
  alg?: unknown;
}

interface KeyCache {
  keys: Map<string, CryptoKey>;
  fetchedAt: number;
  lastAttemptAt: number;
  inflight: Promise<void> | null;
}

function decodeJson(segment: string): Record<string, unknown> | null {
  try {
    const value = JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(b64urlToBytes(segment)));
    return value !== null && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/**
 * Verifies Cloudflare Access JWTs (RS256) against the team's published JWKS.
 * Checks signature, kid, iss, aud, exp and nbf. Keys are cached per team domain.
 */
export function createAccessVerifier(deps: Deps) {
  const caches = new Map<string, KeyCache>();

  async function refresh(teamDomain: string, cache: KeyCache): Promise<void> {
    cache.lastAttemptAt = deps.now();
    const res = await deps.fetch(`https://${teamDomain}/cdn-cgi/access/certs`, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(3000),
    });
    if (!res.ok) throw new Error(`jwks status ${res.status}`);
    const body = (await res.json()) as { keys?: unknown };
    if (!Array.isArray(body.keys)) throw new Error("jwks shape");
    const next = new Map<string, CryptoKey>();
    for (const raw of body.keys as Jwk[]) {
      if (raw.kty !== "RSA" || typeof raw.kid !== "string" || typeof raw.n !== "string" || typeof raw.e !== "string") continue;
      if (raw.alg !== undefined && raw.alg !== "RS256") continue;
      const key = await crypto.subtle.importKey(
        "jwk",
        { kty: "RSA", n: raw.n, e: raw.e, alg: "RS256", ext: true },
        { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
        false,
        ["verify"],
      );
      next.set(raw.kid, key);
    }
    if (next.size === 0) throw new Error("jwks empty");
    cache.keys = next;
    cache.fetchedAt = deps.now();
  }

  async function getKey(teamDomain: string, kid: string): Promise<CryptoKey | "unavailable" | null> {
    let cache = caches.get(teamDomain);
    if (!cache) {
      cache = { keys: new Map(), fetchedAt: 0, lastAttemptAt: 0, inflight: null };
      caches.set(teamDomain, cache);
    }
    const now = deps.now();
    const cached = cache.keys.get(kid);
    if (cached && now - cache.fetchedAt < JWKS_TTL_MS) return cached;

    let refreshFailed = false;
    if (now - cache.lastAttemptAt >= JWKS_MIN_REFRESH_MS) {
      if (!cache.inflight) {
        const state = cache;
        state.inflight = refresh(teamDomain, state).finally(() => {
          state.inflight = null;
        });
      }
      try {
        await cache.inflight;
      } catch {
        refreshFailed = true;
      }
    } else if (cache.inflight) {
      try {
        await cache.inflight;
      } catch {
        refreshFailed = true;
      }
    }

    const key = cache.keys.get(kid);
    if (key && deps.now() - cache.fetchedAt < JWKS_MAX_STALE_MS) return key;
    if (refreshFailed && cache.keys.size === 0) return "unavailable";
    return null;
  }

  async function verify(token: string, expected: { teamDomain: string; aud: string }): Promise<VerifyResult> {
    if (token.length > MAX_TOKEN_LENGTH) return { ok: false, reason: "malformed_token" };
    const parts = token.split(".");
    if (parts.length !== 3 || parts.some((part) => part.length === 0)) return { ok: false, reason: "malformed_token" };
    const [headerPart, payloadPart, signaturePart] = parts;

    const header = decodeJson(headerPart);
    if (!header) return { ok: false, reason: "malformed_token" };
    if (header.alg !== "RS256") return { ok: false, reason: "bad_algorithm" };
    if (typeof header.kid !== "string" || header.kid.length === 0) return { ok: false, reason: "malformed_token" };

    let signature: Uint8Array<ArrayBuffer>;
    try {
      signature = b64urlToBytes(signaturePart);
    } catch {
      return { ok: false, reason: "malformed_token" };
    }

    const key = await getKey(expected.teamDomain, header.kid);
    if (key === "unavailable") return { ok: false, reason: "jwks_unavailable" };
    if (key === null) return { ok: false, reason: "unknown_key" };

    const signedData = new TextEncoder().encode(`${headerPart}.${payloadPart}`);
    const valid = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, signature, signedData);
    if (!valid) return { ok: false, reason: "bad_signature" };

    const claims = decodeJson(payloadPart);
    if (!claims) return { ok: false, reason: "malformed_token" };
    if (claims.iss !== `https://${expected.teamDomain}`) return { ok: false, reason: "bad_issuer" };
    const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    if (!audiences.includes(expected.aud)) return { ok: false, reason: "bad_audience" };

    const nowSeconds = Math.floor(deps.now() / 1000);
    if (typeof claims.exp !== "number" || claims.exp + CLOCK_LEEWAY_S <= nowSeconds) {
      return { ok: false, reason: "expired" };
    }
    if (typeof claims.nbf === "number" && claims.nbf - CLOCK_LEEWAY_S > nowSeconds) {
      return { ok: false, reason: "not_yet_valid" };
    }
    // A human identity token carries an email. If an email claim is present at all it decides
    // the kind (a malformed email is rejected, never reinterpreted as a service token).
    if (claims.email !== undefined) {
      if (typeof claims.email !== "string" || !claims.email.includes("@")) {
        return { ok: false, reason: "missing_email" };
      }
      return { ok: true, kind: "owner", email: claims.email.trim().toLowerCase() };
    }
    // Access service tokens have no email; the token's Client ID is the `common_name` claim.
    if (typeof claims.common_name === "string" && SERVICE_ID_RE.test(claims.common_name)) {
      return { ok: true, kind: "service", clientId: claims.common_name };
    }
    return { ok: false, reason: "missing_email" };
  }

  return { verify };
}
