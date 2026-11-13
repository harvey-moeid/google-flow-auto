/**
 * API client. Authentication is handled entirely by Cloudflare Access (an HttpOnly cookie
 * scoped to the app hostname); this bundle carries NO credentials and sends no Authorization
 * header. Never add a token, key or secret here: everything in a PWA bundle is public.
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
  session_expired: "Sesi login berakhir. Muat ulang halaman untuk login lagi.",
  network: "Tidak dapat menghubungi server. Periksa koneksi atau muat ulang halaman.",
  unauthorized: "Anda belum login. Muat ulang halaman untuk login lagi.",
  forbidden: "Akun ini tidak diizinkan menggunakan aplikasi.",
  origin_not_allowed: "Asal permintaan ditolak oleh server.",
  rate_limited: "Terlalu banyak permintaan. Coba lagi sebentar lagi.",
  validation_failed: "Data tidak valid. Periksa isian Anda.",
  server_misconfigured: "Server belum dikonfigurasi dengan benar.",
  auth_unavailable: "Layanan autentikasi sedang tidak tersedia. Coba lagi nanti.",
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
      // Access answers an expired session with a cross-origin redirect to the login page.
      redirect: "manual",
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
  if (res.type === "opaqueredirect") {
    throw new ApiError(401, "session_expired", MESSAGES.session_expired);
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
