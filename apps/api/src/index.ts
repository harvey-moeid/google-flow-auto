import { createAccessVerifier } from "./auth.ts";
import { isLoopbackHost, loadConfig } from "./config.ts";
import type { AppConfig } from "./config.ts";
import {
  HttpError,
  corsHeaders,
  enforceOrigin,
  errorResponse,
  finalize,
  isOriginAllowed,
  jsonResponse,
} from "./http.ts";
import { routes } from "./routes.ts";
import type { Ctx } from "./routes.ts";
import type { Deps, Env, Identity } from "./types.ts";

const ALLOWED_METHODS = "GET, POST, PATCH, OPTIONS";
const RATE_LIMIT_RETRY_AFTER_S = "60";

/**
 * Request pipeline (order matters):
 *  1. /health (public, no secrets)  2. config validation (fail closed)
 *  3. CORS preflight  4. identity (Access JWT)  5. allowlist authorization
 *  6. Origin check for writes  7. rate limit  8. route + validation + audit
 */
export function createApp(overrides: Partial<Deps> = {}) {
  const deps: Deps = {
    fetch: overrides.fetch ?? ((input, init) => fetch(input, init)),
    now: overrides.now ?? (() => Date.now()),
  };
  const verifier = createAccessVerifier(deps);

  async function authenticate(req: Request, url: URL, cfg: AppConfig, requestId: string): Promise<Identity> {
    // Local development only: never active unless APP_ENV is exactly "development".
    if (cfg.devAuthEmail && isLoopbackHost(url.hostname)) {
      return { email: cfg.devAuthEmail, source: "dev" };
    }
    const token = req.headers.get("cf-access-jwt-assertion");
    if (!token || !cfg.teamDomain || !cfg.aud) {
      throw new HttpError(401, "unauthorized", "Authentication required");
    }
    const result = await verifier.verify(token, { teamDomain: cfg.teamDomain, aud: cfg.aud });
    if (!result.ok) {
      if (result.reason === "jwks_unavailable") {
        console.error(JSON.stringify({ level: "error", event: "auth.jwks_unavailable", request_id: requestId }));
        throw new HttpError(503, "auth_unavailable", "Authentication service is temporarily unavailable");
      }
      console.warn(JSON.stringify({ level: "warn", event: "auth.rejected", reason: result.reason, request_id: requestId }));
      throw new HttpError(401, "unauthorized", "Authentication required");
    }
    if (!cfg.allowedEmails.has(result.email)) {
      console.warn(JSON.stringify({ level: "warn", event: "auth.forbidden", request_id: requestId }));
      throw new HttpError(403, "forbidden", "This identity is not allowed to use this API");
    }
    return { email: result.email, source: "access" };
  }

  async function enforceRateLimit(env: Env, identity: Identity, write: boolean, requestId: string): Promise<void> {
    const limiter = write ? env.RL_WRITE : env.RL_READ;
    if (!limiter) return; // only possible in development; production config requires both bindings
    let allowed = true;
    try {
      allowed = (await limiter.limit({ key: `${write ? "w" : "r"}:${identity.email}` })).success;
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

    const matching = routes.filter((route) => route.pattern.test(url.pathname));
    if (matching.length === 0) {
      // Authenticate first so unauthenticated callers cannot probe which routes exist.
      if (url.pathname.startsWith("/api/")) await authenticate(req, url, cfg, requestId);
      throw new HttpError(404, "not_found", "Route not found");
    }

    const identity = await authenticate(req, url, cfg, requestId);

    const route = matching.find((candidate) => candidate.method === req.method);
    if (!route) {
      throw new HttpError(405, "method_not_allowed", "Method not allowed", undefined, {
        allow: [...new Set(matching.map((candidate) => candidate.method))].join(", "),
      });
    }

    if (route.write) enforceOrigin(req, url, cfg);
    await enforceRateLimit(env, identity, route.write, requestId);

    const match = route.pattern.exec(url.pathname);
    const ctx: Ctx = { req, env, cfg, url, identity, requestId, params: match ? match.slice(1) : [] };
    return route.handler(ctx);
  }

  return {
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
