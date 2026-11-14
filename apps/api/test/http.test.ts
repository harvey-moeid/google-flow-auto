import assert from "node:assert/strict";
import { test } from "node:test";
import { BASE, OWNER_PASSWORD, authed, buildRequest, call, count, createHarness, send } from "./helpers.ts";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

// ---------- configuration fails closed ----------

test("placeholder configuration fails closed with 503 and leaks no values", async () => {
  const h = await createHarness({
    OWNER_PASSWORD: "REPLACE_WITH_OWNER_PASSWORD",
    SESSION_SECRET: "REPLACE_WITH_RANDOM_SESSION_SECRET_0123456789",
    WORKER_TOKEN: "REPLACE_WITH_WORKER_TOKEN_0123456789abcdef",
  });
  const res = await call(h, { path: "/api/me", session: await h.session() });
  assert.equal(res.status, 503);
  assert.equal(res.json.error.code, "server_misconfigured");
  assert.ok(!res.text.includes("REPLACE_WITH"), "response must not echo configuration values");
  const health = await call(h, { path: "/health" });
  assert.equal(health.status, 503);
  assert.deepEqual(health.json, { ok: false });
});

for (const [name, override] of [
  ["missing read rate limit binding", { RL_READ: undefined }],
  ["missing write rate limit binding", { RL_WRITE: undefined }],
  ["missing login rate limit binding", { RL_LOGIN: undefined }],
  ["worker token without a worker rate limit binding", { RL_WORKER: undefined }],
  ["missing owner password", { OWNER_PASSWORD: "" }],
  ["owner password shorter than 10 characters", { OWNER_PASSWORD: "short" }],
  ["missing session secret", { SESSION_SECRET: "" }],
  ["session secret shorter than 32 characters", { SESSION_SECRET: "short-secret" }],
  ["worker token shorter than 32 characters", { WORKER_TOKEN: "short-token" }],
  ["worker token with illegal characters", { WORKER_TOKEN: "worker token with spaces 0123456789abcdef" }],
  ["wildcard CORS origin", { ALLOWED_ORIGINS: "*" }],
  ["origin with a path", { ALLOWED_ORIGINS: "https://app.example.com/ui" }],
  ["non-https non-localhost origin", { ALLOWED_ORIGINS: "http://app.example.com" }],
] as Array<[string, Record<string, unknown>]>) {
  test(`invalid configuration is rejected: ${name}`, async () => {
    const h = await createHarness(override);
    const res = await call(h, { path: "/api/me", session: await h.session() });
    assert.equal(res.status, 503);
    assert.equal(res.json.error.code, "server_misconfigured");
  });
}

test("development mode makes the rate limit bindings optional; production never does", async () => {
  const dev = await createHarness({
    APP_ENV: "development",
    RL_READ: undefined,
    RL_WRITE: undefined,
    RL_LOGIN: undefined,
    RL_WORKER: undefined,
  });
  assert.equal((await authed(dev, { path: "/api/me" })).status, 200);
  const prod = await createHarness({ APP_ENV: "staging", RL_READ: undefined });
  assert.equal((await authed(prod, { path: "/api/me" })).status, 503);
});

test("a trailing newline from a shell pipe does not break the secrets", async () => {
  const h = await createHarness({ OWNER_PASSWORD: `${OWNER_PASSWORD}\n` });
  const res = await call(h, { method: "POST", path: "/api/login", body: { password: OWNER_PASSWORD } });
  assert.equal(res.status, 200);
});

// ---------- headers and request ids ----------

test("security headers and a request id are on success, error and 404 responses", async () => {
  const h = await createHarness();
  const responses = [
    await call(h, { path: "/health" }),
    await authed(h, { path: "/api/me" }),
    await call(h, { path: "/api/me" }), // 401
    await authed(h, { path: "/api/nope" }), // 404
    await authed(h, { method: "PUT", path: "/api/projects" }), // 405
  ];
  for (const res of responses) {
    assert.equal(res.headers.get("x-content-type-options"), "nosniff");
    assert.equal(res.headers.get("cache-control"), "no-store");
    assert.equal(res.headers.get("referrer-policy"), "no-referrer");
    assert.match(res.headers.get("content-security-policy") ?? "", /default-src 'none'/);
    assert.match(res.headers.get("strict-transport-security") ?? "", /max-age=\d+/);
    assert.match(res.headers.get("x-request-id") ?? "", UUID_RE);
  }
  const unauth = responses[2];
  assert.equal(unauth.json.error.request_id, unauth.headers.get("x-request-id"));
  assert.deepEqual(Object.keys(unauth.json.error).sort(), ["code", "message", "request_id"]);
});

test("each request gets a distinct request id", async () => {
  const h = await createHarness();
  const a = await call(h, { path: "/health" });
  const b = await call(h, { path: "/health" });
  assert.notEqual(a.headers.get("x-request-id"), b.headers.get("x-request-id"));
});

test("unexpected errors return a generic 500 without internals", async () => {
  const h = await createHarness();
  (h.env as { DB: unknown }).DB = {
    prepare() {
      throw new Error("SECRET internal detail: table users at /srv/db");
    },
  };
  const res = await authed(h, { path: "/api/accounts" });
  assert.equal(res.status, 500);
  assert.equal(res.json.error.code, "internal_error");
  assert.ok(!res.text.includes("SECRET"));
});

test("405 lists allowed methods", async () => {
  const h = await createHarness();
  const res = await authed(h, { method: "DELETE", path: "/api/projects" });
  assert.equal(res.status, 405);
  assert.equal(res.headers.get("allow"), "GET, POST");
  assert.equal(res.json.error.code, "method_not_allowed");
});

// ---------- CORS and origin checks ----------

test("CORS: only exact allowlisted origins are echoed, never a wildcard", async () => {
  const h = await createHarness({ ALLOWED_ORIGINS: "https://app.example.com, http://localhost:5173" });
  for (const origin of ["https://app.example.com", "http://localhost:5173"]) {
    const res = await authed(h, { path: "/api/me", origin });
    assert.equal(res.headers.get("access-control-allow-origin"), origin);
    assert.equal(res.headers.get("access-control-allow-credentials"), "true");
    assert.match(res.headers.get("vary") ?? "", /Origin/i);
  }
  for (const origin of ["https://evil.example.com", "https://app.example.com.evil.com", "null", "http://app.example.com"]) {
    const res = await authed(h, { path: "/api/me", origin });
    assert.equal(res.headers.get("access-control-allow-origin"), null, origin);
    assert.equal(res.headers.get("access-control-allow-credentials"), null, origin);
  }
  const none = await authed(h, { path: "/api/me" });
  assert.equal(none.headers.get("access-control-allow-origin"), null);
});

test("CORS preflight: allowed origin gets 204 without needing auth; others get 403 with no CORS headers", async () => {
  const h = await createHarness({ ALLOWED_ORIGINS: "http://localhost:5173" });
  const ok = await call(h, { method: "OPTIONS", path: "/api/projects", origin: "http://localhost:5173" });
  assert.equal(ok.status, 204);
  assert.equal(ok.headers.get("access-control-allow-origin"), "http://localhost:5173");
  assert.equal(ok.headers.get("access-control-allow-methods"), "GET, POST, PATCH, OPTIONS");
  assert.equal(ok.headers.get("access-control-allow-headers"), "content-type");
  assert.ok(!(ok.headers.get("access-control-allow-headers") ?? "").includes("authorization"));

  const bad = await call(h, { method: "OPTIONS", path: "/api/projects", origin: "https://evil.example.com" });
  assert.equal(bad.status, 403);
  assert.equal(bad.headers.get("access-control-allow-origin"), null);
  const noOrigin = await call(h, { method: "OPTIONS", path: "/api/projects" });
  assert.equal(noOrigin.status, 403);
});

test("writes from a foreign or null origin are rejected (CSRF), even with a valid token", async () => {
  const h = await createHarness({ ALLOWED_ORIGINS: "http://localhost:5173" });
  for (const origin of ["https://evil.example.com", "null"]) {
    const res = await authed(h, { method: "POST", path: "/api/projects", body: { name: "csrf" }, origin });
    assert.equal(res.status, 403, origin);
    assert.equal(res.json.error.code, "origin_not_allowed");
  }
  assert.equal(count(h.db, "projects"), 0);
  assert.equal(count(h.db, "audit_events"), 0);
});

test("writes from the same origin or an allowlisted origin or a non-browser client succeed", async () => {
  const h = await createHarness({ ALLOWED_ORIGINS: "http://localhost:5173" });
  const same = await authed(h, { method: "POST", path: "/api/projects", body: { name: "same" }, origin: BASE });
  const listed = await authed(h, { method: "POST", path: "/api/projects", body: { name: "listed" }, origin: "http://localhost:5173" });
  const none = await authed(h, { method: "POST", path: "/api/projects", body: { name: "curl" } });
  assert.deepEqual([same.status, listed.status, none.status], [201, 201, 201]);
});

// ---------- request size and shape ----------

test("non-JSON content types are rejected with 415", async () => {
  const h = await createHarness();
  for (const contentType of ["text/plain", "application/x-www-form-urlencoded", "multipart/form-data"]) {
    const res = await authed(h, {
      method: "POST",
      path: "/api/projects",
      rawBody: "name=x",
      headers: { "content-type": contentType },
    });
    assert.equal(res.status, 415, contentType);
  }
  assert.equal(count(h.db, "projects"), 0);
});

test("oversized bodies are rejected with 413 (declared length and streamed)", async () => {
  const h = await createHarness();
  const huge = JSON.stringify({ name: "x".repeat(20_000) });
  const declared = await authed(h, {
    method: "POST",
    path: "/api/projects",
    rawBody: huge,
    headers: { "content-length": String(huge.length) },
  });
  assert.equal(declared.status, 413);

  const stream = new ReadableStream({
    start(controller) {
      const chunk = new TextEncoder().encode(`{"name":"${"y".repeat(8000)}`);
      controller.enqueue(chunk);
      controller.enqueue(chunk);
      controller.enqueue(chunk);
      controller.close();
    },
  });
  const request = buildRequest({ method: "POST", path: "/api/projects", session: await h.session() }, stream);
  const streamed = await send(h, request);
  assert.equal(streamed.status, 413);
  assert.equal(count(h.db, "projects"), 0);
});

test("malformed or non-object JSON is rejected with 400", async () => {
  const h = await createHarness();
  for (const rawBody of ["{", "", "null", "[]", '"text"', "42"]) {
    const res = await authed(h, { method: "POST", path: "/api/projects", rawBody });
    assert.equal(res.status, 400, JSON.stringify(rawBody));
    assert.equal(res.json.error.code, "invalid_json");
  }
});

// ---------- rate limiting ----------

test("rate limits are keyed by identity, separate for reads and writes, and return 429 with Retry-After", async () => {
  const h = await createHarness();
  await authed(h, { path: "/api/me" });
  await authed(h, { method: "POST", path: "/api/projects", body: { name: "a" } });
  assert.deepEqual(h.limiter.read, ["r:owner"]);
  assert.deepEqual(h.limiter.write, ["w:owner"]);

  h.limiter.allowWrite = false;
  const blocked = await authed(h, { method: "POST", path: "/api/projects", body: { name: "b" } });
  assert.equal(blocked.status, 429);
  assert.equal(blocked.json.error.code, "rate_limited");
  assert.equal(blocked.headers.get("retry-after"), "60");
  assert.equal(count(h.db, "projects"), 1, "a rate-limited write must not execute");
  assert.equal((await authed(h, { path: "/api/me" })).status, 200, "reads use their own bucket");

  h.limiter.allowRead = false;
  assert.equal((await authed(h, { path: "/api/accounts" })).status, 429);
});

test("a failing rate limiter does not take the API down", async () => {
  const h = await createHarness();
  h.limiter.throws = true;
  assert.equal((await authed(h, { path: "/api/me" })).status, 200);
});
