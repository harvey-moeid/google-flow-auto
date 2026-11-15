import { useCallback, useEffect, useState } from "react";
import { Activity, HardDrive, RefreshCw, Server, ShieldCheck, Terminal } from "lucide-react";
import { api, describeError } from "../api";
import type { Account, WorkerStatus } from "../api";

function formatBytes(value: number | null): string {
  if (value === null) return "Tidak tersedia";
  if (value < 1024 ** 3) return (value / 1024 ** 2).toFixed(0) + " MB";
  return (value / 1024 ** 3).toFixed(1) + " GB";
}

function formatTime(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "Waktu tidak diketahui" : date.toLocaleString("id-ID", { hour12: false });
}

export function WorkerOperations({ account }: { account: Account }) {
  const [workers, setWorkers] = useState<WorkerStatus[]>([]);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    try {
      const result = await api<{ items: WorkerStatus[] }>("/api/workers");
      setWorkers(result.items);
      setError("");
    } catch (reason) {
      setError(describeError(reason));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => void refresh(), 15_000);
    return () => window.clearInterval(timer);
  }, [refresh]);

  const command = "python -m worker.main --enroll " + account.id;
  const online = workers.filter((worker) => worker.online).length;

  return (
    <>
      <section className="panel">
        <div className="split">
          <h2><Server size={17} /> Worker operations</h2>
          <button className="ghost" onClick={() => void refresh()} disabled={loading} aria-label="Refresh worker status">
            <RefreshCw size={14} /> Refresh
          </button>
        </div>
        <div className="worker-summary">
          <span><Activity size={15} /> {online} online · {workers.length - online} offline</span>
          <small>Heartbeat diperbarui otomatis setiap 15 detik</small>
        </div>
        {loading && workers.length === 0 ? <p>Memuat status worker…</p> : null}
        {!loading && workers.length === 0 && !error ? (
          <div className="notice">Belum ada worker yang mengirim heartbeat. Jalankan worker di host tepercaya untuk mulai memantau statusnya.</div>
        ) : null}
        {workers.map((worker) => (
          <article className="worker-card" key={worker.worker_id}>
            <div className="split">
              <b>{worker.worker_id}</b>
              <span className={worker.online ? "worker-online" : "worker-offline"}>{worker.online ? "ONLINE" : "OFFLINE"}</span>
            </div>
            <div className="worker-meta">
              <span>{worker.state === "busy" ? "Sedang menjalankan job" : worker.state === "stopping" ? "Sedang berhenti" : "Idle"}</span>
              <span>{worker.profile_count}/10 profil terdeteksi</span>
            </div>
            <div className="worker-meta">
              <span><HardDrive size={13} /> {formatBytes(worker.disk_free_bytes)} kosong / {formatBytes(worker.disk_total_bytes)}</span>
              <span className={worker.disk_free_bytes === null ? "" : worker.disk_low ? "worker-warning" : ""}>{worker.disk_free_bytes === null ? "Disk tidak diketahui" : worker.disk_low ? "Disk rendah" : "Disk normal"}</span>
            </div>
            <small className="muted">Heartbeat: {formatTime(worker.last_seen_at)}</small>
          </article>
        ))}
        {error ? <div className="notice warn">{error}</div> : null}
        <p>Status worker bersifat observasional. Worker offline tidak otomatis membatalkan atau mengubah antrean job.</p>
      </section>

      <section className="panel">
        <h2><ShieldCheck size={17} /> Enrollment akun manual</h2>
        <p>
          Akun terpilih: <b>{account.id}</b> · {account.label} · status <b>{account.status}</b>.
          Login Google hanya dilakukan pemilik secara manual pada browser yang berjalan di host worker.
        </p>
        <div className="notice">
          <b>1. Hentikan worker queue terlebih dahulu.</b>
          <p>Pastikan tidak ada job aktif, lalu tekan Ctrl+C pada proses --serve. Tunggu proses berhenti. Jangan membuka satu profil Chromium dari dua proses sekaligus.</p>
        </div>
        <div className="command-block">
          <div><Terminal size={14} /> Jalankan dari folder engine</div>
          <code>{command}</code>
        </div>
        <div className="notice">
          <b>2. Selesaikan login manual.</b>
          <p>Browser akan membuka profil khusus slot ini. Selesaikan login sendiri, lalu konfirmasi "ya" di terminal. Status Ready hanya dilaporkan setelah browser ditutup dan pemilik mengonfirmasi.</p>
        </div>
        <div className="notice">
          <b>3. Jalankan kembali worker queue.</b>
          <code>python -m worker.main --serve</code>
        </div>
        <p>Perintah ini harus dijalankan pada mesin worker, bukan di browser HP. Dashboard tidak menyimpan password Google, cookie, atau profil browser.</p>
      </section>
    </>
  );
}