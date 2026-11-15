"""Phase 6B step 1: the worker uploads adapter output files to the private media API before `complete`.

No network, browser or Google login is involved. Tests are plain sync functions that call asyncio.run.
"""
import asyncio
import hashlib
import os

import pytest

from adapters.base import NotConfiguredAdapter
from scheduler.sequential import SequentialScheduler
from worker import media
from worker.api_client import Claim, WorkerApiClient
from worker.loop import process_claim

JOB_ID = "11111111-2222-4333-8444-555555555555"
TOKEN = 7
PNG = b"\x89PNG\r\n\x1a\n" + b"x" * 32


def job_dict():
    return {
        "id": JOB_ID,
        "project_id": "p1",
        "scene_id": "s1",
        "account_id": "acct-01",
        "engine": "dry-run",
        "attempt": 1,
        "max_attempts": 3,
        "aspect_ratio": "9:16",
        "scene": {"id": "s1", "order": 1, "prompt": "Kucing berlari", "duration_seconds": 5},
    }


class FakeApi:
    def __init__(self, script=None):
        self.script = script or {}
        self.calls = []

    async def __call__(self, path, body):
        self.calls.append((path, body))
        item = self.script.get(path.rsplit("/", 1)[-1], (200, {}))
        return item(body) if callable(item) else item

    def suffixes(self):
        return [path.rsplit("/", 1)[-1] for path, _ in self.calls]

    def body_of(self, suffix):
        return next(body for path, body in self.calls if path.endswith("/" + suffix))


class FakeUpload:
    """Scripted upload transport. `script` entries are (status, body) tuples or exceptions to raise; the last repeats."""

    def __init__(self, script=None, delay=0.0, on_call=None):
        self.script = script or [(201, {"id": "m1"})]
        self.delay = delay
        self.on_call = on_call
        self.calls = []

    async def __call__(self, path, data, headers):
        self.calls.append((path, data, headers))
        if self.on_call:
            self.on_call()
        if self.delay:
            await asyncio.sleep(self.delay)
        item = self.script[min(len(self.calls) - 1, len(self.script) - 1)]
        if isinstance(item, Exception):
            raise item
        return item


class ResultAdapter:
    def __init__(self, result):
        self.result = result

    async def run(self, job, profile_manager):
        return self.result


def error(status, code):
    return status, {"error": {"code": code, "message": "x", "request_id": "r"}}


def write(directory, name, content=PNG):
    directory.mkdir(parents=True, exist_ok=True)
    path = directory / name
    path.write_bytes(content)
    return path


def run_claim(api, upload, result, **kwargs):
    claim = Claim(job=job_dict(), fencing_token=TOKEN, lease_expires_at="x")
    kwargs.setdefault("heartbeat_interval", 0.01)
    kwargs.setdefault("upload_backoff", 0.0)
    client = WorkerApiClient(api, "worker-test", upload_transport=upload)
    scheduler = SequentialScheduler(object(), {"dry-run": ResultAdapter(result), "flowkit": NotConfiguredAdapter()})
    return asyncio.run(process_claim(client, scheduler, claim, **kwargs))


# ---------- client ----------

def test_upload_media_accepts_idempotent_replay():
    upload = FakeUpload([(200, {"id": "m1", "idempotent_replay": True})])
    client = WorkerApiClient(FakeApi(), "worker-test", upload_transport=upload)
    result = asyncio.run(client.upload_media(JOB_ID, TOKEN, mime="image/png", sha256="a" * 64, data=b"x"))
    assert result["idempotent_replay"] is True


def test_client_without_upload_transport_cannot_upload():
    assert WorkerApiClient(FakeApi(), "worker-test").can_upload is False
    assert WorkerApiClient(FakeApi(), "worker-test", upload_transport=FakeUpload()).can_upload is True


# ---------- loop: happy path ----------

def test_output_is_uploaded_with_lease_headers_then_job_completes(tmp_path):
    root = tmp_path / "out"
    file = write(root, "clip.png")
    api, upload = FakeApi(), FakeUpload()
    assert run_claim(api, upload, {"outputs": [str(file)]}, output_root=root) == "succeeded"
    assert api.suffixes() == ["start", "complete"]
    ((path, data, headers),) = upload.calls
    assert path == f"/api/worker/jobs/{JOB_ID}/media"
    assert data == PNG
    assert headers == {
        "content-type": "image/png",
        "x-worker-id": "worker-test",
        "x-fencing-token": str(TOKEN),
        "x-content-sha256": hashlib.sha256(PNG).hexdigest(),
    }


def test_upload_happens_before_complete(tmp_path):
    root = tmp_path / "out"
    file = write(root, "clip.png")
    order = []
    api = FakeApi({"complete": lambda body: (order.append("complete"), (200, {}))[1]})
    upload = FakeUpload(on_call=lambda: order.append("upload"))
    assert run_claim(api, upload, {"outputs": [str(file)]}, output_root=root) == "succeeded"
    assert order == ["upload", "complete"]


def test_job_without_outputs_uploads_nothing(tmp_path):
    api, upload = FakeApi(), FakeUpload()
    assert run_claim(api, upload, {"ok": True, "mode": "dry-run"}) == "succeeded"
    assert upload.calls == []
    assert api.suffixes() == ["start", "complete"]


def test_multiple_outputs_are_uploaded_in_order(tmp_path):
    root = tmp_path / "out"
    first = write(root, "a.png", PNG + b"1")
    second = write(root, "b.webp", b"RIFF....WEBPxx")
    upload = FakeUpload()
    assert run_claim(FakeApi(), upload, {"outputs": [str(first), str(second)]}, output_root=root) == "succeeded"
    assert [call[2]["content-type"] for call in upload.calls] == ["image/png", "image/webp"]


def test_heartbeats_continue_while_uploading(tmp_path):
    root = tmp_path / "out"
    file = write(root, "clip.png")
    api = FakeApi({"heartbeat": (200, {"cancel_requested": False})})
    assert run_claim(api, FakeUpload(delay=0.1), {"outputs": [str(file)]}, output_root=root) == "succeeded"
    assert api.suffixes().count("heartbeat") >= 2
    assert api.suffixes()[-1] == "complete"


# ---------- loop: upload failures never lose or fake the result ----------

def test_transient_upload_errors_are_retried_then_succeed(tmp_path):
    root = tmp_path / "out"
    file = write(root, "clip.png")
    upload = FakeUpload([(503, None), ConnectionError("reset"), (201, {"id": "m1"})])
    api = FakeApi()
    assert run_claim(api, upload, {"outputs": [str(file)]}, output_root=root) == "succeeded"
    assert len(upload.calls) == 3
    assert api.suffixes() == ["start", "complete"]


def test_429_is_treated_as_transient(tmp_path):
    root = tmp_path / "out"
    file = write(root, "clip.png")
    upload = FakeUpload([error(429, "rate_limited"), (201, {"id": "m1"})])
    assert run_claim(FakeApi(), upload, {"outputs": [str(file)]}, output_root=root) == "succeeded"
    assert len(upload.calls) == 2


def test_exhausted_retries_fail_the_job_as_retryable_and_never_complete(tmp_path):
    root = tmp_path / "out"
    file = write(root, "clip.png")
    upload = FakeUpload([(503, None)])
    api = FakeApi()
    assert run_claim(api, upload, {"outputs": [str(file)]}, output_root=root) == "failed"
    assert len(upload.calls) == media.UPLOAD_ATTEMPTS
    assert api.suffixes() == ["start", "fail"]
    fail = api.body_of("fail")
    assert fail["error_code"] == "media_upload_failed" and fail["retryable"] is True


def test_server_rejection_is_permanent_and_not_retried(tmp_path):
    root = tmp_path / "out"
    file = write(root, "clip.png")
    upload = FakeUpload([error(415, "media_signature_mismatch")])
    api = FakeApi()
    assert run_claim(api, upload, {"outputs": [str(file)]}, output_root=root) == "failed"
    assert len(upload.calls) == 1
    fail = api.body_of("fail")
    assert fail["error_code"] == "media_rejected" and fail["retryable"] is False
    assert "complete" not in api.suffixes()


def test_lease_lost_during_upload_sends_nothing_more(tmp_path):
    root = tmp_path / "out"
    file = write(root, "clip.png")
    upload = FakeUpload([error(409, "lease_lost")])
    api = FakeApi()
    assert run_claim(api, upload, {"outputs": [str(file)]}, output_root=root) == "lease_lost"
    assert len(upload.calls) == 1
    assert api.suffixes() == ["start"]


def test_missing_upload_transport_fails_without_retry(tmp_path):
    root = tmp_path / "out"
    file = write(root, "clip.png")
    api = FakeApi()
    assert run_claim(api, None, {"outputs": [str(file)]}, output_root=root) == "failed"
    fail = api.body_of("fail")
    assert fail["error_code"] == "upload_not_configured" and fail["retryable"] is False


# ---------- loop: output validation ----------

def assert_rejected(api, upload, code):
    assert upload.calls == []
    assert api.suffixes() == ["start", "fail"]
    fail = api.body_of("fail")
    assert fail["error_code"] == code and fail["retryable"] is False


def test_output_root_must_be_configured(tmp_path):
    file = write(tmp_path / "out", "clip.png")
    api, upload = FakeApi(), FakeUpload()
    assert run_claim(api, upload, {"outputs": [str(file)]}, output_root=None) == "failed"
    assert_rejected(api, upload, "output_root_not_configured")


def test_file_outside_the_output_root_is_rejected(tmp_path):
    root = tmp_path / "out"
    root.mkdir()
    outside = write(tmp_path, "evil.png")
    api, upload = FakeApi(), FakeUpload()
    assert run_claim(api, upload, {"outputs": [str(outside)]}, output_root=root) == "failed"
    assert_rejected(api, upload, "output_outside_root")


def test_symlink_escaping_the_output_root_is_rejected(tmp_path):
    root = tmp_path / "out"
    root.mkdir()
    outside = write(tmp_path, "secret.png")
    link = root / "link.png"
    try:
        os.symlink(outside, link)
    except OSError:
        pytest.skip("symlinks are not available on this platform")
    api, upload = FakeApi(), FakeUpload()
    assert run_claim(api, upload, {"outputs": [str(link)]}, output_root=root) == "failed"
    assert_rejected(api, upload, "output_outside_root")


def test_dot_dot_traversal_is_rejected(tmp_path):
    root = tmp_path / "out"
    root.mkdir()
    write(tmp_path, "evil.png")
    api, upload = FakeApi(), FakeUpload()
    assert run_claim(api, upload, {"outputs": [str(root / ".." / "evil.png")]}, output_root=root) == "failed"
    assert_rejected(api, upload, "output_outside_root")


def test_missing_file_is_rejected(tmp_path):
    root = tmp_path / "out"
    root.mkdir()
    api, upload = FakeApi(), FakeUpload()
    assert run_claim(api, upload, {"outputs": [str(root / "nope.png")]}, output_root=root) == "failed"
    assert_rejected(api, upload, "output_missing")


def test_unsupported_file_type_is_rejected(tmp_path):
    root = tmp_path / "out"
    file = write(root, "notes.txt", b"hello")
    api, upload = FakeApi(), FakeUpload()
    assert run_claim(api, upload, {"outputs": [str(file)]}, output_root=root) == "failed"
    assert_rejected(api, upload, "output_unsupported_type")


def test_empty_file_is_rejected(tmp_path):
    root = tmp_path / "out"
    file = write(root, "clip.png", b"")
    api, upload = FakeApi(), FakeUpload()
    assert run_claim(api, upload, {"outputs": [str(file)]}, output_root=root) == "failed"
    assert_rejected(api, upload, "output_empty")


def test_oversized_file_is_rejected_before_upload(tmp_path, monkeypatch):
    monkeypatch.setattr(media, "MAX_MEDIA_BYTES", 10)
    root = tmp_path / "out"
    file = write(root, "clip.png", b"x" * 11)
    api, upload = FakeApi(), FakeUpload()
    assert run_claim(api, upload, {"outputs": [str(file)]}, output_root=root) == "failed"
    assert_rejected(api, upload, "output_too_large")


def test_malformed_outputs_list_is_rejected(tmp_path):
    api, upload = FakeApi(), FakeUpload()
    assert run_claim(api, upload, {"outputs": "clip.png"}, output_root=tmp_path) == "failed"
    assert_rejected(api, upload, "invalid_outputs")


def test_too_many_outputs_is_rejected(tmp_path):
    api, upload = FakeApi(), FakeUpload()
    outputs = [f"{i}.png" for i in range(media.MAX_OUTPUTS_PER_JOB + 1)]
    assert run_claim(api, upload, {"outputs": outputs}, output_root=tmp_path) == "failed"
    assert_rejected(api, upload, "too_many_outputs")


def test_reports_never_leak_paths_or_file_names(tmp_path):
    root = tmp_path / "out"
    root.mkdir()
    outside = write(tmp_path, "private-name.png")
    api = FakeApi()
    run_claim(api, FakeUpload(), {"outputs": [str(outside)]}, output_root=root)
    text = repr(api.calls)
    assert str(tmp_path) not in text and "private-name" not in text

def test_adapter_output_metadata_is_validated_and_forwarded(tmp_path):
    root = tmp_path / "out"
    file = write(root, "clip.png")
    api, upload = FakeApi(), FakeUpload()
    result = {"outputs": [{"path": str(file), "width": 1920, "height": 1080}]}
    assert run_claim(api, upload, result, output_root=root) == "succeeded"
    assert upload.calls[0][2]["x-media-width"] == "1920"
    assert upload.calls[0][2]["x-media-height"] == "1080"
    assert "x-media-duration-ms" not in upload.calls[0][2]


def test_adapter_output_metadata_rejects_partial_dimensions(tmp_path):
    root = tmp_path / "out"
    file = write(root, "clip.png")
    api, upload = FakeApi(), FakeUpload()
    assert run_claim(api, upload, {"outputs": [{"path": str(file), "width": 1920}]}, output_root=root) == "failed"
    assert_rejected(api, upload, "invalid_media_metadata")


def test_adapter_output_metadata_rejects_boolean_or_out_of_range_values():
    for metadata in ({"width": True, "height": 10}, {"width": 20000, "height": 10}):
        with pytest.raises(media.MediaUploadError):
            media.outputs_of({"outputs": [{"path": "clip.png", **metadata}]})

def test_video_metadata_can_include_dimensions_and_duration(tmp_path):
    root = tmp_path / "out"
    file = write(root, "clip.mp4", b"\x00\x00\x00\x18ftypisom" + b"x" * 20)
    parsed = media.outputs_of({"outputs": [{"path": str(file), "width": 1920, "height": 1080, "duration_ms": 12500}]})
    assert parsed[0]["width"] == 1920
    assert parsed[0]["height"] == 1080
    assert parsed[0]["duration_ms"] == 12500


def test_image_metadata_cannot_include_duration():
    with pytest.raises(media.MediaUploadError):
        media.outputs_of({"outputs": [{"path": "still.png", "duration_ms": 1000}]})
