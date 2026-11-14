import {
  SESSION_COOKIE,
  SESSION_TTL_S,
  clearSessionCookie,
  createSessionToken,
  readCookie,
  secretsEqual,
  sessionCookie,
  verifySessionToken,
} from "./auth.ts";
import { loadConfig } from "./config.ts";
import type { AppConfig } from "./config.ts";
import {
  HttpError,
  corsHeaders,
  enforceOrigin,
  errorResponse,
  finalize,
  isOriginAllowed,
  jsonResponse,
  readJsonObject,
} from "./http.ts";
import { recoverStale } from "./queue.ts";
import { routes } from "./routes.ts";
import type { Ctx, Route } from "./route-types.ts";
import type { Deps, Env, Identity, RateLimiter } from "./types.ts";

const ALLOWED_METHODS = "GET, POST, PATCH, OPTIONS";
const RATE_LIMIT_RETRY_AFTER_S = "60";
const MAX_LOGIN_BODY_BYTES = 1024;
const MAX_PASSWORD_LENGTH = 256;

/**
 * Request pipeline (order matters):
 *  1. /health (public, no secrets)  2. config validation (fail closed)
 *  3. CORS preflight  4. /api/login and /api/logout (public, origin checked, login rate limited)
 *  5. identity (session cookie for the owner, bearer token for the worker)
 *  6. route audience (owner routes <-> owner only, worker routes <-> worker token only)
 *  7. Origin check for writes  8. rate limit  9. route + validation + audit
 */
export function createApp(overrides: Partial<Deps> = {}) {
  const deps: Deps = {
    now: overrides.now ?? (() => Date.now()),
  };

  function unauthorized(requestId: string, reason: string): HttpError {
    console.warn(JSON.stringify({ level: "warn", event: "auth.rejected", reason, request_id: requestId }));
    return new HttpError(401, "unauthorized", "Authentication required");
  }

  async function authenticate(req: Request, cfg: AppConfig, requestId: string): Promise<Identity> {
    const authorization = req.headers.get("authorization");
    if (authorization !== null) {
      // Only the worker uses a bearer token; any other bearer value is rejected outright.
      const match = /^Bearer (\S{1,512})$/.exec(authorization);
      if (match && cfg.workerToken !== null && (await secretsEqual(match[1], cfg.workerToken))) {
        return { kind: "service", source: "worker-token" };
      }
      throw unauthorized(requestId, "bad_bearer");
    }
    const cookie = readCookie(req.headers.get("cookie"), SESSION_COOKIE);
    if (cookie === null) throw new HttpError(401, "unauthorized", "Authentication required");
    const result = await verifySessionToken(cfg.sessionSecret, cookie, deps.now());
    if (!result.ok) throw unauthorized(requestId, result.reason);
    return { kind: "owner", name: "owner", source: "password" };
  }

  async function applyLimit(limiter: RateLimiter | undefined, key: string, requestId: string): Promise<void> {
    if (!limiter) return; // only possible in development; production config requires the bindings
    let allowed = true;
    try {
      allowed = (await limiter.limit({ key })).success;
    } catch (error) {
      // The limiter is approximate by design; a limiter fault must not take the API down.
      console.error(JSON.stringify({ level: "error", event: "ratelimit.error", request_id: requestId, message: String(error) }));
    }
    if (!allowed) {
      throw new HttpError(429, "rate_limited", "Too many requests", undefined, {
        "retry-after": RATE_LIMIT_RETRY_AFTER_S,
      });
    }
  }

  async function enforceRateLimit(env: Env, identity: Identity, route: Route, requestId: string): Promise<void> {
    const limiter = route.audience === "worker" ? env.RL_WORKER : route.write ? env.RL_WRITE : env.RL_READ;
    const key = identity.kind === "service" ? "s:worker" : `${route.write ? "w" : "r"}:${identity.name}`;
    await applyLimit(limiter, key, requestId);
  }

  async function login(req: Request, env: Env, cfg: AppConfig, url: URL, requestId: string): Promise<Response> {
    enforceOrigin(req, url, cfg);
    // Throttle before any password work so guessing is slow per client address.
    await applyLimit(env.RL_LOGIN, `l:${req.headers.get("cf-connecting-ip") ?? "unknown"}`, requestId);

    const body = await readJsonObject(req, MAX_LOGIN_BODY_BYTES);
    const password = body.password;
    if (
      Object.keys(body).length !== 1 ||
      typeof password !== "string" ||
      password.length < 1 ||
      password.length > MAX_PASSWORD_LENGTH
    ) {
      throw new HttpError(400, "validation_failed", "Request validation failed", {
        issues: [{ field: "password", code: "invalid_value" }],
      });
    }
    if (!(await secretsEqual(password, cfg.ownerPassword))) {
      console.warn(JSON.stringify({ level: "warn", event: "auth.login_failed", request_id: requestId }));
      throw new HttpError(401, "invalid_credentials", "Invalid password");
    }
    const session = await createSessionToken(cfg.sessionSecret, deps.now());
    return jsonResponse({ ok: true, expires_at: new Date(session.expiresAt).toISOString() }, 200, {
      "set-cookie": sessionCookie(session.token, SESSION_TTL_S),
    });
  }

  function logout(req: Request, url: URL, cfg: AppConfig): Response {
    enforceOrigin(req, url, cfg);
    return jsonResponse({ ok: true }, 200, { "set-cookie": clearSessionCookie() });
  }

  async function handle(req: Request, env: Env, requestId: string, cors: { value: Record<string, string> }): Promise<Response> {
    const url = new URL(req.url);

    const configResult = loadConfig(env);
    if (url.pathname === "/health" && req.method === "GET") {
      return jsonResponse({ ok: configResult.ok }, configResult.ok ? 200 : 503);
    }
    if (!configResult.ok) {
      console.error(JSON.stringify({ level: "error", event: "config.invalid", problems: configResult.problems, request_id: requestId }));
      throw new HttpError(503, "server_misconfigured", "The API is not configured correctly");
    }
    const cfg = configResult.config;
    const origin = req.headers.get("origin");
    cors.value = corsHeaders(origin, url, cfg);

    if (req.method === "OPTIONS") {
      if (!url.pathname.startsWith("/api/") || !isOriginAllowed(origin, url, cfg)) {
        throw new HttpError(403, "origin_not_allowed", "Origin is not allowed");
      }
      return new Response(null, {
        status: 204,
        headers: {
          "access-control-allow-methods": ALLOWED_METHODS,
          "access-control-allow-headers": "content-type",
          "access-control-max-age": "600",
        },
      });
    }

    if (url.pathname === "/api/login" || url.pathname === "/api/logout") {
      if (req.method !== "POST") {
        throw new HttpError(405, "method_not_allowed", "Method not allowed", undefined, { allow: "POST" });
      }
      return url.pathname === "/api/login" ? login(req, env, cfg, url, requestId) : logout(req, url, cfg);
    }

    const matching = routes.filter((route) => route.pattern.test(url.pathname));
    if (matching.length === 0) {
      // Authenticate first so unauthenticated callers cannot probe which routes exist.
      if (url.pathname.startsWith("/api/")) await authenticate(req, cfg, requestId);
      throw new HttpError(404, "not_found", "Route not found");
    }

    const identity = await authenticate(req, cfg, requestId);

    const route = matching.find((candidate) => candidate.method === req.method);
    if (!route) {
      throw new HttpError(405, "method_not_allowed", "Method not allowed", undefined, {
        allow: [...new Set(matching.map((candidate) => candidate.method))].join(", "),
      });
    }

    // Least privilege: the worker token reaches only /api/worker/*, the owner never does.
    if ((route.audience === "worker") !== (identity.kind === "service")) {
      console.warn(JSON.stringify({ level: "warn", event: "auth.wrong_audience", kind: identity.kind, request_id: requestId }));
      throw new HttpError(403, "forbidden", "This identity is not allowed to use this endpoint");
    }

    if (route.write) enforceOrigin(req, url, cfg);
    await enforceRateLimit(env, identity, route, requestId);

    const match = route.pattern.exec(url.pathname);
    const ctx: Ctx = { req, env, cfg, url, identity, requestId, params: match ? match.slice(1) : [], now: deps.now };
    return route.handler(ctx);
  }

  /** Stale-lease recovery without a claim; also exposed for tests. Never throws. */
  async function maintain(env: Env): Promise<void> {
    try {
      const outcome = await recoverStale(env.DB, deps.now());
      if (outcome.requeued + outcome.failed + outcome.cancelled > 0) {
        console.warn(JSON.stringify({ level: "warn", event: "queue.recovered", ...outcome }));
      }
    } catch (error) {
      console.error(JSON.stringify({ level: "error", event: "queue.recover_failed", message: String(error) }));
    }
  }

  return {
    maintain,
    /** Cron trigger (see wrangler.toml [triggers]). */
    async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
      ctx.waitUntil(maintain(env));
    },
    async fetch(req: Request, env: Env): Promise<Response> {
      const requestId = crypto.randomUUID();
      const cors = { value: {} as Record<string, string> };
      try {
        const response = await handle(req, env, requestId, cors);
        return finalize(response, requestId, cors.value);
      } catch (error) {
        if (error instanceof HttpError) {
          return finalize(errorResponse(error, requestId), requestId, cors.value);
        }
        console.error(
          JSON.stringify({ level: "error", event: "unhandled", request_id: requestId, message: String(error) }),
        );
        return finalize(
          errorResponse(new HttpError(500, "internal_error", "Internal server error"), requestId),
          requestId,
          cors.value,
        );
      }
    },
  };
}

export default createApp();
