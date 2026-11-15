import { asciiToB64url, b64urlToBytes } from "./encoding.ts";
import { HttpError } from "./http.ts";
import { Issues } from "./validate.ts";

const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 100;

export function encodeCursor(createdAt: string, id: string): string {
  return asciiToB64url(JSON.stringify([createdAt, id]));
}

export function decodeCursor(raw: string): [string, string] {
  try {
    const value = JSON.parse(new TextDecoder().decode(b64urlToBytes(raw)));
    if (
      Array.isArray(value) &&
      value.length === 2 &&
      value.every((part) => typeof part === "string" && part.length > 0 && part.length <= 64)
    ) {
      return [value[0], value[1]];
    }
  } catch {
    // fall through
  }
  throw new HttpError(400, "validation_failed", "Request validation failed", {
    issues: [{ field: "cursor", code: "invalid_value" }],
  });
}

export function parsePagination(url: URL): { limit: number; cursor: [string, string] | null } {
  const issues = new Issues();
  let limit = DEFAULT_PAGE_SIZE;
  const rawLimit = url.searchParams.get("limit");
  if (rawLimit !== null) {
    if (!/^\d{1,3}$/.test(rawLimit) || Number(rawLimit) < 1 || Number(rawLimit) > MAX_PAGE_SIZE) {
      issues.add("limit", "out_of_range");
    } else {
      limit = Number(rawLimit);
    }
  }
  issues.throwIfAny();
  const rawCursor = url.searchParams.get("cursor");
  return { limit, cursor: rawCursor === null ? null : decodeCursor(rawCursor) };
}

export function page<T extends { created_at: string; id: string }>(rows: T[], limit: number) {
  const hasMore = rows.length > limit;
  const items = hasMore ? rows.slice(0, limit) : rows;
  const last = items[items.length - 1];
  return { items, next_cursor: hasMore && last ? encodeCursor(last.created_at, last.id) : null };
}

export function isUniqueViolation(error: unknown): boolean {
  return error instanceof Error && /UNIQUE constraint failed/i.test(error.message);
}
