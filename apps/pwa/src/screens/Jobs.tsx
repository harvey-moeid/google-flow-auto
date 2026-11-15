import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowLeft, ChevronRight, Play, RotateCcw, XCircle } from "lucide-react";
import { FINAL_JOB_STATUSES, STATUS_LABELS, api, describeError, newKey, post } from "../api";
import type { Job, JobDetail } from "../api";

const EVENT_LABELS: Record<string, string> = {
  "job.queued": "Masuk antrean",
  "job.claimed": "Diambil worker",
  "job.started": "Mulai berjalan",
  "job.succeeded": "Selesai",
  "job.worker_failed": "Worker melaporkan kegagalan",
  "job.waiting_for_user": "Menunggu tindakan Anda",
  "job.resumed": "Dilanjutkan",
  "job.recovered": "Dipulihkan setelah worker terhenti",
  "job.cancel_requested": "Pembatalan diminta",
  "job.cancelled": "Dibatalkan",
};

const POLL_MS = 5000;

function formatTime(value: string): string {
  const date = new Date(value.includes("T") ? value : `${value.replace(" ", "T")}Z`);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString("id-ID", { hour12: false });
}

export function StatusChip({ status }: { status: string }) {
  return <span className={`chip status-${status}`}>{STATUS_LABELS[status] ?? status}</span>;
}

export function Queue({ jobs, onOpenJob }: { jobs: Job[]; onOpenJob: (id: string) => void }) {
  return (
    <section className="panel">
      <h2>Antrean job · berurutan</h2>
      {jobs.length === 0 ? <p>Belum ada job.</p> : null}
      <div className="list">
        {jobs.map((job) => (
          <button key={job.id} className="item" onClick={() => onOpenJob(job.id)}>
            <span>
              <b>
                {job.id.slice(0, 8)}
                {job.scene_order ? ` · scene ${job.scene_order}` : ""}
              </b>
              <small>
                Slot {job.account_slot} · {job.account_label} · {job.engine}
              </small>
            </span>
            <span className="row">
              <StatusChip status={job.status} />
              <ChevronRight size={16} />
            </span>
          </button>
        ))}
      </div>
    </section>
  );
}

export function JobScreen({
  id,
  onBack,
  onChanged,
  onOpenJob,
}: {
  id: string;
  onBack: () => void;
  onChanged: () => void;
  onOpenJob: (id: string) => void;
}) {
  const [job, setJob] = useState<JobDetail | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  // One key per job and intention, so a double tap on "Ulangi" never queues two retries.
  const retryKey = useRef({ id, key: newKey() });

  const load = useCallback(async () => {
    try {
      setJob(await api<JobDetail>(`/api/jobs/${id}`));
      setError("");
    } catch (e) {
      setError(describeError(e));
    }
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  const finished = job !== null && FINAL_JOB_STATUSES.includes(job.status);
  useEffect(() => {
    if (!job || finished) return;
    const timer = window.setInterval(() => void load(), POLL_MS);
    return () => window.clearInterval(timer);
  }, [job, finished, load]);

  async function act(path: string, body: unknown = {}): Promise<{ id?: string } | null> {
    setBusy(true);
    setError("");
    try {
      const res = await post<{ id?: string }>(path, body);
      onChanged();
      await load();
      return res;
    } catch (e) {
      setError(describeError(e));
      await load();
      return null;
    } finally {
      setBusy(false);
    }
  }

  async function retry() {
    if (retryKey.current.id !== id) retryKey.current = { id, key: newKey() };
    const res = await act(`/api/jobs/${id}/retry`, { idempotency_key: retryKey.current.key });
    if (res?.id) onOpenJob(res.id);
  }

  if (!job) {
    return (
      <section className="panel">
        <button className="ghost" onClick={onBack}>
          <ArrowLeft size={14} /> Kembali
        </button>
        <p>{error || "Memuat…"}</p>
      </section>
    );
  }

  const canCancel = !finished;
  const canResume = job.status === "waiting_for_user";
  const canRetry = job.status === "failed" || job.status === "cancelled";

  return (
    <>
      <section className="panel">
        <button className="ghost" onClick={onBack}>
          <ArrowLeft size={14} /> Kembali
        </button>
        <div className="split">
          <h2>{job.project_name}</h2>
          <StatusChip status={job.status} />
        </div>
        <dl className="facts">
          <dt>Scene</dt>
          <dd>{job.scene_order ? `Scene ${job.scene_order}` : "Seluruh project"}</dd>
          <dt>Akun</dt>
          <dd>
            Slot {job.account_slot} · {job.account_label}
          </dd>
          <dt>Engine</dt>
          <dd>{job.engine}</dd>
          <dt>Percobaan</dt>
          <dd>
            {job.attempts} dari {job.max_attempts}
          </dd>
          {job.error_code ? (
            <>
              <dt>Kode error</dt>
              <dd>{job.error_code}</dd>
            </>
          ) : null}
          {job.retry_of ? (
            <>
              <dt>Ulangan dari</dt>
              <dd>
                <button className="chip" onClick={() => onOpenJob(job.retry_of!)}>
                  {job.retry_of.slice(0, 8)}
                </button>
              </dd>
            </>
          ) : null}
        </dl>
        {job.scene_prompt ? <p className="prompt">{job.scene_prompt}</p> : null}
        {job.cancel_requested && !finished ? (
          <div className="notice warn">Pembatalan sudah diminta. Worker akan menghentikan job pada denyut berikutnya.</div>
        ) : null}
        {job.status === "waiting_for_user" ? (
          <div className="notice warn">
            Akun perlu login ulang secara manual di browser worker. Setelah akun kembali Ready, tekan Lanjutkan.
          </div>
        ) : null}
        <div className="actions">
          {canResume ? (
            <button className="btn" disabled={busy} onClick={() => void act(`/api/jobs/${id}/resume`)}>
              <Play size={14} /> Lanjutkan
            </button>
          ) : null}
          {canCancel ? (
            <button
              className="ghost danger"
              disabled={busy || job.cancel_requested}
              onClick={() => {
                if (window.confirm("Batalkan job ini?")) void act(`/api/jobs/${id}/cancel`);
              }}
            >
              <XCircle size={14} /> Batalkan
            </button>
          ) : null}
          {canRetry ? (
            <button className="btn" disabled={busy} onClick={() => void retry()}>
              <RotateCcw size={14} /> Ulangi
            </button>
          ) : null}
        </div>
        {error ? <div className="notice">{error}</div> : null}
      </section>

      <section className="panel">
        <h2>Riwayat</h2>
        <ol className="timeline">
          {job.timeline.map((event, index) => (
            <li key={`${event.event}-${index}`}>
              <b>{EVENT_LABELS[event.event] ?? event.event}</b>
              <small>{formatTime(event.at)}</small>
              {typeof event.detail.error_code === "string" ? <small>Kode: {event.detail.error_code}</small> : null}
            </li>
          ))}
        </ol>
        {!finished ? <p>Halaman ini diperbarui otomatis setiap beberapa detik.</p> : null}
      </section>
    </>
  );
}
