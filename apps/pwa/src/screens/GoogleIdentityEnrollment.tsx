import { useEffect, useRef, useState } from "react";
import { CheckCircle2, ExternalLink, Link2, Loader2, Unlink } from "lucide-react";
import { describeError, post } from "../api";
import type { Account } from "../api";
type Challenge = { challenge_id: string; nonce: string; expires_at: string };
type CredentialResponse = { credential: string };
type GoogleIdApi = {
 initialize(options: { client_id: string; nonce: string; auto_select: boolean; cancel_on_tap_outside: boolean; callback: (r: CredentialResponse) => void }): void;
 renderButton(element: HTMLElement, options: Record<string, unknown>): void;
 cancel(): void;
};
declare global { interface Window { google?: { accounts: { id: GoogleIdApi } } } }
const CLIENT_ID = import.meta.env.VITE_GOOGLE_CLIENT_ID ?? "";
let sdkPromise: Promise<void> | null = null;
function loadSdk(): Promise<void> {
 if (window.google?.accounts.id) return Promise.resolve();
 if (sdkPromise) return sdkPromise;
 sdkPromise = new Promise((resolve, reject) => {
  const script = document.createElement("script"); script.src = "https://accounts.google.com/gsi/client";
  script.async = true; script.defer = true; script.onload = () => resolve();
  script.onerror = () => { sdkPromise = null; reject(new Error("Layanan identitas Google tidak dapat dimuat.")); };
  document.head.appendChild(script);
 });
 return sdkPromise;
}
export function GoogleIdentityEnrollment({ account, onChanged }: { account: Account; onChanged?: () => void }) {
 const button = useRef<HTMLDivElement>(null);
 const [challenge, setChallenge] = useState<Challenge | null>(null);
 const [busy, setBusy] = useState(false);
 const [email, setEmail] = useState<string | null>(account.email ?? null);
 const [verifiedAt, setVerifiedAt] = useState<string | null>(account.google_identity_verified_at ?? null);
 const [error, setError] = useState(""); const [notice, setNotice] = useState("");
 useEffect(() => { setEmail(account.email ?? null); setVerifiedAt(account.google_identity_verified_at ?? null); setChallenge(null); setError(""); setNotice(""); }, [account.id, account.email, account.google_identity_verified_at]);
 useEffect(() => {
  if (!challenge || !button.current || !CLIENT_ID) return;
  let cancelled = false;
  void loadSdk().then(() => {
   if (cancelled || !button.current || !window.google?.accounts.id) return;
   window.google.accounts.id.initialize({ client_id: CLIENT_ID, nonce: challenge.nonce, auto_select: false, cancel_on_tap_outside: true, callback: (response) => void verify(response) });
   window.google.accounts.id.renderButton(button.current, { type: "standard", theme: "filled_blue", size: "large", text: "signin_with", shape: "rectangular", width: Math.min(320, Math.max(220, button.current.clientWidth)) });
  }).catch(reason => setError(describeError(reason)));
  return () => { cancelled = true; };
 }, [challenge]);
 async function verify(response: CredentialResponse) {
  if (!challenge || busy) return; setBusy(true); setError("");
  try {
   const result = await post<{ email: string; verified_at: string }>(`/api/accounts/${account.id}/google-identity/verify`, { challenge_id: challenge.challenge_id, credential: response.credential });
   setEmail(result.email); setVerifiedAt(result.verified_at); setChallenge(null);
   setNotice("Identitas Google terverifikasi. Sesi Google Flow belum terhubung."); window.google?.accounts.id.cancel(); onChanged?.();
  } catch (reason) { setError(describeError(reason)); } finally { setBusy(false); }
 }
 async function start() {
  setBusy(true); setError(""); setNotice("");
  try { setChallenge(await post<Challenge>(`/api/accounts/${account.id}/google-identity/challenge`)); }
  catch (reason) { setError(describeError(reason)); } finally { setBusy(false); }
 }
 async function unlink() {
  if (!window.confirm("Putuskan tautan identitas Google dari slot ini?")) return;
  setBusy(true); setError("");
  try { await post(`/api/accounts/${account.id}/google-identity/unlink`, { confirm: true }); setEmail(null); setVerifiedAt(null); setNotice("Identitas berhasil diputuskan dari slot."); onChanged?.(); }
  catch (reason) { setError(describeError(reason)); } finally { setBusy(false); }
 }
 return <section className="panel">
  <h2>Enrollment identitas Google</h2><p>Slot terpilih: <b>{account.id}</b> · {account.label}</p>
  {!CLIENT_ID ? <div className="notice warn">GIS belum dikonfigurasi. Atur VITE_GOOGLE_CLIENT_ID saat build PWA dan GOOGLE_CLIENT_ID pada Worker.</div> : null}
  {email ? <div className="identity-status"><span><CheckCircle2 size={16}/> Identitas terverifikasi</span><b>{email}</b>{verifiedAt ? <small>{new Date(verifiedAt).toLocaleString("id-ID")}</small> : null}</div> : <div className="notice">Belum ada identitas Google tertaut.</div>}
  <div className="actions"><button className="btn" onClick={() => void start()} disabled={busy || !CLIENT_ID}>{busy ? <Loader2 size={15}/> : <Link2 size={15}/>} {email ? "Tautkan akun lain" : "Hubungkan akun Google"}</button>
   {email ? <button className="ghost danger" onClick={() => void unlink()} disabled={busy}><Unlink size={14}/> Putuskan tautan</button> : null}</div>
  {challenge ? <div className="google-signin"><p>Pilih akun Google. Tantangan berlaku 5 menit.</p><div ref={button}/></div> : null}
  {busy ? <p>Memproses…</p> : null}{notice ? <div className="notice success">{notice}</div> : null}{error ? <div className="notice warn">{error}</div> : null}
  <div className="notice warn">Verifikasi identitas bukan autentikasi Google Flow. Slot tidak menjadi Ready dan job otomatis tetap diblokir.</div>
  <a className="flow-link" href="https://labs.google/fx/tools/flow" target="_blank" rel="noreferrer"><ExternalLink size={14}/> Buka Google Flow manual</a>
 </section>;
}