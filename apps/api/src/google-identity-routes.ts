import { HttpError, jsonResponse, readJsonObject } from "./http.ts";
import { auditStatement } from "./route-types.ts";
import type { Ctx, Route } from "./route-types.ts";
import { Issues, UUID_RE, readString, rejectUnknownFields } from "./validate.ts";
const TTL = 5 * 60 * 1000;
const JWKS_URL = "https://www.googleapis.com/oauth2/v3/certs";
const ISSUERS = new Set(["accounts.google.com", "https://accounts.google.com"]);
type Claims = { iss?: unknown; aud?: unknown; azp?: unknown; exp?: unknown; iat?: unknown; sub?: unknown; email?: unknown; email_verified?: unknown; nonce?: unknown };
type Jwk = JsonWebKey & { kid?: string; alg?: string; use?: string };
let jwksCache: { keys: Jwk[]; expires: number } | null = null;
function decode64(value: string): Uint8Array {
 const s = value.replace(/-/g, "+").replace(/_/g, "/"); const binary = atob(s + "=".repeat((4 - s.length % 4) % 4));
 return Uint8Array.from(binary, c => c.charCodeAt(0));
}
function decodeJson<T>(value: string): T { return JSON.parse(new TextDecoder().decode(decode64(value))) as T; }
function encode64(bytes: Uint8Array): string {
 let binary = ""; for (const b of bytes) binary += String.fromCharCode(b);
 return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}
async function hash(value: string): Promise<string> {
 return encode64(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))));
}
async function getKeys(now: number): Promise<Jwk[]> {
 if (jwksCache && jwksCache.expires > now) return jwksCache.keys;
 const res = await fetch(JWKS_URL, { headers: { accept: "application/json" } });
 if (!res.ok) throw new HttpError(503, "google_keys_unavailable", "Google verification keys are unavailable");
 const body = await res.json() as { keys?: Jwk[] };
 if (!Array.isArray(body.keys) || !body.keys.length) throw new HttpError(503, "google_keys_unavailable", "Google verification keys are unavailable");
 const maxAge = /max-age=(\d+)/i.exec(res.headers.get("cache-control") ?? "")?.[1];
 jwksCache = { keys: body.keys, expires: now + Math.min(Math.max(Number(maxAge ?? 3600), 60), 86400) * 1000 };
 return body.keys;
}
async function verifyToken(token: string, clientId: string, nonceHash: string, now: number) {
 const parts = token.split(".");
 if (parts.length !== 3 || parts.some(p => !p)) throw new HttpError(401, "google_token_invalid", "Google identity token is invalid");
 let header: { alg?: string; kid?: string }; let claims: Claims;
 try { header = decodeJson(parts[0]); claims = decodeJson(parts[1]); }
 catch { throw new HttpError(401, "google_token_invalid", "Google identity token is invalid"); }
 if (header.alg !== "RS256" || !header.kid) throw new HttpError(401, "google_token_invalid", "Google identity token is invalid");
 let keys = await getKeys(now);
 let jwk = keys.find(k => k.kid === header.kid && k.alg === "RS256" && k.use === "sig");
 if (!jwk) { jwksCache = null; keys = await getKeys(now); jwk = keys.find(k => k.kid === header.kid && k.alg === "RS256" && k.use === "sig"); }
 if (!jwk) throw new HttpError(401, "google_token_invalid", "Google identity token is invalid");
 let signatureOk = false;
 try {
  const key = await crypto.subtle.importKey("jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
  signatureOk = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, decode64(parts[2]), new TextEncoder().encode(parts[0] + "." + parts[1]));
 } catch { signatureOk = false; }
 const nowS = Math.floor(now / 1000); const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
 const emailVerified = claims.email_verified === true || claims.email_verified === "true";
 if (!signatureOk || typeof claims.iss !== "string" || !ISSUERS.has(claims.iss) ||
  !aud.includes(clientId) || (claims.azp !== undefined && claims.azp !== clientId) ||
  typeof claims.exp !== "number" || claims.exp <= nowS ||
  typeof claims.iat !== "number" || claims.iat > nowS + 60 || claims.iat < nowS - 3600 ||
  typeof claims.sub !== "string" || !claims.sub || claims.sub.length > 255 ||
  typeof claims.email !== "string" || claims.email.length > 254 || !/^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$/.test(claims.email) || !emailVerified ||
  typeof claims.nonce !== "string" || await hash(claims.nonce) !== nonceHash) {
  throw new HttpError(401, "google_token_invalid", "Google identity token is invalid or does not match this enrollment");
 }
 return { sub: claims.sub, email: claims.email.trim().toLowerCase() };
}
function nonceValue(): string { return encode64(crypto.getRandomValues(new Uint8Array(32))); }
async function challenge(ctx: Ctx): Promise<Response> {
 const accountId = ctx.params[0];
 if (!ctx.env.GOOGLE_CLIENT_ID) throw new HttpError(503, "google_identity_not_configured", "Google identity linking is not configured");
 const exists = await ctx.env.DB.prepare("SELECT id FROM accounts WHERE id=?").bind(accountId).first();
 if (!exists) throw new HttpError(404, "account_not_found", "Account not found");
 const nonce = nonceValue(); const nonceHash = await hash(nonce); const id = crypto.randomUUID(); const now = ctx.now();
 await ctx.env.DB.batch([
  ctx.env.DB.prepare("DELETE FROM account_enrollment_challenges WHERE account_id=? AND consumed_at IS NULL").bind(accountId),
  ctx.env.DB.prepare("INSERT INTO account_enrollment_challenges(id,account_id,nonce_hash,expires_at) VALUES(?,?,?,datetime(?/1000,'unixepoch'))").bind(id, accountId, nonceHash, now + TTL),
  auditStatement(ctx, "account.google_identity.challenge_created", { account_id: accountId }, {}),
 ]);
 return jsonResponse({ challenge_id: id, nonce, expires_at: new Date(now + TTL).toISOString() }, 201);
}
async function verify(ctx: Ctx): Promise<Response> {
 const accountId = ctx.params[0]; const body = await readJsonObject(ctx.req, 12 * 1024); const issues = new Issues();
 rejectUnknownFields(body, ["challenge_id", "credential"], issues);
 const challengeId = readString(body, "challenge_id", { required: true, max: 36, pattern: UUID_RE }, issues);
 const credential = readString(body, "credential", { required: true, min: 100, max: 10000 }, issues);
 issues.throwIfAny();
 if (!challengeId || !credential) throw new HttpError(400, "validation_failed", "Request validation failed");
 if (!ctx.env.GOOGLE_CLIENT_ID) throw new HttpError(503, "google_identity_not_configured", "Google identity linking is not configured");
 const row = await ctx.env.DB.prepare("SELECT nonce_hash,expires_at,consumed_at FROM account_enrollment_challenges WHERE id=? AND account_id=?")
  .bind(challengeId, accountId).first<{ nonce_hash: string; expires_at: string; consumed_at: string | null }>();
 const expiry = row ? Date.parse(row.expires_at.replace(" ", "T") + (row.expires_at.includes("Z") ? "" : "Z")) : 0;
 if (!row || row.consumed_at || expiry <= ctx.now()) throw new HttpError(409, "enrollment_challenge_expired", "Enrollment challenge expired or was already used");
 const identity = await verifyToken(credential, ctx.env.GOOGLE_CLIENT_ID, row.nonce_hash, ctx.now());
 const verifiedAt = new Date(ctx.now()).toISOString();
 try {
  const results = await ctx.env.DB.batch([
   ctx.env.DB.prepare("UPDATE account_enrollment_challenges SET consumed_at=? WHERE id=? AND account_id=? AND consumed_at IS NULL AND expires_at>datetime(?/1000,'unixepoch')").bind(verifiedAt, challengeId, accountId, ctx.now()),
   ctx.env.DB.prepare("INSERT INTO account_google_identities(account_id,google_sub,email,verified_at) SELECT ?,?,?,? WHERE EXISTS (SELECT 1 FROM account_enrollment_challenges WHERE id=? AND account_id=? AND consumed_at=?)").bind(accountId, identity.sub, identity.email, verifiedAt, challengeId, accountId, verifiedAt),
   ctx.env.DB.prepare("UPDATE accounts SET email=?,updated_at=CURRENT_TIMESTAMP WHERE id=? AND EXISTS (SELECT 1 FROM account_google_identities WHERE account_id=? AND google_sub=?)").bind(identity.email, accountId, accountId, identity.sub),
   auditStatement(ctx, "account.google_identity.verified", { account_id: accountId }, {}),
  ]);
  if (results[0].meta.changes !== 1 || results[1].meta.changes !== 1) throw new HttpError(409, "enrollment_challenge_expired", "Enrollment challenge expired or was already used");
 } catch (error) {
  if (error instanceof HttpError) throw error;
  if (/unique|constraint/i.test(String(error))) throw new HttpError(409, "google_identity_already_linked", "Google identity is already linked to an account slot");
  throw error;
 }
 return jsonResponse({ account_id: accountId, email: identity.email, verified_at: verifiedAt, flow_connected: false });
}
async function unlink(ctx: Ctx): Promise<Response> {
 const accountId = ctx.params[0]; const body = await readJsonObject(ctx.req, 1024); const issues = new Issues();
 rejectUnknownFields(body, ["confirm"], issues); if (body.confirm !== true) issues.add("confirm", "must_be_true"); issues.throwIfAny();
 const row = await ctx.env.DB.prepare("SELECT email FROM account_google_identities WHERE account_id=?").bind(accountId).first<{ email: string }>();
 if (!row) throw new HttpError(404, "google_identity_not_found", "No Google identity is linked to this slot");
 await ctx.env.DB.batch([
  ctx.env.DB.prepare("UPDATE accounts SET email=NULL,updated_at=CURRENT_TIMESTAMP WHERE id=? AND email=?").bind(accountId, row.email),
  ctx.env.DB.prepare("DELETE FROM account_google_identities WHERE account_id=?").bind(accountId),
  auditStatement(ctx, "account.google_identity.unlinked", { account_id: accountId }, {}),
 ]);
 return jsonResponse({ account_id: accountId, unlinked: true });
}
export const googleIdentityRoutes: Route[] = [
 { method: "POST", pattern: /^\/api\/accounts\/(acct-(?:0[1-9]|10))\/google-identity\/challenge$/, write: true, audience: "owner", handler: challenge },
 { method: "POST", pattern: /^\/api\/accounts\/(acct-(?:0[1-9]|10))\/google-identity\/verify$/, write: true, audience: "owner", handler: verify },
 { method: "POST", pattern: /^\/api\/accounts\/(acct-(?:0[1-9]|10))\/google-identity\/unlink$/, write: true, audience: "owner", handler: unlink },
];