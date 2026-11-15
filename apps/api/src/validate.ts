import { EMAIL_RE } from "./config.ts";
import { HttpError } from "./http.ts";

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const ACCOUNT_ID_RE = /^acct-(0[1-9]|10)$/;
/** Free-form worker process identifier chosen by the worker (e.g. host name + pid). */
export const WORKER_ID_RE = /^[A-Za-z0-9._:-]+$/;
/** Machine-readable error classification reported by a worker, e.g. `engine_timeout`. */
export const ERROR_CODE_RE = /^[a-z][a-z0-9_]{1,63}$/;
/** Object key of a result in private storage (Phase 6). No leading slash, no `..` segments. */
export const RESULT_KEY_RE = /^[A-Za-z0-9][A-Za-z0-9._\/-]*$/;
const CONTROL_CHARS_RE = /[\u0000-\u001f\u007f]/;
/** Same as above but tab, line feed and carriage return are allowed (multi-line prompts). */
const CONTROL_CHARS_MULTILINE_RE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;

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
  /** Allow tab / line breaks inside the value (prompts). Other control characters stay rejected. */
  multiline?: boolean;
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
  if ((rules.multiline ? CONTROL_CHARS_MULTILINE_RE : CONTROL_CHARS_RE).test(value)) {
    issues.add(key, "invalid_characters");
    return undefined;
  }
  if (rules.pattern && !rules.pattern.test(value)) {
    issues.add(key, "invalid_format");
    return undefined;
  }
  return value;
}

interface IntRules {
  required?: boolean;
  min: number;
  max: number;
}

/** Reads an optional/required JSON integer within [min, max]. Strings and floats are rejected. */
export function readInt(
  body: Record<string, unknown>,
  key: string,
  rules: IntRules,
  issues: Issues,
): number | undefined {
  const raw = body[key];
  if (raw === undefined) {
    if (rules.required) issues.add(key, "required");
    return undefined;
  }
  if (typeof raw !== "number" || !Number.isInteger(raw)) {
    issues.add(key, "must_be_integer");
    return undefined;
  }
  if (raw < rules.min || raw > rules.max) {
    issues.add(key, "out_of_range");
    return undefined;
  }
  return raw;
}

/** Reads an optional/required JSON boolean. "true"/1 are rejected. */
export function readBoolean(
  body: Record<string, unknown>,
  key: string,
  rules: { required?: boolean },
  issues: Issues,
): boolean | undefined {
  const raw = body[key];
  if (raw === undefined) {
    if (rules.required) issues.add(key, "required");
    return undefined;
  }
  if (typeof raw !== "boolean") {
    issues.add(key, "must_be_boolean");
    return undefined;
  }
  return raw;
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

export const PROJECT_STATUSES = ["draft", "archived"] as const;

/** Hard limits for a project; also enforced by a database trigger (scenes). */
export const MAX_SCENES_PER_PROJECT = 50;
export const PROMPT_MAX_LENGTH = 2000;
/** Generic bounds only: the real per-engine limits are unverified until Phase 5. */
export const SCENE_DURATION_MIN_S = 1;
export const SCENE_DURATION_MAX_S = 60;

/** Reads a required list of unique UUIDs (1..max). */
export function readUuidList(
  body: Record<string, unknown>,
  key: string,
  max: number,
  issues: Issues,
): string[] | undefined {
  const raw = body[key];
  if (raw === undefined) {
    issues.add(key, "required");
    return undefined;
  }
  if (!Array.isArray(raw)) {
    issues.add(key, "must_be_array");
    return undefined;
  }
  if (raw.length < 1 || raw.length > max) {
    issues.add(key, "out_of_range");
    return undefined;
  }
  if (!raw.every((item) => typeof item === "string" && UUID_RE.test(item))) {
    issues.add(key, "invalid_format");
    return undefined;
  }
  const values = (raw as string[]).map((item) => item.toLowerCase());
  if (new Set(values).size !== values.length) {
    issues.add(key, "duplicate_value");
    return undefined;
  }
  return values;
}
