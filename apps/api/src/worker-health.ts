/**
 * Phase 4b: worker health and account readiness.
 *
 *  - POST /api/worker/status                      worker reports state + disk + profile count (heartbeat of the PROCESS,
 *                                                 distinct from the per-job lease heartbeat in worker-routes.ts)
 *  - POST /api/worker/accounts/:id/readiness      worker reports the session state of ONE account slot
 *  - GET  /api/workers                            owner reads worker health (online flag computed here, not stored)
 *
 * Design decisions:
 *  * Health is observational. The queue and the global lease never read `worker_status`, so a missing or
 *    stale row cannot block or release a job.
 *  * An account can only become `ready` when the worker states `owner_confirmed: true`, i.e. a human finished
 *    the manual login in the visible browser. Nothing here (or anywhere) detects a login automatically, and
 *    there is no way to mark `disabled`/`error` through this route.
 *  * Readiness never changes while a job of that account is claimed/running (409 account_in_use); the job's own
 *    `wait` transition (worker-routes.ts) is the path for "session expired mid-job".
 *  * Reporting `ready` does NOT resume jobs parked in waiting_for_user: the owner resumes them explicitly.
 */
import { HttpError, jsonResponse, readJsonObject } from "./http.ts";
import type { Ctx, Route } from "./route-types.ts";
import { actorOf } from "./route-types.ts";
import {
  ACCOUNT_ID_RE,
  Issues,
  WORKER_ID_RE,
  readBoolean,
  readEnum,
  readInt,
  readString,
  rejectUnknownFields,
} from "./validate.ts";

/** A worker not heard from for longer than this is shown offline (status is reported every ~30 s). */
export const ONLINE_WINDOW_MS = 90_000;
/** Rows of workers silent for this long are deleted on the next status write. */
export const PRUNE_AFTER_MS = 7 * 24 * 3600_000;
/** Upper bound on tracked workers so a leaked token cannot grow the table without limit. */
export const MAX_WORKERS = 50;
/** Below this much free disk the owner API flags `disk_low` (browser profiles and downloads need room). */
export const LOW_DISK_BYTES = 2 * 1024 ** 3;

const WORKER_STATES = ["idle", "busy", "stopping"] as const;
const READINESS_STATUSES = ["ready", "auth_required", "needs_login"] as const;
const ACCOUNT_PATH = /^\/api\/worker\/accounts\/(acct-(?:0[1-9]|10))\/readiness$/;

async function reportStatus(ctx: Ctx): Promise<Response> {
  const body = await readJsonObject(ctx.req);
  const issues = new Issues();
  rejectUnknownFields(body, ["worker_id", "state", "disk_free_bytes", "disk_total_bytes", "profile_count"], issues);
  const workerId = readString(body, "worker_id", { required: true, max: 64, pattern: WORKER_ID_RE }, issues);
  const state = readEnum(body, "state", WORKER_STATES, issues);
  if (body.state === undefined) issues.add("state", "required");
  const free = readInt(body, "disk_free_bytes", { min: 0, max: Number.MAX_SAFE_INTEGER }, issues);
  const total = readInt(body, "disk_total_bytes", { min: 0, max: Number.MAX_SAFE_INTEGER }, issues);
  const profiles = readInt(body, "profile_count", { required: true, min: 0, max: 10 }, issues);
  if (free !== undefined && total !== undefined && free > total) issues.add("disk_free_bytes", "exceeds_total");
  // Disk numbers come as a pair or not at all; half a pair cannot be interpreted.
  if ((body.disk_free_bytes === undefined) !== (body.disk_total_bytes === undefined)) {
    issues.add(body.disk_free_bytes === undefined ? "disk_free_bytes" : "disk_total_bytes", "required_with_pair");
  }
  issues.throwIfAny();
  if (workerId === undefined || state === undefined || profiles === undefined) {
    throw new HttpError(500, "internal_error", "Internal error");
  }

  const now = ctx.now();
  const known = await ctx.env.DB.prepare("SELECT 1 AS known FROM worker_status WHERE worker_id=?").bind(workerId).first();
  if (!known) {
    const row = await ctx.env.DB.prepare("SELECT COUNT(*) AS c FROM worker_status").first<{ c: number }>();
    if (Number(row?.c ?? 0) >= MAX_WORKERS) {
      throw new HttpError(409, "worker_limit_reached", "Too many distinct worker ids are tracked");
    }
  }
  await ctx.env.DB.batch([
    ctx.env.DB.prepare("DELETE FROM worker_status WHERE last_seen_at < ?").bind(now - PRUNE_AFTER_MS),
    ctx.env.DB.prepare(
      `INSERT INTO worker_status(worker_id,state,disk_free_bytes,disk_total_bytes,profile_count,first_seen_at,last_seen_at)
       VALUES(?,?,?,?,?,?,?)
       ON CONFLICT(worker_id) DO UPDATE SET state=excluded.state, disk_free_bytes=excluded.disk_free_bytes,
         disk_total_bytes=excluded.disk_total_bytes, profile_count=excluded.profile_count, last_seen_at=excluded.last_seen_at`,
    ).bind(workerId, state, free ?? null, total ?? null, profiles, now, now),
  ]);
  return jsonResponse({ ok: true });
}

async function reportReadiness(ctx: Ctx): Promise<Response> {
  const accountId = ctx.params[0];
  const body = await readJsonObject(ctx.req);
  const issues = new Issues();
  rejectUnknownFields(body, ["worker_id", "status", "owner_confirmed"], issues);
  const workerId = readString(body, "worker_id", { required: true, max: 64, pattern: WORKER_ID_RE }, issues);
  const status = readEnum(body, "status", READINESS_STATUSES, issues);
  if (body.status === undefined) issues.add("status", "required");
  const confirmed = readBoolean(body, "owner_confirmed", {}, issues);
  // `ready` is a claim that a human just completed the login; refuse it without that explicit statement.
  if (status === "ready" && confirmed !== true) issues.add("owner_confirmed", "required_for_ready");
  issues.throwIfAny();
  if (workerId === undefined || status === undefined || !ACCOUNT_ID_RE.test(accountId)) {
    throw new HttpError(500, "internal_error", "Internal error");
  }

  // One batch: the UPDATE only applies to an enabled account with no active job, and the audit row is
  // only written if that UPDATE changed a row, so the log never claims a change that did not happen.
  const detail = JSON.stringify({
    actor: actorOf(ctx.identity),
    request_id: ctx.requestId,
    worker_id: workerId,
    status,
    owner_confirmed: confirmed === true,
  });
  const results = await ctx.env.DB.batch([
    ctx.env.DB.prepare(
      `UPDATE accounts SET status=?1,
         last_login_at=CASE WHEN ?1='ready' THEN CURRENT_TIMESTAMP ELSE last_login_at END,
         last_error=CASE WHEN ?1='ready' THEN NULL WHEN ?1='auth_required' THEN 'Re-authentication required' ELSE last_error END,
         updated_at=CURRENT_TIMESTAMP
       WHERE id=?2 AND status<>'disabled'
         AND NOT EXISTS (SELECT 1 FROM jobs WHERE jobs.account_id=accounts.id AND jobs.status IN ('claimed','running'))`,
    ).bind(status, accountId),
    ctx.env.DB.prepare(
      "INSERT INTO audit_events(id,account_id,job_id,event_type,detail_json) SELECT ?,?,NULL,?,? WHERE changes()>0",
    ).bind(crypto.randomUUID(), accountId, "account.readiness_reported", detail),
  ]);
  const changed = Number((results[0] as { meta?: { changes?: number } }).meta?.changes ?? 0) > 0;
  if (!changed) {
    const account = await ctx.env.DB.prepare("SELECT status FROM accounts WHERE id=?").bind(accountId).first<{ status: string }>();
    if (!account) throw new HttpError(404, "account_not_found", "Account not found");
    if (account.status === "disabled") throw new HttpError(409, "account_disabled", "This account slot is disabled");
    throw new HttpError(409, "account_in_use", "A job of this account is running; its readiness cannot change now");
  }
  return jsonResponse({ account_id: accountId, status });
}

async function listWorkers(ctx: Ctx): Promise<Response> {
  const now = ctx.now();
  const { results } = await ctx.env.DB.prepare(
    `SELECT worker_id,state,disk_free_bytes,disk_total_bytes,profile_count,first_seen_at,last_seen_at
       FROM worker_status ORDER BY last_seen_at DESC, worker_id LIMIT ?`,
  )
    .bind(MAX_WORKERS)
    .all<{
      worker_id: string;
      state: string;
      disk_free_bytes: number | null;
      disk_total_bytes: number | null;
      profile_count: number;
      first_seen_at: number;
      last_seen_at: number;
    }>();
  return jsonResponse({
    items: results.map((row) => ({
      worker_id: row.worker_id,
      state: row.state,
      // A worker that announced `stopping` is shutting down: show it offline immediately.
      online: row.state !== "stopping" && now - row.last_seen_at <= ONLINE_WINDOW_MS,
      last_seen_at: new Date(row.last_seen_at).toISOString(),
      disk_free_bytes: row.disk_free_bytes,
      disk_total_bytes: row.disk_total_bytes,
      disk_low: row.disk_free_bytes !== null && row.disk_free_bytes < LOW_DISK_BYTES,
      profile_count: row.profile_count,
    })),
  });
}

export const workerHealthRoutes: Route[] = [
  { method: "GET", pattern: /^\/api\/workers$/, write: false, audience: "owner", handler: listWorkers },
  { method: "POST", pattern: /^\/api\/worker\/status$/, write: true, audience: "worker", handler: reportStatus },
  { method: "POST", pattern: ACCOUNT_PATH, write: true, audience: "worker", handler: reportReadiness },
];
