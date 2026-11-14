/**
 * API client. The owner signs in with a password (`login`); the server answers with an HttpOnly
 * session cookie that JavaScript cannot read, so this bundle carries NO credentials, stores no token
 * and sends no Authorization header. Never add a token, key or secret here: everything in a PWA
 * bundle is public. The password is only ever sent to /api/login and is not kept after the call.
 */
export type Account = { id: string; slot: number; label: string; email?: string | null; status: string };
export type Job = { id: string; status: string; account_slot: number; account_label: string; engine: string };
export type Page<T> = { items: T[]; next_cursor: string | null };

// Empty in production (same-origin, API served under /api on the same hostname).
const API_BASE: string = import.meta.env.VITE_API_URL || "";

export class ApiError extends Error {
  status: number;
  code: string;
  requestId?: string;
  constructor(status: number, code: string, message: string, requestId?: string) {
    super(message);
    this.status = status;
    this.code = code;
    this.requestId = requestId;
  }
}

const MESSAGES: Record<string, string> = {
  network: "Tidak dapat menghubungi server. Periksa koneksi atau muat ulang halaman.",
  unauthorized: "Sesi login berakhir. Silakan masuk lagi.",
  invalid_credentials: "Password salah.",
  forbidden: "Akses ditolak untuk fungsi ini.",
  origin_not_allowed: "Asal permintaan ditolak oleh server.",
  rate_limited: "Terlalu banyak percobaan. Coba lagi sebentar lagi.",
  validation_failed: "Data tidak valid. Periksa isian Anda.",
  server_misconfigured: "Server belum dikonfigurasi dengan benar.",
};

export function describeError(error: unknown): string {
  if (error instanceof ApiError) {
    const text = MESSAGES[error.code] ?? error.message;
    return error.requestId ? `${text} (${error.code} · ${error.requestId.slice(0, 8)})` : text;
  }
  return error instanceof Error ? error.message : String(error);
}

export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  let res: Response;
  try {
    res = await fetch(API_BASE + path, {
      credentials: API_BASE ? "include" : "same-origin",
      ...init,
      headers: {
        accept: "application/json",
        ...(init.body ? { "content-type": "application/json" } : {}),
        ...init.headers,
      },
    });
  } catch {
    throw new ApiError(0, "network", MESSAGES.network);
  }
  if (!res.ok) {
    let code = `http_${res.status}`;
    let message = `Permintaan gagal (${res.status}).`;
    let requestId: string | undefined;
    try {
      const body = await res.json();
      if (body?.error) {
        code = body.error.code ?? code;
        message = body.error.message ?? message;
        requestId = body.error.request_id;
      }
    } catch {
      // non-JSON error body: keep the generic message
    }
    throw new ApiError(res.status, code, message, requestId);
  }
  return res.json() as Promise<T>;
}

/** Exchanges the owner password for an HttpOnly session cookie (set by the server, never readable here). */
export function login(password: string): Promise<{ ok: true; expires_at: string }> {
  return api("/api/login", { method: "POST", body: JSON.stringify({ password }) });
}

/** Clears the session cookie. */
export function logout(): Promise<{ ok: true }> {
  return api("/api/logout", { method: "POST", body: "{}" });
}
