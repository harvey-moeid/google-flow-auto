"""Client for the worker-facing queue API (/api/worker/*).

The wire protocol is defined by apps/api/src/worker-routes.ts (queue) and apps/api/src/media-routes.ts
(media upload). Every job-scoped call presents the (worker_id, fencing_token) issued by /claim; the server
rejects stale ones with 409 lease_lost.

The transports are injectable so the protocol can be tested without a network. The real transport
(HttpxTransport) imports httpx lazily and never logs or echoes the bearer token.
"""
from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Any, Awaitable, Callable
from urllib.parse import urlsplit

from accounts.slots import slot_from_account_id

WORKER_ID_RE = re.compile(r"^[A-Za-z0-9._:-]{1,64}$")

# (path, json body) -> (http status, parsed json body or None)
Transport = Callable[[str, dict], Awaitable[tuple[int, Any]]]
# (path, raw bytes, headers) -> (http status, parsed json body or None)
UploadTransport = Callable[[str, bytes, dict], Awaitable[tuple[int, Any]]]


class ApiError(Exception):
    def __init__(self, status: int, code: str):
        super().__init__(f"{status} {code}")
        self.status = status
        self.code = code


class LeaseLost(ApiError):
    """This worker no longer holds the lease. Stop immediately and change nothing else."""


class CancelRequested(ApiError):
    """The owner asked to cancel this job. Acknowledge with cancel_ack."""


@dataclass(frozen=True)
class Claim:
    job: dict
    fencing_token: int
    lease_expires_at: str


def validate_api_base_url(url: str) -> str:
    """The bearer token must never travel over plain HTTP to a remote host."""
    parts = urlsplit(url)
    if parts.scheme == "https" and parts.hostname:
        return url.rstrip("/")
    if parts.scheme == "http" and parts.hostname in ("127.0.0.1", "localhost", "::1"):
        return url.rstrip("/")
    raise ValueError("API_BASE_URL must be https (plain http is allowed only for localhost)")


class HttpxTransport:
    def __init__(self, base_url: str, token: str, timeout: float = 30.0, upload_timeout: float = 180.0):
        import httpx  # lazy: only the real worker needs it

        if not token:
            raise ValueError("WORKER_TOKEN is required")
        self._upload_timeout = upload_timeout
        self._client = httpx.AsyncClient(
            base_url=validate_api_base_url(base_url),
            headers={"authorization": f"Bearer {token}"},
            timeout=timeout,
        )

    async def __call__(self, path: str, body: dict) -> tuple[int, Any]:
        response = await self._client.post(path, json=body)
        try:
            data = response.json()
        except ValueError:
            data = None
        return response.status_code, data

    async def post_bytes(self, path: str, data: bytes, headers: dict) -> tuple[int, Any]:
        """Raw-body POST for media upload. Uses a longer timeout; the bearer header comes from the client."""
        response = await self._client.post(path, content=data, headers=headers, timeout=self._upload_timeout)
        try:
            parsed = response.json()
        except ValueError:
            parsed = None
        return response.status_code, parsed

    async def aclose(self) -> None:
        await self._client.aclose()


class WorkerApiClient:
    def __init__(self, transport: Transport, worker_id: str, upload_transport: UploadTransport | None = None):
        if not WORKER_ID_RE.match(worker_id):
            raise ValueError("worker_id must match [A-Za-z0-9._:-] and be 1-64 characters")
        self._transport = transport
        self._upload_transport = upload_transport
        self.worker_id = worker_id

    @property
    def can_upload(self) -> bool:
        return self._upload_transport is not None

    @staticmethod
    def _check(status: int, data: Any) -> Any:
        if 200 <= status < 300:
            return data
        code = "unknown_error"
        if isinstance(data, dict) and isinstance(data.get("error"), dict):
            raw = data["error"].get("code")
            if isinstance(raw, str):
                code = raw
        if status == 409 and code == "lease_lost":
            raise LeaseLost(status, code)
        if status == 409 and code == "cancel_requested":
            raise CancelRequested(status, code)
        raise ApiError(status, code)

    async def _post(self, path: str, body: dict) -> Any:
        status, data = await self._transport(path, body)
        return self._check(status, data)

    def _ref(self, token: int) -> dict:
        return {"worker_id": self.worker_id, "fencing_token": token}

    async def claim(self, lease_seconds: int = 60) -> Claim | None:
        data = await self._post("/api/worker/claim", {"worker_id": self.worker_id, "lease_seconds": lease_seconds})
        if not isinstance(data, dict) or not data.get("claimed"):
            return None
        return Claim(job=data["job"], fencing_token=data["lease"]["fencing_token"], lease_expires_at=data["lease"]["expires_at"])

    async def start(self, job_id: str, token: int) -> None:
        await self._post(f"/api/worker/jobs/{job_id}/start", self._ref(token))

    async def heartbeat(self, job_id: str, token: int, lease_seconds: int = 60) -> bool:
        """Extends the lease. Returns True when the owner has asked to cancel this job."""
        data = await self._post(f"/api/worker/jobs/{job_id}/heartbeat", {**self._ref(token), "lease_seconds": lease_seconds})
        return bool(isinstance(data, dict) and data.get("cancel_requested"))

    async def complete(self, job_id: str, token: int, result_key: str | None = None) -> None:
        body = self._ref(token)
        if result_key is not None:
            body["result_key"] = result_key
        await self._post(f"/api/worker/jobs/{job_id}/complete", body)

    async def fail(self, job_id: str, token: int, error_code: str, error_message: str, retryable: bool) -> None:
        await self._post(
            f"/api/worker/jobs/{job_id}/fail",
            {**self._ref(token), "error_code": error_code, "error_message": error_message[:500], "retryable": retryable},
        )

    async def wait_for_user(self, job_id: str, token: int) -> None:
        await self._post(f"/api/worker/jobs/{job_id}/wait", self._ref(token))

    async def cancel_ack(self, job_id: str, token: int) -> None:
        await self._post(f"/api/worker/jobs/{job_id}/cancel-ack", self._ref(token))

    # ---------- Phase 6B: media upload ----------

    async def upload_media(self, job_id: str, token: int, *, mime: str, sha256: str, data: bytes) -> dict:
        """POSTs one output file to /api/worker/jobs/:jobId/media. 201 = stored, 200 = idempotent replay.

        The lease is carried in headers (x-worker-id / x-fencing-token) because the body is the raw file.
        """
        if self._upload_transport is None:
            raise RuntimeError("upload transport is not configured")
        headers = {
            "content-type": mime,
            "x-worker-id": self.worker_id,
            "x-fencing-token": str(token),
            "x-content-sha256": sha256,
        }
        status, body = await self._upload_transport(f"/api/worker/jobs/{job_id}/media", data, headers)
        result = self._check(status, body)
        return result if isinstance(result, dict) else {}

    # ---------- Phase 4b: worker health and account readiness ----------

    async def report_status(
        self,
        state: str,
        *,
        profile_count: int,
        disk_free_bytes: int | None = None,
        disk_total_bytes: int | None = None,
    ) -> None:
        """Process-level heartbeat (idle/busy/stopping). Disk numbers are sent as a pair or not at all."""
        body: dict = {"worker_id": self.worker_id, "state": state, "profile_count": profile_count}
        if disk_free_bytes is not None and disk_total_bytes is not None:
            body["disk_free_bytes"] = disk_free_bytes
            body["disk_total_bytes"] = disk_total_bytes
        await self._post("/api/worker/status", body)

    async def report_readiness(self, account_id: str, status: str, *, owner_confirmed: bool = False) -> None:
        """Reports the session state of one slot. `ready` is only accepted by the API with owner_confirmed=True."""
        slot_from_account_id(account_id)  # strict acct-01..acct-10, so the URL path can never be forged
        body = {"worker_id": self.worker_id, "status": status}
        if owner_confirmed:
            body["owner_confirmed"] = True
        await self._post(f"/api/worker/accounts/{account_id}/readiness", body)
