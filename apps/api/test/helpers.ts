import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createApp } from "../src/index.ts";

export const TEAM = "testteam.cloudflareaccess.com";
export const AUD = "ab".repeat(32);
export const OWNER = "owner@example.com";
export const SERVICE = "0123456789abcdef0123456789abcdef.access";
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

// ---------- JWT / JWKS ----------

export interface Signer {
  kid: string;
  privateKey: CryptoKey;
  publicJwk: JsonWebKey & { kid: string; alg: string; use: string };
}

export async function createSigner(kid: string): Promise<Signer> {
  const pair = (await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;
  const jwk = await crypto.subtle.exportKey("jwk", pair.publicKey);
  return { kid, privateKey: pair.privateKey, publicJwk: { ...jwk, kid, alg: "RS256", use: "sig" } };
}

const b64url = (value: string | Uint8Array) => Buffer.from(value).toString("base64url");

export async function signJwt(
  signer: Signer,
  claims: Record<string, unknown>,
  header: Record<string, unknown> = {},
): Promise<string> {
  const head = b64url(JSON.stringify({ alg: "RS256", kid: signer.kid, typ: "JWT", ...header }));
  const body = b64url(JSON.stringify(claims));
  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    signer.privateKey,
    new TextEncoder().encode(`${head}.${body}`),
  );
  return `${head}.${body}.${b64url(new Uint8Array(signature))}`;
}

// ---------- harness ----------

export interface Harness {
  app: ReturnType<typeof createApp>;
  env: Record<string, unknown>;
  db: TestDb;
  signer: Signer;
  clock: { now: number };
  jwks: { keys: Signer[]; fail: boolean; calls: number };
  limiter: {
    read: string[];
    write: string[];
    worker: string[];
    allowRead: boolean;
    allowWrite: boolean;
    allowWorker: boolean;
    throws: boolean;
  };
  claims: (overrides?: Record<string, unknown>) => Record<string, unknown>;
  token: (overrides?: Record<string, unknown>) => Promise<string>;
  /** Access service token (no email, Client ID in `common_name`). */
  serviceToken: (overrides?: Record<string, unknown>) => Promise<string>;
}

export async function createHarness(envOverrides: Record<string, unknown> = {}): Promise<Harness> {
  const db = createD1();
  const signer = await createSigner("kid-1");
  const clock = { now: Date.parse("2026-11-14T00:00:00Z") };
  const jwks = { keys: [signer], fail: false, calls: 0 };
  const limiter = {
    read: [] as string[],
    write: [] as string[],
    worker: [] as string[],
    allowRead: true,
    allowWrite: true,
    allowWorker: true,
    throws: false,
  };

  const app = createApp({
    now: () => clock.now,
    fetch: async (input: string) => {
      jwks.calls += 1;
      if (jwks.fail || input !== `https://${TEAM}/cdn-cgi/access/certs`) return new Response("nope", { status: 500 });
      return new Response(JSON.stringify({ keys: jwks.keys.map((key) => key.publicJwk) }), { status: 200 });
    },
  });

  const makeLimiter = (bucket: "read" | "write" | "worker") => ({
    async limit({ key }: { key: string }) {
      limiter[bucket].push(key);
      if (limiter.throws) throw new Error("limiter down");
      const allow = bucket === "read" ? limiter.allowRead : bucket === "write" ? limiter.allowWrite : limiter.allowWorker;
      return { success: allow };
    },
  });

  const env = {
    DB: db,
    MEDIA: {},
    APP_ENV: "production",
    CF_ACCESS_TEAM_DOMAIN: TEAM,
    CF_ACCESS_AUD: AUD,
    ALLOWED_EMAILS: OWNER,
    ALLOWED_SERVICE_TOKENS: SERVICE,
    LIVE_ENGINES_ENABLED: "false",
    RL_READ: makeLimiter("read"),
    RL_WRITE: makeLimiter("write"),
    RL_WORKER: makeLimiter("worker"),
    ...envOverrides,
  };

  const base = () => {
    const nowSeconds = Math.floor(clock.now / 1000);
    return { iss: `https://${TEAM}`, aud: [AUD], exp: nowSeconds + 3600, iat: nowSeconds };
  };
  const claims = (overrides: Record<string, unknown> = {}) => ({ ...base(), email: OWNER, ...overrides });
  const serviceClaims = (overrides: Record<string, unknown> = {}) => ({
    ...base(),
    common_name: SERVICE,
    ...overrides,
  });
  return {
    app,
    env,
    db,
    signer,
    clock,
    jwks,
    limiter,
    claims,
    token: async (overrides) => signJwt(signer, claims(overrides)),
    serviceToken: async (overrides) => signJwt(signer, serviceClaims(overrides)),
  };
}

export interface CallOptions {
  method?: string;
  path: string;
  token?: string | null;
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

export async function call(h: Harness, options: CallOptions): Promise<CallResult> {
  const method = options.method ?? "GET";
  const headers = new Headers(options.headers ?? {});
  if (options.token) headers.set("cf-access-jwt-assertion", options.token);
  if (options.origin) headers.set("origin", options.origin);
  let body: string | undefined;
  if (options.rawBody !== undefined) body = options.rawBody;
  else if (options.body !== undefined) body = JSON.stringify(options.body);
  if (body !== undefined && !headers.has("content-type")) headers.set("content-type", "application/json");
  const request = new Request(`${options.base ?? BASE}${options.path}`, { method, headers, body });
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

/** Authenticated call as the owner. */
export async function authed(h: Harness, options: CallOptions): Promise<CallResult> {
  return call(h, { ...options, token: await h.token() });
}

/** Authenticated call as the browser worker (Access service token). */
export async function asWorker(h: Harness, options: CallOptions): Promise<CallResult> {
  return call(h, { method: "POST", ...options, token: await h.serviceToken() });
}

export function makeAccountReady(h: Harness, id = "acct-01") {
  h.db.raw.prepare("UPDATE accounts SET status='ready' WHERE id=?").run(id);
}

export async function createProject(h: Harness, name = "Proyek uji"): Promise<string> {
  const res = await authed(h, { method: "POST", path: "/api/projects", body: { name } });
  if (res.status !== 201) throw new Error(`createProject failed: ${res.status} ${res.text}`);
  return res.json.id as string;
}
