import assert from "node:assert/strict";
import { test } from "node:test";
import { asWorker, authed, call, count, createHarness, createProject, makeAccountReady } from "./helpers.ts";
import type { CallResult, Harness } from "./helpers.ts";
import { MAX_WORKERS, ONLINE_WINDOW_MS, PRUNE_AFTER_MS } from "../src/worker-health.ts";

const GIB = 1024 ** 3;
const status = (h: Harness, body: Record<string, unknown>) => asWorker(h, { path: "/api/worker/status", body });
const readiness = (h: Harness, account: string, body: Record<string, unknown>) =>
  asWorker(h, { path: `/api/worker/accounts/${account}/readiness`, body: { worker_id: "worker-1", ...body } });
const issue = (res: CallResult, field: string, code: string) =>
  (res.json?.error?.details?.issues ?? []).some((i: { field: string; code: string }) => i.field === field && i.code === code);
const accountRow = (h: Harness, id = "acct-01") =>
  h.db.raw.prepare("SELECT status,last_login_at,last_error FROM accounts WHERE id=?").get(id) as {
    status: string;
    last_login_at: string | null;
    last_error: string | null;
  };

// ---------- worker status + GET /api/workers ----------

test("a status report shows up for the owner as online with disk and profile numbers", async () => {
  const h = await createHarness();
  const res = await status(h, { worker_id: "worker-1", state: "idle", disk_free_bytes: 50 * GIB, disk_total_bytes: 100 * GIB, profile_count: 3 });
  assert.equal(res.status, 200, res.text);

  const list = await authed(h, { path: "/api/workers" });
  assert.equal(list.status, 200);
  assert.equal(list.json.items.length, 1);
  assert.deepEqual(list.json.items[0], {
    worker_id: "worker-1",
    state: "idle",
    online: true,
    last_seen_at: new Date(h.clock.now).toISOString(),
    disk_free_bytes: 50 * GIB,
    disk_total_bytes: 100 * GIB,
    disk_low: false,
    profile_count: 3,
  });
});

test("a worker goes offline after the online window and back online on the next report", async () => {
  const h = await createHarness();
  await status(h, { worker_id: "worker-1", state: "busy", profile_count: 1 });
  h.clock.now += ONLINE_WINDOW_MS;
  assert.equal((await authed(h, { path: "/api/workers" })).json.items[0].online, true, "boundary is inclusive");
  h.clock.now += 1;
  assert.equal((await authed(h, { path: "/api/workers" })).json.items[0].online, false);
  await status(h, { worker_id: "worker-1", state: "idle", profile_count: 1 });
  assert.equal((await authed(h, { path: "/api/workers" })).json.items[0].online, true);
});

test("a worker that announces `stopping` is shown offline immediately", async () => {
  const h = await createHarness();
  await status(h, { worker_id: "worker-1", state: "stopping", profile_count: 0 });
  const item = (await authed(h, { path: "/api/workers" })).json.items[0];
  assert.equal(item.state, "stopping");
  assert.equal(item.online, false);
});

test("low free disk is flagged, unknown disk is null and never flagged", async () => {
  const h = await createHarness();
  await status(h, { worker_id: "low", state: "idle", disk_free_bytes: 1 * GIB, disk_total_bytes: 10 * GIB, profile_count: 0 });
  await status(h, { worker_id: "unknown", state: "idle", profile_count: 0 });
  const items = (await authed(h, { path: "/api/workers" })).json.items as Array<Record<string, unknown>>;
  const low = items.find((i) => i.worker_id === "low")!;
  const unknown = items.find((i) => i.worker_id === "unknown")!;
  assert.equal(low.disk_low, true);
  assert.equal(unknown.disk_free_bytes, null);
  assert.equal(unknown.disk_low, false);
});

test("a repeated report updates the same row and keeps first_seen_at", async () => {
  const h = await createHarness();
  await status(h, { worker_id: "worker-1", state: "idle", profile_count: 1 });
  const first = h.clock.now;
  h.clock.now += 30_000;
  await status(h, { worker_id: "worker-1", state: "busy", profile_count: 2 });
  assert.equal(count(h.db, "worker_status"), 1);
  const row = h.db.raw.prepare("SELECT state,profile_count,first_seen_at,last_seen_at FROM worker_status").get() as Record<string, number | string>;
  assert.deepEqual({ ...row }, { state: "busy", profile_count: 2, first_seen_at: first, last_seen_at: first + 30_000 });
  assert.equal(count(h.db, "audit_events"), 0, "health reports are not audited (too noisy, nothing sensitive changes)");
});

test("status validation rejects bad input and writes nothing", async () => {
  const h = await createHarness();
  const base = { worker_id: "worker-1", state: "idle", profile_count: 1 };
  assert.ok(issue(await status(h, { ...base, extra: 1 }), "extra", "unknown_field"));
  assert.ok(issue(await status(h, { ...base, state: "sleeping" }), "state", "invalid_value"));
  assert.ok(issue(await status(h, { worker_id: "worker-1", profile_count: 1 }), "state", "required"));
  assert.ok(issue(await status(h, { worker_id: "worker-1", state: "idle" }), "profile_count", "required"));
  assert.ok(issue(await status(h, { ...base, profile_count: 11 }), "profile_count", "out_of_range"));
  assert.ok(issue(await status(h, { ...base, profile_count: -1 }), "profile_count", "out_of_range"));
  assert.ok(issue(await status(h, { ...base, disk_free_bytes: -5, disk_total_bytes: 10 }), "disk_free_bytes", "out_of_range"));
  assert.ok(issue(await status(h, { ...base, disk_free_bytes: 11, disk_total_bytes: 10 }), "disk_free_bytes", "exceeds_total"));
  assert.ok(issue(await status(h, { ...base, disk_free_bytes: 5 }), "disk_total_bytes", "required_with_pair"));
  assert.ok(issue(await status(h, { ...base, disk_total_bytes: 5 }), "disk_free_bytes", "required_with_pair"));
  assert.ok(issue(await status(h, { ...base, disk_free_bytes: "5", disk_total_bytes: 10 }), "disk_free_bytes", "must_be_integer"));
  assert.ok(issue(await status(h, { ...base, worker_id: "bad id!" }), "worker_id", "invalid_format"));
  assert.equal(count(h.db, "worker_status"), 0);
});

test("silent workers are pruned and the number of tracked workers is capped", async () => {
  const h = await createHarness();
  await status(h, { worker_id: "old-worker", state: "idle", profile_count: 0 });
  h.clock.now += PRUNE_AFTER_MS + 1;
  await status(h, { worker_id: "new-worker", state: "idle", profile_count: 0 });
  const ids = (h.db.raw.prepare("SELECT worker_id FROM worker_status").all() as Array<{ worker_id: string }>).map((r) => r.worker_id);
  assert.deepEqual(ids, ["new-worker"]);

  for (let i = 0; i < MAX_WORKERS - 1; i++) {
    assert.equal((await status(h, { worker_id: `w-${i}`, state: "idle", profile_count: 0 })).status, 200);
  }
  const over = await status(h, { worker_id: "one-too-many", state: "idle", profile_count: 0 });
  assert.equal(over.status, 409);
  assert.equal(over.json.error.code, "worker_limit_reached");
  assert.equal((await status(h, { worker_id: "w-0", state: "busy", profile_count: 0 })).status, 200, "known workers keep reporting at the cap");
});

test("audiences are separate: owner cannot report status, worker cannot read the list", async () => {
  const h = await createHarness();
  const asOwner = await authed(h, { method: "POST", path: "/api/worker/status", body: { worker_id: "worker-1", state: "idle", profile_count: 0 } });
  assert.equal(asOwner.status, 403);
  const workerRead = await call(h, { path: "/api/workers", bearer: "test-worker-token-0123456789abcdef0123456789abcdef" });
  assert.equal(workerRead.status, 403);
  assert.equal(count(h.db, "worker_status"), 0);
});

// ---------- account readiness ----------

test("owner-confirmed `ready` marks the account ready, stamps last_login_at, clears last_error and audits", async () => {
  const h = await createHarness();
  h.db.raw.prepare("UPDATE accounts SET status='auth_required', last_error='Re-authentication required' WHERE id='acct-02'").run();
  const res = await readiness(h, "acct-02", { status: "ready", owner_confirmed: true });
  assert.equal(res.status, 200, res.text);
  assert.deepEqual(res.json, { account_id: "acct-02", status: "ready" });
  const row = accountRow(h, "acct-02");
  assert.equal(row.status, "ready");
  assert.ok(row.last_login_at);
  assert.equal(row.last_error, null);

  const audit = h.db.raw.prepare("SELECT account_id,job_id,event_type,detail_json FROM audit_events").all() as Array<{
    account_id: string;
    job_id: string | null;
    event_type: string;
    detail_json: string;
  }>;
  assert.equal(audit.length, 1);
  assert.equal(audit[0].event_type, "account.readiness_reported");
  assert.equal(audit[0].account_id, "acct-02");
  const detail = JSON.parse(audit[0].detail_json);
  assert.equal(detail.actor, "worker");
  assert.equal(detail.status, "ready");
  assert.equal(detail.owner_confirmed, true);
});

test("`ready` without an explicit owner confirmation is refused and changes nothing", async () => {
  const h = await createHarness();
  for (const body of [{ status: "ready" }, { status: "ready", owner_confirmed: false }]) {
    const res = await readiness(h, "acct-01", body);
    assert.equal(res.status, 400);
    assert.ok(issue(res, "owner_confirmed", "required_for_ready"));
  }
  assert.equal(accountRow(h).status, "needs_login");
  assert.equal(count(h.db, "audit_events"), 0);
});

test("auth_required and needs_login need no confirmation; auth_required records a reason", async () => {
  const h = await createHarness();
  makeAccountReady(h);
  assert.equal((await readiness(h, "acct-01", { status: "auth_required" })).status, 200);
  assert.deepEqual(
    { status: accountRow(h).status, error: accountRow(h).last_error },
    { status: "auth_required", error: "Re-authentication required" },
  );
  assert.equal((await readiness(h, "acct-01", { status: "needs_login" })).status, 200);
  assert.equal(accountRow(h).status, "needs_login");
  assert.equal(count(h.db, "audit_events"), 2);
});

test("readiness validation: unknown fields, bad status, `disabled`/`error` can never be set", async () => {
  const h = await createHarness();
  assert.ok(issue(await readiness(h, "acct-01", { status: "disabled" }), "status", "invalid_value"));
  assert.ok(issue(await readiness(h, "acct-01", { status: "error" }), "status", "invalid_value"));
  assert.ok(issue(await readiness(h, "acct-01", {}), "status", "required"));
  assert.ok(issue(await readiness(h, "acct-01", { status: "needs_login", email: "a@b.co" }), "email", "unknown_field"));
  assert.ok(issue(await readiness(h, "acct-01", { status: "ready", owner_confirmed: "true" }), "owner_confirmed", "must_be_boolean"));
  assert.equal((await readiness(h, "acct-11", { status: "needs_login" })).status, 404);
  assert.equal((await readiness(h, "acct-1", { status: "needs_login" })).status, 404);
  assert.equal(accountRow(h).status, "needs_login");
  assert.equal(count(h.db, "audit_events"), 0);
});

test("a disabled account cannot be re-enabled through readiness", async () => {
  const h = await createHarness();
  h.db.raw.prepare("UPDATE accounts SET status='disabled' WHERE id='acct-03'").run();
  const res = await readiness(h, "acct-03", { status: "ready", owner_confirmed: true });
  assert.equal(res.status, 409);
  assert.equal(res.json.error.code, "account_disabled");
  assert.equal(accountRow(h, "acct-03").status, "disabled");
  assert.equal(count(h.db, "audit_events"), 0);
});

test("readiness cannot change while a job of that account is claimed or running", async () => {
  const h = await createHarness();
  makeAccountReady(h);
  const projectId = await createProject(h);
  const scene = await authed(h, { method: "POST", path: `/api/projects/${projectId}/scenes`, body: { prompt: "Kucing" } });
  assert.equal(scene.status, 201);
  const submit = await authed(h, {
    method: "POST",
    path: `/api/projects/${projectId}/submit`,
    body: { account_id: "acct-01", idempotency_key: "submit-key-0001", expected_scene_count: 1 },
  });
  assert.equal(submit.status, 201, submit.text);
  const claim = await asWorker(h, { path: "/api/worker/claim", body: { worker_id: "worker-1" } });
  assert.equal(claim.json.claimed, true);

  const res = await readiness(h, "acct-01", { status: "auth_required" });
  assert.equal(res.status, 409);
  assert.equal(res.json.error.code, "account_in_use");
  assert.equal(accountRow(h).status, "ready");

  // A different account is unaffected by the running job.
  assert.equal((await readiness(h, "acct-02", { status: "ready", owner_confirmed: true })).status, 200);
});

test("`ready` does not resume a job parked in waiting_for_user; the owner must resume it", async () => {
  const h = await createHarness();
  makeAccountReady(h);
  const projectId = await createProject(h);
  await authed(h, { method: "POST", path: `/api/projects/${projectId}/scenes`, body: { prompt: "Kucing" } });
  await authed(h, {
    method: "POST",
    path: `/api/projects/${projectId}/submit`,
    body: { account_id: "acct-01", idempotency_key: "submit-key-0001", expected_scene_count: 1 },
  });
  const claim = await asWorker(h, { path: "/api/worker/claim", body: { worker_id: "worker-1" } });
  const jobId = claim.json.job.id as string;
  const body = { worker_id: "worker-1", fencing_token: claim.json.lease.fencing_token };
  assert.equal((await asWorker(h, { path: `/api/worker/jobs/${jobId}/start`, body })).status, 200);
  assert.equal((await asWorker(h, { path: `/api/worker/jobs/${jobId}/wait`, body })).status, 200);
  assert.equal(accountRow(h).status, "auth_required");

  assert.equal((await readiness(h, "acct-01", { status: "ready", owner_confirmed: true })).status, 200);
  assert.equal(accountRow(h).status, "ready");
  const job = h.db.raw.prepare("SELECT status FROM jobs WHERE id=?").get(jobId) as { status: string };
  assert.equal(job.status, "waiting_for_user");
});
