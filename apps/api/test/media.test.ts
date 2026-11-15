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

async function fixture() {
  const bucket = fakeBucket();
  const h = await createHarness({ MEDIA: bucket });
  makeAccountReady(h);
  const projectId = await createProject(h);
  const queued = await authed(h, {
    method: "POST", path: "/api/jobs",
    body: { project_id: projectId, account_id: "acct-01", idempotency_key: "media-test-0001" },
  });
  assert.equal(queued.status, 201);
  const jobId = queued.json.id as string;
  h.db.raw.prepare("UPDATE jobs SET status='running',worker_id='worker-test',lease_token=1 WHERE id=?").run(jobId);
  h.db.raw.prepare(
    "UPDATE global_lease SET holder_id='worker-test',job_id=?,fencing_token=1,expires_at=? WHERE name='global'",
  ).run(jobId, h.clock.now + 60_000);
  return { h, bucket, jobId };
}

async function upload(h: Awaited<ReturnType<typeof createHarness>>, jobId: string, bytes: Uint8Array, checksum = createHash("sha256").update(bytes).digest("hex")) {
  const headers = new Headers({
    "content-type": "image/png",
    "x-worker-id": "worker-test",
    "x-fencing-token": "1",
    "x-content-sha256": checksum,
  });
  const request = buildRequest({
    method: "POST",
    path: `/api/worker/jobs/${jobId}/media`,
    bearer: WORKER_TOKEN,
    headers: Object.fromEntries(headers.entries()),
  }, bytes.slice().buffer as ArrayBuffer);
  return send(h, request);
}

const PNG = new Uint8Array([137,80,78,71,13,10,26,10,0,0,0,0]);

test("worker uploads verified media to private R2 and owner can list/download it", async () => {
  const { h, bucket, jobId } = await fixture();
  const result = await upload(h, jobId, PNG);
  assert.equal(result.status, 201, result.text);
  assert.equal(result.json.job_id, jobId);
  assert.equal(result.json.mime, "image/png");
  assert.equal(result.json.size_bytes, PNG.length);
  assert.equal(bucket.objects.size, 1);
  assert.equal(h.db.raw.prepare("SELECT COUNT(*) AS n FROM media WHERE job_id=?").get(jobId)?.n, 1);
  assert.equal(h.db.raw.prepare("SELECT event_type FROM audit_events ORDER BY rowid DESC LIMIT 1").get()?.event_type, "media.uploaded");

  const listed = await authed(h, { path: `/api/jobs/${jobId}/media` });
  assert.equal(listed.status, 200);
  assert.equal(listed.json.items.length, 1);
  assert.ok(!("r2_key" in listed.json.items[0]), "internal R2 key is never exposed");

  const downloadResponse = await h.app.fetch(
    buildRequest({ path: `/api/media/${result.json.id}`, session: await h.session() }),
    h.env as never,
  );
  assert.equal(downloadResponse.status, 200);
  assert.equal(downloadResponse.headers.get("content-type"), "image/png");
  assert.equal(downloadResponse.headers.get("cache-control"), "private, no-store, max-age=0");
  assert.deepEqual(new Uint8Array(await downloadResponse.arrayBuffer()), PNG);
});

test("same job and checksum is idempotent and does not create another R2 object", async () => {
  const { h, bucket, jobId } = await fixture();
  const first = await upload(h, jobId, PNG);
  const second = await upload(h, jobId, PNG);
  assert.equal(first.status, 201);
  assert.equal(second.status, 200);
  assert.equal(second.json.idempotent_replay, true);
  assert.equal(bucket.objects.size, 1);
  assert.equal(h.db.raw.prepare("SELECT COUNT(*) AS n FROM media").get()?.n, 1);
});

test("checksum, content signature, and current fencing lease are enforced", async () => {
  const { h, bucket, jobId } = await fixture();
  const badChecksum = await upload(h, jobId, PNG, "0".repeat(64));
  assert.equal(badChecksum.status, 400);
  assert.equal(badChecksum.json.error.code, "checksum_mismatch");
  const wrongMime = await upload(h, jobId, new Uint8Array([1,2,3,4]));
  assert.equal(wrongMime.status, 415);
  assert.equal(wrongMime.json.error.code, "media_signature_mismatch");
  h.db.raw.prepare("UPDATE global_lease SET expires_at=? WHERE name='global'").run(h.clock.now);
  const expired = await upload(h, jobId, PNG);
  assert.equal(expired.status, 409);
  assert.equal(expired.json.error.code, "lease_lost");
  assert.equal(bucket.objects.size, 0);
  assert.equal(h.db.raw.prepare("SELECT COUNT(*) AS n FROM media").get()?.n, 0);
});

test("owner and worker audiences remain isolated for media endpoints", async () => {
  const { h, jobId } = await fixture();
  const ownerUpload = await authed(h, { method: "POST", path: `/api/worker/jobs/${jobId}/media`, body: {} });
  assert.equal(ownerUpload.status, 403);
  const workerList = await send(h, buildRequest({ path: `/api/jobs/${jobId}/media`, bearer: WORKER_TOKEN }));
  assert.equal(workerList.status, 403);
  const workerDownload = await send(h, buildRequest({ path: `/api/media/11111111-2222-4333-8444-555555555555`, bearer: WORKER_TOKEN }));
  assert.equal(workerDownload.status, 403);
});