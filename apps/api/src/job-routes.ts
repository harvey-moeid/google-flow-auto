import { HttpError, jsonResponse, readJsonObject } from "./http.ts";
import { isUniqueViolation } from "./paging.ts";
import { auditStatement } from "./route-types.ts";
import type { Ctx, Route } from "./route-types.ts";
import { Issues, readString, rejectUnknownFields } from "./validate.ts";

const UUID_PATTERN = "[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}";
const jobPath = (suffix = "") => new RegExp(`^/api/jobs/(${UUID_PATTERN})${suffix}$`);

/**
 * Audit detail keys the owner timeline may show. worker_id, fencing_token and request ids are
 * deliberately left out, the same way GET /api/jobs hides worker_id and lease_token.
 */
const TIMELINE_DETAIL_KEYS = [
  "actor",
  "previous_status",
  "error_code",
  "retryable",
  "retry_of",
  "engine",
  "acknowledged_by_worker",
] as const;

const TIMELINE_LIMIT = 100;

interface JobDetailRow {
  id: string;
  project_id: string;
  scene_id: string | null;
  account_id: string;
  engine: string;
  status: string;
  attempts: number;
  max_attempts: number;
  cancel_requested: number;
  error_code: string | null;
  result_key: string | null;
  retry_of: string | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  account_slot: number;
  account_label: string;
  project_name: string;
  scene_order: number | null;
  scene_prompt: string | null;
}

function safeDetail(raw: string | null): Record<string, unknown> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of TIMELINE_DETAIL_KEYS) {
      if (parsed[key] !== undefined) out[key] = parsed[key];
    }
    return out;
  } catch {
    return {};
  }
}

async function getJob(ctx: Ctx): Promise<Response> {
  const id = ctx.params[0].toLowerCase();
  const job = await ctx.env.DB.prepare(
    `SELECT j.id,j.project_id,j.scene_id,j.account_id,j.engine,j.status,j.attempts,j.max_attempts,j.cancel_requested,
            j.error_code,j.result_key,j.retry_of,j.created_at,j.started_at,j.finished_at,
            a.slot AS account_slot,a.label AS account_label,p.name AS project_name,
            s.scene_order AS scene_order,s.prompt AS scene_prompt
       FROM jobs j
       JOIN accounts a ON a.id=j.account_id
       JOIN projects p ON p.id=j.project_id
       LEFT JOIN scenes s ON s.id=j.scene_id
      WHERE j.id=?`,
  )
    .bind(id)
    .first<JobDetailRow>();
  if (!job) throw new HttpError(404, "job_not_found", "Job not found");

  const { results } = await ctx.env.DB.prepare(
    "SELECT event_type,detail_json,created_at FROM audit_events WHERE job_id=? ORDER BY created_at, rowid LIMIT ?",
  )
    .bind(id, TIMELINE_LIMIT)
    .all<{ event_type: string; detail_json: string | null; created_at: string }>();
  const timeline = results.map((event) => ({
    event: event.event_type,
    at: event.created_at,
    detail: safeDetail(event.detail_json),
  }));
  return jsonResponse({ ...job, cancel_requested: job.cancel_requested === 1, timeline });
}

interface RetrySource {
  id: string;
  project_id: string;
  scene_id: string | null;
  account_id: string;
  engine: string;
  status: string;
}

/**
 * A failed or cancelled job cannot change state again (the database enforces that), so a retry is a
 * NEW job that points back at the original through retry_of. The history of the first attempt stays.
 */
async function retryJob(ctx: Ctx): Promise<Response> {
  const id = ctx.params[0].toLowerCase();
  const body = await readJsonObject(ctx.req);
  const issues = new Issues();
  rejectUnknownFields(body, ["idempotency_key"], issues);
  const key = readString(
    body,
    "idempotency_key",
    { required: true, min: 8, max: 128, pattern: /^[A-Za-z0-9._:-]+$/ },
    issues,
  );
  issues.throwIfAny();
  if (key === undefined) throw new HttpError(500, "internal_error", "Internal error");

  const source = await ctx.env.DB.prepare("SELECT id,project_id,scene_id,account_id,engine,status FROM jobs WHERE id=?")
    .bind(id)
    .first<RetrySource>();
  if (!source) throw new HttpError(404, "job_not_found", "Job not found");

  const findByKey = () =>
    ctx.env.DB.prepare("SELECT id,status,retry_of FROM jobs WHERE idempotency_key=?")
      .bind(key)
      .first<{ id: string; status: string; retry_of: string | null }>();
  const replayOrConflict = (existing: { id: string; status: string; retry_of: string | null }): Response => {
    if (existing.retry_of !== id) {
      throw new HttpError(409, "idempotency_key_conflict", "Idempotency key was already used with different parameters");
    }
    return jsonResponse({ id: existing.id, status: existing.status, retry_of: id, idempotent_replay: true }, 200);
  };
  const replay = await findByKey();
  if (replay) return replayOrConflict(replay);

  if (source.status !== "failed" && source.status !== "cancelled") {
    throw new HttpError(409, "job_not_retryable", "Only failed or cancelled jobs can be retried", {
      status: source.status,
    });
  }
  if (source.engine !== "dry-run" && !ctx.cfg.liveEnginesEnabled) {
    throw new HttpError(403, "live_engine_disabled", "Live engines are disabled; use the dry-run engine");
  }

  const project = await ctx.env.DB.prepare("SELECT status FROM projects WHERE id=?")
    .bind(source.project_id)
    .first<{ status: string }>();
  if (project?.status === "archived") {
    throw new HttpError(409, "project_archived", "Archived projects cannot be changed; restore the project first");
  }
  const account = await ctx.env.DB.prepare("SELECT status FROM accounts WHERE id=?")
    .bind(source.account_id)
    .first<{ status: string }>();
  if (!account || account.status !== "ready") {
    throw new HttpError(409, "account_not_ready", "Account is not ready", { status: account?.status ?? "missing" });
  }
  if (source.scene_id) {
    const busy = await ctx.env.DB.prepare(
      "SELECT 1 AS busy FROM jobs WHERE scene_id=? AND status IN ('queued','claimed','running','waiting_for_user') LIMIT 1",
    )
      .bind(source.scene_id)
      .first();
    if (busy) throw new HttpError(409, "scene_busy", "The scene already has a job that is queued or running");
  }

  const newId = crypto.randomUUID();
  try {
    await ctx.env.DB.batch([
      ctx.env.DB.prepare(
        "INSERT INTO jobs(id,project_id,scene_id,account_id,engine,status,idempotency_key,retry_of) VALUES(?,?,?,?,?,'queued',?,?)",
      ).bind(newId, source.project_id, source.scene_id, source.account_id, source.engine, key, id),
      auditStatement(ctx, "job.queued", { account_id: source.account_id, job_id: newId }, {
        project_id: source.project_id,
        engine: source.engine,
        retry_of: id,
      }),
    ]);
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;
    const raced = await findByKey();
    if (raced) return replayOrConflict(raced);
    throw error;
  }
  return jsonResponse({ id: newId, status: "queued", retry_of: id }, 201);
}

export const jobRoutes: Route[] = [
  { method: "GET", pattern: jobPath(), write: false, audience: "owner", handler: getJob },
  { method: "POST", pattern: jobPath("/retry"), write: true, audience: "owner", handler: retryJob },
];
