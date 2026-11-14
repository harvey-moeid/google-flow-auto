/** Minimal shape of the Workers Rate Limiting binding (limit() is all we use). */
export interface RateLimiter {
  limit(options: { key: string }): Promise<{ success: boolean }>;
}

export interface Env {
  DB: D1Database;
  MEDIA: R2Bucket;
  /** "production" (default/strict) or "development" (local wrangler dev only). */
  APP_ENV: string;
  /** Cloudflare Zero Trust team domain, e.g. myteam.cloudflareaccess.com */
  CF_ACCESS_TEAM_DOMAIN: string;
  /** Application Audience (AUD) tag of the Access application, 64 hex chars. */
  CF_ACCESS_AUD: string;
  /** Comma/space separated owner emails allowed to use the API (set as a secret). */
  ALLOWED_EMAILS: string;
  /** Extra exact origins allowed for CORS + mutating requests (e.g. http://localhost:5173). */
  ALLOWED_ORIGINS?: string;
  /** "true" to allow engines other than dry-run to be queued. Defaults to disabled. */
  LIVE_ENGINES_ENABLED?: string;
  /** Local development only: identity used when APP_ENV=development and host is loopback. */
  DEV_AUTH_EMAIL?: string;
  RL_READ?: RateLimiter;
  RL_WRITE?: RateLimiter;
}

export interface Identity {
  email: string;
  source: "access" | "dev";
}

/** Injectable side effects so auth/JWKS logic can be tested deterministically. */
export interface Deps {
  fetch: (input: string, init?: RequestInit) => Promise<Response>;
  now: () => number;
}
