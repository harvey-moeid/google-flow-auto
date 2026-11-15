import { useCallback, useEffect, useState } from "react";
import type { FormEvent } from "react";
import { Activity, Clapperboard, Cloud, Film, LayoutDashboard, LogIn, LogOut, RefreshCw, Smartphone, Video } from "lucide-react";
import { ApiError, api, describeError, login, logout } from "./api";
import type { Account, Job, Page } from "./api";
import { Projects } from "./screens/Projects";
import { ProjectEditor } from "./screens/ProjectEditor";
import { Review } from "./screens/Review";
import { JobScreen, Queue } from "./screens/Jobs";
import { WorkerOperations } from "./screens/WorkerOperations";

type Tab = "Dashboard" | "Accounts" | "Projects" | "Queue";
type View =
  | { t: "tabs" }
  | { t: "project"; id: string }
  | { t: "review"; id: string }
  | { t: "job"; id: string };

const TABS: Array<[Tab, typeof Film]> = [
  ["Dashboard", LayoutDashboard],
  ["Accounts", Activity],
  ["Projects", Film],
  ["Queue", Cloud],
];

function Login({ onDone }: { onDone: () => void }) {
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      await login(password);
      setPassword("");
      onDone();
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="shell">
      <header>
        <div className="brand">
          <Clapperboard />
          <b>FLOW AUTO</b>
        </div>
      </header>
      <main>
        <section className="panel">
          <h2>Masuk</h2>
          <form onSubmit={submit}>
            <label htmlFor="owner-password">Password</label>
            <input
              id="owner-password"
              type="password"
              autoComplete="current-password"
              maxLength={256}
              autoFocus
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
            <button className="primary" disabled={busy || password.length === 0}>
              <LogIn /> Masuk
            </button>
          </form>
          <p>Hanya pemilik yang dapat masuk. Password tidak disimpan di perangkat ini.</p>
          {error ? <div className="notice">{error}</div> : null}
        </section>
      </main>
    </div>
  );
}

export default function App() {
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [selected, setSelected] = useState("acct-01");
  const [notice, setNotice] = useState("Hubungkan API Cloudflare untuk memuat data.");
  const [tab, setTab] = useState<Tab>("Dashboard");
  const [me, setMe] = useState("");
  const [auth, setAuth] = useState<"checking" | "in" | "out">("checking");
  // Screens are a small stack mirrored in the browser history, so the Android Back button works.
  const [stack, setStack] = useState<View[]>([{ t: "tabs" }]);
  const view = stack[stack.length - 1];

  const go = useCallback((next: View) => {
    window.history.pushState({ gfa: true }, "");
    setStack((current) => [...current, next]);
  }, []);
  const back = useCallback(() => window.history.back(), []);
  useEffect(() => {
    const onPop = () => setStack((current) => (current.length > 1 ? current.slice(0, -1) : current));
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  const refresh = useCallback(async () => {
    try {
      const [a, j, m] = await Promise.all([
        api<Page<Account>>("/api/accounts"),
        api<Page<Job>>("/api/jobs?limit=100"),
        api<{ name: string }>("/api/me"),
      ]);
      setAccounts(a.items);
      setJobs(j.items);
      setMe(m.name);
      setAuth("in");
      setNotice("Data berhasil diperbarui.");
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) {
        setAuth("out");
        return;
      }
      setNotice(describeError(e));
      setAuth((current) => (current === "checking" ? "out" : current));
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function doLogout() {
    try {
      await logout();
    } catch {
      // The cookie is cleared by the server; local state is reset either way.
    }
    setAccounts([]);
    setJobs([]);
    setMe("");
    setStack([{ t: "tabs" }]);
    setAuth("out");
  }

  const slots: Account[] = accounts.length
    ? accounts
    : Array.from({ length: 10 }, (_, i) => ({
        id: "acct-" + String(i + 1).padStart(2, "0"),
        slot: i + 1,
        label: "Google Account " + String(i + 1).padStart(2, "0"),
        status: "needs_login",
      }));
  const ready = accounts.filter((a) => a.status === "ready").length;
  const selectedAccount = slots.find((account) => account.id === selected) ?? slots[0];

  if (auth === "checking") {
    return (
      <div className="shell">
        <div className="notice">Memuat…</div>
      </div>
    );
  }
  if (auth === "out") return <Login onDone={refresh} />;

  const openJob = (id: string) => go({ t: "job", id });
  const openProject = (id: string) => go({ t: "project", id });

  let body;
  if (view.t === "project") {
    body = (
      <ProjectEditor
        id={view.id}
        onBack={back}
        onReview={() => go({ t: "review", id: view.id })}
        onOpenJob={openJob}
      />
    );
  } else if (view.t === "review") {
    body = (
      <Review
        id={view.id}
        onBack={back}
        onSubmitted={(count) => {
          setTab("Queue");
          setStack([{ t: "tabs" }]);
          setNotice(`${count} job masuk antrean, dijalankan satu per satu.`);
          void refresh();
        }}
      />
    );
  } else if (view.t === "job") {
    body = <JobScreen id={view.id} onBack={back} onChanged={() => void refresh()} onOpenJob={openJob} />;
  } else {
    body = (
      <>
        <section className="hero">
          <div>
            <small>ANDROID CONTROL CENTER</small>
            <h1>
              Video studio,
              <br />
              <em>from your phone.</em>
            </h1>
            <p>Kelola 10 slot akun Google Flow dengan satu antrean sequential.</p>
          </div>
          <Video size={48} />
        </section>
        <section className="stats">
          <div>
            <small>ACCOUNT SLOTS</small>
            <strong>10</strong>
          </div>
          <div>
            <small>READY</small>
            <strong>{ready}</strong>
          </div>
          <div>
            <small>QUEUE</small>
            <strong>{jobs.filter((j) => j.status === "queued").length}</strong>
          </div>
        </section>
        <nav>
          {TABS.map(([name, Icon]) => (
            <button key={name} className={tab === name ? "active" : ""} onClick={() => setTab(name)}>
              <Icon size={16} />
              {name}
            </button>
          ))}
        </nav>
        {tab === "Accounts" ? <WorkerOperations account={selectedAccount} onChanged={() => void refresh()} /> : null}
        {tab === "Dashboard" || tab === "Accounts" ? (
          <section className="panel">
            <h2>
              Google accounts <small>{ready}/10 ready</small>
            </h2>
            <div className="accountgrid">
              {slots.map((a) => (
                <button key={a.id} className={selected === a.id ? "chosen" : ""} onClick={() => setSelected(a.id)}>
                  <b>
                    {String(a.slot).padStart(2, "0")} · {a.label}
                  </b>
                  <small>
                    {a.email || "Belum dihubungkan"} · {a.status}
                  </small>
                </button>
              ))}
            </div>
            <p>Login dilakukan manual di browser worker tepercaya. PWA tidak meminta password Google.</p>
          </section>
        ) : null}
        {tab === "Dashboard" || tab === "Projects" ? <Projects onOpen={openProject} /> : null}
        {tab === "Dashboard" || tab === "Queue" ? <Queue jobs={jobs} onOpenJob={openJob} /> : null}
      </>
    );
  }

  return (
    <div className="shell">
      <header>
        <div className="brand">
          <Clapperboard />
          <b>FLOW AUTO</b>
        </div>
        <div className="row">
          <button onClick={() => void refresh()} aria-label="Muat ulang">
            <RefreshCw />
          </button>
          <button onClick={doLogout} aria-label="Keluar">
            <LogOut />
          </button>
        </div>
      </header>
      <main>
        {body}
        <div className="notice">{notice}</div>
      </main>
      <footer>
        <Smartphone size={14} /> MOBILE FIRST · SEQUENTIAL MODE{me ? " · " + me : ""}
      </footer>
    </div>
  );
}