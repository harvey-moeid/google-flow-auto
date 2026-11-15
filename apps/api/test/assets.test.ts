import assert from "node:assert/strict";
import { test } from "node:test";
import { asWorker, authed, buildRequest, call, count, createHarness, createProject, makeAccountReady, send } from "./helpers.ts";
import type { Harness } from "./helpers.ts";

const PNG_HEAD = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const JPEG_HEAD = [0xff, 0xd8, 0xff, 0xe0];
const WEBP_HEAD = [0x52, 0x49, 0x46, 0x46, 0x10, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50];

function image(head: number[], size = 64): Uint8Array {
  const bytes = new Uint8Array(size);
  bytes.set(head);
  for (let i = head.length; i < size; i += 1) bytes[i] = i % 251;
  return bytes;
}

async function sha256(bytes: Uint8Array): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return [...digest].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function addScene(h: Harness, projectId: string, prompt = "Adegan") {
  const res = await authed(h, { method: "POST", path: `/api/projects/${projectId}/scenes`, body: { prompt } });
  assert.equal(res.status, 201, res.text);
  return res.json.id as string;
}

async function upload(
  h: Harness,
  sceneId: string,
  bytes: Uint8Array | ReadableStream<Uint8Array>,
  options: { type?: string; query?: string; session?: string | null; bearer?: string; origin?: string } = {},
) {
  const session = options.session === undefined ? await h.session() : options.session;
  const request = buildRequest(
    {
      method: "POST",
      path: `/api/scenes/${sceneId}/assets${options.query ?? ""}`,
      session,
      bearer: options.bearer,
      origin: options.origin,
      headers: { "content-type": options.type ?? "image/png" },
    },
    bytes as never,
  );
  return send(h, request);
}

async function setup() {
  const h = await createHarness();
  const projectId = await createProject(h);
  const sceneId = await addScene(h, projectId);
  return { h, projectId, sceneId };
}

const auditTypes = (h: Harness) =>
  (h.db.raw.prepare("SELECT event_type FROM audit_events ORDER BY created_at, rowid").all() as Array<{ event_type: string }>).map(
    (row) => row.event_type,
  );

test("uploading a PNG stores the object privately and returns only safe metadata", async () => {
  const { h, projectId, sceneId } = await setup();
  const bytes = image(PNG_HEAD, 200);
  const res = await upload(h, sceneId, bytes, { query: "?name=referensi%20kucing.png" });
  assert.equal(res.status, 201, res.text);
  assert.equal(res.json.mime_type, "image/png");
  assert.equal(res.json.size_bytes, 200);
  assert.equal(res.json.name, "referensi kucing.png");
  assert.equal(res.json.scene_id, sceneId);
  assert.match(res.json.sha256, /^[0-9a-f]{64}$/);
  assert.equal("r2_key" in res.json, false, "the storage key is never exposed");

  assert.equal(res.json.sha256, await sha256(bytes), "the checksum is the SHA-256 of the stored bytes");

  const key = `assets/${projectId}/${sceneId}/${res.json.id}`;
  const stored = h.bucket.objects.get(key);
  assert.ok(stored, "object is stored under a server-built key");
  assert.deepEqual([...stored.bytes], [...bytes]);
  assert.equal(stored.contentType, "image/png");

  const audit = h.db.raw.prepare("SELECT detail_json FROM audit_events WHERE event_type='asset.uploaded'").get() as {
    detail_json: string;
  };
  assert.ok(audit, "upload is audited");
  assert.equal(audit.detail_json.includes("kucing"), false, "the user label is not copied into the audit log");
});

test("JPEG and WebP are accepted as well", async () => {
  const { h, sceneId } = await setup();
  const jpeg = await upload(h, sceneId, image(JPEG_HEAD), { type: "image/jpeg" });
  assert.equal(jpeg.status, 201, jpeg.text);
  const webp = await upload(h, sceneId, image(WEBP_HEAD), { type: "image/webp; charset=binary" });
  assert.equal(webp.status, 201, webp.text);
  assert.equal(webp.json.mime_type, "image/webp");
});

test("list and content return the stored file to the owner with the validated type", async () => {
  const { h, sceneId } = await setup();
  const bytes = image(PNG_HEAD, 120);
  const created = await upload(h, sceneId, bytes);
  const list = await authed(h, { path: `/api/scenes/${sceneId}/assets` });
  assert.equal(list.status, 200);
  assert.equal(list.json.items.length, 1);
  assert.equal(list.json.items[0].id, created.json.id);

  const response = await h.app.fetch(
    buildRequest({ path: `/api/assets/${created.json.id}/content`, session: await h.session() }),
    h.env as never,
  );
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "image/png");
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  assert.equal(response.headers.get("etag"), `"${created.json.sha256}"`);
  assert.deepEqual([...new Uint8Array(await response.arrayBuffer())], [...bytes]);
});

test("project detail reports how many reference images each scene has", async () => {
  const { h, projectId, sceneId } = await setup();
  await upload(h, sceneId, image(PNG_HEAD));
  const detail = await authed(h, { path: `/api/projects/${projectId}` });
  assert.equal(detail.json.scenes[0].asset_count, 1);
});

test("content types outside the allow-list are refused, including SVG", async () => {
  const { h, sceneId } = await setup();
  for (const type of ["text/plain", "image/svg+xml", "image/gif", "application/json", "application/octet-stream"]) {
    const res = await upload(h, sceneId, image(PNG_HEAD), { type });
    assert.equal(res.status, 415, `${type}: ${res.text}`);
    assert.equal(res.json.error.code, "unsupported_media_type");
  }
  assert.equal(h.bucket.objects.size, 0);
  assert.equal(count(h.db, "scene_assets"), 0);
});

test("the file content must match the declared type (magic bytes)", async () => {
  const { h, sceneId } = await setup();
  const cases: Array<[string, Uint8Array]> = [
    ["image/png", image(JPEG_HEAD)],
    ["image/jpeg", image(PNG_HEAD)],
    ["image/webp", image(PNG_HEAD)],
    ["image/png", new TextEncoder().encode("<svg xmlns='http://www.w3.org/2000/svg'><script>alert(1)</script></svg>")],
    ["image/png", new TextEncoder().encode("GIF89a not a png at all")],
  ];
  for (const [type, bytes] of cases) {
    const res = await upload(h, sceneId, bytes, { type });
    assert.equal(res.status, 400, `${type}: ${res.text}`);
    assert.equal(res.json.error.code, "asset_content_mismatch");
  }
  assert.equal(h.bucket.objects.size, 0);
});

test("an empty body is refused", async () => {
  const { h, sceneId } = await setup();
  const res = await upload(h, sceneId, new Uint8Array(0));
  assert.equal(res.status, 400, res.text);
  assert.equal(res.json.error.code, "empty_body");
});

test("oversized uploads are refused by declared length and by streamed length, and nothing is stored", async () => {
  const { h, sceneId } = await setup();
  const limit = 5 * 1024 * 1024;

  const declared = await upload(h, sceneId, image(PNG_HEAD, limit + 1));
  assert.equal(declared.status, 413, declared.text);
  assert.equal(declared.json.error.code, "payload_too_large");

  // No Content-Length: a stream is only known to be too big once it has been read past the cap.
  const big = image(PNG_HEAD, limit + 1);
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(big.subarray(0, limit / 2));
      controller.enqueue(big.subarray(limit / 2));
      controller.close();
    },
  });
  const streamed = await upload(h, sceneId, stream);
  assert.equal(streamed.status, 413, streamed.text);

  const exact = await upload(h, sceneId, image(PNG_HEAD, limit));
  assert.equal(exact.status, 201, "a file of exactly the maximum size is allowed");
  assert.equal(h.bucket.objects.size, 1);
});

test("at most three reference images per scene", async () => {
  const { h, sceneId } = await setup();
  for (let i = 0; i < 3; i += 1) assert.equal((await upload(h, sceneId, image(PNG_HEAD, 64 + i))).status, 201);
  const fourth = await upload(h, sceneId, image(PNG_HEAD, 70));
  assert.equal(fourth.status, 409, fourth.text);
  assert.equal(fourth.json.error.code, "asset_limit_reached");
  assert.equal(h.bucket.objects.size, 3);
  assert.equal(count(h.db, "scene_assets"), 3);
});

test("the database trigger also refuses a fourth row that slips past the API check", async () => {
  const { h, projectId, sceneId } = await setup();
  const insert = (n: number) =>
    h.db.raw
      .prepare(
        "INSERT INTO scene_assets(id,project_id,scene_id,r2_key,mime_type,size_bytes,sha256) VALUES(?,?,?,?,?,?,?)",
      )
      .run(`00000000-0000-4000-8000-00000000000${n}`, projectId, sceneId, `k${n}`, "image/png", 10, "a".repeat(64));
  insert(1);
  insert(2);
  insert(3);
  assert.throws(() => insert(4), /asset limit reached/);
});

test("a failed database write after the object was stored removes the object again", async () => {
  const { h, sceneId } = await setup();
  // Make the row insert fail at commit time without touching the API's own pre-checks.
  h.db.raw.exec(
    "CREATE TRIGGER fail_asset_insert BEFORE INSERT ON scene_assets BEGIN SELECT RAISE(ABORT, 'disk full'); END",
  );
  const res = await upload(h, sceneId, image(PNG_HEAD));
  assert.equal(res.status, 500, res.text);
  assert.equal(h.bucket.objects.size, 0, "no orphan object is left behind");
  assert.equal(count(h.db, "scene_assets"), 0);
});

test("when the object store is down nothing is recorded", async () => {
  const { h, sceneId } = await setup();
  h.bucket.faults.failPut = true;
  const res = await upload(h, sceneId, image(PNG_HEAD));
  assert.equal(res.status, 500, res.text);
  assert.equal(count(h.db, "scene_assets"), 0);
  assert.equal(auditTypes(h).includes("asset.uploaded"), false);
});

test("labels may not contain path separators and unknown query fields are rejected", async () => {
  const { h, sceneId } = await setup();
  for (const query of ["?name=..%2Fsecret.png", "?name=a%5Cb.png", "?other=1", "?name="]) {
    const res = await upload(h, sceneId, image(PNG_HEAD), { query });
    assert.equal(res.status, 400, `${query}: ${res.text}`);
    assert.equal(res.json.error.code, "validation_failed");
  }
  assert.equal(h.bucket.objects.size, 0);
});

test("only the owner can use the asset routes: no session, wrong session and the worker token are refused", async () => {
  const { h, sceneId } = await setup();
  const created = await upload(h, sceneId, image(PNG_HEAD));
  const id = created.json.id as string;

  assert.equal((await upload(h, sceneId, image(PNG_HEAD), { session: null })).status, 401);
  assert.equal((await call(h, { path: `/api/scenes/${sceneId}/assets` })).status, 401);
  assert.equal((await call(h, { path: `/api/assets/${id}/content` })).status, 401);
  assert.equal((await call(h, { method: "POST", path: `/api/assets/${id}/delete`, body: {} })).status, 401);

  const worker = await asWorker(h, { method: "GET", path: `/api/assets/${id}/content` });
  assert.equal(worker.status, 403, "the worker token cannot read reference images through the owner routes");
  assert.equal(
    (await upload(h, sceneId, image(PNG_HEAD), { session: null, bearer: "test-worker-token-0123456789abcdef0123456789abcdef" })).status,
    403,
  );
  assert.equal(count(h.db, "scene_assets"), 1);
});

test("uploads and deletes from a foreign origin are refused (CSRF)", async () => {
  const { h, sceneId } = await setup();
  const created = await upload(h, sceneId, image(PNG_HEAD));
  const foreign = await upload(h, sceneId, image(PNG_HEAD), { origin: "https://evil.example" });
  assert.equal(foreign.status, 403, foreign.text);
  assert.equal(foreign.json.error.code, "origin_not_allowed");
  const del = await authed(h, {
    method: "POST",
    path: `/api/assets/${created.json.id}/delete`,
    body: {},
    origin: "https://evil.example",
  });
  assert.equal(del.status, 403);
  assert.equal(count(h.db, "scene_assets"), 1);
});

test("unknown scene and unknown asset are 404", async () => {
  const { h } = await setup();
  const missing = "11111111-1111-4111-8111-111111111111";
  assert.equal((await upload(h, missing, image(PNG_HEAD))).status, 404);
  assert.equal((await authed(h, { path: `/api/scenes/${missing}/assets` })).status, 404);
  assert.equal((await authed(h, { path: `/api/assets/${missing}/content` })).status, 404);
  assert.equal((await authed(h, { method: "POST", path: `/api/assets/${missing}/delete`, body: {} })).status, 404);
});

test("a stored file that has gone missing reports asset_missing instead of an empty image", async () => {
  const { h, sceneId } = await setup();
  const created = await upload(h, sceneId, image(PNG_HEAD));
  h.bucket.objects.clear();
  const res = await authed(h, { path: `/api/assets/${created.json.id}/content` });
  assert.equal(res.status, 404);
  assert.equal(res.json.error.code, "asset_missing");
});

test("deleting an asset removes the row and the object and is audited", async () => {
  const { h, sceneId } = await setup();
  const created = await upload(h, sceneId, image(PNG_HEAD));
  const res = await authed(h, { method: "POST", path: `/api/assets/${created.json.id}/delete`, body: {} });
  assert.equal(res.status, 200, res.text);
  assert.equal(count(h.db, "scene_assets"), 0);
  assert.equal(h.bucket.objects.size, 0);
  assert.ok(auditTypes(h).includes("asset.deleted"));
  assert.equal((await authed(h, { method: "POST", path: `/api/assets/${created.json.id}/delete`, body: {} })).status, 404);
});

test("a failing object delete does not fail the request; the row is gone and no row points at the object", async () => {
  const { h, sceneId } = await setup();
  const created = await upload(h, sceneId, image(PNG_HEAD));
  h.bucket.faults.failDelete = true;
  const res = await authed(h, { method: "POST", path: `/api/assets/${created.json.id}/delete`, body: {} });
  assert.equal(res.status, 200, res.text);
  assert.equal(count(h.db, "scene_assets"), 0);
  assert.equal(h.bucket.objects.size, 1, "the orphan is left for the cleanup job, not silently referenced");
});

test("deleting a scene removes its reference images from the bucket too", async () => {
  const { h, projectId, sceneId } = await setup();
  const otherScene = await addScene(h, projectId, "Lain");
  await upload(h, sceneId, image(PNG_HEAD, 64));
  await upload(h, sceneId, image(PNG_HEAD, 65));
  const kept = await upload(h, otherScene, image(PNG_HEAD, 66));
  assert.equal(h.bucket.objects.size, 3);

  const res = await authed(h, { method: "POST", path: `/api/scenes/${sceneId}/delete`, body: {} });
  assert.equal(res.status, 200, res.text);
  assert.equal(count(h.db, "scene_assets"), 1);
  assert.deepEqual(
    [...h.bucket.objects.keys()],
    [`assets/${projectId}/${otherScene}/${kept.json.id}`],
    "only the other scene's image remains",
  );
});

test("a scene with a queued job is locked: no upload, no delete", async () => {
  const { h, sceneId, projectId } = await setup();
  makeAccountReady(h);
  const created = await upload(h, sceneId, image(PNG_HEAD));
  const submit = await authed(h, {
    method: "POST",
    path: `/api/projects/${projectId}/submit`,
    body: { account_id: "acct-01", idempotency_key: "submit-key-0001", expected_scene_count: 1 },
  });
  assert.equal(submit.status, 201, submit.text);

  const blockedUpload = await upload(h, sceneId, image(PNG_HEAD, 70));
  assert.equal(blockedUpload.status, 409, blockedUpload.text);
  assert.equal(blockedUpload.json.error.code, "scene_locked");
  const blockedDelete = await authed(h, { method: "POST", path: `/api/assets/${created.json.id}/delete`, body: {} });
  assert.equal(blockedDelete.status, 409, blockedDelete.text);
  assert.equal(blockedDelete.json.error.code, "scene_locked");
  assert.equal(count(h.db, "scene_assets"), 1);
  assert.equal(h.bucket.objects.size, 1);

  // Reading is still fine while the job runs.
  assert.equal((await authed(h, { path: `/api/assets/${created.json.id}/content` })).status, 200);
});

test("an archived project refuses new and removed reference images", async () => {
  const { h, projectId, sceneId } = await setup();
  const created = await upload(h, sceneId, image(PNG_HEAD));
  const archived = await authed(h, { method: "PATCH", path: `/api/projects/${projectId}`, body: { status: "archived" } });
  assert.equal(archived.status, 200, archived.text);

  const blockedUpload = await upload(h, sceneId, image(PNG_HEAD, 70));
  assert.equal(blockedUpload.status, 409);
  assert.equal(blockedUpload.json.error.code, "project_archived");
  const blockedDelete = await authed(h, { method: "POST", path: `/api/assets/${created.json.id}/delete`, body: {} });
  assert.equal(blockedDelete.status, 409);
  assert.equal(blockedDelete.json.error.code, "project_archived");
});

test("uploads count against the write rate limit", async () => {
  const { h, sceneId } = await setup();
  h.limiter.allowWrite = false;
  const res = await upload(h, sceneId, image(PNG_HEAD));
  assert.equal(res.status, 429, res.text);
  assert.equal(h.bucket.objects.size, 0);
});
