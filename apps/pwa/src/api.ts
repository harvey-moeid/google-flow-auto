/**
 * API client. The owner signs in with a password (`login`); the server answers with an HttpOnly
 * session cookie that JavaScript cannot read, so this bundle carries NO credentials, stores no token
 * and sends no Authorization header. Never add a token, key or secret here: everything in a PWA
 * bundle is public. The password is only ever sent to /api/login and is not kept after the call.
 */
export type Account = { id: string; slot: number; label: string; email?: string | null; status: string; google_identity_verified_at?: string | null };
export type WorkerStatus = {
  worker_id: string;
  state: "idle" | "busy" | "stopping";
  online: boolean;
  last_seen_at: string;
  disk_free_bytes: number | null;
  disk_total_bytes: number | null;
  disk_low: boolean;
  profile_count: number;
};
export type Job = {
  id: string;
  status: string;
  account_slot: number;
  account_label: string;
  engine: string;
  project_id?: string;
  scene_order?: number | null;
  error_code?: string | null;
  retry_of?: string | null;
  cancel_requested?: number;
  created_at?: string;
};
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
  project_archived: "Project diarsipkan. Pulihkan dulu untuk mengubahnya.",
  project_busy: "Project masih punya job yang antre atau berjalan.",
  project_not_found: "Project tidak ditemukan.",
  scene_not_found: "Scene tidak ditemukan.",
  scene_locked: "Scene ini punya job yang antre atau berjalan, jadi belum bisa diubah.",
  scene_busy: "Scene ini masih punya job yang antre atau berjalan.",
  scene_limit_reached: "Jumlah scene sudah mencapai batas maksimum (50).",
  scene_set_mismatch: "Daftar scene berubah. Muat ulang lalu coba lagi.",
  scenes_changed: "Scene berubah sejak Anda meninjau. Periksa ulang sebelum mengirim.",
  submit_blocked: "Project belum siap dikirim.",
  account_not_ready: "Akun belum berstatus Ready.",
  google_identity_not_configured: "Google Identity belum dikonfigurasi di server.",
  google_token_invalid: "Verifikasi Google gagal. Mulai enrollment baru.",
  google_keys_unavailable: "Layanan verifikasi Google sedang tidak tersedia.",
  enrollment_challenge_expired: "Tantangan enrollment kedaluwarsa atau sudah digunakan. Mulai ulang.",
  google_identity_already_linked: "Identitas Google sudah ditautkan ke slot lain.",
  google_identity_not_found: "Belum ada identitas Google pada slot ini.",
  job_not_found: "Job tidak ditemukan.",
  job_not_retryable: "Hanya job gagal atau dibatalkan yang bisa diulang.",
  job_not_cancellable: "Job sudah selesai.",
  job_not_resumable: "Job ini tidak sedang menunggu Anda.",
  idempotency_key_conflict: "Permintaan ini bentrok dengan pengiriman sebelumnya. Muat ulang dan coba lagi.",
  live_engine_disabled: "Engine live dinonaktifkan; gunakan mode dry-run.",
  payload_too_large: "Isian terlalu panjang.",
  worker_limit_reached: "Batas jumlah worker yang tercatat sudah tercapai.",
  media_not_found: "Media tidak ditemukan.",
  job_active: "Media job yang sedang diproses worker belum bisa dihapus. Tunggu job selesai atau batalkan dulu.",
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

// ---------- Phase 3: projects, scenes, review, jobs ----------

export type Project = {
  id: string;
  name: string;
  aspect_ratio: string;
  status: "draft" | "archived";
  scene_count?: number;
  created_at?: string;
  updated_at?: string;
};
export type Scene = {
  id: string;
  scene_order: number;
  prompt: string;
  duration_seconds: number;
  last_job: { id: string; status: string } | null;
};
export type ProjectDetail = Project & { scene_count: number; total_seconds: number; scenes: Scene[] };
export type Problem = { code: string; scene_id?: string };
export type ReadyAccount = { id: string; slot: number; label: string };
export type Readiness = {
  project_id: string;
  aspect_ratio: string;
  scene_count: number;
  total_seconds: number;
  account: { id: string; slot: number; label: string; status: string } | null;
  ready_accounts: ReadyAccount[];
  problems: Problem[];
  can_submit: boolean;
};
export type TimelineEvent = { event: string; at: string; detail: Record<string, unknown> };
export type JobDetail = Omit<Job, "cancel_requested"> & {
  project_name: string;
  scene_id: string | null;
  scene_prompt: string | null;
  attempts: number;
  max_attempts: number;
  cancel_requested: boolean;
  started_at: string | null;
  finished_at: string | null;
  timeline: TimelineEvent[];
};

export const ACTIVE_JOB_STATUSES = ["queued", "claimed", "running", "waiting_for_user"];
export const FINAL_JOB_STATUSES = ["succeeded", "failed", "cancelled"];

export const STATUS_LABELS: Record<string, string> = {
  queued: "Antre",
  claimed: "Diambil worker",
  running: "Berjalan",
  waiting_for_user: "Menunggu Anda",
  succeeded: "Selesai",
  failed: "Gagal",
  cancelled: "Dibatalkan",
};

export const PROBLEM_LABELS: Record<string, string> = {
  project_archived: "Project diarsipkan.",
  no_scenes: "Belum ada scene.",
  account_required: "Pilih satu akun Google.",
  account_not_found: "Akun tidak ditemukan.",
  account_not_ready: "Akun belum Ready (perlu login manual di worker).",
  scene_busy: "Ada scene yang masih punya job antre atau berjalan.",
};

/** One key per user intention (a form, a button press) so a double tap or a retry never queues twice. */
export function newKey(): string {
  return crypto.randomUUID();
}

export function post<T>(path: string, body: unknown = {}): Promise<T> {
  return api<T>(path, { method: "POST", body: JSON.stringify(body) });
}
export function patch<T>(path: string, body: unknown): Promise<T> {
  return api<T>(path, { method: "PATCH", body: JSON.stringify(body) });
}
/** Deleting is a POST action (like cancel/resume), so the API only needs GET/POST/PATCH. */
export function remove<T>(path: string): Promise<T> {
  return post<T>(`${path}/delete`);
}

// ---------- Phase 6B: job media (private R2, owner-authenticated) ----------

/** Public media metadata from GET /api/jobs/:id/media. The API never exposes the storage key. */
export type JobMedia = {
  id: string;
  job_id: string;
  project_id: string;
  scene_id: string | null;
  kind: "video" | "image";
  mime: string;
  size_bytes: number;
  sha256: string;
  width: number | null;
  height: number | null;
  duration_ms: number | null;
  created_at: string;
};

/**
 * Result of POST /api/media/:id/delete. The listing entry is always gone when this resolves;
 * `object_deleted:false` means the stored file could not be removed right now and remains as an orphan.
 */
export type MediaDeleteResult = { id: string; deleted: true; object_deleted: boolean };

const MEDIA_EXTENSIONS: Record<string, string> = {
  "video/mp4": "mp4",
  "video/webm": "webm",
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
};

/** Same file name the API suggests in its content-disposition header. */
export function mediaFileName(item: Pick<JobMedia, "id" | "mime">): string {
  const extension = MEDIA_EXTENSIONS[item.mime];
  return extension ? `media-${item.id}.${extension}` : `media-${item.id}`;
}

/**
 * Downloads one media file through the owner session cookie. The bytes are streamed by the API; there is
 * no public bucket URL and no token in any URL, so the result is only ever held as an in-memory Blob.
 */
export async function fetchMediaBlob(id: string): Promise<Blob> {
  let res: Response;
  try {
    res = await fetch(`${API_BASE}/api/media/${id}`, { credentials: API_BASE ? "include" : "same-origin" });
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
  return res.blob();
}