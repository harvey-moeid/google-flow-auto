"""Phase 6B: uploads the output files an adapter produced, before the job is reported complete.

Contract with adapters: `run()` may return a dict with an optional `outputs` list of file paths. Nothing
else about the result is interpreted. A result without `outputs` (the dry-run adapter) uploads nothing.

Safety rules enforced here (the server re-validates everything; see apps/api/src/media-routes.ts):
  * Only regular files that resolve (symlinks followed) to a location inside the configured output root.
  * Only the five media types the API accepts, non-empty, and at most the API's 25 MiB one-shot cap.
  * Errors carry a fixed code only: never a path, file name, prompt or server message.
  * Uploads are idempotent per (job, SHA-256) on the server, so a retry after a lost response is safe.
"""
from __future__ import annotations

import asyncio
import hashlib
from pathlib import Path
from typing import Awaitable, Callable

from worker.api_client import ApiError, LeaseLost, WorkerApiClient

# Mirrors MAX_MEDIA_BYTES in apps/api/src/media-routes.ts (buffered one-shot upload).
MAX_MEDIA_BYTES = 25 * 1024 * 1024
MAX_OUTPUTS_PER_JOB = 10
UPLOAD_ATTEMPTS = 3

MIME_BY_SUFFIX = {
    ".mp4": "video/mp4",
    ".webm": "video/webm",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".webp": "image/webp",
}


class MediaUploadError(Exception):
    """Output handling failed. `code` is a fixed identifier that is safe to report to the API."""

    def __init__(self, code: str, retryable: bool):
        super().__init__(code)
        self.code = code
        self.retryable = retryable


def outputs_of(result) -> list[str]:
    """Extracts the output file paths from an adapter result. Raises MediaUploadError on a malformed list."""
    if not isinstance(result, dict):
        return []
    raw = result.get("outputs")
    if raw is None:
        return []
    if not isinstance(raw, (list, tuple)) or not all(isinstance(item, (str, Path)) for item in raw):
        raise MediaUploadError("invalid_outputs", False)
    if len(raw) > MAX_OUTPUTS_PER_JOB:
        raise MediaUploadError("too_many_outputs", False)
    return [str(item) for item in raw]


def load_output(path: str, output_root: Path | None) -> tuple[str, bytes, str]:
    """Validates one output file and returns (mime, bytes, sha256 hex). Blocking: call it in a thread."""
    if output_root is None:
        raise MediaUploadError("output_root_not_configured", False)
    try:
        root = Path(output_root).resolve(strict=True)
        file = Path(path).resolve(strict=True)
    except (OSError, RuntimeError):
        raise MediaUploadError("output_missing", False) from None
    if root not in file.parents or not file.is_file():
        raise MediaUploadError("output_outside_root", False)
    mime = MIME_BY_SUFFIX.get(file.suffix.lower())
    if mime is None:
        raise MediaUploadError("output_unsupported_type", False)
    try:
        size = file.stat().st_size
        if size == 0:
            raise MediaUploadError("output_empty", False)
        if size > MAX_MEDIA_BYTES:
            raise MediaUploadError("output_too_large", False)
        data = file.read_bytes()
    except OSError:
        raise MediaUploadError("output_missing", False) from None
    if not data:
        raise MediaUploadError("output_empty", False)
    if len(data) > MAX_MEDIA_BYTES:
        raise MediaUploadError("output_too_large", False)
    return mime, data, hashlib.sha256(data).hexdigest()


async def upload_outputs(
    client: WorkerApiClient,
    job_id: str,
    token: int,
    paths: list[str],
    output_root: Path | None,
    *,
    attempts: int = UPLOAD_ATTEMPTS,
    backoff: float = 2.0,
    sleep: Callable[[float], Awaitable[None]] = asyncio.sleep,
) -> int:
    """Uploads every path in order. Returns the number uploaded.

    LeaseLost propagates untouched (the caller must then send nothing more). Server rejections other than
    429/5xx are permanent. Transport errors, 429 and 5xx are retried up to `attempts` times in total.
    """
    if not client.can_upload:
        raise MediaUploadError("upload_not_configured", False)
    uploaded = 0
    for path in paths:
        mime, data, digest = await asyncio.to_thread(load_output, path, output_root)
        for attempt in range(1, attempts + 1):
            try:
                await client.upload_media(job_id, token, mime=mime, sha256=digest, data=data)
                uploaded += 1
                break
            except LeaseLost:
                raise
            except ApiError as exc:
                if exc.status < 500 and exc.status != 429:
                    raise MediaUploadError("media_rejected", False) from None
            except Exception:
                pass  # transport error (timeout, connection reset): transient
            if attempt == attempts:
                raise MediaUploadError("media_upload_failed", True)
            await sleep(backoff * attempt)
    return uploaded
