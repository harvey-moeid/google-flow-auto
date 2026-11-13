import type { AppConfig } from "./config.ts";

export class HttpError extends Error {
  status: number;
  code: string;
  details?: unknown;
  headers?: Record<string, string>;
  constructor(
    status: number,
    code: string,
    message: string,
    details?: unknown,
    headers?: Record<string, string>,
  ) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
    this.headers = headers;
  }
}

/** Applied to every response, including errors and preflights. */
const SECURITY_HEADERS: Record<string, string> = {
  "x-content-type-options": "nosniff",
  "cache-control": "no-store",
  "referrer-policy": "no-referrer",
  "content-security-policy": "default-src 'none'; frame-ancestors 'none'",
  "strict-transport-security": "max-age=31536000; includeSubDomains",
};

export const MAX_BODY_BYTES = 16 * 1024;

export function jsonResponse(data: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...headers },
  });
}

export function errorResponse(error: HttpError, requestId: string): Response {
  const body: { error: { code: string; message: string; request_id: string; details?: unknown } } = {
    error: { code: error.code, message: error.message, request_id: requestId },
  };
  if (error.details !== undefined) body.error.details = error.details;
  return jsonResponse(body, error.status, error.headers);
}

/** Adds security headers, request id and (when applicable) CORS headers. */
export function finalize(res: Response, requestId: string, extra: Record<string, string> = {}): Response {
  const headers = new Headers(res.headers);
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) headers.set(name, value);
  headers.set("x-request-id", requestId);
  for (const [name, value] of Object.entries(extra)) headers.set(name, value);
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}

export function isOriginAllowed(origin: string | null, url: URL, cfg: AppConfig): boolean {
  if (origin === null) return false;
  return origin === url.origin || cfg.allowedOrigins.has(origin);
}

/** CORS headers are only ever emitted for an exact-match origin; never a wildcard. */
export function corsHeaders(origin: string | null, url: URL, cfg: AppConfig): Record<string, string> {
  if (origin === null) return {};
  const headers: Record<string, string> = { vary: "Origin" };
  if (isOriginAllowed(origin, url, cfg)) {
    headers["access-control-allow-origin"] = origin;
    headers["access-control-allow-credentials"] = "true";
  }
  return headers;
}

/**
 * CSRF defence for cookie-authenticated browsers: a mutating request that carries an
 * Origin header must come from this origin or an allowlisted one. Non-browser clients
 * do not send Origin and cannot be driven by a victim's browser.
 */
export function enforceOrigin(req: Request, url: URL, cfg: AppConfig): void {
  const origin = req.headers.get("origin");
  if (origin === null) return;
  if (!isOriginAllowed(origin, url, cfg)) {
    throw new HttpError(403, "origin_not_allowed", "Origin is not allowed");
  }
}

/** Reads a size-capped JSON object body. */
export async function readJsonObject(req: Request, maxBytes = MAX_BODY_BYTES): Promise<Record<string, unknown>> {
  const contentType = req.headers.get("content-type") ?? "";
  if (!/^application\/json(\s*;|$)/i.test(contentType)) {
    throw new HttpError(415, "unsupported_media_type", "Content-Type must be application/json");
  }
  const declared = req.headers.get("content-length");
  if (declared !== null && Number(declared) > maxBytes) {
    throw new HttpError(413, "payload_too_large", "Request body is too large");
  }
  if (!req.body) throw new HttpError(400, "invalid_json", "Request body must be a JSON object");

  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    received += value.byteLength;
    if (received > maxBytes) {
      await reader.cancel();
      throw new HttpError(413, "payload_too_large", "Request body is too large");
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new HttpError(400, "invalid_json", "Request body is not valid JSON");
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new HttpError(400, "invalid_json", "Request body must be a JSON object");
  }
  return parsed as Record<string, unknown>;
}
