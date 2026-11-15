import { HttpError, jsonResponse } from "./http.ts";
import { actorOf } from "./route-types.ts";
import type { Ctx, Route } from "./route-types.ts";

const UUID = "[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}";
const deleteMediaPath = new RegExp(`^/api/media/(${UUID})/delete$`);

interface DeletableMedia {
  id: string;
  job_id: string;
  project_id: string;
  mime: string;
  size_bytes: number;
  sha256: string;
  r2_key: string;
}

/**
 * Owner-only hard delete of one media item.
 *
 * Order is deliberate: the D1 row (what the owner can see and download) and its audit event are removed
 * in one atomic batch FIRST. Only then is the R2 object deleted. If the R2 delete fails, the worst case is
 * an invisible orphan object (cost only, reported to the caller and audited), never a listed item whose
 * bytes are gone. Media of a job that a worker currently owns (claimed/running) is not deletable, so a
 * delete can never race the worker's idempotent upload replay.
 *
 * The R2 key is never returned or written to the audit log.
 */
async function deleteMedia(ctx: Ctx): Promise<Response> {
  if (ctx.identity.kind !== "owner") throw new HttpError(403, "forbidden", "This identity is not allowed to use this endpoint");
  const id = ctx.params[0].toLowerCase();
  const row = await ctx.env.DB.prepare(
    "SELECT id,job_id,project_id,mime,size_bytes,sha256,r2_key FROM media WHERE id=?",
  ).bind(id).first<DeletableMedia>();
  if (!row) throw new HttpError(404, "media_not_found", "Media not found");

  const results = await ctx.env.DB.batch([
    ctx.env.DB.prepare(
      `DELETE FROM media WHERE id=?
         AND NOT EXISTS (SELECT 1 FROM jobs WHERE jobs.id=media.job_id AND jobs.status IN ('claimed','running'))`,
    ).bind(id),
    ctx.env.DB.prepare(
      "INSERT INTO audit_events(id,account_id,job_id,event_type,detail_json) SELECT ?,NULL,?,'media.deleted',? WHERE changes()>0",
    ).bind(crypto.randomUUID(), row.job_id, JSON.stringify({
      actor: actorOf(ctx.identity), request_id: ctx.requestId, media_id: id, project_id: row.project_id,
      mime: row.mime, size_bytes: row.size_bytes, sha256: row.sha256,
    })),
  ]);
  if (results[0].meta.changes !== 1) {
    const remaining = await ctx.env.DB.prepare("SELECT id FROM media WHERE id=?").bind(id).first();
    if (!remaining) throw new HttpError(404, "media_not_found", "Media not found");
    throw new HttpError(409, "job_active", "Media of a job that a worker is running cannot be deleted");
  }

  let objectDeleted = true;
  try {
    await ctx.env.MEDIA.delete(row.r2_key);
  } catch (error) {
    objectDeleted = false;
    console.error(JSON.stringify({
      level: "error", event: "media.object_delete_failed", request_id: ctx.requestId, media_id: id, message: String(error),
    }));
  }
  await ctx.env.DB.prepare(
    "INSERT INTO audit_events(id,account_id,job_id,event_type,detail_json) VALUES(?,NULL,?,?,?)",
  ).bind(
    crypto.randomUUID(), row.job_id, objectDeleted ? "media.object_deleted" : "media.object_delete_failed",
    JSON.stringify({ actor: actorOf(ctx.identity), request_id: ctx.requestId, media_id: id }),
  ).run().catch(() => undefined);

  return jsonResponse({ id, deleted: true, object_deleted: objectDeleted });
}

export const mediaDeleteRoutes: Route[] = [
  { method: "POST", pattern: deleteMediaPath, write: true, audience: "owner", handler: deleteMedia },
];
