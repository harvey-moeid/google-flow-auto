import { useCallback, useEffect, useState } from "react";
import type { FormEvent } from "react";
import { Archive, ChevronRight, Plus } from "lucide-react";
import { api, describeError, post } from "../api";
import type { Page, Project } from "../api";

const RATIOS = ["9:16", "16:9", "1:1"];

export function Projects({ onOpen }: { onOpen: (id: string) => void }) {
  const [items, setItems] = useState<Project[]>([]);
  const [archived, setArchived] = useState(false);
  const [name, setName] = useState("");
  const [ratio, setRatio] = useState("9:16");
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api<Page<Project>>(`/api/projects?status=${archived ? "archived" : "draft"}&limit=100`);
      setItems(res.items);
      setError("");
    } catch (e) {
      setError(describeError(e));
    } finally {
      setLoading(false);
    }
  }, [archived]);

  useEffect(() => {
    void load();
  }, [load]);

  async function create(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      const created = await post<{ id: string }>("/api/projects", { name: name.trim(), aspect_ratio: ratio });
      setName("");
      onOpen(created.id);
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <section className="panel">
        <h2>Project baru</h2>
        <form onSubmit={create}>
          <label htmlFor="project-name">Nama project</label>
          <input
            id="project-name"
            value={name}
            maxLength={120}
            placeholder="Contoh: Iklan kopi 15 detik"
            onChange={(e) => setName(e.target.value)}
          />
          <label htmlFor="project-ratio">Rasio layar</label>
          <select id="project-ratio" value={ratio} onChange={(e) => setRatio(e.target.value)}>
            {RATIOS.map((r) => (
              <option key={r} value={r}>
                {r}
              </option>
            ))}
          </select>
          <button className="primary" disabled={busy || name.trim().length === 0}>
            <Plus /> Buat project
          </button>
        </form>
        <p>Project hanya menyimpan scene. Tidak ada video yang dibuat sampai Anda meninjau dan mengirimnya.</p>
      </section>

      <section className="panel">
        <div className="split">
          <h2>{archived ? "Arsip" : "Project"}</h2>
          <button className="ghost" onClick={() => setArchived((v) => !v)}>
            <Archive size={14} /> {archived ? "Lihat aktif" : "Lihat arsip"}
          </button>
        </div>
        {error ? <div className="notice">{error}</div> : null}
        {loading ? <p>Memuat…</p> : null}
        {!loading && items.length === 0 ? <p>{archived ? "Belum ada project di arsip." : "Belum ada project."}</p> : null}
        <div className="list">
          {items.map((p) => (
            <button key={p.id} className="item" onClick={() => onOpen(p.id)}>
              <span>
                <b>{p.name}</b>
                <small>
                  {p.scene_count ?? 0} scene · {p.aspect_ratio}
                </small>
              </span>
              <ChevronRight size={16} />
            </button>
          ))}
        </div>
      </section>
    </>
  );
}
