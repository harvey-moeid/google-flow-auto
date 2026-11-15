"""Worker API client + claim/run/report loop, against a scripted fake of /api/worker/*.

Tests are plain sync functions that call asyncio.run so they do not depend on pytest-asyncio.
No network, browser or Google login is involved.
"""
import asyncio

import pytest

from adapters.base import AuthRequired, NotConfiguredAdapter
from scheduler.sequential import SequentialScheduler
from worker.api_client import (
    ApiError,
    CancelRequested,
    Claim,
    LeaseLost,
    WorkerApiClient,
    validate_api_base_url,
)
from worker.loop import process_claim, serve

JOB_ID = "11111111-2222-4333-8444-555555555555"
TOKEN = 7


def job_dict(scene="default", engine="dry-run"):
    return {
        "id": JOB_ID,
        "project_id": "p1",
        "scene_id": "s1",
        "account_id": "acct-01",
        "engine": engine,
        "attempt": 1,
        "max_attempts": 3,
        "aspect_ratio": "9:16",
        "scene": {"id": "s1", "order": 1, "prompt": "Kucing berlari", "duration_seconds": 5} if scene == "default" else scene,
    }


def claim_response(job=None):
    return {"claimed": True, "job": job or job_dict(), "lease": {"fencing_token": TOKEN, "expires_at": "2026-11-15T00:00:00.000Z"}}


class FakeApi:
    """Records every call. `script` maps a path suffix to a response, a callable, or a list consumed in order."""

    def __init__(self, script=None):
        self.script = script or {}
        self.calls = []

    async def __call__(self, path, body):
        self.calls.append((path, body))
        key = path.rsplit("/", 1)[-1]
        item = self.script.get(key, (200, {}))
        if isinstance(item, list):
            item = item.pop(0) if len(item) > 1 else item[0]
        if callable(item):
            item = item(body)
        return item

    def suffixes(self):
        return [path.rsplit("/", 1)[-1] for path, _ in self.calls]

    def body_of(self, suffix):
        return next(body for path, body in self.calls if path.endswith("/" + suffix))


def error(status, code):
    return status, {"error": {"code": code, "message": "x", "request_id": "r"}}


class CaptureAdapter:
    def __init__(self, result=None, exc=None, delay=0.0):
        self.jobs, self.result, self.exc, self.delay = [], result or {"ok": True}, exc, delay

    async def run(self, job, profile_manager):
        self.jobs.append(job)
        if self.delay:
            await asyncio.sleep(self.delay)
        if self.exc:
            raise self.exc
        return self.result


def scheduler_for(adapter):
    return SequentialScheduler(object(), {"dry-run": adapter, "flowkit": NotConfiguredAdapter()})


def client_for(api):
    return WorkerApiClient(api, "worker-test")


def run_claim(api, adapter, job=None, **kwargs):
    claim = Claim(job=job or job_dict(), fencing_token=TOKEN, lease_expires_at="x")
    kwargs.setdefault("heartbeat_interval", 0.01)
    return asyncio.run(process_claim(client_for(api), scheduler_for(adapter), claim, **kwargs))


# ---------- client ----------

def test_claim_sends_worker_id_and_parses_payload():
    api = FakeApi({"claim": (200, claim_response())})
    claim = asyncio.run(client_for(api).claim(30))
    assert api.calls == [("/api/worker/claim", {"worker_id": "worker-test", "lease_seconds": 30})]
    assert claim.fencing_token == TOKEN
    assert claim.job["scene"]["prompt"] == "Kucing berlari"
    assert claim.job["aspect_ratio"] == "9:16"


def test_claim_returns_none_when_queue_is_empty():
    assert asyncio.run(client_for(FakeApi({"claim": (200, {"claimed": False})})).claim()) is None


def test_job_calls_carry_worker_id_and_fencing_token():
    api = FakeApi()
    client = client_for(api)

    async def go():
        await client.start(JOB_ID, TOKEN)
        await client.complete(JOB_ID, TOKEN, "results/a.mp4")
        await client.fail(JOB_ID, TOKEN, "adapter_error", "x" * 900, retryable=True)

    asyncio.run(go())
    assert api.calls[0] == (f"/api/worker/jobs/{JOB_ID}/start", {"worker_id": "worker-test", "fencing_token": TOKEN})
    assert api.body_of("complete")["result_key"] == "results/a.mp4"
    fail = api.body_of("fail")
    assert fail["retryable"] is True and len(fail["error_message"]) == 500


def test_error_mapping():
    async def call(response):
        return await client_for(FakeApi({"start": response})).start(JOB_ID, TOKEN)

    with pytest.raises(LeaseLost):
        asyncio.run(call(error(409, "lease_lost")))
    with pytest.raises(CancelRequested):
        asyncio.run(call(error(409, "cancel_requested")))
    with pytest.raises(ApiError) as info:
        asyncio.run(call(error(401, "unauthorized")))
    assert info.value.status == 401 and not isinstance(info.value, LeaseLost)
    with pytest.raises(ApiError) as other:
        asyncio.run(call((502, None)))
    assert other.value.code == "unknown_error"


def test_worker_id_is_validated_and_base_url_must_be_https():
    for bad in ["", "has space", "x" * 65, "a/b"]:
        with pytest.raises(ValueError):
            WorkerApiClient(FakeApi(), bad)
    assert validate_api_base_url("https://api.example.test/") == "https://api.example.test"
    assert validate_api_base_url("http://127.0.0.1:8787") == "http://127.0.0.1:8787"
    for bad in ["http://api.example.test", "ftp://x", "api.example.test", "https://", ""]:
        with pytest.raises(ValueError):
            validate_api_base_url(bad)


# ---------- loop ----------

def test_success_runs_adapter_with_scene_payload_then_completes():
    api = FakeApi()
    adapter = CaptureAdapter()
    assert run_claim(api, adapter) == "succeeded"
    assert api.suffixes() == ["start", "complete"]
    (job,) = adapter.jobs
    assert job.id == JOB_ID and job.account_id == "acct-01" and job.engine == "dry-run"
    assert job.payload["aspect_ratio"] == "9:16"
    assert job.payload["scene"]["prompt"] == "Kucing berlari"
    assert job.payload["scene"]["duration_seconds"] == 5


def test_missing_scene_fails_without_retry_and_never_runs_the_adapter():
    api = FakeApi()
    adapter = CaptureAdapter()
    assert run_claim(api, adapter, job_dict(scene=None)) == "failed"
    assert api.suffixes() == ["start", "fail"]
    fail = api.body_of("fail")
    assert fail["error_code"] == "scene_missing" and fail["retryable"] is False
    assert adapter.jobs == []


def test_unconfigured_live_engine_fails_without_retry():
    api = FakeApi()
    assert run_claim(api, CaptureAdapter(), job_dict(engine="flowkit")) == "failed"
    fail = api.body_of("fail")
    assert fail["error_code"] == "engine_not_configured" and fail["retryable"] is False


def test_adapter_error_is_retryable_and_leaks_no_message():
    api = FakeApi()
    secret = "cookie=SID-super-secret at /home/owner/profile"
    assert run_claim(api, CaptureAdapter(exc=RuntimeError(secret))) == "failed"
    fail = api.body_of("fail")
    assert fail["error_code"] == "adapter_error" and fail["retryable"] is True
    assert fail["error_message"] == "RuntimeError"
    assert secret not in repr(api.calls)


def test_auth_required_parks_the_job_instead_of_failing_it():
    api = FakeApi()
    assert run_claim(api, CaptureAdapter(exc=AuthRequired())) == "waiting_for_user"
    assert api.suffixes() == ["start", "wait"]


def test_cancel_requested_at_start_acknowledges_and_skips_the_adapter():
    api = FakeApi({"start": error(409, "cancel_requested")})
    adapter = CaptureAdapter()
    assert run_claim(api, adapter) == "cancelled"
    assert api.suffixes() == ["start", "cancel-ack"]
    assert adapter.jobs == []


def test_lease_lost_at_start_does_nothing_more():
    api = FakeApi({"start": error(409, "lease_lost")})
    adapter = CaptureAdapter()
    assert run_claim(api, adapter) == "lease_lost"
    assert api.suffixes() == ["start"]
    assert adapter.jobs == []


def test_heartbeats_keep_the_lease_alive_while_the_adapter_runs():
    api = FakeApi({"heartbeat": (200, {"cancel_requested": False})})
    assert run_claim(api, CaptureAdapter(delay=0.1), lease_seconds=45) == "succeeded"
    beats = [body for path, body in api.calls if path.endswith("/heartbeat")]
    assert len(beats) >= 2
    assert all(b["fencing_token"] == TOKEN and b["lease_seconds"] == 45 for b in beats)
    assert api.suffixes()[-1] == "complete"


def test_cancel_during_run_stops_the_adapter_and_acknowledges():
    api = FakeApi({"heartbeat": (200, {"cancel_requested": True})})
    adapter = CaptureAdapter(delay=5)
    assert asyncio.run(asyncio.wait_for(_cancel_run(api, adapter), timeout=2)) == "cancelled"
    assert "complete" not in api.suffixes() and "fail" not in api.suffixes()
    assert api.suffixes()[-1] == "cancel-ack"


async def _cancel_run(api, adapter):
    claim = Claim(job=job_dict(), fencing_token=TOKEN, lease_expires_at="x")
    return await process_claim(client_for(api), scheduler_for(adapter), claim, heartbeat_interval=0.01)


def test_lease_lost_during_run_stops_the_adapter_and_sends_nothing_more():
    api = FakeApi({"heartbeat": error(409, "lease_lost")})
    outcome = asyncio.run(asyncio.wait_for(_cancel_run(api, CaptureAdapter(delay=5)), timeout=2))
    assert outcome == "lease_lost"
    assert api.suffixes()[-1] == "heartbeat"
    assert not {"complete", "fail", "wait", "cancel-ack"} & set(api.suffixes())


def test_transient_heartbeat_errors_do_not_abort_the_job():
    api = FakeApi({"heartbeat": [(503, None), (200, {"cancel_requested": False})]})
    assert run_claim(api, CaptureAdapter(delay=0.08)) == "succeeded"
    assert api.suffixes()[-1] == "complete"


def test_lease_lost_on_complete_is_reported_as_lost_not_raised():
    api = FakeApi({"complete": error(409, "lease_lost")})
    assert run_claim(api, CaptureAdapter()) == "lease_lost"


# ---------- serve ----------

def test_serve_once_processes_exactly_one_job():
    api = FakeApi({"claim": (200, claim_response())})
    logs = []
    asyncio.run(serve(client_for(api), scheduler_for(CaptureAdapter()), asyncio.Event(), once=True, log=logs.append))
    assert api.suffixes() == ["claim", "start", "complete"]
    assert logs == [f"job {JOB_ID}: succeeded"]


def test_serve_once_with_empty_queue_returns():
    api = FakeApi({"claim": (200, {"claimed": False})})
    asyncio.run(serve(client_for(api), scheduler_for(CaptureAdapter()), asyncio.Event(), once=True))
    assert api.suffixes() == ["claim"]


def test_serve_backs_off_on_claim_errors_then_recovers_and_stops_gracefully():
    api = FakeApi({"claim": [(503, None), (503, None), (200, claim_response())]})
    stop = asyncio.Event()
    logs = []

    def log(message):
        logs.append(message)
        if "succeeded" in message:
            stop.set()

    asyncio.run(
        asyncio.wait_for(
            serve(client_for(api), scheduler_for(CaptureAdapter()), stop, poll_interval=0.01, max_backoff=0.02, log=log),
            timeout=5,
        )
    )
    assert any("claim failed: ApiError" in line for line in logs)
    assert logs[-1] == f"job {JOB_ID}: succeeded"
    assert api.suffixes().count("claim") == 3


def test_serve_once_propagates_claim_errors():
    api = FakeApi({"claim": error(401, "unauthorized")})
    with pytest.raises(ApiError):
        asyncio.run(serve(client_for(api), scheduler_for(CaptureAdapter()), asyncio.Event(), once=True))


def test_logs_never_contain_prompts_or_tokens():
    api = FakeApi({"claim": (200, claim_response())})
    logs = []
    asyncio.run(serve(client_for(api), scheduler_for(CaptureAdapter()), asyncio.Event(), once=True, log=logs.append))
    text = " ".join(logs)
    assert "Kucing berlari" not in text and str(TOKEN) not in text
