/**
 * Durable queue + single global execution lease (Phase 2).
 *
 * Invariants (each is enforced in SQL, not just in application code):
 *  1. There is exactly one lease row (`global_lease`). A job is only ever `claimed`/`running` while
 *     that row names it, so at most ONE job executes globally.
 *  2. Acquiring the lease and claiming the job happen in one D1 batch (one transaction). Two
 *     concurrent claims are serialised by D1; the loser changes 0 rows.
 *  3. `fencing_token` increases on every acquisition and is never reset. Every mutation by a worker
 *     must present (worker_id, fencing_token) and the lease must still be unexpired, so a stale or
 *     crashed worker can never touch a newer lease.
 *  4. A job whose lease expired or vanished is recovered: requeued with exponential backoff, failed
 *     once `max_attempts` is exhausted, or cancelled if the owner had asked to cancel.
 *  5. State changes and their audit rows commit together (audit insert is guarded by `changes()`).
 *
 * All times are epoch milliseconds supplied by the caller (injectable clock, testable).
 * SQL fragments below are fixed strings; every value is a bound parameter.
 */

export const LEASE_DEFAULT_S = 60;
export const LEASE_MIN_S = 10;
export const LEASE_MAX_S = 300;
export const RETRY_BASE_MS = 30_000;
export const RETRY_CAP_MS = 15 * 60_000;
export const ACTIVE_STATUSES = ["claimed", "running"] as const;

export interface AuditMeta {
  actor: string;
  requestId: string;
}

export interface LeaseRef {
  jobId: string;
  workerId: string;
  token: number;
}

export interface ClaimedJob {
  id: string;
  project_id: string;
  scene_id: string | null;
  account_id: string;
  engine: string;
  attempts: number;
  max_attempts: number;
  fencing_token: number;
  expires_at: number;
}

function detailJson(meta: AuditMeta, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ actor: meta.actor, request_id: meta.requestId, ...extra });
}

/** A job is claimable only if it is queued, not backing off, not cancel-requested, its account is ready, and (kill switch) live engines are enabled or it is a dry-run. */
const ELIGIBLE =
  "status='queued' AND cancel_requested=0 AND available_at<=? AND (engine='dry-run' OR ?=1) AND account_id IN (SELECT id FROM accounts WHERE status='ready')";

/** An active job is stale when no unexpired lease row names it under its own fencing token. */
const STALE =
  "status IN ('claimed','running') AND NOT EXISTS (SELECT 1 FROM global_lease l WHERE l.name='global' AND l.job_id=jobs.id AND l.fencing_token=jobs.lease_token AND l.holder_id IS NOT NULL AND l.expires_at>?)";

const TS = "datetime(?/1000,'unixepoch')";

/**
 * Requeue / fail / cancel jobs whose lease expired, then release the expired lease.
 * Safe to run at any time and from several places (claim, cron); it only touches stale rows.
 */
export async function recoverStale(
  db: D1Database,
  now: number,
): Promise<{ requeued: number; failed: number; cancelled: number }> {
  const results = await db.batch([
    // 0: audit first, while the rows still look stale, with the outcome each will get.
    db
      .prepare(
        `INSERT INTO audit_events(id,account_id,job_id,event_type,detail_json)
         SELECT lower(hex(randomblob(16))), account_id, id, 'job.recovered',
                json_object('actor','system','previous_status',status,'attempt',attempts,
                  'outcome',CASE WHEN cancel_requested=1 THEN 'cancelled' WHEN attempts>=max_attempts THEN 'failed' ELSE 'requeued' END)
           FROM jobs WHERE ${STALE}`,
      )
      .bind(now),
    // 1: owner asked to cancel -> cancelled.
    db
      .prepare(
        `UPDATE jobs SET status='cancelled', error_code='lease_expired', finished_at=${TS}, updated_at=CURRENT_TIMESTAMP
          WHERE cancel_requested=1 AND ${STALE}`,
      )
      .bind(now, now),
    // 2: retry budget exhausted -> failed.
    db
      .prepare(
        `UPDATE jobs SET status='failed', error_code='lease_expired', error_message='worker lease expired and the retry limit was reached',
                         finished_at=${TS}, updated_at=CURRENT_TIMESTAMP
          WHERE attempts>=max_attempts AND ${STALE}`,
      )
      .bind(now, now),
    // 3: everything else stale -> back to the queue with exponential backoff.
    db
      .prepare(
        `UPDATE jobs SET status='queued', error_code='lease_expired', worker_id=NULL, lease_token=NULL,
                         available_at=?+MIN(?, ?*(1<<(attempts-1))), updated_at=CURRENT_TIMESTAMP
          WHERE ${STALE}`,
      )
      .bind(now, RETRY_CAP_MS, RETRY_BASE_MS, now),
    // 4: release the expired lease (fencing_token is kept; it only ever grows).
    db
      .prepare(
        "UPDATE global_lease SET holder_id=NULL, job_id=NULL, expires_at=0, updated_at=? WHERE name='global' AND holder_id IS NOT NULL AND expires_at<=?",
      )
      .bind(now, now),
  ]);
  return {
    cancelled: results[1].meta.changes,
    failed: results[2].meta.changes,
    requeued: results[3].meta.changes,
  };
}

/**
 * Atomically take the global lease for the oldest eligible job. Returns null when there is nothing
 * to run or another worker holds an unexpired lease.
 */
export async function claimNext(
  db: D1Database,
  now: number,
  options: { workerId: string; leaseMs: number; liveEnabled: boolean; meta: AuditMeta },
): Promise<ClaimedJob | null> {
  await recoverStale(db, now);
  const live = options.liveEnabled ? 1 : 0;
  const { workerId, leaseMs, meta } = options;

  const results = await db.batch([
    // 0: acquire the lease and pick the job in ONE statement. Succeeds only if the lease is free or
    // expired AND an eligible job exists. FIFO by creation time, then insertion order.
    db
      .prepare(
        `UPDATE global_lease
            SET holder_id=?, fencing_token=fencing_token+1,
                job_id=(SELECT id FROM jobs WHERE ${ELIGIBLE} ORDER BY created_at, rowid LIMIT 1),
                expires_at=?, heartbeat_at=?, updated_at=?
          WHERE name='global' AND (holder_id IS NULL OR expires_at<=?)
            AND EXISTS (SELECT 1 FROM jobs WHERE ${ELIGIBLE})`,
      )
      .bind(workerId, now, live, now + leaseMs, now, now, now, now, live),
    // 1: bind the picked job to this worker and token (no-op unless statement 0 just acquired).
    db
      .prepare(
        `UPDATE jobs
            SET status='claimed', attempts=attempts+1, worker_id=?,
                lease_token=(SELECT fencing_token FROM global_lease WHERE name='global'),
                error_code=NULL, error_message=NULL, updated_at=CURRENT_TIMESTAMP
          WHERE id=(SELECT job_id FROM global_lease WHERE name='global' AND holder_id=? AND expires_at>?)
            AND status='queued'`,
      )
      .bind(workerId, workerId, now),
    // 2: audit, only if statement 1 changed a row.
    db
      .prepare(
        `INSERT INTO audit_events(id,account_id,job_id,event_type,detail_json)
         SELECT ?, j.account_id, j.id, 'job.claimed', ?
           FROM jobs j
          WHERE j.id=(SELECT job_id FROM global_lease WHERE name='global' AND holder_id=? AND expires_at>?)
            AND j.worker_id=? AND j.status='claimed' AND changes()>0`,
      )
      .bind(crypto.randomUUID(), detailJson(meta, { worker_id: workerId }), workerId, now, workerId),
  ]);

  if (results[0].meta.changes !== 1) return null;
  if (results[1].meta.changes !== 1) {
    // Cannot happen inside one transaction; if it ever does, never report a claim we did not make.
    console.error(JSON.stringify({ level: "error", event: "queue.claim_inconsistent", request_id: meta.requestId }));
    return null;
  }

  return db
    .prepare(
      `SELECT j.id, j.project_id, j.scene_id, j.account_id, j.engine, j.attempts, j.max_attempts,
              l.fencing_token, l.expires_at
         FROM global_lease l JOIN jobs j ON j.id=l.job_id
        WHERE l.name='global' AND l.holder_id=? AND j.worker_id=? AND j.lease_token=l.fencing_token`,
    )
    .bind(workerId, workerId)
    .first<ClaimedJob>();
}

export interface TransitionSpec {
  /** Job must currently be in one of these states. */
  from: readonly string[];
  /** Fixed SQL assignment list (no user data; values go in setBinds). `updated_at` is appended. */
  set: string;
  setBinds: unknown[];
  /** Fixed extra condition, e.g. " AND cancel_requested=0". Must contain no placeholders. */
  extraWhere?: string;
  event: string;
  detail?: Record<string, unknown>;
  /** Extra statements run after the audit row (e.g. flag the account). */
  after?: D1PreparedStatement[];
  /** Release the global lease if the job left the active states. */
  release: boolean;
}

/**
 * Guarded state change by the lease holder. Applies only if the job belongs to (worker, token) in an
 * allowed state AND the global lease still names this job, worker and token and has not expired.
 * Returns false when nothing changed (stale/expired/wrong state) so the caller can explain why.
 */
export async function transition(
  db: D1Database,
  now: number,
  ref: LeaseRef,
  spec: TransitionSpec,
  meta: AuditMeta,
): Promise<boolean> {
  const fromMarks = spec.from.map(() => "?").join(",");
  const guard = `id=? AND worker_id=? AND lease_token=? AND status IN (${fromMarks})${spec.extraWhere ?? ""}
    AND EXISTS (SELECT 1 FROM global_lease WHERE name='global' AND holder_id=? AND job_id=? AND fencing_token=? AND expires_at>?)`;
  const statements: D1PreparedStatement[] = [
    db
      .prepare(`UPDATE jobs SET ${spec.set}, updated_at=CURRENT_TIMESTAMP WHERE ${guard}`)
      .bind(...spec.setBinds, ref.jobId, ref.workerId, ref.token, ...spec.from, ref.workerId, ref.jobId, ref.token, now),
    // MUST directly follow the UPDATE: changes() refers to the most recent data-changing statement.
    db
      .prepare(
        "INSERT INTO audit_events(id,account_id,job_id,event_type,detail_json) SELECT ?,account_id,id,?,? FROM jobs WHERE id=? AND changes()>0",
      )
      .bind(
        crypto.randomUUID(),
        spec.event,
        detailJson(meta, { worker_id: ref.workerId, fencing_token: ref.token, ...spec.detail }),
        ref.jobId,
      ),
    ...(spec.after ?? []),
  ];
  if (spec.release) {
    statements.push(
      db
        .prepare(
          `UPDATE global_lease SET holder_id=NULL, job_id=NULL, expires_at=0, updated_at=?
            WHERE name='global' AND holder_id=? AND job_id=? AND fencing_token=?
              AND NOT EXISTS (SELECT 1 FROM jobs WHERE id=? AND lease_token=? AND status IN ('claimed','running'))`,
        )
        .bind(now, ref.workerId, ref.jobId, ref.token, ref.jobId, ref.token),
    );
  }
  const results = await db.batch(statements);
  return results[0].meta.changes === 1;
}

/** Extend the lease (never shorten it). False if the lease/job is not the caller's or already expired. */
export async function heartbeat(db: D1Database, now: number, ref: LeaseRef, leaseMs: number): Promise<boolean> {
  const result = await db
    .prepare(
      `UPDATE global_lease SET expires_at=MAX(expires_at, ?), heartbeat_at=?, updated_at=?
        WHERE name='global' AND holder_id=? AND job_id=? AND fencing_token=? AND expires_at>?
          AND EXISTS (SELECT 1 FROM jobs WHERE id=? AND worker_id=? AND lease_token=? AND status IN ('claimed','running'))`,
    )
    .bind(now + leaseMs, now, now, ref.workerId, ref.jobId, ref.token, now, ref.jobId, ref.workerId, ref.token)
    .run();
  return result.meta.changes === 1;
}

export interface JobInfo {
  id: string;
  status: string;
  worker_id: string | null;
  lease_token: number | null;
  cancel_requested: number;
}

export function jobInfo(db: D1Database, jobId: string): Promise<JobInfo | null> {
  return db
    .prepare("SELECT id,status,worker_id,lease_token,cancel_requested FROM jobs WHERE id=?")
    .bind(jobId)
    .first<JobInfo>();
}

export function leaseState(
  db: D1Database,
  jobId: string,
): Promise<{ expires_at: number; cancel_requested: number } | null> {
  return db
    .prepare(
      "SELECT l.expires_at, j.cancel_requested FROM global_lease l JOIN jobs j ON j.id=l.job_id WHERE l.name='global' AND j.id=?",
    )
    .bind(jobId)
    .first<{ expires_at: number; cancel_requested: number }>();
}

/** Backoff schedule used by both worker-reported retries and stale recovery: 30s, 60s, 120s ... capped at 15 min. */
export const RETRY_SQL = "?+MIN(?, ?*(1<<(attempts-1)))";

export const SQL_TS = TS;
