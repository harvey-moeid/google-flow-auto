import { useCallback, useEffect, useState } from "react";
import type { FormEvent } from "react";
import { ArrowDown, ArrowLeft, ArrowUp, Archive, ArchiveRestore, Pencil, Plus, Save, Send, Trash2, X } from "lucide-react";
import { ACTIVE_JOB_STATUSES, STATUS_LABELS, api, describeError, patch, post, remove } from "../api";
import type { ProjectDetail, Scene } from "../api";

const RATIOS = ["9:16", "16:9", "1:1"];
const PROMPT_MAX = 2000;

function SceneCard({
  scene,
  index,
  total,
  locked,
  onMove,
  onSave,
  onDelete,
  onOpenJob,
}: {
  scene: Scene;
  index: number;
  total: number;
  locked: boolean;
  onMove: (direction: -1 | 1) => void;
  onSave: (prompt: string, duration: number) => Promise<void>;
  onDelete: () => void;
  onOpenJob: (id: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [prompt, setPrompt] = useState(scene.prompt);
  const [duration, setDuration] = useState(String(scene.duration_seconds));
  const [busy, setBusy] = useState(false);

  async function save() {
    setBusy(true);
    try {
      await onSave(prompt, Number(duration));
      setEditing(false);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="scene">
      <div className="split">
        <b>Scene {index + 1}</b>
        <span className="muted">{scene.duration_seconds} dtk</span>
      </div>
      {editing ? (
        <>
          <label htmlFor={`prompt-${scene.id}`}>Prompt</label>
          <textarea
            id={`prompt-${scene.id}`}
            value={prompt}
            maxLength={PROMPT_MAX}
            rows={5}
            onChange={(e) => setPrompt(e.target.value)}
          />
          <small className="muted">
            {prompt.length}/{PROMPT_MAX}
          </small>
          <label htmlFor={`dur-${scene.id}`}>Durasi (detik)</label>
          <input
            id={`dur-${scene.id}`}
            type="number"
            min={1}
            max={60}
            value={duration}
            onChange={(e) => setDuration(e.target.value)}
          />
          <div className="actions">
            <button className="btn" disabled={busy || prompt.trim().length === 0} onClick={save}>
              <Save size={14} /> Simpan
            </button>
            <button
              className="ghost"
              onClick={() => {
                setPrompt(scene.prompt);
                setDuration(String(scene.duration_seconds));
                setEditing(false);
              }}
            >
              <X size={14} /> Batal
            </button>
          </div>
        </>
      ) : (
        <p className="prompt">{scene.prompt}</p>
      )}
      {scene.last_job ? (
        <button className="chip" onClick={() => onOpenJob(scene.last_job!.id)}>
          Job terakhir: {STATUS_LABELS[scene.last_job.status] ?? scene.last_job.status}
        </button>
      ) : null}
      {locked ? <small className="muted">Terkunci selama job antre atau berjalan.</small> : null}
      {!editing ? (
        <div className="actions">
          <button className="ghost" aria-label="Naikkan" disabled={index === 0} onClick={() => onMove(-1)}>
            <ArrowUp size={14} />
          </button>
          <button className="ghost" aria-label="Turunkan" disabled={index === total - 1} onClick={() => onMove(1)}>
            <ArrowDown size={14} />
          </button>
          <button className="ghost" disabled={locked} onClick={() => setEditing(true)}>
            <Pencil size={14} /> Ubah
          </button>
          <button className="ghost danger" disabled={locked} onClick={onDelete}>
            <Trash2 size={14} /> Hapus
          </button>
        </div>
      ) : null}
    </div>
  );
}

export function ProjectEditor({
  id,
  onBack,
  onReview,
  onOpenJob,
}: {
  id: string;
  onBack: () => void;
  onReview: () => void;
  onOpenJob: (id: string) => void;
}) {
  const [project, setProject] = useState<ProjectDetail | null>(null);
  const [name, setName] = useState("");
  const [prompt, setPrompt] = useState("");
  const [duration, setDuration] = useState("8");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");

  const load = useCallback(async () => {
    try {
      const detail = await api<ProjectDetail>(`/api/projects/${id}`);
      setProject(detail);
      setName(detail.name);
    } catch (e) {
      setNotice(describeError(e));
    }
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  /** Runs one mutation, then reloads so the screen always shows what the server stored. */
  async function run(action: () => Promise<unknown>, done = "") {
    setNotice("");
    try {
      await action();
      if (done) setNotice(done);
    } catch (e) {
      setNotice(describeError(e));
    }
    await load();
  }

  async function addScene(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    await run(async () => {
      await post(`/api/projects/${id}/scenes`, { prompt: prompt.trim(), duration_seconds: Number(duration) });
      setPrompt("");
    });
    setBusy(false);
  }

  if (!project) {
    return (
      <section className="panel">
        <button className="ghost" onClick={onBack}>
          <ArrowLeft size={14} /> Kembali
        </button>
        <p>{notice || "Memuat…"}</p>
      </section>
    );
  }

  const archived = project.status === "archived";
  const scenes = project.scenes;
  const locked = (scene: Scene) => scene.last_job !== null && ACTIVE_JOB_STATUSES.includes(scene.last_job.status);
  const anyActive = scenes.some(locked);

  function move(index: number, direction: -1 | 1) {
    const ids = scenes.map((s) => s.id);
    const target = index + direction;
    [ids[index], ids[target]] = [ids[target], ids[index]];
    void run(() => post(`/api/projects/${id}/scenes/reorder`, { scene_ids: ids }));
  }

  return (
    <>
      <section className="panel">
        <div className="split">
          <button className="ghost" onClick={onBack}>
            <ArrowLeft size={14} /> Project
          </button>
          <button
            className="ghost"
            disabled={anyActive && !archived}
            onClick={() => run(() => patch(`/api/projects/${id}`, { status: archived ? "draft" : "archived" }))}
          >
            {archived ? <ArchiveRestore size={14} /> : <Archive size={14} />} {archived ? "Pulihkan" : "Arsipkan"}
          </button>
        </div>
        <label htmlFor="edit-name">Nama project</label>
        <input id="edit-name" value={name} maxLength={120} disabled={archived} onChange={(e) => setName(e.target.value)} />
        <div className="actions">
          <button
            className="btn"
            disabled={archived || name.trim().length === 0 || name.trim() === project.name}
            onClick={() => run(() => patch(`/api/projects/${id}`, { name: name.trim() }), "Nama disimpan.")}
          >
            <Save size={14} /> Simpan nama
          </button>
        </div>
        <label htmlFor="edit-ratio">Rasio layar</label>
        <select
          id="edit-ratio"
          value={project.aspect_ratio}
          disabled={archived || anyActive}
          onChange={(e) => run(() => patch(`/api/projects/${id}`, { aspect_ratio: e.target.value }), "Rasio disimpan.")}
        >
          {RATIOS.map((r) => (
            <option key={r} value={r}>
              {r}
            </option>
          ))}
        </select>
        <p>
          {project.scene_count} scene · total {project.total_seconds} detik{archived ? " · diarsipkan" : ""}
        </p>
      </section>

      {scenes.length === 0 ? <div className="notice">Belum ada scene. Tambahkan scene pertama di bawah.</div> : null}
      {scenes.map((scene, index) => (
        <SceneCard
          key={scene.id}
          scene={scene}
          index={index}
          total={scenes.length}
          locked={archived || locked(scene)}
          onMove={(direction) => move(index, direction)}
          onSave={async (nextPrompt, nextDuration) => {
            setNotice("");
            try {
              await patch(`/api/scenes/${scene.id}`, { prompt: nextPrompt.trim(), duration_seconds: nextDuration });
              await load();
            } catch (e) {
              setNotice(describeError(e));
              throw e;
            }
          }}
          onDelete={() => {
            if (window.confirm(`Hapus scene ${index + 1}? Riwayat job-nya tetap tersimpan.`)) {
              void run(() => remove(`/api/scenes/${scene.id}`));
            }
          }}
          onOpenJob={onOpenJob}
        />
      ))}

      {!archived ? (
        <section className="panel">
          <h2>Tambah scene</h2>
          <form onSubmit={addScene}>
            <label htmlFor="new-prompt">Prompt</label>
            <textarea
              id="new-prompt"
              rows={5}
              maxLength={PROMPT_MAX}
              value={prompt}
              placeholder="Jelaskan adegan yang ingin dibuat"
              onChange={(e) => setPrompt(e.target.value)}
            />
            <small className="muted">
              {prompt.length}/{PROMPT_MAX}
            </small>
            <label htmlFor="new-duration">Durasi (detik)</label>
            <input
              id="new-duration"
              type="number"
              min={1}
              max={60}
              value={duration}
              onChange={(e) => setDuration(e.target.value)}
            />
            <button className="primary" disabled={busy || prompt.trim().length === 0}>
              <Plus /> Tambah scene
            </button>
          </form>
        </section>
      ) : null}

      {notice ? <div className="notice">{notice}</div> : null}

      {!archived ? (
        <button className="primary" disabled={scenes.length === 0} onClick={onReview}>
          <Send /> Tinjau dan kirim
        </button>
      ) : null}
    </>
  );
}
