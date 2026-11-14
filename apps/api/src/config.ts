import type { Env } from "./types.ts";

export const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,63}$/;
export const MIN_PASSWORD_LENGTH = 10;
export const MIN_SECRET_LENGTH = 32;
const MAX_SECRET_LENGTH = 256;
/** Characters allowed in the worker bearer token (it travels in an HTTP header). */
const TOKEN_CHARS_RE = /^[A-Za-z0-9._~+/=-]+$/;
const PLACEHOLDER_RE = /^REPLACE_WITH/i;
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

export interface AppConfig {
  isDevelopment: boolean;
  ownerPassword: string;
  sessionSecret: string;
  /** Null = worker API disabled. */
  workerToken: string | null;
  allowedOrigins: Set<string>;
  liveEnginesEnabled: boolean;
}

export type ConfigResult =
  | { ok: true; config: AppConfig }
  | { ok: false; problems: string[] };

export function isLoopbackHost(hostname: string): boolean {
  return LOOPBACK_HOSTS.has(hostname);
}

function splitList(value: string | undefined): string[] {
  return (value ?? "")
    .split(/[\s,]+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

/** Secrets set from a shell pipe often carry a trailing newline; nothing else is altered. */
function cleanSecret(value: string | undefined): string {
  return (value ?? "").replace(/[\r\n]+$/, "");
}

function isAllowedOriginSyntax(value: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return false;
  }
  if (parsed.origin !== value) return false; // no path, no trailing slash, normalized
  if (parsed.protocol === "https:") return true;
  return parsed.protocol === "http:" && isLoopbackHost(parsed.hostname);
}

/**
 * Validates every setting the security boundary depends on. Any problem makes the
 * API fail closed (503) instead of running with a weaker configuration.
 * Placeholder values such as REPLACE_WITH_... never pass these checks.
 * Problems name variables only, never values.
 */
export function loadConfig(env: Env): ConfigResult {
  const problems: string[] = [];
  const isDevelopment = env.APP_ENV === "development";

  const ownerPassword = cleanSecret(env.OWNER_PASSWORD);
  if (
    ownerPassword.length < MIN_PASSWORD_LENGTH ||
    ownerPassword.length > MAX_SECRET_LENGTH ||
    PLACEHOLDER_RE.test(ownerPassword)
  ) {
    problems.push("OWNER_PASSWORD");
  }

  const sessionSecret = cleanSecret(env.SESSION_SECRET);
  if (
    sessionSecret.length < MIN_SECRET_LENGTH ||
    sessionSecret.length > MAX_SECRET_LENGTH ||
    PLACEHOLDER_RE.test(sessionSecret)
  ) {
    problems.push("SESSION_SECRET");
  }

  let workerToken: string | null = null;
  const rawWorkerToken = cleanSecret(env.WORKER_TOKEN);
  if (rawWorkerToken) {
    if (
      rawWorkerToken.length >= MIN_SECRET_LENGTH &&
      rawWorkerToken.length <= MAX_SECRET_LENGTH &&
      TOKEN_CHARS_RE.test(rawWorkerToken) &&
      !PLACEHOLDER_RE.test(rawWorkerToken)
    ) {
      workerToken = rawWorkerToken;
    } else {
      problems.push("WORKER_TOKEN");
    }
  }

  const allowedOrigins = new Set<string>();
  for (const origin of splitList(env.ALLOWED_ORIGINS)) {
    if (isAllowedOriginSyntax(origin)) allowedOrigins.add(origin);
    else problems.push("ALLOWED_ORIGINS");
  }

  if (!isDevelopment) {
    if (!env.RL_READ) problems.push("RL_READ binding");
    if (!env.RL_WRITE) problems.push("RL_WRITE binding");
    if (!env.RL_LOGIN) problems.push("RL_LOGIN binding");
    // The worker API is only reachable when a worker token is configured; then it must be rate limited.
    if (workerToken !== null && !env.RL_WORKER) problems.push("RL_WORKER binding");
  }

  if (problems.length > 0) return { ok: false, problems: [...new Set(problems)] };
  return {
    ok: true,
    config: {
      isDevelopment,
      ownerPassword,
      sessionSecret,
      workerToken,
      allowedOrigins,
      liveEnginesEnabled: env.LIVE_ENGINES_ENABLED === "true",
    },
  };
}
