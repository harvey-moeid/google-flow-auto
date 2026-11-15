/** Minimal shape of the Workers Rate Limiting binding (limit() is all we use). */
export interface RateLimiter {
  limit(options: { key: string }): Promise<{ success: boolean }>;
}

export interface Env {
  DB: D1Database;
  MEDIA: R2Bucket;
  /** "production" (default/strict) or "development" (local wrangler dev only: rate-limit bindings become optional). */
  APP_ENV: string;
  /** Owner login password (secret, at least 10 characters). */
  OWNER_PASSWORD: string;
  /** Random key that signs session cookies (secret, at least 32 characters). Changing it logs everyone out. */
  SESSION_SECRET: string;
  /** Bearer token of the browser worker (secret, at least 32 characters). Empty/unset disables the worker API entirely. */
  WORKER_TOKEN?: string;
  /** Extra exact origins allowed for CORS + mutating requests (e.g. http://localhost:5173). */
  ALLOWED_ORIGINS?: string;
  /** "true" to allow engines other than dry-run to be queued/claimed. Defaults to disabled (kill switch). */
  LIVE_ENGINES_ENABLED?: string;
  RL_READ?: RateLimiter;
  RL_WRITE?: RateLimiter;
  RL_WORKER?: RateLimiter;
  RL_LOGIN?: RateLimiter;
}

/**
 * Who is calling. The owner (a human who logged in with the password) may use the owner routes; the
 * browser worker (bearer WORKER_TOKEN) may use ONLY the worker routes. The two sets never overlap:
 * a leaked worker token cannot create jobs, edit accounts or read the audit log.
 */
export type Identity =
  | { kind: "owner"; name: "owner"; source: "password" }
  | { kind: "service"; source: "worker-token" }
  /** Holder of a short-lived signed media link (see media-routes.ts); reaches only GET /api/media/:id/content. */
  | { kind: "link"; source: "signed-url" };

/** Injectable side effects so session expiry and lease logic can be tested deterministically. */
export interface Deps {
  now: () => number;
}
