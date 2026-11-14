import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { SESSION_COOKIE, createSessionToken } from "../src/auth.ts";
import { createApp } from "../src/index.ts";

export const OWNER_PASSWORD = "correct-horse-battery-staple";
export const SESSION_SECRET = "test-session-secret-0123456789abcdef-0123456789";
export const WORKER_TOKEN = "test-worker-token-0123456789abcdef0123456789abcdef";
export const BASE = "https://api.example.test";
const MIGRATIONS_DIR = fileURLToPath(new URL("../../../cloudflare/migrations/", import.meta.url));

/** Applies the real versioned migrations in order, exactly like `wrangler d1 migrations apply`. */
export function applyMigrations(db: DatabaseSync): string[] {
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((name) => /^\d{4}_.+\.sql$/.test(name))
    .sort();
  for (const name of files) db.exec(readFileSync(`${MIGRATIONS_DIR}${name}`, "utf8"));
  return files;
}

/** A D1-shaped wrapper over an in-memory SQLite with the real migrations applied. */
export function createD1() {
  const db = new DatabaseSync(":memory:");
  applyMigrations(db);
  const statement = (sql: string, args: unknown[] = []) => ({
    bind: (...next: unknown[]) => statement(sql, next),
    async run() {
      const result = db.prepare(sql).run(...(args as never[]));
      return { success: true, meta: { changes: Number(result.changes) } };
    },
    async first() {
      return db.prepare(sql).get(...(args as never[])) ?? null;
    },
    async all() {
      return { success: true, results: db.prepare(sql).all(...(args as never[])) };
    },
  });
  // D1 runs batches one at a time, each as a single transaction. A single in-memory connection
  // would interleave concurrent batches at `await` points, so they are serialised here.
  let queue: Promise<unknown> = Promise.resolve();
  const runBatch = async (statements: Array<{ run: () => Promise<unknown> }>) => {
    db.exec("BEGIN");
    try {
      const out = [];
      for (const item of statements) out.push(await item.run());
      db.exec("COMMIT");
      return out;
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  };
  return {
    raw: db,
    prepare: (sql: string) => statement(sql),
    batch(statements: Array<{ run: () => Promise<unknown> }>) {
      const result = queue.then(() => runBatch(statements));
      queue = result.catch(() => undefined);
      return result;
    },
  };
}

export type TestDb = ReturnType<typeof createD1>;

export function count(db: TestDb, table: string): number {
  return Number((db.raw.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get() as { c: number }).c);
}

// ---------- harness ----------

type Bucket = "read" | "write" | "worker" | "login";

export interface Harness {
  app: ReturnType<typeof createApp>;
  env: Record<string, unknown>;
  db: TestDb;
  clock: { now: number };
  limiter: {
    read: string[];
    write: string[];
    worker: string[];
    login: string[];
    allowRead: boolean;
    allowWrite: boolean;
    allowWorker: boolean;
    allowLogin: boolean;
    throws: boolean;
  };
  /** A valid owner session token for the harness clock (or a custom issue time / lifetime). */
  session: (options?: { nowMs?: number; ttlSeconds?: number; secret?: string }) => Promise<string>;
}

export async function createHarness(envOverrides: Record<string, unknown> = {}): Promise<Harness> {
  const db = createD1();
  const clock = { now: Date.parse("2026-11-14T00:00:00Z") };
  const limiter = {
    read: [] as string[],
    write: [] as string[],
    worker: [] as string[],
    login: [] as string[],
    allowRead: true,
    allowWrite: true,
    allowWorker: true,
    allowLogin: true,
    throws: false,
  };

  const app = createApp({ now: () => clock.now });

  const allowFlag = {
    read: "allowRead",
    write: "allowWrite",
    worker: "allowWorker",
    login: "allowLogin",
  } as const;
  const makeLimiter = (bucket: Bucket) => ({
    async limit({ key }: { key: string }) {
      limiter[bucket].push(key);
      if (limiter.throws) throw new Error("limiter down");
      return { success: limiter[allowFlag[bucket]] };
    },
  });

  const env = {
    DB: db,
    MEDIA: {},
    APP_ENV: "production",
    OWNER_PASSWORD,
    SESSION_SECRET,
    WORKER_TOKEN,
    LIVE_ENGINES_ENABLED: "false",
    RL_READ: makeLimiter("read"),
    RL_WRITE: makeLimiter("write"),
    RL_WORKER: makeLimiter("worker"),
    RL_LOGIN: makeLimiter("login"),
    ...envOverrides,
  };

  return {
    app,
    env,
    db,
    clock,
    limiter,
    session: async (options = {}) =>
      (await createSessionToken(options.secret ?? SESSION_SECRET, options.nowMs ?? clock.now, options.ttlSeconds)).token,
  };
}

export interface CallOptions {
  method?: string;
  path: string;
  /** Raw session token placed in the `__Host-gfa_session` cookie. */
  session?: string | null;
  /** Value after "Bearer " in the Authorization header. */
  bearer?: string | null;
  body?: unknown;
  rawBody?: string;
  headers?: Record<string, string>;
  origin?: string | null;
  base?: string;
}

export interface CallResult {
  status: number;
  headers: Headers;
  json: any;
  text: string;
}

export function buildRequest(options: CallOptions, body?: BodyInit | null): Request {
  const headers = new Headers(options.headers ?? {});
  if (options.session) headers.set("cookie", `${SESSION_COOKIE}=${options.session}`);
  if (options.bearer) headers.set("authorization", `Bearer ${options.bearer}`);
  if (options.origin) headers.set("origin", options.origin);
  const init: RequestInit & { duplex?: "half" } = { method: options.method ?? "GET", headers };
  if (body !== undefined && body !== null) {
    if (!headers.has("content-type")) headers.set("content-type", "application/json");
    init.body = body;
    if (typeof body !== "string") init.duplex = "half";
  }
  return new Request(`${options.base ?? BASE}${options.path}`, init);
}

export async function send(h: Harness, request: Request): Promise<CallResult> {
  const response = await h.app.fetch(request, h.env as never);
  const text = await response.text();
  let json: any = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  return { status: response.status, headers: response.headers, json, text };
}

export async function call(h: Harness, options: CallOptions): Promise<CallResult> {
  let body: string | undefined;
  if (options.rawBody !== undefined) body = options.rawBody;
  else if (options.body !== undefined) body = JSON.stringify(options.body);
  return send(h, buildRequest(options, body));
}

/** Authenticated call as the owner (valid session cookie). */
export async function authed(h: Harness, options: CallOptions): Promise<CallResult> {
  return call(h, { ...options, session: await h.session() });
}

/** Authenticated call as the browser worker (bearer WORKER_TOKEN). */
export async function asWorker(h: Harness, options: CallOptions): Promise<CallResult> {
  return call(h, { method: "POST", ...options, bearer: WORKER_TOKEN });
}

export function makeAccountReady(h: Harness, id = "acct-01") {
  h.db.raw.prepare("UPDATE accounts SET status='ready' WHERE id=?").run(id);
}

export async function createProject(h: Harness, name = "Proyek uji"): Promise<string> {
  const res = await authed(h, { method: "POST", path: "/api/projects", body: { name } });
  if (res.status !== 201) throw new Error(`createProject failed: ${res.status} ${res.text}`);
  return res.json.id as string;
}
