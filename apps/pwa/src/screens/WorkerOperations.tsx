import { useCallback, useEffect, useState } from "react";
import { Activity, HardDrive, RefreshCw, Server } from "lucide-react";
import { api, describeError } from "../api";
import type { Account, WorkerStatus } from "../api";
import { GoogleIdentityEnrollment } from "./GoogleIdentityEnrollment";
function formatBytes(value: number | null): string {
 if (value === null) return "Tidak tersedia";
 if (value < 1024 ** 3) return (value / 1024 ** 2).toFixed(0) + " MB";
 return (value / 1024 ** 3).toFixed(1) + " GB";
}
function formatTime(value: string): string {
 const date = new Date(value); return Number.isNaN(date.getTime()) ? "Waktu tidak diketahui" : date.toLocaleString("id-ID", { hour12: false });
}
export function WorkerOperations({ account }: { account: Account }) {
 const [workers,setWorkers] = useState<WorkerStatus[]>([]); const [error,setError] = useState(""); const [loading,setLoading] = useState(true);
 const refresh = useCallback(async () => {
  try { const result = await api<{items:WorkerStatus[]}>("/api/workers"); setWorkers(result.items); setError(""); }
  catch (reason) { setError(describeError(reason)); } finally { setLoading(false); }
 }, []);
 useEffect(() => { void refresh(); const timer = window.setInterval(() => void refresh(),15000); return () => window.clearInterval(timer); },[refresh]);
 const online = workers.filter(w => w.online).length;
 return <>
  <section className="panel">
   <div className="split"><h2><Server size={17}/> Worker operations</h2><button className="ghost" onClick={() => void refresh()} disabled={loading}><RefreshCw size={14}/> Refresh</button></div>
   <div className="worker-summary"><span><Activity size={15}/> {online} online · {workers.length-online} offline</span><small>Heartbeat otomatis setiap 15 detik</small></div>
   {loading && !workers.length ? <p>Memuat status worker…</p> : null}
   {!loading && !workers.length && !error ? <div className="notice">Tidak ada worker persisten. Tanpa VPS, GitHub Actions hanya untuk CI/CD dan pengujian.</div> : null}
   {workers.map(w => <article className="worker-card" key={w.worker_id}><div className="split"><b>{w.worker_id}</b><span className={w.online?"worker-online":"worker-offline"}>{w.online?"ONLINE":"OFFLINE"}</span></div>
    <div className="worker-meta"><span>{w.state==="busy"?"Sedang menjalankan job":w.state==="stopping"?"Sedang berhenti":"Idle"}</span><span>{w.profile_count}/10 profil terdeteksi</span></div>
    <div className="worker-meta"><span><HardDrive size={13}/> {formatBytes(w.disk_free_bytes)} kosong / {formatBytes(w.disk_total_bytes)}</span><span className={w.disk_low?"worker-warning":""}>{w.disk_free_bytes===null?"Disk tidak diketahui":w.disk_low?"Disk rendah":"Disk normal"}</span></div><small className="muted">Heartbeat: {formatTime(w.last_seen_at)}</small></article>)}
   {error ? <div className="notice warn">{error}</div> : null}<p>Worker status hanya observasional.</p>
  </section>
  <GoogleIdentityEnrollment account={account}/>
 </>;
}
