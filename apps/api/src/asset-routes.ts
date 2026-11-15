/**
 * Reference images for scenes (Phase 3B). Owner-only: the browser worker cannot reach these routes,
 * and there is no public or signed URL. Objects live in the private MEDIA bucket under server-built
 * keys; the database row is the source of truth for what a scene owns.
 *
 *   POST /api/scenes/:id/assets        raw image bytes, Content-Type image/png|jpeg|webp, ?name= (optional label)
 *   GET  /api/scenes/:id/assets        metadata list
 *   GET  /api/assets/:id/content       the image, streamed through the Worker (owner session only)
 *   POST /api/assets/:id/delete        remove (a POST action, like the other deletes, so methods stay GET/POST/PATCH)
 *
 * Changing the assets changes what a job would be given, so uploads and deletes follow the same lock
 * as scene edits: refused for archived projects and for scenes with a queued/running job.
 */
import { ASSET_MAX_BYTES, MAX_ASSETS_PER_SCENE, assetKey, deleteObjects, isAssetMime, sha256Hex, sniffImageType } from "./asset-store.ts";
import { ASSET_MIME_TYPES } from "./asset-store.ts";
import { HttpError, jsonResponse, readBytes } from "./http.ts";
import { hasActiveJob, loadScene, requireEditable } from "./project-routes.ts";
import { auditStatement } from "./route-types.ts";
import type { Ctx, Route } from "./route-types.ts";
import { Issues, readString } from "./validate.ts";

const UUID_PATTERN = "[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}";
const SCENE_ASSETS_PATH = new RegExp(`^/api/scenes/(${UUID_PATTERN})/assets$`);
const ASSET_CONTENT_PATH = new RegExp(`^/api/assets/(${UUID_PATTERN})/content$`);
const ASSET_DELETE_PATH = new RegExp(`^/api/assets/(${UUID_PATTERN})/delete$`);
/** A display label only (never used to build a key or path), so it just may not contain separators. */
const NAME_RE = /^[^\\/]+$/;

interface AssetRow {
  id: string;
  project_id: string;
  scene_id: string;
  r2_key: string;
  name: string | null;
  mime_type: string;
  size_bytes: number;
  sha256: string;
  created_at: string;
}

const PUBLIC_COLUMNS = "id,scene_id,name,mime_type,size_bytes,sha256,created_at";

async function countAssets(ctx: Ctx, sceneId: string): Promise<number> {
  const row = await ctx.env.DB.prepare("SELECT COUNT(*) AS n FROM scene_assets WHERE scene_id=?")
    .bind(sceneId)
    .first<{ n: number }>();
  return Number(row?.n ?? 0);
}

async function uploadAsset(ctx: Ctx): Promise<Response> {
  const sceneId = ctx.params[0].toLowerCase();

  // Cheap checks first, so a bad request never makes the Worker read megabytes.
  const issues = new Issues();
  for (const key of ctx.url.searchParams.keys()) {
    if (key !== "name") issues.add(key, "unknown_field");
  }
  const rawName = ctx.url.searchParams.get("name");
  const name =
    rawName === null ? undefined : readString({ name: rawName }, "name", { max: 120, pattern: NAME_RE }, issues);
  issues.throwIfAny();

  const declared = (ctx.req.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
  if (!isAssetMime(declared)) {
    throw new HttpError(415, "unsupported_media_type", "Content-Type must be one of the allowed image types", {
      allowed: ASSET_MIME_TYPES,
    });
  }

  const scene = await loadScene(ctx, sceneId);
  requireEditable({ status: scene.project_status });
  if (await hasActiveJob(ctx, "scene_id", sceneId)) {
    throw new HttpError(409, "scene_locked", "The scene has a job that is queued or running");
  }
  if ((await countAssets(ctx, sceneId)) >= MAX_ASSETS_PER_SCENE) {
    throw new HttpError(409, "asset_limit_reached", "The scene already has the maximum number of reference images", {
      max: MAX_ASSETS_PER_SCENE,
    });
  }

  const bytes = await readBytes(ctx.req, ASSET_MAX_BYTES);
  const sniffed = sniffImageType(bytes);
  if (sniffed === null || sniffed !== declared) {
    throw new HttpError(400, "asset_content_mismatch", "The file content does not match the declared image type");
  }

  const id = crypto.randomUUID();
  const key = assetKey(scene.project_id, sceneId, id);
  const sha256 = await sha256Hex(bytes);

  // Object first, row second: if the row cannot be written the object is removed again, and a crash
  // in between leaves only an unreferenced object (a Phase 6 orphan), never a row without an object.
  await ctx.env.MEDIA.put(key, bytes, { httpMetadata: { contentType: sniffed }, customMetadata: { sha256 } });
  try {
    await ctx.env.DB.batch([
      ctx.env.DB.prepare(
        "INSERT INTO scene_assets(id,project_id,scene_id,r2_key,name,mime_type,size_bytes,sha256) VALUES(?,?,?,?,?,?,?,?)",
      ).bind(id, scene.project_id, sceneId, key, name ?? null, sniffed, bytes.byteLength, sha256),
      ctx.env.DB.prepare("UPDATE projects SET updated_at=CURRENT_TIMESTAMP WHERE id=?").bind(scene.project_id),
      // The label is user text and stays out of the audit log; ids, type and size are enough to trace it.
      auditStatement(ctx, "asset.uploaded", {}, {
        project_id: scene.project_id,
        scene_id: sceneId,
        asset_id: id,
        mime_type: sniffed,
        size_bytes: bytes.byteLength,
      }),
    ]);
  } catch (error) {
    await deleteObjects(ctx.env, [key], ctx.requestId);
    if (error instanceof Error && /asset limit reached/i.test(error.message)) {
      throw new HttpError(409, "asset_limit_reached", "The scene already has the maximum number of reference images", {
        max: MAX_ASSETS_PER_SCENE,
      });
    }
    throw error;
  }

  const row = await ctx.env.DB.prepare(`SELECT ${PUBLIC_COLUMNS} FROM scene_assets WHERE id=?`).bind(id).first();
  return jsonResponse(row, 201);
}

async function listAssets(ctx: Ctx): Promise<Response> {
  const sceneId = ctx.params[0].toLowerCase();
  await loadScene(ctx, sceneId);
  const { results } = await ctx.env.DB.prepare(
    `SELECT ${PUBLIC_COLUMNS} FROM scene_assets WHERE scene_id=? ORDER BY created_at, id`,
  )
    .bind(sceneId)
    .all();
  return jsonResponse({ items: results });
}

async function loadAsset(ctx: Ctx, id: string): Promise<AssetRow> {
  const row = await ctx.env.DB.prepare(
    "SELECT id,project_id,scene_id,r2_key,name,mime_type,size_bytes,sha256,created_at FROM scene_assets WHERE id=?",
  )
    .bind(id)
    .first<AssetRow>();
  if (!row) throw new HttpError(404, "asset_not_found", "Asset not found");
  return row;
}

async function assetContent(ctx: Ctx): Promise<Response> {
  const asset = await loadAsset(ctx, ctx.params[0].toLowerCase());
  const object = await ctx.env.MEDIA.get(asset.r2_key);
  if (!object) throw new HttpError(404, "asset_missing", "The stored file is missing");
  return new Response(object.body, {
    status: 200,
    headers: {
      // The type comes from the row (validated at upload), never from anything a client sends now.
      "content-type": asset.mime_type,
      "content-length": String(asset.size_bytes),
      "content-disposition": "inline",
      etag: `"${asset.sha256}"`,
    },
  });
}

async function deleteAsset(ctx: Ctx): Promise<Response> {
  const asset = await loadAsset(ctx, ctx.params[0].toLowerCase());
  const scene = await loadScene(ctx, asset.scene_id);
  requireEditable({ status: scene.project_status });
  if (await hasActiveJob(ctx, "scene_id", asset.scene_id)) {
    throw new HttpError(409, "scene_locked", "The scene has a job that is queued or running");
  }

  await ctx.env.DB.batch([
    ctx.env.DB.prepare("DELETE FROM scene_assets WHERE id=?").bind(asset.id),
    ctx.env.DB.prepare("UPDATE projects SET updated_at=CURRENT_TIMESTAMP WHERE id=?").bind(asset.project_id),
    auditStatement(ctx, "asset.deleted", {}, {
      project_id: asset.project_id,
      scene_id: asset.scene_id,
      asset_id: asset.id,
    }),
  ]);
  await deleteObjects(ctx.env, [asset.r2_key], ctx.requestId);
  return jsonResponse({ id: asset.id, deleted: true });
}

export const assetRoutes: Route[] = [
  { method: "POST", pattern: SCENE_ASSETS_PATH, write: true, audience: "owner", handler: uploadAsset },
  { method: "GET", pattern: SCENE_ASSETS_PATH, write: false, audience: "owner", handler: listAssets },
  { method: "GET", pattern: ASSET_CONTENT_PATH, write: false, audience: "owner", handler: assetContent },
  { method: "POST", pattern: ASSET_DELETE_PATH, write: true, audience: "owner", handler: deleteAsset },
];
