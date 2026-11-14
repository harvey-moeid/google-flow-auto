import assert from "node:assert/strict";
import { test } from "node:test";
import { routes } from "../src/routes.ts";
import {
  AUD,
  OWNER,
  TEAM,
  authed,
  call,
  count,
  createHarness,
  createSigner,
  signJwt,
} from "./helpers.ts";

const UUID = "11111111-2222-4333-8444-555555555555";
const WORKER_BODY = { worker_id: "worker-1", fencing_token: 1 };

/** One concrete request per route. The coverage test below fails if a route is added without a sample. */
const SAMPLES: Array<{ method: string; path: string; body?: unknown }> = [
  { method: "GET", path: "/api/me" },
  { method: "GET", path: "/api/accounts" },
  { method: "PATCH", path: "/api/accounts/acct-01", body: { label: "Hacked" } },
  { method: "GET", path: "/api/projects" },
  { method: "POST", path: "/api/projects", body: { name: "Hacked" } },
  { method: "GET", path: "/api/jobs" },
  {
    method: "POST",
    path: "/api/jobs",
    body: { project_id: UUID, account_id: "acct-01", idempotency_key: "hack-attempt-0001" },
  },
  { method: "POST", path: `/api/jobs/${UUID}/cancel` },
  { method: "POST", path: `/api/jobs/${UUID}/resume` },
  { method: "GET", path: "/api/audit" },
  // Worker (service token) routes.
  { method: "POST", path: "/api/worker/claim", body: { worker_id: "worker-1" } },
  { method: "POST", path: `/api/worker/jobs/${UUID}/start`, body: WORKER_BODY },
  { method: "POST", path: `/api/worker/jobs/${UUID}/heartbeat`, body: WORKER_BODY },
  { method: "POST", path: `/api/worker/jobs/${UUID}/complete`, body: WORKER_BODY },
  {
    method: "POST",
    path: `/api/worker/jobs/${UUID}/fail`,
    body: { ...WORKER_BODY, error_code: "boom", retryable: false },
  },
  { method: "POST", path: `/api/worker/jobs/${UUID}/wait`, body: WORKER_BODY },
  { method: "POST", path: `/api/worker/jobs/${UUID}/cancel-ack`, body: WORKER_BODY },
];

test("every route has an auth sample (new routes must be added to SAMPLES)", () => {
  for (const route of routes) {
    assert.ok(
      SAMPLES.some((sample) => sample.method === route.method && route.pattern.test(sample.path)),
      `no auth sample for ${route.method} ${route.pattern}`,
    );
  }
});

test("GET /health is public and reports configuration state without details", async () => {
  const h = await createHarness();
  const res = await call(h, { path: "/health" });
  assert.equal(res.status, 200);
  assert.deepEqual(res.json, { ok: true });
});

test("unauthenticated requests to every route are rejected with 401 and change nothing", async () => {
  const h = await createHarness();
  const before = { projects: count(h.db, "projects"), jobs: count(h.db, "jobs"), audit: count(h.db, "audit_events") };
  const label = h.db.raw.prepare("SELECT label FROM accounts WHERE id='acct-01'").get();
  for (const sample of SAMPLES) {
    const res = await call(h, { method: sample.method, path: sample.path, body: sample.body });
    assert.equal(res.status, 401, `${sample.method} ${sample.path}`);
    assert.equal(res.json.error.code, "unauthorized");
  }
  assert.equal(count(h.db, "projects"), before.projects);
  assert.equal(count(h.db, "jobs"), before.jobs);
  assert.equal(count(h.db, "audit_events"), before.audit);
  assert.deepEqual(h.db.raw.prepare("SELECT label FROM accounts WHERE id='acct-01'").get(), label);
  assert.equal(h.limiter.read.length + h.limiter.write.length, 0, "limiter must not be hit before auth");
});

test("the old static bearer token is no longer accepted", async () => {
  const h = await createHarness({ API_TOKEN: "secret-token" });
  const res = await call(h, {
    method: "POST",
    path: "/api/projects",
    body: { name: "x" },
    headers: { authorization: "Bearer secret-token" },
  });
  assert.equal(res.status, 401);
  assert.equal(count(h.db, "projects"), 0);
});

test("unknown /api routes do not reveal themselves to unauthenticated callers", async () => {
  const h = await createHarness();
  assert.equal((await call(h, { path: "/api/does-not-exist" })).status, 401);
  assert.equal((await authed(h, { path: "/api/does-not-exist" })).status, 404);
});

test("a valid Access token for an allowlisted email is accepted and email is lowercased", async () => {
  const h = await createHarness();
  const token = await h.token({ email: OWNER.toUpperCase() });
  const res = await call(h, { path: "/api/me", token });
  assert.equal(res.status, 200);
  assert.deepEqual(res.json, { email: OWNER, source: "access" });
});

test("aud may be a plain string", async () => {
  const h = await createHarness();
  const res = await call(h, { path: "/api/me", token: await h.token({ aud: AUD }) });
  assert.equal(res.status, 200);
});

test("a valid token for an email that is not allowlisted gets 403", async () => {
  const h = await createHarness();
  const token = await h.token({ email: "stranger@example.com" });
  for (const sample of SAMPLES) {
    const res = await call(h, { method: sample.method, path: sample.path, body: sample.body, token });
    assert.equal(res.status, 403, `${sample.method} ${sample.path}`);
    assert.equal(res.json.error.code, "forbidden");
  }
  assert.equal(count(h.db, "audit_events"), 0);
});

test("invalid tokens are rejected", async () => {
  const h = await createHarness();
  const otherKey = await createSigner("kid-1"); // same kid, different key material
  const cases: Array<[string, string]> = [
    ["garbage", "not-a-jwt"],
    ["empty segments", "a..b"],
    ["wrong signature key", await signJwt(otherKey, h.claims())],
    ["alg none", `${Buffer.from('{"alg":"none","kid":"kid-1"}').toString("base64url")}.${Buffer.from(JSON.stringify(h.claims())).toString("base64url")}.`],
    ["alg HS256", await signJwt(h.signer, h.claims(), { alg: "HS256" })],
    ["wrong audience", await h.token({ aud: ["f".repeat(64)] })],
    ["missing audience", await h.token({ aud: undefined })],
    ["wrong issuer", await h.token({ iss: "https://evil.cloudflareaccess.com" })],
    ["expired", await h.token({ exp: Math.floor(h.clock.now / 1000) - 3600 })],
    ["missing exp", await h.token({ exp: undefined })],
    ["not yet valid", await h.token({ nbf: Math.floor(h.clock.now / 1000) + 3600 })],
    ["missing email", await h.token({ email: undefined })],
    ["email without @", await h.token({ email: "owner" })],
    ["unknown kid", await signJwt(await createSigner("kid-unknown"), h.claims())],
    ["oversized token", "a".repeat(9000)],
  ];
  for (const [name, token] of cases) {
    const res = await call(h, { path: "/api/me", token });
    assert.equal(res.status, 401, name);
  }
});

test("payload tampering invalidates the signature", async () => {
  const h = await createHarness();
  const [head, , signature] = (await h.token()).split(".");
  const forged = Buffer.from(JSON.stringify(h.claims({ email: "attacker@example.com" }))).toString("base64url");
  const res = await call(h, { path: "/api/me", token: `${head}.${forged}.${signature}` });
  assert.equal(res.status, 401);
});

test("small clock skew within leeway is tolerated, beyond it is not", async () => {
  const h = await createHarness();
  const nowSeconds = Math.floor(h.clock.now / 1000);
  assert.equal((await call(h, { path: "/api/me", token: await h.token({ exp: nowSeconds - 30 }) })).status, 200);
  assert.equal((await call(h, { path: "/api/me", token: await h.token({ exp: nowSeconds - 120 }) })).status, 401);
});

test("JWKS outage with no cached keys returns 503, not a misleading 401", async () => {
  const h = await createHarness();
  h.jwks.fail = true;
  const res = await call(h, { path: "/api/me", token: await h.token() });
  assert.equal(res.status, 503);
  assert.equal(res.json.error.code, "auth_unavailable");
});

test("cached keys keep working through a short JWKS outage", async () => {
  const h = await createHarness();
  assert.equal((await call(h, { path: "/api/me", token: await h.token() })).status, 200);
  h.jwks.fail = true;
  h.clock.now += 2 * 60 * 60 * 1000; // past the 1h TTL, within the 24h stale limit
  assert.equal((await call(h, { path: "/api/me", token: await h.token() })).status, 200);
});

test("keys are cached, and key rotation is picked up with throttled refreshes", async () => {
  const h = await createHarness();
  assert.equal((await call(h, { path: "/api/me", token: await h.token() })).status, 200);
  assert.equal((await call(h, { path: "/api/me", token: await h.token() })).status, 200);
  assert.equal(h.jwks.calls, 1, "second request must use the cached key");

  const rotated = await createSigner("kid-2");
  h.jwks.keys = [h.signer, rotated];
  const rotatedToken = await signJwt(rotated, h.claims());
  // Within 60s of the last fetch the unknown kid does not trigger another fetch (flood protection).
  assert.equal((await call(h, { path: "/api/me", token: rotatedToken })).status, 401);
  assert.equal(h.jwks.calls, 1);
  h.clock.now += 61 * 1000;
  const fresh = await signJwt(rotated, h.claims({ exp: Math.floor(h.clock.now / 1000) + 3600 }));
  assert.equal((await call(h, { path: "/api/me", token: fresh })).status, 200);
  assert.equal(h.jwks.calls, 2);
});

test("many requests with unknown kids cause at most one JWKS fetch per minute", async () => {
  const h = await createHarness();
  const stranger = await createSigner("kid-flood");
  const token = await signJwt(stranger, h.claims());
  for (let i = 0; i < 20; i += 1) await call(h, { path: "/api/me", token });
  assert.equal(h.jwks.calls, 1);
});

test("development bypass works only for APP_ENV=development on a loopback host", async () => {
  const dev = await createHarness({ APP_ENV: "development", DEV_AUTH_EMAIL: "Dev@Example.test", CF_ACCESS_TEAM_DOMAIN: "", CF_ACCESS_AUD: "", ALLOWED_EMAILS: "", RL_READ: undefined, RL_WRITE: undefined });
  const local = await call(dev, { path: "/api/me", base: "http://localhost:8787" });
  assert.equal(local.status, 200);
  assert.deepEqual(local.json, { email: "dev@example.test", source: "dev" });
  const remoteHost = await call(dev, { path: "/api/me", base: "https://tunnel.example.org" });
  assert.equal(remoteHost.status, 401, "non-loopback host must not get the bypass");

  const prod = await createHarness({ DEV_AUTH_EMAIL: "dev@example.test" });
  const res = await call(prod, { path: "/api/me", base: "http://localhost:8787" });
  assert.equal(res.status, 401, "DEV_AUTH_EMAIL must be ignored outside APP_ENV=development");

  const staging = await createHarness({ APP_ENV: "staging", DEV_AUTH_EMAIL: "dev@example.test" });
  assert.equal((await call(staging, { path: "/api/me", base: "http://localhost:8787" })).status, 401);
});

test("tokens are bound to the configured team domain (issuer) and application (audience)", async () => {
  const h = await createHarness();
  const good = await call(h, { path: "/api/me", token: await h.token() });
  assert.equal(good.status, 200);
  const otherTeam = await signJwt(h.signer, h.claims({ iss: `https://other.cloudflareaccess.com` }));
  assert.equal((await call(h, { path: "/api/me", token: otherTeam })).status, 401);
  assert.equal(TEAM.endsWith(".cloudflareaccess.com"), true);
});
