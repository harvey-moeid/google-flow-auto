import assert from "node:assert/strict";
import { test } from "node:test";
import { authed, createHarness, count } from "./helpers.ts";

const encoder = new TextEncoder();
function b64url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}
function encodeJson(value: unknown): string {
  return b64url(encoder.encode(JSON.stringify(value)));
}

test("Android Google identity enrollment verifies a signed GIS token without marking the Flow slot ready", async () => {
  const h = await createHarness({ GOOGLE_CLIENT_ID: "gfa-test-web-client.apps.googleusercontent.com" });
  const originalFetch = globalThis.fetch;
  const pair = await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign", "verify"],
  );
  const jwk = await crypto.subtle.exportKey("jwk", pair.publicKey);
  const kid = "gfa-test-" + crypto.randomUUID();
  Object.assign(jwk, { kid, alg: "RS256", use: "sig" });
  globalThis.fetch = async () => new Response(JSON.stringify({ keys: [jwk] }), {
    status: 200,
    headers: { "content-type": "application/json", "cache-control": "public, max-age=3600" },
  });

  async function signedCredential(nonce: string, sub: string, email: string): Promise<string> {
    const now = Math.floor(h.clock.now / 1000);
    const head = encodeJson({ alg: "RS256", typ: "JWT", kid });
    const payload = encodeJson({
      iss: "https://accounts.google.com",
      aud: "gfa-test-web-client.apps.googleusercontent.com",
      sub,
      email,
      email_verified: true,
      iat: now,
      exp: now + 3600,
      nonce,
    });
    const input = head + "." + payload;
    const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", pair.privateKey, encoder.encode(input));
    return input + "." + b64url(new Uint8Array(signature));
  }

  try {
    const challenge = await authed(h, {
      method: "POST",
      path: "/api/accounts/acct-01/google-identity/challenge",
      body: {},
    });
    assert.equal(challenge.status, 201);
    const rawNonce = challenge.json.nonce as string;
    const stored = h.db.raw.prepare("SELECT nonce_hash FROM account_enrollment_challenges WHERE id=?").get(challenge.json.challenge_id) as { nonce_hash: string };
    assert.notEqual(stored.nonce_hash, rawNonce, "only the nonce hash is stored");

    const credential = await signedCredential(rawNonce, "google-subject-001", "owner@example.com");
    const linked = await authed(h, {
      method: "POST",
      path: "/api/accounts/acct-01/google-identity/verify",
      body: { challenge_id: challenge.json.challenge_id, credential },
    });
    assert.equal(linked.status, 200, linked.text);
    assert.equal(linked.json.email, "owner@example.com");
    assert.equal(linked.json.flow_connected, false);
    assert.equal(h.db.raw.prepare("SELECT status FROM accounts WHERE id='acct-01'").get()?.status, "needs_login");
    assert.equal(count(h.db, "account_google_identities"), 1);
    assert.equal(count(h.db, "audit_events"), 2);

    const listed = await authed(h, { path: "/api/accounts" });
    assert.equal(listed.json.items[0].email, "owner@example.com");
    assert.ok(listed.json.items[0].google_identity_verified_at);

    const replay = await authed(h, {
      method: "POST",
      path: "/api/accounts/acct-01/google-identity/verify",
      body: { challenge_id: challenge.json.challenge_id, credential },
    });
    assert.equal(replay.status, 409);

    const second = await authed(h, {
      method: "POST",
      path: "/api/accounts/acct-02/google-identity/challenge",
      body: {},
    });
    const secondCredential = await signedCredential(second.json.nonce, "google-subject-001", "owner@example.com");
    const duplicate = await authed(h, {
      method: "POST",
      path: "/api/accounts/acct-02/google-identity/verify",
      body: { challenge_id: second.json.challenge_id, credential: secondCredential },
    });
    assert.equal(duplicate.status, 409);
    assert.equal(duplicate.json.error.code, "google_identity_already_linked");
    assert.equal(count(h.db, "account_google_identities"), 1);
    assert.equal(h.db.raw.prepare("SELECT status FROM accounts WHERE id='acct-02'").get()?.status, "needs_login");

    const unlinked = await authed(h, {
      method: "POST",
      path: "/api/accounts/acct-01/google-identity/unlink",
      body: { confirm: true },
    });
    assert.equal(unlinked.status, 200);
    assert.equal(count(h.db, "account_google_identities"), 0);
    assert.equal(h.db.raw.prepare("SELECT status FROM accounts WHERE id='acct-01'").get()?.status, "needs_login");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Google identity challenge is unavailable until the public OAuth client ID is configured", async () => {
  const h = await createHarness();
  const res = await authed(h, { method: "POST", path: "/api/accounts/acct-01/google-identity/challenge", body: {} });
  assert.equal(res.status, 503);
  assert.equal(res.json.error.code, "google_identity_not_configured");
  assert.equal(count(h.db, "account_enrollment_challenges"), 0);
});
