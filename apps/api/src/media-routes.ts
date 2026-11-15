import { HttpError, jsonResponse } from "./http.ts";
import { jobInfo, leaseState } from "./queue.ts";
import { actorOf } from "./route-types.ts";
import { isUniqueViolation } from "./paging.ts";
import type { Ctx, Route } from "./route-types.ts";
import { mediaDeleteRoutes } from "./media-delete.ts";
import { WORKER_ID_RE } from "./validate.ts";

// Buffering is required for WebCrypto SHA-256; keep the one-shot Worker request below a safe memory ceiling.
const MAX_MEDIA_BYTES = 25 * 1024 * 1024;
const MAX_DIMENSION = 16_384;
const MAX_DURATION_MS = 86_400_000;
const MIME_EXT: Record<string, string> = {
  "video/mp4": "mp4",
  "video/webm": "webm",
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
};
const UUID = "[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}";
const workerUploadPath = new RegExp(`^/api/worker/jobs/(${UUID})/media$`);
const jobMediaPath = new RegExp(`^/api/jobs/(${UUID})/media$`);
const mediaPath = new RegExp(`^/api/media/(${UUID})$`);

interface MediaRow {
  id: string;
  job_id: string;
  project_id: string;
  scene_id: string | null;
  kind: "video" | "image";
  mime: string;
  size_bytes: number;
  sha256: string;
  width: number | null;
  height: number | null;
  duration_ms: number | null;
  r2_key: string;
  created_at: string;
}

function hex(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function validSignature(mime: string, bytes: Uint8Array): boolean {
  if (mime === "image/png") return bytes.length >= 8 && [137,80,78,71,13,10,26,10].every((v, i) => bytes[i] === v);
  if (mime === "image/jpeg") return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  if (mime === "image/webp") return bytes.length >= 12 && String.fromCharCode(...bytes.slice(0,4)) === "RIFF" && String.fromCharCode(...bytes.slice(8,12)) === "WEBP";
  if (mime === "video/webm") return bytes.length >= 4 && bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3;
  if (mime === "video/mp4") return bytes.length >= 12 && String.fromCharCode(...bytes.slice(4,8)) === "ftyp";
  return false;
}

function optionalIntegerHeader(ctx: Ctx, name: string, max: number): number | null {
  const raw = ctx.req.headers.get(name);
  if (raw === null || raw === "") return null;
  if (!/^\d+$/.test(raw)) throw new HttpError(400, "invalid_media_metadata", "Media metadata is invalid");
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1 || value > max) {
    throw new HttpError(400, "invalid_media_metadata", "Media metadata is outside the supported range");
  }
  return value;
}

function readMediaMetadata(ctx: Ctx, mime: string) {
  const width = optionalIntegerHeader(ctx, "x-media-width", MAX_DIMENSION);
  const height = optionalIntegerHeader(ctx, "x-media-height", MAX_DIMENSION);
  const durationMs = optionalIntegerHeader(ctx, "x-media-duration-ms", MAX_DURATION_MS);
  if ((width === null) !== (height === null) || (mime.startsWith("image/") && durationMs !== null)) {
    throw new HttpError(400, "invalid_media_metadata", "Media metadata fields are inconsistent");
  }
  return { width, height, duration_ms: durationMs };
}

async function readBoundedBody(ctx: Ctx): Promise<Uint8Array> {
  const declared = ctx.req.headers.get("content-length");
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > MAX_MEDIA_BYTES)) {
    throw new HttpError(413, "media_too_large", "Media exceeds the maximum upload size");
  }
  if (!ctx.req.body) throw new HttpError(400, "empty_media", "Media body is required");
  const reader = ctx.req.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_MEDIA_BYTES) {
      await reader.cancel();
      throw new HttpError(413, "media_too_large", "Media exceeds the maximum upload size");
    }
    chunks.push(value);
  }
  if (size === 0) throw new HttpError(400, "empty_media", "Media body is required");
  if (declared !== null && Number(declared) !== size) throw new HttpError(400, "content_length_mismatch", "Content-Length does not match the received body");
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return bytes;
}

async function uploadMedia(ctx: Ctx): Promise<Response> {
  const jobId = ctx.params[0].toLowerCase();
  if (ctx.identity.kind !== "service") throw new HttpError(403, "forbidden", "Worker identity required");
  const workerId = ctx.req.headers.get("x-worker-id") ?? "";
  const tokenRaw = ctx.req.headers.get("x-fencing-token") ?? "";
  if (!WORKER_ID_RE.test(workerId) || !/^\d+$/.test(tokenRaw)) {
    throw new HttpError(400, "invalid_worker_lease", "Worker lease headers are invalid");
  }
  const token = Number(tokenRaw);
  if (!Number.isSafeInteger(token) || token < 1) throw new HttpError(400, "invalid_worker_lease", "Worker lease headers are invalid");

  const job = await jobInfo(ctx.env.DB, jobId);
  if (!job) throw new HttpError(404, "job_not_found", "Job not found");
  const lease = await leaseState(ctx.env.DB, jobId);
  if (job.status !== "running" || job.worker_id !== workerId || job.lease_token !== token || !lease || lease.expires_at <= ctx.now()) {
    throw new HttpError(409, "lease_lost", "The worker no longer holds the active job lease");
  }

  const mime = (ctx.req.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
  if (!Object.hasOwn(MIME_EXT, mime)) throw new HttpError(415, "unsupported_media_type", "Media type is not supported");
  const metadata = readMediaMetadata(ctx, mime);
  const checksum = (ctx.req.headers.get("x-content-sha256") ?? "").toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(checksum)) throw new HttpError(400, "invalid_checksum", "A SHA-256 checksum header is required");

  const bytes = await readBoundedBody(ctx);
  const digest = hex(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)));
  if (digest !== checksum) throw new HttpError(400, "checksum_mismatch", "Media checksum does not match the uploaded bytes");
  if (!validSignature(mime, bytes)) throw new HttpError(415, "media_signature_mismatch", "Media bytes do not match the declared content type");

  const columns = "id,job_id,project_id,scene_id,kind,mime,size_bytes,sha256,width,height,duration_ms,r2_key,created_at";
  const existing = await ctx.env.DB.prepare(`SELECT ${columns} FROM media WHERE job_id=? AND sha256=?`)
    .bind(jobId, digest).first<MediaRow>();
  if (existing) {
    if (existing.mime !== mime || existing.size_bytes !== bytes.length ||
        existing.width !== metadata.width || existing.height !== metadata.height || existing.duration_ms !== metadata.duration_ms) {
      throw new HttpError(409, "media_replay_conflict", "The checksum already exists with different media metadata");
    }
    return jsonResponse({ ...publicMedia(existing), idempotent_replay: true }, 200);
  }

  const context = await ctx.env.DB.prepare(
    "SELECT project_id,scene_id FROM jobs WHERE id=? AND status='running' AND worker_id=? AND lease_token=?",
  ).bind(jobId, workerId, token).first<{ project_id: string; scene_id: string | null }>();
  if (!context) throw new HttpError(409, "lease_lost", "The worker no longer holds the active job lease");

  const id = crypto.randomUUID();
  const key = `media/${context.project_id}/${jobId}/${id}.${MIME_EXT[mime]}`;
  const kind = mime.startsWith("video/") ? "video" : "image";
  await ctx.env.MEDIA.put(key, bytes, {
    httpMetadata: { contentType: mime, cacheControl: "private, no-store, max-age=0" },
    customMetadata: { mediaId: id, jobId, sha256: digest },
  });

  try {
    const results = await ctx.env.DB.batch([
      ctx.env.DB.prepare(
        `INSERT INTO media(id,job_id,project_id,scene_id,kind,mime,size_bytes,sha256,width,height,duration_ms,r2_key)
         SELECT ?,?,?,?,?,?,?,?,?,?,?,?
          WHERE EXISTS (
            SELECT 1 FROM jobs j JOIN global_lease l
              ON l.name='global' AND l.job_id=j.id AND l.holder_id=j.worker_id AND l.fencing_token=j.lease_token
           WHERE j.id=? AND j.status='running' AND j.worker_id=? AND j.lease_token=? AND l.expires_at>?
          )`,
      ).bind(id, jobId, context.project_id, context.scene_id, kind, mime, bytes.length, digest,
        metadata.width, metadata.height, metadata.duration_ms, key, jobId, workerId, token, ctx.now()),
      ctx.env.DB.prepare(
        "INSERT INTO audit_events(id,account_id,job_id,event_type,detail_json) SELECT ?,NULL,?,'media.uploaded',? WHERE changes()>0",
      ).bind(crypto.randomUUID(), jobId, JSON.stringify({
        actor: actorOf(ctx.identity), request_id: ctx.requestId, media_id: id, mime,
        size_bytes: bytes.length, sha256: digest, ...metadata,
      })),
    ]);
    if (results[0].meta.changes !== 1) throw new HttpError(409, "lease_lost", "The worker lease expired during upload");
  } catch (error) {
    await ctx.env.MEDIA.delete(key).catch(() => undefined);
    if (isUniqueViolation(error)) {
      const raced = await ctx.env.DB.prepare(`SELECT ${columns} FROM media WHERE job_id=? AND sha256=?`)
        .bind(jobId, digest).first<MediaRow>();
      if (raced && raced.mime === mime && raced.size_bytes === bytes.length &&
          raced.width === metadata.width && raced.height === metadata.height && raced.duration_ms === metadata.duration_ms) {
        return jsonResponse({ ...publicMedia(raced), idempotent_replay: true }, 200);
      }
      if (raced) throw new HttpError(409, "media_replay_conflict", "The checksum already exists with different media metadata");
    }
    if (error instanceof HttpError) throw error;
    throw error;
  }

  return jsonResponse({
    id, job_id: jobId, project_id: context.project_id, scene_id: context.scene_id,
    kind, mime, size_bytes: bytes.length, sha256: digest, ...metadata,
  }, 201);
}

function publicMedia(row: MediaRow) {
  return {
    id: row.id, job_id: row.job_id, project_id: row.project_id, scene_id: row.scene_id,
    kind: row.kind, mime: row.mime, size_bytes: row.size_bytes, sha256: row.sha256,
    width: row.width, height: row.height, duration_ms: row.duration_ms, created_at: row.created_at,
  };
}

async function listJobMedia(ctx: Ctx): Promise<Response> {
  const jobId = ctx.params[0].toLowerCase();
  const job = await ctx.env.DB.prepare("SELECT id FROM jobs WHERE id=?").bind(jobId).first();
  if (!job) throw new HttpError(404, "job_not_found", "Job not found");
  const { results } = await ctx.env.DB.prepare(
    "SELECT id,job_id,project_id,scene_id,kind,mime,size_bytes,sha256,width,height,duration_ms,r2_key,created_at FROM media WHERE job_id=? ORDER BY created_at,id",
  ).bind(jobId).all<MediaRow>();
  return jsonResponse({ items: results.map(publicMedia) });
}

async function downloadMedia(ctx: Ctx): Promise<Response> {
  const id = ctx.params[0].toLowerCase();
  const row = await ctx.env.DB.prepare("SELECT id,mime,size_bytes,r2_key FROM media WHERE id=?")
    .bind(id).first<{ id: string; mime: string; size_bytes: number; r2_key: string }>();
  if (!row) throw new HttpError(404, "media_not_found", "Media not found");
  const object = await ctx.env.MEDIA.get(row.r2_key);
  if (!object) throw new HttpError(404, "media_not_found", "Media not found");
  const headers = new Headers({
    "content-type": row.mime,
    "content-length": String(row.size_bytes),
    "content-disposition": `attachment; filename="media-${id}.${MIME_EXT[row.mime]}"`,
    "cache-control": "private, no-store, max-age=0",
    "x-content-type-options": "nosniff",
  });
  return new Response(object.body, { status: 200, headers });
}

export const mediaRoutes: Route[] = [
  { method: "POST", pattern: workerUploadPath, write: true, audience: "worker", handler: uploadMedia },
  { method: "GET", pattern: jobMediaPath, write: false, audience: "owner", handler: listJobMedia },
  { method: "GET", pattern: mediaPath, write: false, audience: "owner", handler: downloadMedia },
  ...mediaDeleteRoutes,
];
