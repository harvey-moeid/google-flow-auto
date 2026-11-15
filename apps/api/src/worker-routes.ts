/**
 * Worker-facing endpoints (/api/worker/*). Authenticated ONLY by an Access service token that is
 * listed in ALLOWED_SERVICE_TOKENS; owners cannot call these and service tokens cannot call owner
 * routes. Every mutation presents the (worker_id, fencing_token) issued by /claim; see queue.ts for
 * the invariants and docs/QUEUE_PROTOCOL.md for the wire protocol.
 */
import { HttpError, jsonResponse, readJsonObject } from "./http.ts";
import {
  ACTIVE_STATUSES,
  LEASE_DEFAULT_S,
  LEASE_MAX_S,
  LEASE_MIN_S,
  RETRY_BASE_MS,
  RETRY_CAP_MS,
  RETRY_SQL,
  SQL_TS,
  claimNext,
  heartbeat,
  jobInfo,
  leaseState,
  transition,
} from "./queue.ts";
import type { AuditMeta, LeaseRef, TransitionSpec } from "./queue.ts";
import { actorOf } from "./route-types.ts";
import type { Ctx, Route } from "./route-types.ts";
import {
  ERROR_CODE_RE,
  Issues,
  RESULT_KEY_RE,
  WORKER_ID_RE,
  readBoolean,
  readInt,
  readString,
  rejectUnknownFields,
} from "./validate.ts";

const UUID = "[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}";
const jobPath = (action: string) => new RegExp(`^/api/worker/jobs/(${UUID})/${action}$`);

function metaOf(ctx: Ctx): AuditMeta {
  return { actor: actorOf(ctx.identity), requestId: ctx.requestId };
}

function internal(): HttpError {
  return new HttpError(500, "internal_error", "Internal error");
}

/** Reads the fields every job-scoped worker request carries. */
function readRef(ctx: Ctx, body: Record<string, unknown>, issues: Issues): LeaseRef | null {
  const workerId = readString(body, "worker_id", { required: true, max: 64, pattern: WORKER_ID_RE }, issues);
  const token = readInt(body, "fencing_token", { required: true, min: 1, max: Number.MAX_SAFE_INTEGER }, issues);
  return workerId !== undefined && token !== undefined ? { jobId: ctx.params[0], workerId, token } : null;
}

interface RefuseOptions {
  /** If the job already reached this state under the same (worker, token), the call is an idempotent replay. */
  replayStatus?: string;
  /** Report `cancel_requested` (instead of lease_lost) when the owner asked to stop this active job. */
  onCancelRequested?: boolean;
  /** Report `cancel_not_requested` when an acknowledgement arrives for a job nobody asked to cancel. */
  requireCancelRequested?: boolean;
}

/**
 * Called when a guarded transition changed nothing. Distinguishes: unknown job (404), idempotent
 * retry of a call that already succeeded (200), and a lost/expired/foreign lease (409).
 */
async function refuse(ctx: Ctx, ref: LeaseRef, options: RefuseOptions = {}): Promise<Response> {
  const info = await jobInfo(ctx.env.DB, ref.jobId);
  if (!info) throw new HttpError(404, "job_not_found", "Job not found");
  const mine = info.worker_id === ref.workerId && info.lease_token === ref.token;
  if (mine && options.replayStatus && info.status === options.replayStatus) {
    return jsonResponse({ id: ref.jobId, status: info.status, idempotent_replay: true });
  }
  if (mine && (ACTIVE_STATUSES as readonly string[]).includes(info.status)) {
    if (options.onCancelRequested && info.cancel_requested === 1) {
      throw new HttpError(409, "cancel_requested", "The owner cancelled this job; acknowledge with cancel-ack", {
        status: info.status,
      });
    }
    if (options.requireCancelRequested && info.cancel_requested === 0) {
      throw new HttpError(409, "cancel_not_requested", "This job has no pending cancellation", { status: info.status });
    }
  }
  throw new HttpError(409, "lease_lost", "This worker no longer holds the lease for this job", { status: info.status });
}

// ---------- handlers ----------

async function claim(ctx: Ctx): Promise<Response> {
  const body = await readJsonObject(ctx.req);
  const issues = new Issues();
  rejectUnknownFields(body, ["worker_id", "lease_seconds"], issues);
  const workerId = readString(body, "worker_id", { required: true, max: 64, pattern: WORKER_ID_RE }, issues);
  const leaseSeconds = readInt(body, "lease_seconds", { min: LEASE_MIN_S, max: LEASE_MAX_S }, issues) ?? LEASE_DEFAULT_S;
  issues.throwIfAny();
  if (workerId === undefined) throw internal();

  const job = await claimNext(ctx.env.DB, ctx.now(), {
    workerId,
    leaseMs: leaseSeconds * 1000,
    liveEnabled: ctx.cfg.liveEnginesEnabled,
    meta: metaOf(ctx),
  });
  if (!job) return jsonResponse({ claimed: false });
  return jsonResponse({
    claimed: true,
    job: {
      id: job.id,
      project_id: job.project_id,
      scene_id: job.scene_id,
      account_id: job.account_id,
      engine: job.engine,
      attempt: job.attempts,
      max_attempts: job.max_attempts,
      aspect_ratio: job.aspect_ratio,
      // null when the scene was deleted after the job was queued; the worker must fail such a job
      // as non-retryable instead of guessing a prompt.
      scene:
        job.scene_id !== null && job.scene_prompt !== null
          ? {
              id: job.scene_id,
              order: job.scene_order,
              prompt: job.scene_prompt,
              duration_seconds: job.scene_duration_seconds,
            }
          : null,
    },
    lease: { fencing_token: job.fencing_token, expires_at: new Date(job.expires_at).toISOString() },
  });
}

async function start(ctx: Ctx): Promise<Response> {
  const body = await readJsonObject(ctx.req);
  const issues = new Issues();
  rejectUnknownFields(body, ["worker_id", "fencing_token"], issues);
  const ref = readRef(ctx, body, issues);
  issues.throwIfAny();
  if (!ref) throw internal();

  const now = ctx.now();
  const changed = await transition(
    ctx.env.DB,
    now,
    ref,
    {
      from: ["claimed"],
      set: `status='running', started_at=COALESCE(started_at, ${SQL_TS})`,
      setBinds: [now],
      extraWhere: " AND cancel_requested=0",
      event: "job.started",
      release: false,
    },
    metaOf(ctx),
  );
  if (changed) return jsonResponse({ id: ref.jobId, status: "running" });
  return refuse(ctx, ref, { replayStatus: "running", onCancelRequested: true });
}

async function beat(ctx: Ctx): Promise<Response> {
  const body = await readJsonObject(ctx.req);
  const issues = new Issues();
  rejectUnknownFields(body, ["worker_id", "fencing_token", "lease_seconds"], issues);
  const ref = readRef(ctx, body, issues);
  const leaseSeconds = readInt(body, "lease_seconds", { min: LEASE_MIN_S, max: LEASE_MAX_S }, issues) ?? LEASE_DEFAULT_S;
  issues.throwIfAny();
  if (!ref) throw internal();

  if (!(await heartbeat(ctx.env.DB, ctx.now(), ref, leaseSeconds * 1000))) return refuse(ctx, ref);
  const state = await leaseState(ctx.env.DB, ref.jobId);
  if (!state) throw internal();
  return jsonResponse({
    id: ref.jobId,
    lease: { expires_at: new Date(state.expires_at).toISOString() },
    cancel_requested: state.cancel_requested === 1,
  });
}

async function complete(ctx: Ctx): Promise<Response> {
  const body = await readJsonObject(ctx.req);
  const issues = new Issues();
  rejectUnknownFields(body, ["worker_id", "fencing_token", "result_key"], issues);
  const ref = readRef(ctx, body, issues);
  const resultKey = readString(body, "result_key", { max: 512, pattern: RESULT_KEY_RE }, issues);
  if (resultKey !== undefined && resultKey.includes("..")) issues.add("result_key", "invalid_format");
  issues.throwIfAny();
  if (!ref) throw internal();

  const now = ctx.now();
  const changed = await transition(
    ctx.env.DB,
    now,
    ref,
    {
      from: ["running"],
      set: `status='succeeded', result_key=?, error_code=NULL, error_message=NULL, finished_at=${SQL_TS}`,
      setBinds: [resultKey ?? null, now],
      event: "job.succeeded",
      release: true,
    },
    metaOf(ctx),
  );
  if (changed) return jsonResponse({ id: ref.jobId, status: "succeeded" });
  return refuse(ctx, ref, { replayStatus: "succeeded" });
}

async function fail(ctx: Ctx): Promise<Response> {
  const body = await readJsonObject(ctx.req);
  const issues = new Issues();
  rejectUnknownFields(body, ["worker_id", "fencing_token", "error_code", "error_message", "retryable"], issues);
  const ref = readRef(ctx, body, issues);
  const errorCode = readString(body, "error_code", { required: true, max: 64, pattern: ERROR_CODE_RE }, issues);
  const errorMessage = readString(body, "error_message", { max: 500 }, issues);
  const retryable = readBoolean(body, "retryable", { required: true }, issues);
  issues.throwIfAny();
  if (!ref || errorCode === undefined || retryable === undefined) throw internal();

  // Retry only if the worker says it is retryable, attempts remain and nobody asked to cancel.
  const r = retryable ? 1 : 0;
  const retry = "(?=1 AND attempts<max_attempts AND cancel_requested=0)";
  const now = ctx.now();
  const spec: TransitionSpec = {
    from: ["claimed", "running"],
    set: [
      `status=CASE WHEN ${retry} THEN 'queued' WHEN cancel_requested=1 THEN 'cancelled' ELSE 'failed' END`,
      "error_code=?",
      "error_message=?",
      `finished_at=CASE WHEN ${retry} THEN NULL ELSE ${SQL_TS} END`,
      `available_at=CASE WHEN ${retry} THEN ${RETRY_SQL} ELSE available_at END`,
      `worker_id=CASE WHEN ${retry} THEN NULL ELSE worker_id END`,
      `lease_token=CASE WHEN ${retry} THEN NULL ELSE lease_token END`,
    ].join(", "),
    // Bind order follows the placeholders above, left to right.
    setBinds: [r, errorCode, errorMessage ?? null, r, now, r, now, RETRY_CAP_MS, RETRY_BASE_MS, r, r],
    event: "job.worker_failed",
    detail: { error_code: errorCode, retryable },
    release: true,
  };
  if (!(await transition(ctx.env.DB, now, ref, spec, metaOf(ctx)))) return refuse(ctx, ref);
  const info = await jobInfo(ctx.env.DB, ref.jobId);
  return jsonResponse({ id: ref.jobId, status: info?.status ?? "unknown", will_retry: info?.status === "queued" });
}

/** Browser session needs a human: park the job, flag the account, free the lane. */
async function waitForUser(ctx: Ctx): Promise<Response> {
  const body = await readJsonObject(ctx.req);
  const issues = new Issues();
  rejectUnknownFields(body, ["worker_id", "fencing_token"], issues);
  const ref = readRef(ctx, body, issues);
  issues.throwIfAny();
  if (!ref) throw internal();

  const now = ctx.now();
  const changed = await transition(
    ctx.env.DB,
    now,
    ref,
    {
      from: ["claimed", "running"],
      set: `status=CASE WHEN cancel_requested=1 THEN 'cancelled' ELSE 'waiting_for_user' END, error_code='auth_required', finished_at=CASE WHEN cancel_requested=1 THEN ${SQL_TS} ELSE NULL END`,
      setBinds: [now],
      event: "job.waiting_for_user",
      after: [
        ctx.env.DB.prepare(
          `UPDATE accounts SET status='auth_required', last_error='Re-authentication required', updated_at=CURRENT_TIMESTAMP
            WHERE status='ready' AND id=(SELECT account_id FROM jobs WHERE id=? AND worker_id=? AND lease_token=? AND status IN ('waiting_for_user','cancelled'))`,
        ).bind(ref.jobId, ref.workerId, ref.token),
      ],
      release: true,
    },
    metaOf(ctx),
  );
  if (!changed) return refuse(ctx, ref, { replayStatus: "waiting_for_user" });
  const info = await jobInfo(ctx.env.DB, ref.jobId);
  return jsonResponse({ id: ref.jobId, status: info?.status ?? "unknown" });
}

/** The worker has safely stopped a job the owner asked to cancel. */
async function cancelAck(ctx: Ctx): Promise<Response> {
  const body = await readJsonObject(ctx.req);
  const issues = new Issues();
  rejectUnknownFields(body, ["worker_id", "fencing_token"], issues);
  const ref = readRef(ctx, body, issues);
  issues.throwIfAny();
  if (!ref) throw internal();

  const now = ctx.now();
  const changed = await transition(
    ctx.env.DB,
    now,
    ref,
    {
      from: ["claimed", "running"],
      set: `status='cancelled', finished_at=${SQL_TS}`,
      setBinds: [now],
      extraWhere: " AND cancel_requested=1",
      event: "job.cancelled",
      detail: { previous_status: "running", acknowledged_by_worker: true },
      release: true,
    },
    metaOf(ctx),
  );
  if (changed) return jsonResponse({ id: ref.jobId, status: "cancelled" });
  return refuse(ctx, ref, { replayStatus: "cancelled", requireCancelRequested: true });
}

export const workerRoutes: Route[] = [
  { method: "POST", pattern: /^\/api\/worker\/claim$/, write: true, audience: "worker", handler: claim },
  { method: "POST", pattern: jobPath("start"), write: true, audience: "worker", handler: start },
  { method: "POST", pattern: jobPath("heartbeat"), write: true, audience: "worker", handler: beat },
  { method: "POST", pattern: jobPath("complete"), write: true, audience: "worker", handler: complete },
  { method: "POST", pattern: jobPath("fail"), write: true, audience: "worker", handler: fail },
  { method: "POST", pattern: jobPath("wait"), write: true, audience: "worker", handler: waitForUser },
  { method: "POST", pattern: jobPath("cancel-ack"), write: true, audience: "worker", handler: cancelAck },
];
