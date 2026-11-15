import type { Env } from "./types.ts";

/** Reference images only. SVG is deliberately absent: it can carry script and is not a raster input. */
export const ASSET_MIME_TYPES = ["image/png", "image/jpeg", "image/webp"] as const;
export type AssetMime = (typeof ASSET_MIME_TYPES)[number];

/** Keep in sync with the CHECK constraint and trigger in cloudflare/migrations/0004_scene_assets.sql. */
export const ASSET_MAX_BYTES = 5 * 1024 * 1024;
export const MAX_ASSETS_PER_SCENE = 3;

export function isAssetMime(value: string): value is AssetMime {
  return (ASSET_MIME_TYPES as readonly string[]).includes(value);
}

/** Identifies the real image format from the first bytes; the declared Content-Type is never trusted alone. */
export function sniffImageType(bytes: Uint8Array): AssetMime | null {
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  ) {
    return "image/png";
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (
    bytes.length >= 12 &&
    bytes[0] === 0x52 && // R
    bytes[1] === 0x49 && // I
    bytes[2] === 0x46 && // F
    bytes[3] === 0x46 && // F
    bytes[8] === 0x57 && // W
    bytes[9] === 0x45 && // E
    bytes[10] === 0x42 && // B
    bytes[11] === 0x50 // P
  ) {
    return "image/webp";
  }
  return null;
}

/** Object key in the private bucket. Built only from server-generated ids, never from user input. */
export function assetKey(projectId: string, sceneId: string, assetId: string): string {
  return `assets/${projectId}/${sceneId}/${assetId}`;
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * Best-effort removal of objects whose rows are already gone. A failure leaves an orphan object (no
 * row points at it) that the Phase 6 cleanup job removes; it must never fail the owner's request.
 */
export async function deleteObjects(env: Env, keys: string[], requestId: string): Promise<void> {
  for (const key of keys) {
    try {
      await env.MEDIA.delete(key);
    } catch (error) {
      console.error(
        JSON.stringify({ level: "error", event: "asset.object_delete_failed", request_id: requestId, key, message: String(error) }),
      );
    }
  }
}
