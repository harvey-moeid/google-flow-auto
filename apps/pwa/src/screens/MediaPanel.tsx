import { useCallback, useEffect, useRef, useState } from "react";
import { Download, Eye, EyeOff, Film, Image as ImageIcon, Trash2 } from "lucide-react";
import { ApiError, api, describeError, fetchMediaBlob, mediaFileName, remove } from "../api";
import type { JobMedia, MediaDeleteResult } from "../api";

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

const previewStyle = { width: "100%", maxHeight: "70vh", marginTop: 8, borderRadius: 8, background: "#000" } as const;

/** The API refuses to delete media while a worker owns the job; the button is hidden then instead of failing. */
const WORKER_OWNED_STATUSES = ["claimed", "running"];

/**
 * Output media of one job. Nothing is fetched until the owner asks: previews and downloads go through
 * the owner session cookie and are held only as in-memory object URLs, which are revoked when hidden or
 * when the screen closes. There is no public link to a file.
 *
 * Deleting is permanent and always asks for confirmation first. The list is only updated after the
 * server confirms, so the screen never shows a file as gone that the server still has.
 */
export function MediaPanel({ jobId, status }: { jobId: string; status: string }) {
  const [items, setItems] = useState<JobMedia[] | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [deletedAny, setDeletedAny] = useState(false);
  const [previews, setPreviews] = useState<Record<string, string>>({});
  const [busyId, setBusyId] = useState<string | null>(null);
  const blobs = useRef(new Map<string, Blob>());
  const urls = useRef(new Map<string, string>());

  const load = useCallback(async () => {
    try {
      const page = await api<{ items: JobMedia[] }>(`/api/jobs/${jobId}/media`);
      setItems(page.items);
      setError("");
    } catch (e) {
      setError(describeError(e));
    }
  }, [jobId]);

  // Reload when the job moves to another status (media is published while it runs, before it finishes).
  useEffect(() => {
    void load();
  }, [load, status]);

  // Leaving the job (or the screen) releases every object URL and cached blob.
  useEffect(() => {
    const currentUrls = urls.current;
    const currentBlobs = blobs.current;
    return () => {
      currentUrls.forEach((url) => URL.revokeObjectURL(url));
      currentUrls.clear();
      currentBlobs.clear();
      setPreviews({});
      setItems(null);
      setNotice("");
      setDeletedAny(false);
    };
  }, [jobId]);

  async function getBlob(item: JobMedia): Promise<Blob> {
    const cached = blobs.current.get(item.id);
    if (cached) return cached;
    const blob = await fetchMediaBlob(item.id);
    blobs.current.set(item.id, blob);
    return blob;
  }

  /** Drops the preview URL and cached bytes of one item. */
  function release(id: string) {
    const url = urls.current.get(id);
    if (url) {
      URL.revokeObjectURL(url);
      urls.current.delete(id);
    }
    blobs.current.delete(id);
    setPreviews((current) => {
      if (!(id in current)) return current;
      const next = { ...current };
      delete next[id];
      return next;
    });
  }

  async function togglePreview(item: JobMedia) {
    const existing = urls.current.get(item.id);
    if (existing) {
      URL.revokeObjectURL(existing);
      urls.current.delete(item.id);
      setPreviews((current) => {
        const next = { ...current };
        delete next[item.id];
        return next;
      });
      return;
    }
    setBusyId(item.id);
    setError("");
    try {
      const url = URL.createObjectURL(await getBlob(item));
      urls.current.set(item.id, url);
      setPreviews((current) => ({ ...current, [item.id]: url }));
    } catch (e) {
      setError(describeError(e));
    } finally {
      setBusyId(null);
    }
  }

  async function download(item: JobMedia) {
    setBusyId(item.id);
    setError("");
    try {
      const url = URL.createObjectURL(await getBlob(item));
      const link = document.createElement("a");
      link.href = url;
      link.download = mediaFileName(item);
      document.body.appendChild(link);
      link.click();
      link.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 10000);
    } catch (e) {
      setError(describeError(e));
    } finally {
      setBusyId(null);
    }
  }

  async function deleteItem(item: JobMedia, label: string) {
    if (!window.confirm(`Hapus ${label} secara permanen? File tidak bisa dipulihkan.`)) return;
    setBusyId(item.id);
    setError("");
    setNotice("");
    try {
      const result = await remove<MediaDeleteResult>(`/api/media/${item.id}`);
      release(item.id);
      setItems((current) => (current === null ? current : current.filter((entry) => entry.id !== item.id)));
      setDeletedAny(true);
      if (!result.object_deleted) {
        setNotice(
          `${label} sudah dihapus dari daftar, tetapi file di penyimpanan belum bisa dihapus saat ini. ` +
            "File itu tidak bisa diakses lagi dan akan dibersihkan nanti.",
        );
      }
    } catch (e) {
      if (e instanceof ApiError && e.code === "media_not_found") {
        // Already deleted elsewhere: show what the server has now instead of an error.
        release(item.id);
        await load();
      } else {
        setError(describeError(e));
      }
    } finally {
      setBusyId(null);
    }
  }

  // Jobs that are still queued or that produced nothing do not need an empty panel.
  if (items !== null && items.length === 0 && status !== "succeeded" && !error && !notice && !deletedAny) return null;

  const canDelete = !WORKER_OWNED_STATUSES.includes(status);

  return (
    <section className="panel">
      <h2>Media hasil</h2>
      {items === null && !error ? <p>Memuat media…</p> : null}
      {items !== null && items.length === 0 ? (
        <p>{deletedAny ? "Semua media job ini sudah dihapus." : "Job ini belum menghasilkan media."}</p>
      ) : null}
      {items?.map((item, index) => {
        const preview = previews[item.id];
        const busy = busyId === item.id;
        const label = `${item.kind === "video" ? "Video" : "Gambar"} ${index + 1}`;
        return (
          <div key={item.id} style={{ marginBottom: 16 }}>
            <div className="split">
              <span>
                <b>
                  {item.kind === "video" ? <Film size={14} /> : <ImageIcon size={14} />} {label}
                </b>
                <small>
                  {item.mime} · {formatBytes(item.size_bytes)}
                  {item.width && item.height ? ` · ${item.width}×${item.height}` : ""}
                  {item.duration_ms ? ` · ${(item.duration_ms / 1000).toFixed(1)} dtk` : ""}
                </small>
              </span>
              <span className="row">
                <button
                  className="ghost"
                  disabled={busy}
                  aria-label={`${preview ? "Sembunyikan" : "Pratinjau"} ${label}`}
                  onClick={() => void togglePreview(item)}
                >
                  {preview ? <EyeOff size={14} /> : <Eye size={14} />} {preview ? "Sembunyikan" : "Pratinjau"}
                </button>
                <button className="btn" disabled={busy} aria-label={`Unduh ${label}`} onClick={() => void download(item)}>
                  <Download size={14} /> Unduh
                </button>
                {canDelete ? (
                  <button
                    className="ghost danger"
                    disabled={busy}
                    aria-label={`Hapus ${label}`}
                    onClick={() => void deleteItem(item, label)}
                  >
                    <Trash2 size={14} /> Hapus
                  </button>
                ) : null}
              </span>
            </div>
            {preview && item.kind === "video" ? <video src={preview} controls playsInline preload="metadata" style={previewStyle} /> : null}
            {preview && item.kind === "image" ? <img src={preview} alt={label} style={previewStyle} /> : null}
          </div>
        );
      })}
      {!canDelete && items !== null && items.length > 0 ? (
        <small className="muted">Media tidak bisa dihapus selama worker masih memproses job ini.</small>
      ) : null}
      {notice ? <div className="notice">{notice}</div> : null}
      {error ? <div className="notice">{error}</div> : null}
    </section>
  );
}