import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowLeft, Send } from "lucide-react";
import { ApiError, PROBLEM_LABELS, api, describeError, newKey, post } from "../api";
import type { ProjectDetail, Readiness } from "../api";

export function Review({
  id,
  onBack,
  onSubmitted,
}: {
  id: string;
  onBack: () => void;
  onSubmitted: (jobCount: number) => void;
}) {
  const [project, setProject] = useState<ProjectDetail | null>(null);
  const [readiness, setReadiness] = useState<Readiness | null>(null);
  const [account, setAccount] = useState<string>("");
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  // One key per review: a double tap on "Kirim" replays the same submission instead of queuing twice.
  const key = useRef(newKey());

  const load = useCallback(
    async (accountId: string) => {
      try {
        const query = accountId ? `?account_id=${encodeURIComponent(accountId)}` : "";
        const [detail, ready] = await Promise.all([
          api<ProjectDetail>(`/api/projects/${id}`),
          api<Readiness>(`/api/projects/${id}/readiness${query}`),
        ]);
        setProject(detail);
        setReadiness(ready);
        setError("");
      } catch (e) {
        setError(describeError(e));
      }
    },
    [id],
  );

  useEffect(() => {
    void load("");
  }, [load]);

  function choose(accountId: string) {
    setAccount(accountId);
    setConfirmed(false);
    void load(accountId);
  }

  async function submit() {
    if (!project || !account) return;
    setBusy(true);
    setError("");
    try {
      const res = await post<{ jobs: unknown[] }>(`/api/projects/${id}/submit`, {
        account_id: account,
        engine: "dry-run",
        idempotency_key: key.current,
        expected_scene_count: project.scene_count,
      });
      onSubmitted(res.jobs.length);
    } catch (e) {
      setError(describeError(e));
      if (e instanceof ApiError && e.code === "scenes_changed") {
        // The review is stale: start a new one with fresh data and a fresh key.
        key.current = newKey();
        setConfirmed(false);
        await load(account);
      }
    } finally {
      setBusy(false);
    }
  }

  if (!project || !readiness) {
    return (
      <section className="panel">
        <button className="ghost" onClick={onBack}>
          <ArrowLeft size={14} /> Kembali
        </button>
        <p>{error || "Memuat…"}</p>
      </section>
    );
  }

  const blockers = readiness.problems.filter((p) => !(p.code === "account_required" && !account));
  const canSend = account !== "" && readiness.can_submit && confirmed && !busy;

  return (
    <>
      <section className="panel">
        <button className="ghost" onClick={onBack}>
          <ArrowLeft size={14} /> Ubah scene
        </button>
        <h2>Tinjau sebelum kirim</h2>
        <p>
          <b>{project.name}</b> · {project.aspect_ratio} · {project.scene_count} scene · total {project.total_seconds} detik
        </p>
        <ol className="review-scenes">
          {project.scenes.map((scene) => (
            <li key={scene.id}>
              <span className="prompt">{scene.prompt}</span>
              <small className="muted">{scene.duration_seconds} dtk</small>
            </li>
          ))}
        </ol>
      </section>

      <section className="panel">
        <h2>Pilih akun Google</h2>
        {readiness.ready_accounts.length === 0 ? (
          <div className="notice">
            Belum ada akun berstatus Ready. Login manual dilakukan di browser worker, lalu akun akan muncul di sini.
          </div>
        ) : (
          <div className="accountgrid">
            {readiness.ready_accounts.map((a) => (
              <button key={a.id} className={account === a.id ? "chosen" : ""} onClick={() => choose(a.id)}>
                <b>
                  {String(a.slot).padStart(2, "0")} · {a.label}
                </b>
                <small>Ready</small>
              </button>
            ))}
          </div>
        )}
        <p>Akun dipilih manual untuk seluruh scene. Tidak ada pergantian akun otomatis.</p>
      </section>

      <section className="panel">
        <h2>Mode eksekusi</h2>
        <p>
          <b>Dry-run.</b> Engine live dinonaktifkan dan belum diverifikasi, jadi pengiriman ini hanya menguji antrean
          berurutan dan tidak membuat video di Google Flow.
        </p>
      </section>

      {blockers.length > 0 ? (
        <div className="notice warn">
          {blockers.map((p, i) => (
            <div key={`${p.code}-${i}`}>{PROBLEM_LABELS[p.code] ?? p.code}</div>
          ))}
        </div>
      ) : null}
      {error ? <div className="notice">{error}</div> : null}

      <label className="check">
        <input
          type="checkbox"
          checked={confirmed}
          disabled={account === "" || !readiness.can_submit}
          onChange={(e) => setConfirmed(e.target.checked)}
        />
        <span>
          Saya sudah memeriksa {project.scene_count} scene dan akun yang dipilih. Job dijalankan satu per satu sesuai urutan.
        </span>
      </label>
      <button className="primary" disabled={!canSend} onClick={submit}>
        <Send /> Kirim ke antrean
      </button>
    </>
  );
}
