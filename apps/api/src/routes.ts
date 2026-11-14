import { asciiToB64url, b64urlToBytes } from "./encoding.ts";
import { HttpError, jsonResponse, readJsonObject } from "./http.ts";
import { ACTIVE_STATUSES } from "./queue.ts";
import { auditIfChanged, auditStatement } from "./route-types.ts";
import type { Ctx, Route } from "./route-types.ts";
import { workerRoutes } from "./worker-routes.ts";
import {
  ACCOUNT_ID_RE,
  ASPECT_RATIOS,
  ENGINES,
  Issues,
  JOB_STATUSES,
  UUID_RE,
  readEnum,
  readNullableEmail,
  readString,
  rejectUnknownFields,
} from "./validate.ts";

export type { Ctx, Route } from "./route-types.ts";

const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 100;

// ---------- helpers ----------

function encodeCursor(createdAt: string, id: string): string {
  return asciiToB64url(JSON.stringify([createdAt, id]));
}

function decodeCursor(raw: string): [string, string] {
  try {
    const value = JSON.parse(new TextDecoder().decode(b64urlToBytes(raw)));
    if (
      Array.isArray(value) &&
      value.length === 2 &&
      value.every((part) => typeof part === "string" && part.length > 0 && part.length <= 64)
    ) {
      return [value[0], value[1]];
    }
  } catch {
    // fall through
  }
  throw new HttpError(400, "validation_failed", "Request validation failed", {
    issues: [{ field: "cursor", code: "invalid_value" }],
  });
}

function parsePagination(url: URL): { limit: number; cursor: [string, string] | null } {
  const issues = new Issues();
  let limit = DEFAULT_PAGE_SIZE;
  const rawLimit = url.searchParams.get("limit");
  if (rawLimit !== null) {
    if (!/^\d{1,3}$/.test(rawLimit) || Number(rawLimit) < 1 || Number(rawLimit) > MAX_PAGE_SIZE) {
      issues.add("limit", "out_of_range");
    } else {
      limit = Number(rawLimit);
    }
  }
  issues.throwIfAny();
  const rawCursor = url.searchParams.get("cursor");
  return { limit, cursor: rawCursor === null ? null : decodeCursor(rawCursor) };
}

function page<T extends { created_at: string; id: string }>(rows: T[], limit: number) {
  const hasMore = rows.length > limit;
  const items = hasMore ? rows.slice(0, limit) : rows;
  const last = items[items.length - 1];
  return { items, next_cursor: hasMore && last ? encodeCursor(last.created_at, last.id) : null };
}

function isUniqueViolation(error: unknown): boolean {
  return error instanceof Error && /UNIQUE constraint failed/i.test(error.message);
}

// ---------- handlers ----------

async function me(ctx: Ctx): Promise<Response> {
  // Owner routes are only reachable by owner identities (enforced in the request pipeline).
  if (ctx.identity.kind !== "owner") throw new HttpError(403, "forbidden", "This identity is not allowed to use this endpoint");
  return jsonResponse({ email: ctx.identity.email, source: ctx.identity.source });
}

async function listAccounts(ctx: Ctx): Promise<Response> {
  const { results } = await ctx.env.DB.prepare(
    "SELECT id,slot,label,email,status,last_login_at,last_used_at,last_error FROM accounts ORDER BY slot",
  ).all();
  return jsonResponse({ items: results });
}

async function patchAccount(ctx: Ctx): Promise<Response> {
  const id = ctx.params[0];
  const body = await readJsonObject(ctx.req);
  const issues = new Issues();
  rejectUnknownFields(body, ["label", "email"], issues);
  const label = readString(body, "label", { max: 80 }, issues);
  const email = readNullableEmail(body, "email", issues);
  if (body.label === undefined && body.email === undefined) issues.add("$", "empty_update");
  issues.throwIfAny();

  const exists = await ctx.env.DB.prepare("SELECT id FROM accounts WHERE id=?").bind(id).first();
  if (!exists) throw new HttpError(404, "account_not_found", "Account not found");

  // Only fixed column fragments are ever concatenated; values are always bound.
  const sets: string[] = [];
  const binds: unknown[] = [];
  const fields: string[] = [];
  if (label !== undefined) {
    sets.push("label=?");
    binds.push(label);
    fields.push("label");
  }
  if (email !== undefined) {
    sets.push("email=?");
    binds.push(email);
    fields.push("email");
  }
  sets.push("updated_at=CURRENT_TIMESTAMP");
  await ctx.env.DB.batch([
    ctx.env.DB.prepare(`UPDATE accounts SET ${sets.join(",")} WHERE id=?`).bind(...binds, id),
    auditStatement(ctx, "account.updated", { account_id: id }, { fields }),
  ]);

  const row = await ctx.env.DB.prepare("SELECT id,slot,label,email,status FROM accounts WHERE id=?").bind(id).first();
  return jsonResponse(row);
}

async function listProjects(ctx: Ctx): Promise<Response> {
  const { limit, cursor } = parsePagination(ctx.url);
  const columns = "SELECT id,name,aspect_ratio,status,created_at,updated_at FROM projects";
  const statement = cursor
    ? ctx.env.DB.prepare(
        `${columns} WHERE (created_at < ? OR (created_at = ? AND id < ?)) ORDER BY created_at DESC, id DESC LIMIT ?`,
      ).bind(cursor[0], cursor[0], cursor[1], limit + 1)
    : ctx.env.DB.prepare(`${columns} ORDER BY created_at DESC, id DESC LIMIT ?`).bind(limit + 1);
  const { results } = await statement.all<{ id: string; created_at: string }>();
  return jsonResponse(page(results, limit));
}

async function createProject(ctx: Ctx): Promise<Response> {
  const body = await readJsonObject(ctx.req);
  const issues = new Issues();
  rejectUnknownFields(body, ["name", "aspect_ratio"], issues);
  const name = readString(body, "name", { required: true, max: 120 }, issues);
  const aspectRatio = readEnum(body, "aspect_ratio", ASPECT_RATIOS, issues) ?? "9:16";
  issues.throwIfAny();

  const id = crypto.randomUUID();
  await ctx.env.DB.batch([
    ctx.env.DB.prepare("INSERT INTO projects(id,name,aspect_ratio) VALUES(?,?,?)").bind(id, name, aspectRatio),
    auditStatement(ctx, "project.created", {}, { project_id: id }),
  ]);
  return jsonResponse({ id, name, aspect_ratio: aspectRatio }, 201);
}

async function listJobs(ctx: Ctx): Promise<Response> {
  const { limit, cursor } = parsePagination(ctx.url);
  const issues = new Issues();
  const rawStatus = ctx.url.searchParams.get("status");
  const status = rawStatus === null ? undefined : readEnum({ status: rawStatus }, "status", JOB_STATUSES, issues);
  issues.throwIfAny();

  const conditions: string[] = [];
  const binds: unknown[] = [];
  if (status) {
    conditions.push("j.status = ?");
    binds.push(status);
  }
  if (cursor) {
    conditions.push("(j.created_at > ? OR (j.created_at = ? AND j.id > ?))");
    binds.push(cursor[0], cursor[0], cursor[1]);
  }
  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  // worker_id / lease_token are deliberately not exposed to the PWA.
  const { results } = await ctx.env.DB.prepare(
    `SELECT j.id,j.project_id,j.scene_id,j.account_id,j.engine,j.status,j.attempts,j.max_attempts,j.cancel_requested,
            j.error_code,j.result_key,j.created_at,j.started_at,j.finished_at,
            a.slot AS account_slot,a.label AS account_label
       FROM jobs j JOIN accounts a ON a.id = j.account_id
       ${where}
       ORDER BY j.created_at ASC, j.id ASC LIMIT ?`,
  )
    .bind(...binds, limit + 1)
    .all<{ id: string; created_at: string }>();
  return jsonResponse(page(results, limit));
}

interface ExistingJob {
  id: string;
  project_id: string;
  scene_id: string | null;
  account_id: string;
  engine: string;
  status: string;
}

function replayOrConflict(
  existing: ExistingJob,
  wanted: { project_id: string; scene_id: string | null; account_id: string; engine: string },
): Response {
  const same =
    existing.project_id === wanted.project_id &&
    existing.scene_id === wanted.scene_id &&
    existing.account_id === wanted.account_id &&
    existing.engine === wanted.engine;
  if (!same) {
    throw new HttpError(409, "idempotency_key_conflict", "Idempotency key was already used with different parameters");
  }
  return jsonResponse({ id: existing.id, status: existing.status, idempotent_replay: true }, 200);
}

async function createJob(ctx: Ctx): Promise<Response> {
  const body = await readJsonObject(ctx.req);
  const issues = new Issues();
  rejectUnknownFields(body, ["project_id", "account_id", "scene_id", "engine", "idempotency_key"], issues);
  const projectId = readString(body, "project_id", { required: true, max: 36, pattern: UUID_RE }, issues);
  const accountId = readString(body, "account_id", { required: true, max: 8, pattern: ACCOUNT_ID_RE }, issues);
  const sceneId = readString(body, "scene_id", { max: 36, pattern: UUID_RE }, issues);
  const engine = readEnum(body, "engine", ENGINES, issues) ?? "dry-run";
  const idempotencyKey = readString(
    body,
    "idempotency_key",
    { required: true, min: 8, max: 128, pattern: /^[A-Za-z0-9._:-]+$/ },
    issues,
  );
  issues.throwIfAny();
  if (!projectId || !accountId || !idempotencyKey) throw new HttpError(500, "internal_error", "Internal error");

  if (engine !== "dry-run" && !ctx.cfg.liveEnginesEnabled) {
    throw new HttpError(403, "live_engine_disabled", "Live engines are disabled; use the dry-run engine");
  }
  const wanted = { project_id: projectId, scene_id: sceneId ?? null, account_id: accountId, engine };

  const findExisting = () =>
    ctx.env.DB.prepare("SELECT id,project_id,scene_id,account_id,engine,status FROM jobs WHERE idempotency_key=?")
      .bind(idempotencyKey)
      .first<ExistingJob>();

  const replay = await findExisting();
  if (replay) return replayOrConflict(replay, wanted);

  const project = await ctx.env.DB.prepare("SELECT id FROM projects WHERE id=?").bind(projectId).first();
  if (!project) throw new HttpError(404, "project_not_found", "Project not found");
  const account = await ctx.env.DB.prepare("SELECT status FROM accounts WHERE id=?")
    .bind(accountId)
    .first<{ status: string }>();
  if (!account) throw new HttpError(404, "account_not_found", "Account not found");
  if (account.status !== "ready") {
    throw new HttpError(409, "account_not_ready", "Account is not ready", { status: account.status });
  }
  if (sceneId) {
    const scene = await ctx.env.DB.prepare("SELECT id FROM scenes WHERE id=? AND project_id=?")
      .bind(sceneId, projectId)
      .first();
    if (!scene) throw new HttpError(404, "scene_not_found", "Scene not found in this project");
  }

  const id = crypto.randomUUID();
  try {
    await ctx.env.DB.batch([
      ctx.env.DB.prepare(
        "INSERT INTO jobs(id,project_id,scene_id,account_id,engine,status,idempotency_key) VALUES(?,?,?,?,?,'queued',?)",
      ).bind(id, projectId, sceneId ?? null, accountId, engine, idempotencyKey),
      auditStatement(ctx, "job.queued", { account_id: accountId, job_id: id }, { project_id: projectId, engine }),
    ]);
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;
    const raced = await findExisting();
    if (raced) return replayOrConflict(raced, wanted);
    throw error;
  }
  return jsonResponse({ id, status: "queued" }, 201);
}

interface CancelRow {
  id: string;
  account_id: string;
  status: string;
  cancel_requested: number;
}

/**
 * Safe cancellation:
 *  - queued / waiting_for_user: no worker owns it, so it is cancelled immediately (200).
 *  - claimed / running: a worker may be mid-generation, so the owner only records a request (202);
 *    the lease holder sees it on its next heartbeat and acknowledges with /api/worker/.../cancel-ack.
 *    If the worker dies instead, stale-lease recovery turns the request into `cancelled`.
 *  - final states: 409.
 */
async function cancelJob(ctx: Ctx): Promise<Response> {
  const id = ctx.params[0];
  const job = await ctx.env.DB.prepare("SELECT id,account_id,status,cancel_requested FROM jobs WHERE id=?")
    .bind(id)
    .first<CancelRow>();
  if (!job) throw new HttpError(404, "job_not_found", "Job not found");

  const immediate = await ctx.env.DB.batch([
    ctx.env.DB.prepare(
      "UPDATE jobs SET status='cancelled', finished_at=datetime(?/1000,'unixepoch'), updated_at=CURRENT_TIMESTAMP WHERE id=? AND status IN ('queued','waiting_for_user')",
    ).bind(ctx.now(), id),
    auditIfChanged(ctx, "job.cancelled", id, { previous_status: job.status }),
  ]);
  if (immediate[0].meta.changes === 1) return jsonResponse({ id, status: "cancelled" });

  const requested = await ctx.env.DB.batch([
    ctx.env.DB.prepare(
      "UPDATE jobs SET cancel_requested=1, updated_at=CURRENT_TIMESTAMP WHERE id=? AND status IN ('claimed','running') AND cancel_requested=0",
    ).bind(id),
    auditIfChanged(ctx, "job.cancel_requested", id, { previous_status: job.status }),
  ]);
  const current = await ctx.env.DB.prepare("SELECT status,cancel_requested FROM jobs WHERE id=?")
    .bind(id)
    .first<{ status: string; cancel_requested: number }>();
  if (requested[0].meta.changes === 1) {
    return jsonResponse({ id, status: current?.status ?? job.status, cancel_requested: true }, 202);
  }
  if (current && (ACTIVE_STATUSES as readonly string[]).includes(current.status) && current.cancel_requested === 1) {
    return jsonResponse({ id, status: current.status, cancel_requested: true, already_requested: true }, 202);
  }
  throw new HttpError(409, "job_not_cancellable", "Job is already finished", {
    status: current?.status ?? job.status,
  });
}

/** waiting_for_user -> queued once the owner has fixed the account (it must be `ready` again). */
async function resumeJob(ctx: Ctx): Promise<Response> {
  const id = ctx.params[0];
  const job = await ctx.env.DB.prepare("SELECT id,account_id,status FROM jobs WHERE id=?")
    .bind(id)
    .first<{ id: string; account_id: string; status: string }>();
  if (!job) throw new HttpError(404, "job_not_found", "Job not found");
  if (job.status !== "waiting_for_user") {
    throw new HttpError(409, "job_not_resumable", "Only jobs waiting for the user can be resumed", { status: job.status });
  }

  // Waiting for re-authentication is not a failure, so the attempt it consumed is given back.
  const results = await ctx.env.DB.batch([
    ctx.env.DB.prepare(
      `UPDATE jobs SET status='queued', error_code=NULL, error_message=NULL, worker_id=NULL, lease_token=NULL,
                       available_at=0, attempts=MAX(attempts-1,0), updated_at=CURRENT_TIMESTAMP
        WHERE id=? AND status='waiting_for_user'
          AND EXISTS (SELECT 1 FROM accounts WHERE id=jobs.account_id AND status='ready')`,
    ).bind(id),
    auditIfChanged(ctx, "job.resumed", id, {}),
  ]);
  if (results[0].meta.changes === 1) return jsonResponse({ id, status: "queued" });

  const account = await ctx.env.DB.prepare("SELECT status FROM accounts WHERE id=?")
    .bind(job.account_id)
    .first<{ status: string }>();
  if (account && account.status !== "ready") {
    throw new HttpError(409, "account_not_ready", "Account is not ready", { status: account.status });
  }
  throw new HttpError(409, "job_not_resumable", "Only jobs waiting for the user can be resumed");
}

async function listAudit(ctx: Ctx): Promise<Response> {
  const { limit, cursor } = parsePagination(ctx.url);
  const columns = "SELECT id,account_id,job_id,event_type,detail_json,created_at FROM audit_events";
  const statement = cursor
    ? ctx.env.DB.prepare(
        `${columns} WHERE (created_at < ? OR (created_at = ? AND id < ?)) ORDER BY created_at DESC, id DESC LIMIT ?`,
      ).bind(cursor[0], cursor[0], cursor[1], limit + 1)
    : ctx.env.DB.prepare(`${columns} ORDER BY created_at DESC, id DESC LIMIT ?`).bind(limit + 1);
  const { results } = await statement.all<{
    id: string;
    account_id: string | null;
    job_id: string | null;
    event_type: string;
    detail_json: string | null;
    created_at: string;
  }>();
  const { items, next_cursor } = page(results, limit);
  return jsonResponse({
    items: items.map(({ detail_json, ...rest }) => {
      let detail: unknown = null;
      try {
        detail = detail_json ? JSON.parse(detail_json) : null;
      } catch {
        detail = null;
      }
      return { ...rest, detail };
    }),
    next_cursor,
  });
}

// ---------- route table ----------

const ACCOUNT_PATH = /^\/api\/accounts\/(acct-(?:0[1-9]|10))$/;
const JOB_ACTION_PATH = (action: string) =>
  new RegExp(`^/api/jobs/([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})/${action}$`);

const ownerRoutes: Route[] = [
  { method: "GET", pattern: /^\/api\/me$/, write: false, audience: "owner", handler: me },
  { method: "GET", pattern: /^\/api\/accounts$/, write: false, audience: "owner", handler: listAccounts },
  { method: "PATCH", pattern: ACCOUNT_PATH, write: true, audience: "owner", handler: patchAccount },
  { method: "GET", pattern: /^\/api\/projects$/, write: false, audience: "owner", handler: listProjects },
  { method: "POST", pattern: /^\/api\/projects$/, write: true, audience: "owner", handler: createProject },
  { method: "GET", pattern: /^\/api\/jobs$/, write: false, audience: "owner", handler: listJobs },
  { method: "POST", pattern: /^\/api\/jobs$/, write: true, audience: "owner", handler: createJob },
  { method: "POST", pattern: JOB_ACTION_PATH("cancel"), write: true, audience: "owner", handler: cancelJob },
  { method: "POST", pattern: JOB_ACTION_PATH("resume"), write: true, audience: "owner", handler: resumeJob },
  { method: "GET", pattern: /^\/api\/audit$/, write: false, audience: "owner", handler: listAudit },
];

export const routes: Route[] = [...ownerRoutes, ...workerRoutes];
