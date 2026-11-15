import assert from "node:assert/strict";
import { test } from "node:test";
import { createHash } from "node:crypto";
import { authed, buildRequest, createHarness, createProject, makeAccountReady, send, WORKER_TOKEN } from "./helpers.ts";

function fakeBucket() {
  const objects = new Map<string, Uint8Array>();
  return {
    objects,
    async put(key: string, value: Uint8Array) { objects.set(key, new Uint8Array(value)); return { key }; },
    async delete(key: string) { objects.delete(key); },
    async get(key: string) {
      const value = objects.get(key);
      if (!value) return null;
      return { body: new Blob([new Uint8Array(value).buffer as ArrayBuffer]).stream(), size: value.length };
    },
  };
}

const PNG = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0]);

async function fixture(envOverrides: (bucket: ReturnType<typeof fakeBucket>) => Record<string, unknown> = (bucket) => ({ MEDIA: bucket })) {
  const bucket = fakeBucket();
  const h = await createHarness(envOverrides(bucket));
  makeAccountReady(h);
  const projectId = await createProject(h);
  const queued = await authed(h, {
    method: "POST", path: "/api/jobs",
    body: { project_id: projectId, account_id: "acct-01", idempotency_key: "media-delete-0001" },
  });
  assert.equal(queued.status, 201);
  const jobId = queued.json.id as string;
  h.db.raw.prepare("UPDATE jobs SET status='running',worker_id='worker-test',lease_token=1 WHERE id=?").run(jobId);
  h.db.raw.prepare(
    "UPDATE global_lease SET holder_id='worker-test',job_id=?,fencing_token=1,expires_at=? WHERE name='global'",
  ).run(jobId, h.clock.now + 60_000);
  const uploaded = await send(h, buildRequest({
    method: "POST",
    path: `/api/worker/jobs/${jobId}/media`,
    bearer: WORKER_TOKEN,
    headers: {
      "content-type": "image/png",
      "x-worker-id": "worker-test",
      "x-fencing-token": "1",
      "x-content-sha256": createHash("sha256").update(PNG).digest("hex"),
    },
  }, PNG.slice().buffer as ArrayBuffer));
  assert.equal(uploaded.status, 201, uploaded.text);
  return { h, bucket, jobId, mediaId: uploaded.json.id as string };
}

function finishJob(h: Awaited<ReturnType<typeof createHarness>>, jobId: string) {
  h.db.raw.prepare("UPDATE jobs SET status='succeeded' WHERE id=?").run(jobId);
}

function auditTypes(h: Awaited<ReturnType<typeof createHarness>>): string[] {
  return (h.db.raw.prepare("SELECT event_type FROM audit_events ORDER BY rowid").all() as Array<{ event_type: string }>)
    .map((row) => row.event_type);
}

test("owner deletes finished-job media: row, R2 object and listing are gone and both steps are audited", async () => {
  const { h, bucket, jobId, mediaId } = await fixture();
  finishJob(h, jobId);
  assert.equal(bucket.objects.size, 1);

  const result = await authed(h, { method: "POST", path: `/api/media/${mediaId}/delete` });
  assert.equal(result.status, 200, result.text);
  assert.deepEqual(result.json, { id: mediaId, deleted: true, object_deleted: true });
  assert.ok(!result.text.includes("media/"), "R2 key is never exposed");
  assert.equal(bucket.objects.size, 0);
  assert.equal(h.db.raw.prepare("SELECT COUNT(*) AS n FROM media").get()?.n, 0);

  const types = auditTypes(h);
  assert.ok(types.includes("media.deleted"));
  assert.equal(types[types.length - 1], "media.object_deleted");
  const detail = h.db.raw.prepare("SELECT detail_json FROM audit_events WHERE event_type='media.deleted'").get()?.detail_json as string;
  assert.ok(!detail.includes("media/"), "audit log never records the R2 key");
  assert.equal(JSON.parse(detail).media_id, mediaId);

  const listed = await authed(h, { path: `/api/jobs/${jobId}/media` });
  assert.equal(listed.json.items.length, 0);
  const download = await authed(h, { path: `/api/media/${mediaId}` });
  assert.equal(download.status, 404);
});

test("deleting twice or deleting an unknown id returns 404 and writes no extra audit event", async () => {
  const { h, jobId, mediaId } = await fixture();
  finishJob(h, jobId);
  assert.equal((await authed(h, { method: "POST", path: `/api/media/${mediaId}/delete` })).status, 200);
  const before = auditTypes(h).length;
  const again = await authed(h, { method: "POST", path: `/api/media/${mediaId}/delete` });
  assert.equal(again.status, 404);
  assert.equal(again.json.error.code, "media_not_found");
  const unknown = await authed(h, { method: "POST", path: "/api/media/11111111-2222-4333-8444-555555555555/delete" });
  assert.equal(unknown.status, 404);
  assert.equal(auditTypes(h).length, before);
});

test("media of a job a worker is still running cannot be deleted", async () => {
  const { h, bucket, jobId, mediaId } = await fixture();
  const blocked = await authed(h, { method: "POST", path: `/api/media/${mediaId}/delete` });
  assert.equal(blocked.status, 409);
  assert.equal(blocked.json.error.code, "job_active");
  assert.equal(bucket.objects.size, 1);
  assert.equal(h.db.raw.prepare("SELECT COUNT(*) AS n FROM media").get()?.n, 1);
  assert.ok(!auditTypes(h).includes("media.deleted"));

  finishJob(h, jobId);
  const allowed = await authed(h, { method: "POST", path: `/api/media/${mediaId}/delete` });
  assert.equal(allowed.status, 200);
});

test("R2 delete failure still removes the listing, reports object_deleted=false and audits the failure", async () => {
  const { h, bucket, jobId, mediaId } = await fixture((bucket) => ({
    MEDIA: { ...bucket, async delete() { throw new Error("r2 unavailable"); } },
  }));
  finishJob(h, jobId);
  const result = await authed(h, { method: "POST", path: `/api/media/${mediaId}/delete` });
  assert.equal(result.status, 200, result.text);
  assert.deepEqual(result.json, { id: mediaId, deleted: true, object_deleted: false });
  assert.equal(h.db.raw.prepare("SELECT COUNT(*) AS n FROM media").get()?.n, 0);
  assert.equal(bucket.objects.size, 1, "the object remains as an orphan for later cleanup");
  const types = auditTypes(h);
  assert.ok(types.includes("media.deleted"));
  assert.equal(types[types.length - 1], "media.object_delete_failed");
});

test("delete is owner-only: worker token and anonymous callers are rejected and nothing changes", async () => {
  const { h, bucket, jobId, mediaId } = await fixture();
  finishJob(h, jobId);
  const asWorker = await send(h, buildRequest({ method: "POST", path: `/api/media/${mediaId}/delete`, bearer: WORKER_TOKEN }));
  assert.equal(asWorker.status, 403);
  const anonymous = await send(h, buildRequest({ method: "POST", path: `/api/media/${mediaId}/delete` }));
  assert.equal(anonymous.status, 401);
  const wrongMethod = await authed(h, { method: "GET", path: `/api/media/${mediaId}/delete` });
  assert.equal(wrongMethod.status, 405);
  assert.equal(bucket.objects.size, 1);
  assert.equal(h.db.raw.prepare("SELECT COUNT(*) AS n FROM media").get()?.n, 1);
});
