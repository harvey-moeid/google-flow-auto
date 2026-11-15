"""Phase 6B: uploads adapter outputs and optional trusted metadata before job completion."""
from __future__ import annotations

import asyncio
import hashlib
from pathlib import Path
from typing import Awaitable, Callable

from worker.api_client import ApiError, LeaseLost, WorkerApiClient

MAX_MEDIA_BYTES = 25 * 1024 * 1024
MAX_OUTPUTS_PER_JOB = 10
MAX_DIMENSION = 16_384
MAX_DURATION_MS = 86_400_000
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
    """Output handling failed. code is a fixed identifier safe to report to the API."""
    def __init__(self, code: str, retryable: bool):
        super().__init__(code)
        self.code = code
        self.retryable = retryable


def _metadata_integer(value, maximum: int):
    if value is None:
        return None
    if isinstance(value, bool) or not isinstance(value, int) or not 1 <= value <= maximum:
        raise MediaUploadError("invalid_media_metadata", False)
    return value


def outputs_of(result) -> list[dict]:
    """Accept legacy path strings or {path,width,height,duration_ms} adapter records."""
    if not isinstance(result, dict):
        return []
    raw = result.get("outputs")
    if raw is None:
        return []
    if not isinstance(raw, (list, tuple)) or len(raw) > MAX_OUTPUTS_PER_JOB:
        raise MediaUploadError("invalid_outputs" if not isinstance(raw, (list, tuple)) else "too_many_outputs", False)
    outputs = []
    for item in raw:
        if isinstance(item, (str, Path)):
            record = {"path": str(item)}
        elif isinstance(item, dict) and isinstance(item.get("path"), (str, Path)) and set(item) <= {"path", "width", "height", "duration_ms"}:
            record = dict(item)
            record["path"] = str(record["path"])
        else:
            raise MediaUploadError("invalid_outputs", False)
        width = _metadata_integer(record.get("width"), MAX_DIMENSION)
        height = _metadata_integer(record.get("height"), MAX_DIMENSION)
        duration = _metadata_integer(record.get("duration_ms"), MAX_DURATION_MS)
        if (width is None) != (height is None) or (width is not None and duration is not None):
            raise MediaUploadError("invalid_media_metadata", False)
        outputs.append({"path": record["path"], "width": width, "height": height, "duration_ms": duration})
    return outputs


def load_output(path: str, output_root: Path | None) -> tuple[str, bytes, str]:
    """Validates one output file and returns (mime, bytes, sha256 hex). Blocking: call in a thread."""
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
    paths: list[dict],
    output_root: Path | None,
    *,
    attempts: int = UPLOAD_ATTEMPTS,
    backoff: float = 2.0,
    sleep: Callable[[float], Awaitable[None]] = asyncio.sleep,
) -> int:
    """Uploads each output in order; retries transient errors and stops immediately on LeaseLost."""
    if not client.can_upload:
        raise MediaUploadError("upload_not_configured", False)
    uploaded = 0
    for output in paths:
        mime, data, digest = await asyncio.to_thread(load_output, output["path"], output_root)
        for attempt in range(1, attempts + 1):
            try:
                await client.upload_media(
                    job_id, token, mime=mime, sha256=digest, data=data,
                    width=output["width"], height=output["height"], duration_ms=output["duration_ms"],
                )
                uploaded += 1
                break
            except LeaseLost:
                raise
            except ApiError as exc:
                if exc.status < 500 and exc.status != 429:
                    raise MediaUploadError("media_rejected", False) from None
            except Exception:
                pass
            if attempt == attempts:
                raise MediaUploadError("media_upload_failed", True)
            await sleep(backoff * attempt)
    return uploaded
