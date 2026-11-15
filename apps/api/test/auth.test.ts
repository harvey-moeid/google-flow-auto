import assert from "node:assert/strict";
import { test } from "node:test";
import {
  SESSION_COOKIE,
  SESSION_TTL_S,
  createSessionToken,
  readCookie,
  secretsEqual,
  verifySessionToken,
} from "../src/auth.ts";
import { routes } from "../src/routes.ts";
import {
  BASE,
  OWNER_PASSWORD,
  SESSION_SECRET,
  WORKER_TOKEN,
  asWorker,
  authed,
  call,
  count,
  createHarness,
  createProject,
  makeAccountReady,
} from "./helpers.ts";
import type { Harness } from "./helpers.ts";

const UUID = "11111111-2222-4333-8444-555555555555";
const WORKER_BODY = { worker_id: "worker-1", fencing_token: 1 };

/** One concrete request per route. The coverage test below fails if a route is added without a sample. */
const SAMPLES: Array<{ method: string; path: string; body?: unknown }> = [
  { method: "GET", path: "/api/me" },
  { method: "GET", path: "/api/accounts" },
  { method: "POST", path: "/api/accounts/acct-01/google-identity/challenge" },
  { method: "POST", path: "/api/accounts/acct-01/google-identity/verify", body: { challenge_id: UUID, credential: "x".repeat(100) } },
  { method: "POST", path: "/api/accounts/acct-01/google-identity/unlink", body: { confirm: true } },
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
  { method: "GET", path: `/api/projects/${UUID}` },
  { method: "PATCH", path: `/api/projects/${UUID}`, body: { name: "Hacked" } },
  { method: "POST", path: `/api/projects/${UUID}/scenes`, body: { prompt: "hack" } },
  { method: "POST", path: `/api/projects/${UUID}/scenes/reorder`, body: { scene_ids: [UUID] } },
  { method: "GET", path: `/api/projects/${UUID}/readiness` },
  {
    method: "POST",
    path: `/api/projects/${UUID}/submit`,
    body: { account_id: "acct-01", idempotency_key: "hack-attempt-0001", expected_scene_count: 1 },
  },
  { method: "PATCH", path: `/api/scenes/${UUID}`, body: { prompt: "hack" } },
  { method: "POST", path: `/api/scenes/${UUID}/delete` },
  { method: "GET", path: `/api/jobs/${UUID}` },
  { method: "POST", path: `/api/jobs/${UUID}/retry`, body: { idempotency_key: "hack-attempt-0001" } },
  // Worker (bearer token) routes.
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
  { method: "POST", path: `/api/worker/jobs/${UUID}/media` },
  { method: "GET", path: `/api/jobs/${UUID}/media` },
  { method: "GET", path: `/api/media/${UUID}` },
  { method: "POST", path: `/api/media/${UUID}/delete` },
  { method: "GET", path: "/api/workers" },
  { method: "POST", path: "/api/worker/status", body: { worker_id: "worker-1", state: "idle", profile_count: 0 } },
  {
    method: "POST",
    path: "/api/worker/accounts/acct-01/readiness",
    body: { worker_id: "worker-1", status: "ready", owner_confirmed: true },
  },
];

const isWorkerSample = (sample: { path: string }) => sample.path.startsWith("/api/worker/");
const OWNER_SAMPLES = SAMPLES.filter((sample) => !isWorkerSample(sample));
const WORKER_SAMPLES = SAMPLES.filter(isWorkerSample);

const TTL_MS = SESSION_TTL_S * 1000;

function sessionTokenFrom(setCookie: string | null): string {
  const match = new RegExp(`^${SESSION_COOKIE}=([^;]+)`).exec(setCookie ?? "");
  assert.ok(match, "response must set the session cookie");
  return match[1];
}

function snapshot(h: Harness) {
  return {
    projects: count(h.db, "projects"),
    jobs: count(h.db, "jobs"),
    audit: count(h.db, "audit_events"),
    label: h.db.raw.prepare("SELECT label FROM accounts WHERE id='acct-01'").get(),
  };
}

// ---------- route table and public surface ----------

test("every route has an auth sample (new routes must be added to SAMPLES)", () => {
  for (const route of routes) {
    assert.ok(
      SAMPLES.some((sample) => sample.method === route.method && route.pattern.test(sample.path)),
      `no auth sample for ${route.method} ${route.pattern}`,
    );
  }
  assert.ok(OWNER_SAMPLES.length > 0 && WORKER_SAMPLES.length > 0);
});

test("GET /health is public and reports configuration state without details", async () => {
  const h = await createHarness();
  const res = await call(h, { path: "/health" });
  assert.equal(res.status, 200);
  assert.deepEqual(res.json, { ok: true });
});

test("unauthenticated requests to every route are rejected with 401 and change nothing", async () => {
  const h = await createHarness();
  const before = snapshot(h);
  for (const sample of SAMPLES) {
    const res = await call(h, { method: sample.method, path: sample.path, body: sample.body });
    assert.equal(res.status, 401, `${sample.method} ${sample.path}`);
    assert.equal(res.json.error.code, "unauthorized");
  }
  assert.deepEqual(snapshot(h), before);
  const hits = h.limiter.read.length + h.limiter.write.length + h.limiter.worker.length + h.limiter.login.length;
  assert.equal(hits, 0, "limiters must not be hit before authentication");
});

test("unknown /api routes do not reveal themselves to unauthenticated callers", async () => {
  const h = await createHarness();
  assert.equal((await call(h, { path: "/api/does-not-exist" })).status, 401);
  assert.equal((await authed(h, { path: "/api/does-not-exist" })).status, 404);
});

// ---------- login ----------

test("login with the right password sets a hardened session cookie that then authenticates", async () => {
  const h = await createHarness();
  const res = await call(h, {
    method: "POST",
    path: "/api/login",
    body: { password: OWNER_PASSWORD },
    headers: { "cf-connecting-ip": "203.0.113.7" },
  });
  assert.equal(res.status, 200);
  assert.equal(res.json.ok, true);
  assert.equal(res.json.expires_at, new Date(h.clock.now + TTL_MS).toISOString());

  const setCookie = res.headers.get("set-cookie") ?? "";
  assert.ok(SESSION_COOKIE.startsWith("__Host-"), "cookie must be host-locked");
  for (const attribute of ["HttpOnly", "Secure", "SameSite=Strict", "Path=/", `Max-Age=${SESSION_TTL_S}`]) {
    assert.ok(setCookie.includes(attribute), `missing ${attribute}`);
  }
  assert.ok(!/domain=/i.test(setCookie), "a __Host- cookie must not set Domain");
  assert.ok(!setCookie.includes(OWNER_PASSWORD) && !res.text.includes(OWNER_PASSWORD), "password is never echoed");
  assert.deepEqual(h.limiter.login, ["l:203.0.113.7"], "login is throttled per client address");

  const me = await call(h, { path: "/api/me", session: sessionTokenFrom(setCookie) });
  assert.equal(me.status, 200);
  assert.deepEqual(me.json, { name: "owner", source: "password" });
  assert.ok(!("email" in me.json));
});

test("wrong passwords are rejected with the same generic 401 and set no cookie", async () => {
  const h = await createHarness();
  for (const password of ["wrong", OWNER_PASSWORD.slice(0, -1), `${OWNER_PASSWORD}x`, OWNER_PASSWORD.toUpperCase(), " "]) {
    const res = await call(h, { method: "POST", path: "/api/login", body: { password } });
    assert.equal(res.status, 401, JSON.stringify(password));
    assert.equal(res.json.error.code, "invalid_credentials");
    assert.equal(res.headers.get("set-cookie"), null);
    assert.ok(!res.text.includes(password.trim() || "\u0000"), "response must not echo the attempt");
  }
});

test("login validates its body strictly", async () => {
  const h = await createHarness();
  const bodies: unknown[] = [
    {},
    { password: "" },
    { password: 123 },
    { password: null },
    { password: ["a"] },
    { password: "x".repeat(257) },
    { password: OWNER_PASSWORD, remember: true },
    { pass: OWNER_PASSWORD },
  ];
  for (const body of bodies) {
    const res = await call(h, { method: "POST", path: "/api/login", body });
    assert.equal(res.status, 400, JSON.stringify(body));
    assert.equal(res.json.error.code, "validation_failed");
    assert.equal(res.headers.get("set-cookie"), null);
  }
  assert.equal((await call(h, { method: "POST", path: "/api/login", rawBody: "{" })).status, 400);
  assert.equal(
    (await call(h, { method: "POST", path: "/api/login", rawBody: "password=x", headers: { "content-type": "text/plain" } })).status,
    415,
  );
  const huge = await call(h, { method: "POST", path: "/api/login", rawBody: JSON.stringify({ password: "y".repeat(2000) }) });
  assert.equal(huge.status, 413, "login bodies are capped at 1 KiB");
});

test("login and logout accept POST only", async () => {
  const h = await createHarness();
  for (const path of ["/api/login", "/api/logout"]) {
    for (const method of ["GET", "PUT", "DELETE"]) {
      const res = await call(h, { method, path });
      assert.equal(res.status, 405, `${method} ${path}`);
      assert.equal(res.headers.get("allow"), "POST");
    }
  }
});

test("login is rate limited before any password comparison", async () => {
  const h = await createHarness();
  h.limiter.allowLogin = false;
  const res = await call(h, { method: "POST", path: "/api/login", body: { password: OWNER_PASSWORD } });
  assert.equal(res.status, 429, "even the right password is refused while throttled");
  assert.equal(res.json.error.code, "rate_limited");
  assert.equal(res.headers.get("retry-after"), "60");
  assert.equal(res.headers.get("set-cookie"), null);
});

test("a failing limiter does not lock the owner out of login", async () => {
  const h = await createHarness();
  h.limiter.throws = true;
  const res = await call(h, { method: "POST", path: "/api/login", body: { password: OWNER_PASSWORD } });
  assert.equal(res.status, 200);
});

test("login and logout enforce the Origin check (login CSRF)", async () => {
  const h = await createHarness();
  for (const path of ["/api/login", "/api/logout"]) {
    for (const origin of ["https://evil.example.com", "null"]) {
      const res = await call(h, { method: "POST", path, body: { password: OWNER_PASSWORD }, origin });
      assert.equal(res.status, 403, `${path} from ${origin}`);
      assert.equal(res.json.error.code, "origin_not_allowed");
      assert.equal(res.headers.get("set-cookie"), null);
    }
  }
  const same = await call(h, { method: "POST", path: "/api/login", body: { password: OWNER_PASSWORD }, origin: BASE });
  assert.equal(same.status, 200);
});

test("login fails closed (503) when the password or session secret is not configured", async () => {
  for (const override of [{ OWNER_PASSWORD: "" }, { SESSION_SECRET: "short" }, { OWNER_PASSWORD: "REPLACE_WITH_OWNER_PASSWORD" }]) {
    const h = await createHarness(override);
    const res = await call(h, { method: "POST", path: "/api/login", body: { password: OWNER_PASSWORD } });
    assert.equal(res.status, 503, JSON.stringify(override));
    assert.equal(res.json.error.code, "server_misconfigured");
    assert.equal(res.headers.get("set-cookie"), null);
  }
});

test("logout clears the session cookie without needing a session", async () => {
  const h = await createHarness();
  const res = await call(h, { method: "POST", path: "/api/logout" });
  assert.equal(res.status, 200);
  assert.deepEqual(res.json, { ok: true });
  const setCookie = res.headers.get("set-cookie") ?? "";
  assert.ok(setCookie.startsWith(`${SESSION_COOKIE}=;`));
  assert.ok(setCookie.includes("Max-Age=0"));
});

// ---------- session tokens ----------

test("invalid session cookies are rejected on every owner route", async () => {
  const h = await createHarness();
  const good = await h.session();
  const [payload, signature] = good.split(".");
  const widened = Buffer.from(JSON.stringify({ v: 1, iat: 0, exp: Math.floor(h.clock.now / 1000) + 10 * SESSION_TTL_S })).toString("base64url");
  const flipped = `${signature.slice(0, -1)}${signature.endsWith("A") ? "B" : "A"}`;
  const cases: Array<[string, string]> = [
    ["garbage", "not-a-session"],
    ["too few parts", "abc"],
    ["too many parts", `${good}.extra`],
    ["bad base64", "!!!.!!!"],
    ["empty payload", `.${signature}`],
    ["empty signature", `${payload}.`],
    ["signed with another secret", await h.session({ secret: "another-secret-another-secret-0123456789" })],
    ["payload tampered, signature kept", `${widened}.${signature}`],
    ["signature bit-flipped", `${payload}.${flipped}`],
    ["expired", await h.session({ nowMs: h.clock.now - TTL_MS - 1000 })],
    ["issued in the future", await h.session({ nowMs: h.clock.now + 120_000 })],
    ["lifetime beyond the maximum", await h.session({ ttlSeconds: SESSION_TTL_S + 1 })],
    ["oversized", "a".repeat(600)],
  ];
  const before = snapshot(h);
  for (const [name, token] of cases) {
    for (const sample of OWNER_SAMPLES) {
      const res = await call(h, { method: sample.method, path: sample.path, body: sample.body, session: token });
      assert.equal(res.status, 401, `${name}: ${sample.method} ${sample.path}`);
    }
  }
  assert.deepEqual(snapshot(h), before);
});

test("session lifetime boundaries: valid until expiry, small clock skew tolerated", async () => {
  const h = await createHarness();
  const token = await h.session();
  h.clock.now += TTL_MS - 1000;
  assert.equal((await call(h, { path: "/api/me", session: token })).status, 200, "one second before expiry");
  h.clock.now += 1000;
  assert.equal((await call(h, { path: "/api/me", session: token })).status, 401, "at expiry");

  const fresh = await createHarness();
  const slightlyAhead = await fresh.session({ nowMs: fresh.clock.now + 30_000 });
  assert.equal((await call(fresh, { path: "/api/me", session: slightlyAhead })).status, 200, "30s of skew is tolerated");
});

test("rotating SESSION_SECRET logs every session out", async () => {
  const h = await createHarness();
  const token = await h.session();
  assert.equal((await call(h, { path: "/api/me", session: token })).status, 200);
  h.env.SESSION_SECRET = "rotated-secret-rotated-secret-0123456789";
  assert.equal((await call(h, { path: "/api/me", session: token })).status, 401);
});

test("the worker token is not accepted as a session cookie", async () => {
  const h = await createHarness();
  assert.equal((await call(h, { path: "/api/me", session: WORKER_TOKEN })).status, 401);
});

test("session token unit behaviour", async () => {
  const now = Date.parse("2026-11-14T00:00:00Z");
  const { token, expiresAt } = await createSessionToken(SESSION_SECRET, now);
  assert.equal(expiresAt, now + TTL_MS);
  assert.deepEqual(await verifySessionToken(SESSION_SECRET, token, now), { ok: true, expiresAt });
  assert.deepEqual(await verifySessionToken(SESSION_SECRET, token, expiresAt), { ok: false, reason: "expired" });
  assert.deepEqual(await verifySessionToken(SESSION_SECRET, token, now - 120_000), { ok: false, reason: "not_yet_valid" });
  assert.deepEqual(await verifySessionToken("some-other-secret-some-other-secret-0123", token, now), { ok: false, reason: "bad_signature" });
  assert.deepEqual(await verifySessionToken(SESSION_SECRET, "x", now), { ok: false, reason: "malformed" });
  assert.deepEqual(await verifySessionToken(SESSION_SECRET, "", now), { ok: false, reason: "malformed" });
});

test("secretsEqual compares by value, including different lengths", async () => {
  assert.equal(await secretsEqual("same", "same"), true);
  assert.equal(await secretsEqual("same", "sama"), false);
  assert.equal(await secretsEqual("a", "aa"), false);
  assert.equal(await secretsEqual("", "x"), false);
  assert.equal(await secretsEqual("", ""), true);
});

test("readCookie picks the named cookie and ignores empty, oversized and look-alike ones", () => {
  assert.equal(readCookie(`a=1; ${SESSION_COOKIE}=tok; b=2`, SESSION_COOKIE), "tok");
  assert.equal(readCookie(`x${SESSION_COOKIE}=tok`, SESSION_COOKIE), null);
  assert.equal(readCookie(`${SESSION_COOKIE}=`, SESSION_COOKIE), null);
  assert.equal(readCookie(`${SESSION_COOKIE}=${"a".repeat(513)}`, SESSION_COOKIE), null);
  assert.equal(readCookie(null, SESSION_COOKIE), null);
});

// ---------- worker bearer token ----------

test("the worker token reaches worker routes only; owner routes answer 403 and change nothing", async () => {
  const h = await createHarness();
  const before = snapshot(h);
  for (const sample of OWNER_SAMPLES) {
    const res = await call(h, { method: sample.method, path: sample.path, body: sample.body, bearer: WORKER_TOKEN });
    assert.equal(res.status, 403, `${sample.method} ${sample.path}`);
    assert.equal(res.json.error.code, "forbidden");
  }
  assert.deepEqual(snapshot(h), before);
  assert.equal(h.limiter.read.length + h.limiter.write.length, 0, "forbidden calls are refused before rate limiting");
});

test("an owner session cannot call worker routes", async () => {
  const h = await createHarness();
  for (const sample of WORKER_SAMPLES) {
    const res = await authed(h, { method: sample.method, path: sample.path, body: sample.body });
    assert.equal(res.status, 403, `${sample.method} ${sample.path}`);
    assert.equal(res.json.error.code, "forbidden");
  }
  assert.equal(count(h.db, "audit_events"), 0);
});

test("bearer authentication is strict", async () => {
  const h = await createHarness();
  const path = "/api/worker/claim";
  const body = { worker_id: "worker-1" };
  const wrong: Array<[string, Record<string, string>]> = [
    ["wrong token", { authorization: "Bearer not-the-worker-token-not-the-worker-token" }],
    ["token prefix", { authorization: `Bearer ${WORKER_TOKEN.slice(0, -1)}` }],
    ["token plus suffix", { authorization: `Bearer ${WORKER_TOKEN}x` }],
    ["lowercase scheme", { authorization: `bearer ${WORKER_TOKEN}` }],
    ["basic scheme", { authorization: `Basic ${WORKER_TOKEN}` }],
    ["bare token", { authorization: WORKER_TOKEN }],
    ["empty bearer", { authorization: "Bearer " }],
    ["two spaces", { authorization: `Bearer  ${WORKER_TOKEN}` }],
    ["oversized", { authorization: `Bearer ${"a".repeat(600)}` }],
  ];
  for (const [name, headers] of wrong) {
    const res = await call(h, { method: "POST", path, body, headers });
    assert.equal(res.status, 401, name);
    assert.equal(res.json.error.code, "unauthorized");
  }
  const ok = await asWorker(h, { path, body });
  assert.equal(ok.status, 200);
  assert.deepEqual(ok.json, { claimed: false });
});

test("a bad bearer is never rescued by a valid session cookie", async () => {
  const h = await createHarness();
  const res = await call(h, {
    path: "/api/me",
    session: await h.session(),
    headers: { authorization: "Bearer not-the-worker-token-not-the-worker-token" },
  });
  assert.equal(res.status, 401);
});

test("the worker API stays disabled while WORKER_TOKEN is unset", async () => {
  const h = await createHarness({ WORKER_TOKEN: undefined, RL_WORKER: undefined });
  assert.equal((await call(h, { path: "/health" })).status, 200);
  const res = await asWorker(h, { path: "/api/worker/claim", body: { worker_id: "worker-1" } });
  assert.equal(res.status, 401);
  assert.equal((await authed(h, { path: "/api/me" })).status, 200, "the owner API is unaffected");
});

test("the old static API_TOKEN is no longer accepted", async () => {
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

test("worker calls are rate limited in their own bucket", async () => {
  const h = await createHarness();
  await asWorker(h, { path: "/api/worker/claim", body: { worker_id: "worker-1" } });
  assert.deepEqual(h.limiter.worker, ["s:worker"]);
  h.limiter.allowWorker = false;
  const blocked = await asWorker(h, { path: "/api/worker/claim", body: { worker_id: "worker-1" } });
  assert.equal(blocked.status, 429);
  assert.equal(blocked.headers.get("retry-after"), "60");
});

test("a worker can run a job end to end with the bearer token, and its actions are audited as the worker", async () => {
  const h = await createHarness();
  makeAccountReady(h);
  const projectId = await createProject(h);
  const queued = await authed(h, {
    method: "POST",
    path: "/api/jobs",
    body: { project_id: projectId, account_id: "acct-01", idempotency_key: "worker-flow-0001" },
  });
  assert.equal(queued.status, 201);

  const claim = await asWorker(h, { path: "/api/worker/claim", body: { worker_id: "worker-1" } });
  assert.equal(claim.status, 200);
  assert.equal(claim.json.claimed, true);
  assert.equal(claim.json.job.id, queued.json.id);
  const token = claim.json.lease.fencing_token as number;
  assert.ok(Number.isInteger(token) && token >= 1);

  const ref = { worker_id: "worker-1", fencing_token: token };
  const started = await asWorker(h, { path: `/api/worker/jobs/${queued.json.id}/start`, body: ref });
  assert.equal(started.status, 200);
  assert.equal(started.json.status, "running");
  const done = await asWorker(h, { path: `/api/worker/jobs/${queued.json.id}/complete`, body: ref });
  assert.equal(done.status, 200);
  assert.equal(done.json.status, "succeeded");

  const audits = h.db.raw
    .prepare("SELECT event_type,detail_json FROM audit_events WHERE event_type IN ('job.started','job.succeeded')")
    .all() as Array<{ event_type: string; detail_json: string }>;
  assert.equal(audits.length, 2);
  for (const audit of audits) assert.equal(JSON.parse(audit.detail_json).actor, "worker");
});