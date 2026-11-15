import assert from "node:assert/strict";
import { test } from "node:test";
import { asWorker, authed, count, createHarness, createProject, makeAccountReady } from "./helpers.ts";
import type { CallResult, Harness } from "./helpers.ts";

const issuesOf = (res: CallResult) => res.json.error.details.issues as Array<{ field: string; code: string }>;
const hasIssue = (res: CallResult, field: string, code: string) =>
  issuesOf(res).some((issue) => issue.field === field && issue.code === code);

const post = (h: Harness, path: string, body?: unknown) => authed(h, { method: "POST", path, body: body ?? {} });
const patch = (h: Harness, path: string, body: unknown) => authed(h, { method: "PATCH", path, body });
const del = (h: Harness, path: string) => authed(h, { method: "POST", path: `${path}/delete`, body: {} });

async function addScene(h: Harness, projectId: string, prompt = "Kucing berlari di pantai", duration?: number) {
  const res = await post(h, `/api/projects/${projectId}/scenes`, {
    prompt,
    ...(duration === undefined ? {} : { duration_seconds: duration }),
  });
  assert.equal(res.status, 201, res.text);
  return res.json as { id: string; scene_order: number; prompt: string; duration_seconds: number };
}

async function projectWithScenes(h: Harness, n = 3) {
  const projectId = await createProject(h);
  const scenes = [];
  for (let i = 1; i <= n; i += 1) scenes.push(await addScene(h, projectId, `Scene ${i}`));
  return { projectId, scenes };
}

const submitBody = (overrides: Record<string, unknown> = {}) => ({
  account_id: "acct-01",
  idempotency_key: "submit-key-0001",
  expected_scene_count: 3,
  ...overrides,
});

const jobStatuses = (h: Harness) =>
  (h.db.raw.prepare("SELECT status FROM jobs ORDER BY rowid").all() as Array<{ status: string }>).map((row) => row.status);

// ---------- projects ----------

test("projects: list hides archived by default, supports status filter, and shows scene_count", async () => {
  const h = await createHarness();
  const kept = await createProject(h, "Aktif");
  const archived = await createProject(h, "Lama");
  await addScene(h, kept);
  assert.equal((await patch(h, `/api/projects/${archived}`, { status: "archived" })).status, 200);

  const list = await authed(h, { path: "/api/projects" });
  assert.equal(list.status, 200);
  assert.deepEqual(list.json.items.map((p: { id: string }) => p.id), [kept]);
  assert.equal(list.json.items[0].scene_count, 1);

  const onlyArchived = await authed(h, { path: "/api/projects?status=archived" });
  assert.deepEqual(onlyArchived.json.items.map((p: { id: string }) => p.id), [archived]);
  assert.equal((await authed(h, { path: "/api/projects?status=all" })).json.items.length, 2);

  const bad = await authed(h, { path: "/api/projects?status=nope" });
  assert.equal(bad.status, 400);
  assert.ok(hasIssue(bad, "status", "invalid_value"));
});

test("projects: GET returns ordered scenes with totals and the latest job per scene", async () => {
  const h = await createHarness();
  const { projectId, scenes } = await projectWithScenes(h, 2);
  makeAccountReady(h);
  await post(h, `/api/projects/${projectId}/submit`, submitBody({ expected_scene_count: 2 }));

  const res = await authed(h, { path: `/api/projects/${projectId}` });
  assert.equal(res.status, 200);
  assert.equal(res.json.scene_count, 2);
  assert.equal(res.json.total_seconds, 16);
  assert.deepEqual(res.json.scenes.map((s: { id: string }) => s.id), scenes.map((s) => s.id));
  assert.equal(res.json.scenes[0].last_job.status, "queued");

  assert.equal((await authed(h, { path: "/api/projects/11111111-2222-4333-8444-555555555555" })).status, 404);
  assert.equal((await authed(h, { path: "/api/projects/not-a-uuid" })).status, 404);
});

test("projects: PATCH validates, audits field names, and blocks archive/ratio change while jobs are active", async () => {
  const h = await createHarness();
  const { projectId } = await projectWithScenes(h, 1);

  assert.equal((await patch(h, `/api/projects/${projectId}`, {})).status, 400);
  const unknown = await patch(h, `/api/projects/${projectId}`, { owner: "x" });
  assert.ok(hasIssue(unknown, "owner", "unknown_field"));
  const badRatio = await patch(h, `/api/projects/${projectId}`, { aspect_ratio: "4:3" });
  assert.ok(hasIssue(badRatio, "aspect_ratio", "invalid_value"));

  const renamed = await patch(h, `/api/projects/${projectId}`, { name: "  Baru  ", aspect_ratio: "16:9" });
  assert.equal(renamed.status, 200);
  assert.equal(renamed.json.name, "Baru");
  assert.equal(renamed.json.aspect_ratio, "16:9");
  const audit = h.db.raw
    .prepare("SELECT detail_json FROM audit_events WHERE event_type='project.updated'")
    .get() as { detail_json: string };
  assert.deepEqual(JSON.parse(audit.detail_json).fields, ["name", "aspect_ratio"]);

  makeAccountReady(h);
  await post(h, `/api/projects/${projectId}/submit`, submitBody({ expected_scene_count: 1 }));
  const archive = await patch(h, `/api/projects/${projectId}`, { status: "archived" });
  assert.equal(archive.status, 409);
  assert.equal(archive.json.error.code, "project_busy");
  const ratio = await patch(h, `/api/projects/${projectId}`, { aspect_ratio: "1:1" });
  assert.equal(ratio.json.error.code, "project_busy");
  assert.equal((await patch(h, `/api/projects/${projectId}`, { name: "Masih boleh" })).status, 200);
});

test("projects: archived projects refuse edits and new scenes until restored", async () => {
  const h = await createHarness();
  const { projectId, scenes } = await projectWithScenes(h, 1);
  assert.equal((await patch(h, `/api/projects/${projectId}`, { status: "archived" })).status, 200);

  assert.equal((await patch(h, `/api/projects/${projectId}`, { name: "x" })).json.error.code, "project_archived");
  assert.equal((await post(h, `/api/projects/${projectId}/scenes`, { prompt: "x" })).json.error.code, "project_archived");
  assert.equal((await patch(h, `/api/scenes/${scenes[0].id}`, { prompt: "x" })).json.error.code, "project_archived");
  assert.equal((await del(h, `/api/scenes/${scenes[0].id}`)).json.error.code, "project_archived");
  assert.equal(
    (await post(h, `/api/projects/${projectId}/scenes/reorder`, { scene_ids: [scenes[0].id] })).json.error.code,
    "project_archived",
  );

  assert.equal((await patch(h, `/api/projects/${projectId}`, { status: "draft" })).status, 200);
  assert.equal((await post(h, `/api/projects/${projectId}/scenes`, { prompt: "kembali" })).status, 201);
});

// ---------- scenes ----------

test("scenes: created in order with defaults, multi-line prompts allowed, audit holds no prompt text", async () => {
  const h = await createHarness();
  const projectId = await createProject(h);
  const first = await addScene(h, projectId, "Baris satu\nBaris dua\tTab");
  const second = await addScene(h, projectId, "Kedua", 5);
  assert.equal(first.scene_order, 1);
  assert.equal(first.duration_seconds, 8);
  assert.equal(first.prompt, "Baris satu\nBaris dua\tTab");
  assert.equal(second.scene_order, 2);
  assert.equal(second.duration_seconds, 5);

  const audit = h.db.raw.prepare("SELECT detail_json FROM audit_events WHERE event_type='scene.created'").all() as Array<{
    detail_json: string;
  }>;
  assert.equal(audit.length, 2);
  assert.ok(audit.every((row) => !row.detail_json.includes("Baris satu") && !row.detail_json.includes("Kedua")));
});

test("scenes: validation rejects bad prompts, durations and unknown fields", async () => {
  const h = await createHarness();
  const projectId = await createProject(h);
  const path = `/api/projects/${projectId}/scenes`;

  assert.ok(hasIssue(await post(h, path, {}), "prompt", "required"));
  assert.ok(hasIssue(await post(h, path, { prompt: "   " }), "prompt", "too_short"));
  assert.ok(hasIssue(await post(h, path, { prompt: "a".repeat(2001) }), "prompt", "too_long"));
  assert.ok(hasIssue(await post(h, path, { prompt: "bad\u0000char" }), "prompt", "invalid_characters"));
  assert.ok(hasIssue(await post(h, path, { prompt: "bad\u001bescape" }), "prompt", "invalid_characters"));
  assert.ok(hasIssue(await post(h, path, { prompt: 5 }), "prompt", "must_be_string"));
  assert.ok(hasIssue(await post(h, path, { prompt: "ok", duration_seconds: 0 }), "duration_seconds", "out_of_range"));
  assert.ok(hasIssue(await post(h, path, { prompt: "ok", duration_seconds: 61 }), "duration_seconds", "out_of_range"));
  assert.ok(hasIssue(await post(h, path, { prompt: "ok", duration_seconds: 7.5 }), "duration_seconds", "must_be_integer"));
  assert.ok(hasIssue(await post(h, path, { prompt: "ok", duration_seconds: "8" }), "duration_seconds", "must_be_integer"));
  assert.ok(hasIssue(await post(h, path, { prompt: "ok", scene_order: 1 }), "scene_order", "unknown_field"));
  assert.equal((await post(h, path, { prompt: "a".repeat(2000) })).status, 201, "exactly 2000 characters is allowed");
  assert.equal(count(h.db, "scenes"), 1);

  assert.equal((await post(h, "/api/projects/11111111-2222-4333-8444-555555555555/scenes", { prompt: "x" })).status, 404);
});

test("scenes: a project holds at most 50, enforced by the API and by the database", async () => {
  const h = await createHarness();
  const projectId = await createProject(h);
  for (let i = 1; i <= 50; i += 1) {
    h.db.raw
      .prepare("INSERT INTO scenes(id,project_id,scene_order,prompt) VALUES(?,?,?,?)")
      .run(crypto.randomUUID(), projectId, i, `Scene ${i}`);
  }
  const res = await post(h, `/api/projects/${projectId}/scenes`, { prompt: "terlalu banyak" });
  assert.equal(res.status, 409);
  assert.equal(res.json.error.code, "scene_limit_reached");
  assert.throws(
    () =>
      h.db.raw
        .prepare("INSERT INTO scenes(id,project_id,scene_order,prompt) VALUES(?,?,?,?)")
        .run(crypto.randomUUID(), projectId, 51, "lolos?"),
    /scene limit reached/,
  );
  assert.equal(count(h.db, "scenes"), 50);
});

test("scenes: PATCH edits prompt/duration, DELETE removes and keeps finished job history", async () => {
  const h = await createHarness();
  const { projectId, scenes } = await projectWithScenes(h, 2);

  assert.equal((await patch(h, `/api/scenes/${scenes[0].id}`, {})).status, 400);
  const edited = await patch(h, `/api/scenes/${scenes[0].id}`, { prompt: "Diubah", duration_seconds: 4 });
  assert.equal(edited.status, 200);
  assert.equal(edited.json.prompt, "Diubah");
  assert.equal(edited.json.duration_seconds, 4);
  assert.equal(edited.json.scene_order, 1, "editing never moves a scene");

  makeAccountReady(h);
  assert.equal(
    (await post(h, `/api/projects/${projectId}/submit`, submitBody({ expected_scene_count: 2 }))).status,
    201,
  );
  h.db.raw.prepare("UPDATE jobs SET status='failed'").run();

  const gone = await del(h, `/api/scenes/${scenes[0].id}`);
  assert.equal(gone.status, 200);
  assert.deepEqual(gone.json, { id: scenes[0].id, deleted: true });
  assert.equal(count(h.db, "scenes"), 1);
  assert.equal(count(h.db, "jobs"), 2, "job history survives");
  const orphaned = h.db.raw.prepare("SELECT COUNT(*) AS c FROM jobs WHERE scene_id IS NULL").get() as { c: number };
  assert.equal(orphaned.c, 1);
  assert.equal((await del(h, `/api/scenes/${scenes[0].id}`)).status, 404);
  assert.equal((await patch(h, `/api/scenes/${scenes[0].id}`, { prompt: "x" })).status, 404);

  const next = await addScene(h, projectId, "Setelah hapus");
  assert.equal(next.scene_order, 3, "new scenes continue after the highest order; gaps are allowed");
});

test("scenes: a scene with a queued or running job cannot be edited or deleted", async () => {
  const h = await createHarness();
  const { projectId, scenes } = await projectWithScenes(h, 1);
  makeAccountReady(h);
  await post(h, `/api/projects/${projectId}/submit`, submitBody({ expected_scene_count: 1 }));

  for (const status of ["queued", "claimed", "running", "waiting_for_user"]) {
    h.db.raw.prepare("UPDATE jobs SET status=?").run(status);
    const edit = await patch(h, `/api/scenes/${scenes[0].id}`, { prompt: "ubah" });
    assert.equal(edit.status, 409, status);
    assert.equal(edit.json.error.code, "scene_locked");
    assert.equal((await del(h, `/api/scenes/${scenes[0].id}`)).json.error.code, "scene_locked", status);
  }
  h.db.raw.prepare("UPDATE jobs SET status='succeeded'").run();
  assert.equal((await patch(h, `/api/scenes/${scenes[0].id}`, { prompt: "boleh lagi" })).status, 200);
});

test("scenes: reorder renumbers 1..N atomically and rejects partial, duplicate or foreign lists", async () => {
  const h = await createHarness();
  const { projectId, scenes } = await projectWithScenes(h, 3);
  const other = await createProject(h, "Lain");
  const foreign = await addScene(h, other);
  const path = `/api/projects/${projectId}/scenes/reorder`;
  const [a, b, c] = scenes.map((scene) => scene.id);

  const ok = await post(h, path, { scene_ids: [c, a, b] });
  assert.equal(ok.status, 200);
  const detail = await authed(h, { path: `/api/projects/${projectId}` });
  assert.deepEqual(detail.json.scenes.map((s: { id: string }) => s.id), [c, a, b]);
  assert.deepEqual(detail.json.scenes.map((s: { scene_order: number }) => s.scene_order), [1, 2, 3]);

  const before = h.db.raw.prepare("SELECT id,scene_order FROM scenes ORDER BY id").all();
  const partial = await post(h, path, { scene_ids: [a, b] });
  assert.equal(partial.status, 409);
  assert.equal(partial.json.error.code, "scene_set_mismatch");
  assert.equal((await post(h, path, { scene_ids: [a, b, foreign.id] })).json.error.code, "scene_set_mismatch");
  assert.ok(hasIssue(await post(h, path, { scene_ids: [a, a, b] }), "scene_ids", "duplicate_value"));
  assert.ok(hasIssue(await post(h, path, { scene_ids: [] }), "scene_ids", "out_of_range"));
  assert.ok(hasIssue(await post(h, path, { scene_ids: ["x"] }), "scene_ids", "invalid_format"));
  assert.ok(hasIssue(await post(h, path, { scene_ids: "abc" }), "scene_ids", "must_be_array"));
  assert.ok(hasIssue(await post(h, path, {}), "scene_ids", "required"));
  assert.deepEqual(h.db.raw.prepare("SELECT id,scene_order FROM scenes ORDER BY id").all(), before, "failed reorders change nothing");
});

// ---------- readiness and submit ----------

test("readiness: reports every blocking problem and the ready accounts", async () => {
  const h = await createHarness();
  const empty = await createProject(h, "Kosong");

  const bare = await authed(h, { path: `/api/projects/${empty}/readiness` });
  assert.equal(bare.status, 200);
  assert.equal(bare.json.can_submit, false);
  assert.deepEqual(bare.json.problems.map((p: { code: string }) => p.code), ["no_scenes", "account_required"]);
  assert.deepEqual(bare.json.ready_accounts, []);

  const { projectId } = await projectWithScenes(h, 2);
  const notReady = await authed(h, { path: `/api/projects/${projectId}/readiness?account_id=acct-02` });
  assert.deepEqual(notReady.json.problems.map((p: { code: string }) => p.code), ["account_not_ready"]);
  assert.equal(notReady.json.account.status, "needs_login");

  makeAccountReady(h, "acct-02");
  const ready = await authed(h, { path: `/api/projects/${projectId}/readiness?account_id=acct-02` });
  assert.equal(ready.json.can_submit, true);
  assert.equal(ready.json.scene_count, 2);
  assert.equal(ready.json.total_seconds, 16);
  assert.deepEqual(ready.json.ready_accounts.map((a: { id: string }) => a.id), ["acct-02"]);

  assert.equal((await authed(h, { path: `/api/projects/${projectId}/readiness?account_id=acct-99` })).status, 400);
});

test("submit: queues one job per scene in scene order and the global lane runs them FIFO", async () => {
  const h = await createHarness();
  const { projectId, scenes } = await projectWithScenes(h, 3);
  await post(h, `/api/projects/${projectId}/scenes/reorder`, { scene_ids: [scenes[2].id, scenes[0].id, scenes[1].id] });
  makeAccountReady(h);

  const res = await post(h, `/api/projects/${projectId}/submit`, submitBody());
  assert.equal(res.status, 201, res.text);
  assert.deepEqual(res.json.jobs.map((job: { scene_id: string }) => job.scene_id), [scenes[2].id, scenes[0].id, scenes[1].id]);
  assert.deepEqual(jobStatuses(h), ["queued", "queued", "queued"]);

  const claim = await asWorker(h, { path: "/api/worker/claim", body: { worker_id: "worker-1" } });
  assert.equal(claim.json.claimed, true);
  assert.equal(claim.json.job.scene_id, scenes[2].id, "the first scene in order runs first");

  const audit = h.db.raw.prepare("SELECT event_type FROM audit_events WHERE event_type IN ('job.queued','project.submitted')").all();
  assert.equal(audit.length, 4);
});

test("submit: repeating the same key replays; a different account or scene set is a conflict", async () => {
  const h = await createHarness();
  const { projectId } = await projectWithScenes(h, 2);
  makeAccountReady(h);
  makeAccountReady(h, "acct-02");
  const body = submitBody({ expected_scene_count: 2 });

  const first = await post(h, `/api/projects/${projectId}/submit`, body);
  assert.equal(first.status, 201);
  const again = await post(h, `/api/projects/${projectId}/submit`, body);
  assert.equal(again.status, 200);
  assert.equal(again.json.idempotent_replay, true);
  assert.deepEqual(
    again.json.jobs.map((job: { id: string }) => job.id),
    first.json.jobs.map((job: { id: string }) => job.id),
  );
  assert.equal(count(h.db, "jobs"), 2, "no duplicate jobs");

  const otherAccount = await post(h, `/api/projects/${projectId}/submit`, { ...body, account_id: "acct-02" });
  assert.equal(otherAccount.status, 409);
  assert.equal(otherAccount.json.error.code, "idempotency_key_conflict");

  await addScene(h, projectId, "Scene baru");
  const changedSet = await post(h, `/api/projects/${projectId}/submit`, body);
  assert.equal(changedSet.json.error.code, "idempotency_key_conflict");
  assert.equal(count(h.db, "jobs"), 2);
});

test("submit: refuses a stale review, unready account, busy scenes, archived project and live engines", async () => {
  const h = await createHarness();
  const { projectId } = await projectWithScenes(h, 2);
  const path = `/api/projects/${projectId}/submit`;

  const notReady = await post(h, path, submitBody({ expected_scene_count: 2 }));
  assert.equal(notReady.status, 409);
  assert.equal(notReady.json.error.code, "submit_blocked");
  assert.deepEqual(notReady.json.error.details.problems, [{ code: "account_not_ready" }]);

  makeAccountReady(h);
  const stale = await post(h, path, submitBody({ expected_scene_count: 5, idempotency_key: "stale-key-0001" }));
  assert.equal(stale.json.error.code, "scenes_changed");
  assert.deepEqual(stale.json.error.details, { expected: 5, actual: 2 });

  const live = await post(h, path, submitBody({ expected_scene_count: 2, engine: "flowkit", idempotency_key: "live-key-00001" }));
  assert.equal(live.status, 403);
  assert.equal(live.json.error.code, "live_engine_disabled");

  assert.equal((await post(h, path, submitBody({ expected_scene_count: 2, idempotency_key: "good-key-00001" }))).status, 201);
  const busy = await post(h, path, submitBody({ expected_scene_count: 2, idempotency_key: "good-key-00002" }));
  assert.equal(busy.json.error.code, "submit_blocked");
  assert.ok(busy.json.error.details.problems.every((p: { code: string }) => p.code === "scene_busy"));
  assert.equal(count(h.db, "jobs"), 2, "nothing was queued by the refused calls");

  h.db.raw.prepare("UPDATE jobs SET status='succeeded'").run();
  await patch(h, `/api/projects/${projectId}`, { status: "archived" });
  const archived = await post(h, path, submitBody({ expected_scene_count: 2, idempotency_key: "good-key-00003" }));
  assert.ok(archived.json.error.details.problems.some((p: { code: string }) => p.code === "project_archived"));
});

test("submit: validation and unknown projects", async () => {
  const h = await createHarness();
  const { projectId } = await projectWithScenes(h, 1);
  const path = `/api/projects/${projectId}/submit`;
  const res = await post(h, path, { idempotency_key: "short", expected_scene_count: 0, extra: 1 });
  assert.equal(res.status, 400);
  assert.ok(hasIssue(res, "account_id", "required"));
  assert.ok(hasIssue(res, "idempotency_key", "too_short"));
  assert.ok(hasIssue(res, "expected_scene_count", "out_of_range"));
  assert.ok(hasIssue(res, "extra", "unknown_field"));
  assert.equal(
    (await post(h, "/api/projects/11111111-2222-4333-8444-555555555555/submit", submitBody())).status,
    404,
  );
});

// ---------- job detail and retry ----------

test("GET /api/jobs/:id returns the job with a safe timeline and never leaks worker or lease data", async () => {
  const h = await createHarness();
  const { projectId, scenes } = await projectWithScenes(h, 1);
  makeAccountReady(h);
  const submitted = await post(h, `/api/projects/${projectId}/submit`, submitBody({ expected_scene_count: 1 }));
  const jobId = submitted.json.jobs[0].id as string;
  await asWorker(h, { path: "/api/worker/claim", body: { worker_id: "worker-secret-name" } });

  const res = await authed(h, { path: `/api/jobs/${jobId}` });
  assert.equal(res.status, 200);
  assert.equal(res.json.status, "claimed");
  assert.equal(res.json.scene_id, scenes[0].id);
  assert.equal(res.json.scene_order, 1);
  assert.equal(res.json.scene_prompt, "Scene 1");
  assert.equal(res.json.account_slot, 1);
  assert.equal(res.json.cancel_requested, false);
  assert.deepEqual(res.json.timeline.map((e: { event: string }) => e.event), ["job.queued", "job.claimed"]);
  assert.ok(!res.text.includes("worker-secret-name"), "worker id must not reach the PWA");
  assert.ok(!res.text.includes("lease_token") && !res.text.includes("fencing"));
  assert.ok(!("error_message" in res.json));

  assert.equal((await authed(h, { path: "/api/jobs/11111111-2222-4333-8444-555555555555" })).status, 404);
});

test("GET /api/jobs supports the project filter and exposes scene order and retry_of", async () => {
  const h = await createHarness();
  const a = await projectWithScenes(h, 1);
  const b = await projectWithScenes(h, 1);
  makeAccountReady(h);
  await post(h, `/api/projects/${a.projectId}/submit`, submitBody({ expected_scene_count: 1, idempotency_key: "key-a-000001" }));
  await post(h, `/api/projects/${b.projectId}/submit`, submitBody({ expected_scene_count: 1, idempotency_key: "key-b-000001" }));

  const all = await authed(h, { path: "/api/jobs" });
  assert.equal(all.json.items.length, 2);
  const onlyA = await authed(h, { path: `/api/jobs?project_id=${a.projectId}` });
  assert.equal(onlyA.json.items.length, 1);
  assert.equal(onlyA.json.items[0].project_id, a.projectId);
  assert.equal(onlyA.json.items[0].scene_order, 1);
  assert.equal(onlyA.json.items[0].retry_of, null);
  assert.equal((await authed(h, { path: "/api/jobs?project_id=zzz" })).status, 400);
});

test("retry: creates a new job linked to the failed one; history is untouched", async () => {
  const h = await createHarness();
  const { projectId } = await projectWithScenes(h, 1);
  makeAccountReady(h);
  const submitted = await post(h, `/api/projects/${projectId}/submit`, submitBody({ expected_scene_count: 1 }));
  const failedId = submitted.json.jobs[0].id as string;
  const path = `/api/jobs/${failedId}/retry`;
  const body = { idempotency_key: "retry-key-0001" };

  const early = await post(h, path, body);
  assert.equal(early.status, 409);
  assert.equal(early.json.error.code, "job_not_retryable");

  h.db.raw.prepare("UPDATE jobs SET status='failed', error_code='engine_timeout' WHERE id=?").run(failedId);
  const retry = await post(h, path, body);
  assert.equal(retry.status, 201, retry.text);
  assert.equal(retry.json.retry_of, failedId);
  assert.equal(retry.json.status, "queued");
  assert.equal(count(h.db, "jobs"), 2);
  assert.equal((h.db.raw.prepare("SELECT status FROM jobs WHERE id=?").get(failedId) as { status: string }).status, "failed");

  const again = await post(h, path, body);
  assert.equal(again.status, 200);
  assert.equal(again.json.idempotent_replay, true);
  assert.equal(again.json.id, retry.json.id);
  assert.equal(count(h.db, "jobs"), 2);

  const detail = await authed(h, { path: `/api/jobs/${retry.json.id}` });
  assert.equal(detail.json.retry_of, failedId);
  assert.equal(detail.json.timeline[0].detail.retry_of, failedId);

  const busy = await post(h, path, { idempotency_key: "retry-key-0002" });
  assert.equal(busy.json.error.code, "scene_busy", "a second retry cannot queue while the first is active");
});

test("retry: cancelled jobs can be retried; guards for key reuse, unready account and archive", async () => {
  const h = await createHarness();
  const { projectId } = await projectWithScenes(h, 2);
  makeAccountReady(h);
  const submitted = await post(h, `/api/projects/${projectId}/submit`, submitBody({ expected_scene_count: 2 }));
  const [first, second] = submitted.json.jobs as Array<{ id: string }>;
  h.db.raw.prepare("UPDATE jobs SET status='cancelled'").run();

  const reused = await post(h, `/api/jobs/${first.id}/retry`, { idempotency_key: "retry-key-0001" });
  assert.equal(reused.status, 201);
  const conflict = await post(h, `/api/jobs/${second.id}/retry`, { idempotency_key: "retry-key-0001" });
  assert.equal(conflict.status, 409);
  assert.equal(conflict.json.error.code, "idempotency_key_conflict");

  h.db.raw.prepare("UPDATE accounts SET status='auth_required' WHERE id='acct-01'").run();
  const unready = await post(h, `/api/jobs/${second.id}/retry`, { idempotency_key: "retry-key-0002" });
  assert.equal(unready.json.error.code, "account_not_ready");
  makeAccountReady(h);

  h.db.raw.prepare("UPDATE jobs SET status='failed' WHERE id=?").run(reused.json.id);
  await patch(h, `/api/projects/${projectId}`, { status: "archived" });
  const archived = await post(h, `/api/jobs/${second.id}/retry`, { idempotency_key: "retry-key-0003" });
  assert.equal(archived.json.error.code, "project_archived");

  assert.ok(hasIssue(await post(h, `/api/jobs/${second.id}/retry`, {}), "idempotency_key", "required"));
  assert.equal((await post(h, "/api/jobs/11111111-2222-4333-8444-555555555555/retry", { idempotency_key: "retry-key-0009" })).status, 404);
});

test("retry: live-engine jobs stay blocked while live engines are disabled", async () => {
  const h = await createHarness();
  const { projectId } = await projectWithScenes(h, 1);
  makeAccountReady(h);
  const submitted = await post(h, `/api/projects/${projectId}/submit`, submitBody({ expected_scene_count: 1 }));
  const jobId = submitted.json.jobs[0].id as string;
  h.db.raw.prepare("UPDATE jobs SET status='failed', engine='flowkit' WHERE id=?").run(jobId);
  const res = await post(h, `/api/jobs/${jobId}/retry`, { idempotency_key: "retry-key-0001" });
  assert.equal(res.status, 403);
  assert.equal(res.json.error.code, "live_engine_disabled");
});

test("worker tokens cannot reach any new owner route", async () => {
  const h = await createHarness();
  const { projectId, scenes } = await projectWithScenes(h, 1);
  const paths: Array<[string, string, unknown]> = [
    ["GET", `/api/projects/${projectId}`, undefined],
    ["PATCH", `/api/projects/${projectId}`, { name: "x" }],
    ["POST", `/api/projects/${projectId}/scenes`, { prompt: "x" }],
    ["GET", `/api/projects/${projectId}/readiness`, undefined],
    ["PATCH", `/api/scenes/${scenes[0].id}`, { prompt: "x" }],
    ["POST", `/api/scenes/${scenes[0].id}/delete`, {}],
    ["GET", "/api/jobs/11111111-2222-4333-8444-555555555555", undefined],
  ];
  const before = count(h.db, "scenes");
  for (const [method, path, body] of paths) {
    const res = await asWorker(h, { method, path, body });
    assert.equal(res.status, 403, `${method} ${path}`);
  }
  assert.equal(count(h.db, "scenes"), before);
});
