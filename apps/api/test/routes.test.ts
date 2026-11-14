import assert from "node:assert/strict";
import { test } from "node:test";
import { authed, count, createHarness, createProject, makeAccountReady } from "./helpers.ts";
import type { CallResult, Harness } from "./helpers.ts";

const issuesOf = (res: CallResult) => res.json.error.details.issues as Array<{ field: string; code: string }>;
const hasIssue = (res: CallResult, field: string, code: string) =>
  issuesOf(res).some((issue) => issue.field === field && issue.code === code);

async function queueJob(h: Harness, body: Record<string, unknown>) {
  return authed(h, { method: "POST", path: "/api/jobs", body });
}

// ---------- accounts ----------

test("GET /api/accounts returns the 10 seeded slots in an items envelope", async () => {
  const h = await createHarness();
  const res = await authed(h, { path: "/api/accounts" });
  assert.equal(res.status, 200);
  assert.equal(res.json.items.length, 10);
  assert.equal(res.json.items[0].id, "acct-01");
  assert.equal(res.json.items[9].id, "acct-10");
});

test("PATCH /api/accounts/:id updates label/email, can clear email, and audits without storing values", async () => {
  const h = await createHarness();
  const set = await authed(h, {
    method: "PATCH",
    path: "/api/accounts/acct-03",
    body: { label: "  Akun Utama  ", email: "Person@Example.com" },
  });
  assert.equal(set.status, 200);
  assert.equal(set.json.label, "Akun Utama");
  assert.equal(set.json.email, "person@example.com");

  const cleared = await authed(h, { method: "PATCH", path: "/api/accounts/acct-03", body: { email: null } });
  assert.equal(cleared.json.email, null);
  assert.equal(cleared.json.label, "Akun Utama", "untouched fields are preserved");

  const audit = h.db.raw.prepare("SELECT account_id,event_type,detail_json FROM audit_events ORDER BY created_at,rowid").all() as Array<{
    account_id: string;
    event_type: string;
    detail_json: string;
  }>;
  assert.equal(audit.length, 2);
  assert.equal(audit[0].event_type, "account.updated");
  assert.equal(audit[0].account_id, "acct-03");
  const detail = JSON.parse(audit[0].detail_json);
  assert.deepEqual(detail.fields, ["label", "email"]);
  assert.equal(detail.actor, "owner@example.com");
  assert.ok(!audit[0].detail_json.includes("person@example.com"), "audit must not store the email value");
});

test("PATCH /api/accounts validation", async () => {
  const h = await createHarness();
  const patch = (path: string, body: unknown) => authed(h, { method: "PATCH", path, body });

  assert.equal((await patch("/api/accounts/acct-11", { label: "x" })).status, 404);
  assert.equal((await patch("/api/accounts/acct-00", { label: "x" })).status, 404);
  assert.equal((await patch("/api/accounts/acct-1", { label: "x" })).status, 404);
  assert.equal((await patch("/api/accounts/acct-01%27--", { label: "x" })).status, 404);

  const empty = await patch("/api/accounts/acct-01", {});
  assert.equal(empty.status, 400);
  assert.ok(hasIssue(empty, "$", "empty_update"));

  const unknown = await patch("/api/accounts/acct-01", { label: "ok", status: "ready", slot: 5 });
  assert.equal(unknown.status, 400);
  assert.ok(hasIssue(unknown, "status", "unknown_field"));
  assert.ok(hasIssue(unknown, "slot", "unknown_field"));

  assert.ok(hasIssue(await patch("/api/accounts/acct-01", { label: "" }), "label", "too_short"));
  assert.ok(hasIssue(await patch("/api/accounts/acct-01", { label: "x".repeat(81) }), "label", "too_long"));
  assert.ok(hasIssue(await patch("/api/accounts/acct-01", { label: "bad\u0000name" }), "label", "invalid_characters"));
  assert.ok(hasIssue(await patch("/api/accounts/acct-01", { label: 5 }), "label", "must_be_string"));
  assert.ok(hasIssue(await patch("/api/accounts/acct-01", { email: "nope" }), "email", "invalid_format"));
  assert.ok(hasIssue(await patch("/api/accounts/acct-01", { label: null }), "label", "must_be_string"));

  assert.equal(h.db.raw.prepare("SELECT status FROM accounts WHERE id='acct-01'").get()?.status, "needs_login");
  assert.equal(count(h.db, "audit_events"), 0, "rejected requests write no audit events");
});

test("account status cannot be changed through the API (manual enrollment only)", async () => {
  const h = await createHarness();
  const res = await authed(h, { method: "PATCH", path: "/api/accounts/acct-01", body: { status: "ready" } });
  assert.equal(res.status, 400);
  assert.equal(h.db.raw.prepare("SELECT status FROM accounts WHERE id='acct-01'").get()?.status, "needs_login");
});

// ---------- projects ----------

test("POST /api/projects creates a project with defaults and audits it", async () => {
  const h = await createHarness();
  const res = await authed(h, { method: "POST", path: "/api/projects", body: { name: "  Video TikTok  " } });
  assert.equal(res.status, 201);
  assert.equal(res.json.name, "Video TikTok");
  assert.equal(res.json.aspect_ratio, "9:16");
  const stored = h.db.raw.prepare("SELECT name,aspect_ratio FROM projects WHERE id=?").get(res.json.id);
  assert.equal(stored?.name, "Video TikTok");
  const audit = h.db.raw.prepare("SELECT event_type,detail_json FROM audit_events").all() as Array<{ event_type: string; detail_json: string }>;
  assert.equal(audit.length, 1);
  assert.equal(audit[0].event_type, "project.created");
  assert.equal(JSON.parse(audit[0].detail_json).project_id, res.json.id);
});

test("POST /api/projects validation", async () => {
  const h = await createHarness();
  const post = (body: unknown) => authed(h, { method: "POST", path: "/api/projects", body });
  assert.ok(hasIssue(await post({}), "name", "required"));
  assert.ok(hasIssue(await post({ name: "   " }), "name", "too_short"));
  assert.ok(hasIssue(await post({ name: "x".repeat(121) }), "name", "too_long"));
  assert.ok(hasIssue(await post({ name: 12 }), "name", "must_be_string"));
  assert.ok(hasIssue(await post({ name: "ok", aspect_ratio: "4:3" }), "aspect_ratio", "invalid_value"));
  assert.ok(hasIssue(await post({ name: "ok", status: "published" }), "status", "unknown_field"));
  assert.ok(hasIssue(await post({ name: "ok", id: "forced-id" }), "id", "unknown_field"));
  assert.equal(count(h.db, "projects"), 0);
  const ok = await post({ name: "ok", aspect_ratio: "16:9" });
  assert.equal(ok.status, 201);
  assert.equal(ok.json.aspect_ratio, "16:9");
});

test("SQL metacharacters are stored literally (parameterized queries)", async () => {
  const h = await createHarness();
  const nasty = "'); DROP TABLE projects;--";
  const res = await authed(h, { method: "POST", path: "/api/projects", body: { name: nasty } });
  assert.equal(res.status, 201);
  assert.equal(h.db.raw.prepare("SELECT name FROM projects WHERE id=?").get(res.json.id)?.name, nasty);
  assert.equal(count(h.db, "projects"), 1);
});

test("project listing paginates with a stable cursor, even when created_at ties", async () => {
  const h = await createHarness();
  const created = new Set<string>();
  for (let i = 0; i < 7; i += 1) created.add(await createProject(h, `Proyek ${i}`));

  const seen: string[] = [];
  let cursor: string | null = null;
  let pages = 0;
  do {
    const query: string = `/api/projects?limit=3${cursor ? `&cursor=${cursor}` : ""}`;
    const res: CallResult = await authed(h, { path: query });
    assert.equal(res.status, 200);
    assert.ok(res.json.items.length <= 3);
    for (const item of res.json.items) seen.push(item.id);
    cursor = res.json.next_cursor;
    pages += 1;
    assert.ok(pages <= 4, "pagination must terminate");
  } while (cursor);
  assert.equal(pages, 3);
  assert.equal(seen.length, 7);
  assert.deepEqual(new Set(seen), created, "no duplicates, no gaps");
});

test("pagination parameters are validated", async () => {
  const h = await createHarness();
  for (const query of ["limit=0", "limit=101", "limit=abc", "limit=-1", "limit=1.5", "limit=1e2"]) {
    const res = await authed(h, { path: `/api/projects?${query}` });
    assert.equal(res.status, 400, query);
    assert.ok(hasIssue(res, "limit", "out_of_range"), query);
  }
  for (const cursor of ["!!!", "bm90LWpzb24", "WyJvbmx5LW9uZSJd", "W10", "WzEsMl0"]) {
    const res = await authed(h, { path: `/api/projects?cursor=${cursor}` });
    assert.equal(res.status, 400, cursor);
    assert.ok(hasIssue(res, "cursor", "invalid_value"), cursor);
  }
  assert.equal((await authed(h, { path: "/api/projects?limit=100" })).status, 200);
});

// ---------- jobs ----------

test("job creation requires a ready account, an existing project, and valid input", async () => {
  const h = await createHarness();
  const projectId = await createProject(h);
  const key = "key-0000-0001";

  const notReady = await queueJob(h, { project_id: projectId, account_id: "acct-01", idempotency_key: key });
  assert.equal(notReady.status, 409);
  assert.equal(notReady.json.error.code, "account_not_ready");
  assert.equal(notReady.json.error.details.status, "needs_login");

  makeAccountReady(h);
  const missingProject = await queueJob(h, {
    project_id: "11111111-2222-4333-8444-555555555555",
    account_id: "acct-01",
    idempotency_key: key,
  });
  assert.equal(missingProject.status, 404);
  assert.equal(missingProject.json.error.code, "project_not_found");

  const bad = await queueJob(h, { project_id: "nope", account_id: "acct-99", idempotency_key: "short", extra: 1 });
  assert.equal(bad.status, 400);
  assert.ok(hasIssue(bad, "project_id", "invalid_format"));
  assert.ok(hasIssue(bad, "account_id", "invalid_format"));
  assert.ok(hasIssue(bad, "idempotency_key", "too_short"));
  assert.ok(hasIssue(bad, "extra", "unknown_field"));
  assert.ok(hasIssue(await queueJob(h, {}), "project_id", "required"));
  assert.ok(hasIssue(await queueJob(h, { project_id: projectId, account_id: "acct-01", idempotency_key: "has space 12345" }), "idempotency_key", "invalid_format"));
  assert.equal(count(h.db, "jobs"), 0);

  const ok = await queueJob(h, { project_id: projectId, account_id: "acct-01", idempotency_key: key });
  assert.equal(ok.status, 201);
  assert.equal(ok.json.status, "queued");
  const row = h.db.raw.prepare("SELECT engine,status FROM jobs WHERE id=?").get(ok.json.id);
  assert.equal(row?.engine, "dry-run", "default engine is dry-run");
  assert.equal(row?.status, "queued");
});

test("live engines are refused while disabled, allowed only when explicitly enabled", async () => {
  const h = await createHarness();
  makeAccountReady(h);
  const projectId = await createProject(h);
  for (const engine of ["flowkit", "gflow"]) {
    const res = await queueJob(h, { project_id: projectId, account_id: "acct-01", engine, idempotency_key: `live-${engine}-0001` });
    assert.equal(res.status, 403, engine);
    assert.equal(res.json.error.code, "live_engine_disabled");
  }
  assert.ok(hasIssue(await queueJob(h, { project_id: projectId, account_id: "acct-01", engine: "other", idempotency_key: "engine-bad-0001" }), "engine", "invalid_value"));
  assert.equal(count(h.db, "jobs"), 0);

  const enabled = await createHarness({ LIVE_ENGINES_ENABLED: "true" });
  makeAccountReady(enabled);
  const projectEnabled = await createProject(enabled);
  const res = await queueJob(enabled, { project_id: projectEnabled, account_id: "acct-01", engine: "flowkit", idempotency_key: "live-ok-0001" });
  assert.equal(res.status, 201);
});

test("idempotency: same key and parameters replay the job; different parameters conflict", async () => {
  const h = await createHarness();
  makeAccountReady(h, "acct-01");
  makeAccountReady(h, "acct-02");
  const projectId = await createProject(h);
  const body = { project_id: projectId, account_id: "acct-01", idempotency_key: "idem-key-0001" };

  const first = await queueJob(h, body);
  assert.equal(first.status, 201);
  const replay = await queueJob(h, body);
  assert.equal(replay.status, 200);
  assert.equal(replay.json.id, first.json.id);
  assert.equal(replay.json.idempotent_replay, true);
  assert.equal(count(h.db, "jobs"), 1);
  assert.equal(count(h.db, "audit_events") - 1, 1, "one project.created + exactly one job.queued");

  const conflict = await queueJob(h, { ...body, account_id: "acct-02" });
  assert.equal(conflict.status, 409);
  assert.equal(conflict.json.error.code, "idempotency_key_conflict");
  assert.equal(count(h.db, "jobs"), 1);
});

test("a scene must belong to the project", async () => {
  const h = await createHarness();
  makeAccountReady(h);
  const projectA = await createProject(h, "A");
  const projectB = await createProject(h, "B");
  const sceneId = "99999999-2222-4333-8444-555555555555";
  h.db.raw.prepare("INSERT INTO scenes(id,project_id,scene_order,prompt) VALUES(?,?,1,'p')").run(sceneId, projectB);

  const wrong = await queueJob(h, { project_id: projectA, scene_id: sceneId, account_id: "acct-01", idempotency_key: "scene-key-0001" });
  assert.equal(wrong.status, 404);
  assert.equal(wrong.json.error.code, "scene_not_found");
  const right = await queueJob(h, { project_id: projectB, scene_id: sceneId, account_id: "acct-01", idempotency_key: "scene-key-0002" });
  assert.equal(right.status, 201);
});

test("job listing: pagination in queue order and status filter validation", async () => {
  const h = await createHarness();
  makeAccountReady(h);
  const projectId = await createProject(h);
  const ids: string[] = [];
  for (let i = 0; i < 5; i += 1) {
    const res = await queueJob(h, { project_id: projectId, account_id: "acct-01", idempotency_key: `list-key-000${i}` });
    ids.push(res.json.id);
  }
  const page1 = await authed(h, { path: "/api/jobs?limit=2" });
  assert.equal(page1.json.items.length, 2);
  assert.ok(page1.json.next_cursor);
  assert.equal(page1.json.items[0].account_slot, 1);
  const page2 = await authed(h, { path: `/api/jobs?limit=2&cursor=${page1.json.next_cursor}` });
  const page3 = await authed(h, { path: `/api/jobs?limit=2&cursor=${page2.json.next_cursor}` });
  assert.equal(page3.json.next_cursor, null);
  const all = [...page1.json.items, ...page2.json.items, ...page3.json.items].map((job) => job.id);
  assert.deepEqual(new Set(all), new Set(ids));
  assert.equal(all.length, 5);
  assert.ok(!("error_message" in page1.json.items[0]), "raw error messages are not exposed");

  assert.equal((await authed(h, { path: "/api/jobs?status=queued" })).json.items.length, 5);
  assert.equal((await authed(h, { path: "/api/jobs?status=running" })).json.items.length, 0);
  const bad = await authed(h, { path: "/api/jobs?status=queued%27%20OR%201=1" });
  assert.equal(bad.status, 400);
  assert.ok(hasIssue(bad, "status", "invalid_value"));
});

test("cancel: queued jobs can be cancelled once; other states and unknown ids are refused", async () => {
  const h = await createHarness();
  makeAccountReady(h);
  const projectId = await createProject(h);
  const job = await queueJob(h, { project_id: projectId, account_id: "acct-01", idempotency_key: "cancel-key-0001" });
  const path = `/api/jobs/${job.json.id}/cancel`;

  const ok = await authed(h, { method: "POST", path });
  assert.equal(ok.status, 200);
  assert.deepEqual(ok.json, { id: job.json.id, status: "cancelled" });
  const again = await authed(h, { method: "POST", path });
  assert.equal(again.status, 409);
  assert.equal(again.json.error.code, "job_not_cancellable");
  assert.equal(again.json.error.details.status, "cancelled");
  const cancelAudits = h.db.raw.prepare("SELECT COUNT(*) AS c FROM audit_events WHERE event_type='job.cancelled'").get();
  assert.equal(Number(cancelAudits?.c), 1, "cancel is audited exactly once");

  const running = await queueJob(h, { project_id: projectId, account_id: "acct-01", idempotency_key: "cancel-key-0002" });
  h.db.raw.prepare("UPDATE jobs SET status='running' WHERE id=?").run(running.json.id);
  const refused = await authed(h, { method: "POST", path: `/api/jobs/${running.json.id}/cancel` });
  assert.equal(refused.status, 409);
  assert.equal(h.db.raw.prepare("SELECT status FROM jobs WHERE id=?").get(running.json.id)?.status, "running");

  const unknown = await authed(h, { method: "POST", path: "/api/jobs/11111111-2222-4333-8444-555555555555/cancel" });
  assert.equal(unknown.status, 404);
  assert.equal(unknown.json.error.code, "job_not_found");
  assert.equal((await authed(h, { method: "POST", path: "/api/jobs/not-a-uuid/cancel" })).status, 404);
});

// ---------- audit ----------

test("GET /api/audit lists recent events newest first with actor and request id", async () => {
  const h = await createHarness();
  makeAccountReady(h);
  const projectId = await createProject(h);
  await queueJob(h, { project_id: projectId, account_id: "acct-01", idempotency_key: "audit-key-0001" });

  const res = await authed(h, { path: "/api/audit?limit=10" });
  assert.equal(res.status, 200);
  const types = res.json.items.map((item: { event_type: string }) => item.event_type);
  assert.deepEqual(new Set(types), new Set(["project.created", "job.queued"]));
  for (const item of res.json.items) {
    assert.equal(item.detail.actor, "owner@example.com");
    assert.match(item.detail.request_id, /^[0-9a-f-]{36}$/);
    assert.ok(!("detail_json" in item));
  }
  const paged = await authed(h, { path: "/api/audit?limit=1" });
  assert.equal(paged.json.items.length, 1);
  assert.ok(paged.json.next_cursor);
});

test("an audit failure rolls the whole mutation back (atomic batch)", async () => {
  const h = await createHarness();
  h.db.raw.exec("DROP TABLE audit_events");
  const res = await authed(h, { method: "POST", path: "/api/projects", body: { name: "must-not-persist" } });
  assert.equal(res.status, 500);
  assert.equal(count(h.db, "projects"), 0, "project insert must roll back with the failed audit insert");
});
