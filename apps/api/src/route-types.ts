import type { AppConfig } from "./config.ts";
import type { Env, Identity } from "./types.ts";

export interface Ctx {
  req: Request;
  env: Env;
  cfg: AppConfig;
  url: URL;
  identity: Identity;
  requestId: string;
  /** Capture groups from the route pattern. */
  params: string[];
  /** Injectable clock (epoch ms); the lease logic must never read Date.now() directly. */
  now: () => number;
}

export interface Route {
  method: "GET" | "POST" | "PATCH";
  pattern: RegExp;
  /** Mutating routes get Origin enforcement and the stricter write rate limit. */
  write: boolean;
  /** owner = human with a password session; worker = bearer WORKER_TOKEN. Never both. */
  audience: "owner" | "worker";
  handler: (ctx: Ctx) => Promise<Response>;
}

/** Stable audit label for the caller. */
export function actorOf(identity: Identity): string {
  return identity.kind === "owner" ? identity.name : "worker";
}

export function auditStatement(
  ctx: Ctx,
  eventType: string,
  refs: { account_id?: string; job_id?: string },
  detail: Record<string, unknown>,
): D1PreparedStatement {
  return ctx.env.DB.prepare(
    "INSERT INTO audit_events(id,account_id,job_id,event_type,detail_json) VALUES(?,?,?,?,?)",
  ).bind(
    crypto.randomUUID(),
    refs.account_id ?? null,
    refs.job_id ?? null,
    eventType,
    JSON.stringify({ actor: actorOf(ctx.identity), request_id: ctx.requestId, ...detail }),
  );
}

/**
 * Audit row that is only written if the immediately preceding statement in the same D1 batch
 * changed a row (SQLite `changes()`), so the log can never claim a transition that did not happen
 * and the mutation + its audit row commit or roll back together.
 */
export function auditIfChanged(
  ctx: Ctx,
  eventType: string,
  jobId: string,
  detail: Record<string, unknown>,
): D1PreparedStatement {
  return ctx.env.DB.prepare(
    "INSERT INTO audit_events(id,account_id,job_id,event_type,detail_json) SELECT ?,account_id,id,?,? FROM jobs WHERE id=? AND changes()>0",
  ).bind(
    crypto.randomUUID(),
    eventType,
    JSON.stringify({ actor: actorOf(ctx.identity), request_id: ctx.requestId, ...detail }),
    jobId,
  );
}
