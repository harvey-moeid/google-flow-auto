import type { Env } from "./types.ts";

const TEAM_DOMAIN_RE = /^[a-z0-9][a-z0-9-]*\.cloudflareaccess\.com$/;
const AUD_RE = /^[a-f0-9]{64}$/;
export const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,63}$/;
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

export interface AppConfig {
  isDevelopment: boolean;
  teamDomain: string;
  aud: string;
  allowedEmails: Set<string>;
  allowedOrigins: Set<string>;
  liveEnginesEnabled: boolean;
  /** Only ever non-null when APP_ENV is exactly "development". */
  devAuthEmail: string | null;
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

  const devAuthEmail =
    isDevelopment && env.DEV_AUTH_EMAIL ? env.DEV_AUTH_EMAIL.trim().toLowerCase() : null;
  if (devAuthEmail && !EMAIL_RE.test(devAuthEmail)) problems.push("DEV_AUTH_EMAIL");

  const accessRequired = devAuthEmail === null;
  const teamDomain = (env.CF_ACCESS_TEAM_DOMAIN ?? "").trim();
  const aud = (env.CF_ACCESS_AUD ?? "").trim();
  if (accessRequired || teamDomain) {
    if (!TEAM_DOMAIN_RE.test(teamDomain)) problems.push("CF_ACCESS_TEAM_DOMAIN");
  }
  if (accessRequired || aud) {
    if (!AUD_RE.test(aud)) problems.push("CF_ACCESS_AUD");
  }

  const allowedEmails = new Set<string>();
  const emails = splitList(env.ALLOWED_EMAILS).map((e) => e.toLowerCase());
  for (const email of emails) {
    if (EMAIL_RE.test(email)) allowedEmails.add(email);
    else problems.push("ALLOWED_EMAILS");
  }
  if (accessRequired && allowedEmails.size === 0) problems.push("ALLOWED_EMAILS");

  const allowedOrigins = new Set<string>();
  for (const origin of splitList(env.ALLOWED_ORIGINS)) {
    if (isAllowedOriginSyntax(origin)) allowedOrigins.add(origin);
    else problems.push("ALLOWED_ORIGINS");
  }

  if (!isDevelopment) {
    if (!env.RL_READ) problems.push("RL_READ binding");
    if (!env.RL_WRITE) problems.push("RL_WRITE binding");
  }

  if (problems.length > 0) return { ok: false, problems: [...new Set(problems)] };
  return {
    ok: true,
    config: {
      isDevelopment,
      teamDomain,
      aud,
      allowedEmails,
      allowedOrigins,
      liveEnginesEnabled: env.LIVE_ENGINES_ENABLED === "true",
      devAuthEmail,
    },
  };
}
