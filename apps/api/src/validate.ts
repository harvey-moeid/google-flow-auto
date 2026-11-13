import { EMAIL_RE } from "./config.ts";
import { HttpError } from "./http.ts";

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const ACCOUNT_ID_RE = /^acct-(0[1-9]|10)$/;
const CONTROL_CHARS_RE = /[\u0000-\u001f\u007f]/;

export interface Issue {
  field: string;
  code: string;
}

/** Collects every validation problem so the client sees them all at once. */
export class Issues {
  list: Issue[] = [];
  add(field: string, code: string): void {
    this.list.push({ field, code });
  }
  throwIfAny(): void {
    if (this.list.length > 0) {
      throw new HttpError(400, "validation_failed", "Request validation failed", { issues: this.list });
    }
  }
}

export function rejectUnknownFields(body: Record<string, unknown>, allowed: readonly string[], issues: Issues): void {
  for (const key of Object.keys(body)) {
    if (!allowed.includes(key)) issues.add(key, "unknown_field");
  }
}

interface StringRules {
  required?: boolean;
  min?: number;
  max: number;
  pattern?: RegExp;
}

/** Reads an optional/required string field; returns the trimmed value or undefined. */
export function readString(
  body: Record<string, unknown>,
  key: string,
  rules: StringRules,
  issues: Issues,
): string | undefined {
  const raw = body[key];
  if (raw === undefined) {
    if (rules.required) issues.add(key, "required");
    return undefined;
  }
  if (typeof raw !== "string") {
    issues.add(key, "must_be_string");
    return undefined;
  }
  const value = raw.trim();
  if (value.length < (rules.min ?? 1)) {
    issues.add(key, "too_short");
    return undefined;
  }
  if (value.length > rules.max) {
    issues.add(key, "too_long");
    return undefined;
  }
  if (CONTROL_CHARS_RE.test(value)) {
    issues.add(key, "invalid_characters");
    return undefined;
  }
  if (rules.pattern && !rules.pattern.test(value)) {
    issues.add(key, "invalid_format");
    return undefined;
  }
  return value;
}

export function readEnum<T extends string>(
  body: Record<string, unknown>,
  key: string,
  allowed: readonly T[],
  issues: Issues,
): T | undefined {
  const raw = body[key];
  if (raw === undefined) return undefined;
  if (typeof raw !== "string" || !allowed.includes(raw as T)) {
    issues.add(key, "invalid_value");
    return undefined;
  }
  return raw as T;
}

/** Email that may be cleared by sending null. undefined = field not provided. */
export function readNullableEmail(
  body: Record<string, unknown>,
  key: string,
  issues: Issues,
): string | null | undefined {
  const raw = body[key];
  if (raw === undefined) return undefined;
  if (raw === null) return null;
  if (typeof raw !== "string") {
    issues.add(key, "must_be_string");
    return undefined;
  }
  const value = raw.trim().toLowerCase();
  if (value.length > 254 || !EMAIL_RE.test(value)) {
    issues.add(key, "invalid_format");
    return undefined;
  }
  return value;
}

export const ASPECT_RATIOS = ["9:16", "16:9", "1:1"] as const;
export const ENGINES = ["dry-run", "flowkit", "gflow"] as const;
export const JOB_STATUSES = [
  "queued",
  "claimed",
  "running",
  "waiting_for_user",
  "succeeded",
  "failed",
  "cancelled",
] as const;
