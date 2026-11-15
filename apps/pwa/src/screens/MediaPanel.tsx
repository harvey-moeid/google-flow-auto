import { useCallback, useEffect, useRef, useState } from "react";
import { Download, Eye, EyeOff, Film, Image as ImageIcon } from "lucide-react";
import { api, describeError, fetchMediaBlob, mediaFileName } from "../api";
import type { JobMedia } from "../api";

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

const previewStyle = { width: "100%", maxHeight: "70vh", marginTop: 8, borderRadius: 8, background: "#000" } as const;

/**
 * Output media of one job. Nothing is fetched until the owner asks: previews and downloads go through the
 * owner session cookie and are held only as in-memory object URLs, which are revoked when hidden or when
 * the screen closes. There is no public link to a file.
 */
export function MediaPanel({ jobId, status }: { jobId: string; status: string }) {
  const [items, setItems] = useState<JobMedia[] | null>(null);
  const [error, setError] = useState("");
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
    };
  }, [jobId]);

  async function getBlob(item: JobMedia): Promise<Blob> {
    const cached = blobs.current.get(item.id);
    if (cached) return cached;
    const blob = await fetchMediaBlob(item.id);
    blobs.current.set(item.id, blob);
    return blob;
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

  // Jobs that are still queued or that produced nothing do not need an empty panel.
  if (items !== null && items.length === 0 && status !== "succeeded" && !error) return null;

  return (
    <section className="panel">
      <h2>Media hasil</h2>
      {items === null && !error ? <p>Memuat media…</p> : null}
      {items !== null && items.length === 0 ? <p>Job ini belum menghasilkan media.</p> : null}
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
              </span>
            </div>
            {preview && item.kind === "video" ? <video src={preview} controls playsInline preload="metadata" style={previewStyle} /> : null}
            {preview && item.kind === "image" ? <img src={preview} alt={label} style={previewStyle} /> : null}
          </div>
        );
      })}
      {error ? <div className="notice">{error}</div> : null}
    </section>
  );
}
