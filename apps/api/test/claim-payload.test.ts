import assert from "node:assert/strict";
import { test } from "node:test";
import { asWorker, authed, createHarness, createProject, makeAccountReady } from "./helpers.ts";
import type { Harness } from "./helpers.ts";

const claim = (h: Harness, workerId = "worker-1") =>
  asWorker(h, { path: "/api/worker/claim", body: { worker_id: workerId } });

async function addScene(h: Harness, projectId: string, prompt: string, duration?: number) {
  const res = await authed(h, {
    method: "POST",
    path: `/api/projects/${projectId}/scenes`,
    body: { prompt, ...(duration === undefined ? {} : { duration_seconds: duration }) },
  });
  assert.equal(res.status, 201, res.text);
  return res.json as { id: string; scene_order: number };
}

async function submit(h: Harness, projectId: string, count: number, key = "submit-key-0001") {
  const res = await authed(h, {
    method: "POST",
    path: `/api/projects/${projectId}/submit`,
    body: { account_id: "acct-01", idempotency_key: key, expected_scene_count: count },
  });
  assert.equal(res.status, 201, res.text);
  return res.json.jobs as Array<{ id: string; scene_id: string }>;
}

test("claim returns the scene prompt, duration, order and the project aspect ratio", async () => {
  const h = await createHarness();
  makeAccountReady(h);
  const projectId = await createProject(h);
  const patched = await authed(h, { method: "PATCH", path: `/api/projects/${projectId}`, body: { aspect_ratio: "16:9" } });
  assert.equal(patched.status, 200);
  const scene = await addScene(h, projectId, "Baris satu\nBaris dua", 5);
  await submit(h, projectId, 1);

  const res = await claim(h);
  assert.equal(res.status, 200);
  assert.equal(res.json.claimed, true);
  assert.equal(res.json.job.aspect_ratio, "16:9");
  assert.deepEqual(res.json.job.scene, {
    id: scene.id,
    order: 1,
    prompt: "Baris satu\nBaris dua",
    duration_seconds: 5,
  });
});

test("claim follows scene order and each job carries its own scene data", async () => {
  const h = await createHarness();
  makeAccountReady(h);
  const projectId = await createProject(h);
  const first = await addScene(h, projectId, "Pertama", 3);
  const second = await addScene(h, projectId, "Kedua", 9);
  await authed(h, {
    method: "POST",
    path: `/api/projects/${projectId}/scenes/reorder`,
    body: { scene_ids: [second.id, first.id] },
  });
  await submit(h, projectId, 2);

  const one = await claim(h);
  assert.equal(one.json.job.scene.prompt, "Kedua");
  assert.equal(one.json.job.scene.order, 1);
  assert.equal(one.json.job.scene.duration_seconds, 9);
  assert.equal(one.json.job.aspect_ratio, "9:16", "default project ratio");

  const ref = { worker_id: "worker-1", fencing_token: one.json.lease.fencing_token };
  await asWorker(h, { path: `/api/worker/jobs/${one.json.job.id}/start`, body: ref });
  const done = await asWorker(h, { path: `/api/worker/jobs/${one.json.job.id}/complete`, body: ref });
  assert.equal(done.status, 200, done.text);

  const two = await claim(h);
  assert.equal(two.json.job.scene.prompt, "Pertama");
  assert.equal(two.json.job.scene.order, 2);
  assert.equal(two.json.job.scene.duration_seconds, 3);
});

test("a job whose scene was deleted after queuing is still claimable with scene: null", async () => {
  const h = await createHarness();
  makeAccountReady(h);
  const projectId = await createProject(h);
  await addScene(h, projectId, "Akan dihapus");
  const jobs = await submit(h, projectId, 1);
  // The API refuses to delete a scene with an active job; simulate the row vanishing directly
  // (FK is ON DELETE SET NULL), which is the case the worker must be able to survive.
  h.db.raw.prepare("DELETE FROM scenes WHERE id=?").run(jobs[0].scene_id);

  const res = await claim(h);
  assert.equal(res.status, 200);
  assert.equal(res.json.claimed, true);
  assert.equal(res.json.job.id, jobs[0].id);
  assert.equal(res.json.job.scene_id, null);
  assert.equal(res.json.job.scene, null);
  assert.equal(res.json.job.aspect_ratio, "9:16");
});

test("claim payload exposes no lease internals, other jobs' data or unrelated fields", async () => {
  const h = await createHarness();
  makeAccountReady(h);
  const projectId = await createProject(h);
  await addScene(h, projectId, "Rahasia prompt");
  await submit(h, projectId, 1);

  const res = await claim(h, "worker-xyz");
  assert.deepEqual(Object.keys(res.json.job).sort(), [
    "account_id",
    "aspect_ratio",
    "attempt",
    "engine",
    "id",
    "max_attempts",
    "project_id",
    "scene",
    "scene_id",
  ]);
  assert.deepEqual(Object.keys(res.json.job.scene).sort(), ["duration_seconds", "id", "order", "prompt"]);
  assert.deepEqual(Object.keys(res.json.lease).sort(), ["expires_at", "fencing_token"]);
});

test("an empty queue still answers claimed:false and does not need scene data", async () => {
  const h = await createHarness();
  const res = await claim(h);
  assert.equal(res.status, 200);
  assert.deepEqual(res.json, { claimed: false });
});

test("a job queued without a scene (direct POST /api/jobs) is claimable with scene: null", async () => {
  const h = await createHarness();
  makeAccountReady(h);
  const projectId = await createProject(h);
  const queued = await authed(h, {
    method: "POST",
    path: "/api/jobs",
    body: { project_id: projectId, account_id: "acct-01", idempotency_key: "direct-key-0001" },
  });
  assert.equal(queued.status, 201);

  const res = await claim(h);
  assert.equal(res.json.claimed, true);
  assert.equal(res.json.job.scene, null);
  assert.equal(res.json.job.scene_id, null);
});
