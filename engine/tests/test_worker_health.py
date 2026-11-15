"""Phase 4b: health collection, status heartbeat in the serve loop, readiness client and manual enrollment.

Sync tests calling asyncio.run (no pytest-asyncio dependency). No browser, network or Google login.
"""
import asyncio

import pytest

from adapters.base import NotConfiguredAdapter
from scheduler.sequential import SequentialScheduler
from worker import health
from worker.api_client import ApiError, WorkerApiClient
from worker.enroll import enroll, validate_enroll_origin
from worker.loop import serve

from tests.test_worker_loop import FakeApi, claim_response, client_for, error, scheduler_for, CaptureAdapter


# ---------- health.collect ----------

def test_count_profiles_counts_only_slot_directories(tmp_path):
    profiles = tmp_path / "profiles"
    for name in ("slot-01", "slot-10", "slot-1", "slot-11", "slot-00", "other"):
        (profiles / name).mkdir(parents=True)
    (profiles / "slot-02").write_text("a file, not a directory")
    assert health.count_profiles(tmp_path) == 2


def test_count_profiles_is_zero_when_nothing_exists(tmp_path):
    assert health.count_profiles(tmp_path / "missing") == 0


def test_collect_reports_disk_and_profiles_but_no_paths(tmp_path):
    (tmp_path / "profiles" / "slot-03").mkdir(parents=True)
    status = health.collect(tmp_path, "idle")
    assert set(status) == {"state", "profile_count", "disk_free_bytes", "disk_total_bytes"}
    assert status["state"] == "idle" and status["profile_count"] == 1
    assert 0 <= status["disk_free_bytes"] <= status["disk_total_bytes"]
    assert str(tmp_path) not in repr(status)


def test_collect_omits_disk_numbers_when_the_disk_cannot_be_read(tmp_path, monkeypatch):
    def boom(_path):
        raise OSError("no disk")

    monkeypatch.setattr(health.shutil, "disk_usage", boom)
    assert health.collect(tmp_path, "busy") == {"state": "busy", "profile_count": 0}


def test_collect_rejects_unknown_states(tmp_path):
    with pytest.raises(ValueError):
        health.collect(tmp_path, "sleeping")


# ---------- client ----------

def test_report_status_sends_the_pair_or_nothing():
    api = FakeApi()
    client = client_for(api)
    asyncio.run(client.report_status("idle", profile_count=2, disk_free_bytes=5, disk_total_bytes=10))
    asyncio.run(client.report_status("busy", profile_count=0, disk_free_bytes=5))  # half a pair is dropped
    assert api.calls[0] == (
        "/api/worker/status",
        {"worker_id": "worker-test", "state": "idle", "profile_count": 2, "disk_free_bytes": 5, "disk_total_bytes": 10},
    )
    assert api.calls[1][1] == {"worker_id": "worker-test", "state": "busy", "profile_count": 0}


def test_report_readiness_only_sends_confirmation_when_given():
    api = FakeApi()
    client = client_for(api)
    asyncio.run(client.report_readiness("acct-04", "auth_required"))
    asyncio.run(client.report_readiness("acct-04", "ready", owner_confirmed=True))
    assert api.calls[0] == ("/api/worker/accounts/acct-04/readiness", {"worker_id": "worker-test", "status": "auth_required"})
    assert api.calls[1][1] == {"worker_id": "worker-test", "status": "ready", "owner_confirmed": True}


@pytest.mark.parametrize("bad", ["acct-1", "acct-11", "acct-01/../x", "", "ACCT-01"])
def test_report_readiness_rejects_forged_account_ids_before_any_request(bad):
    api = FakeApi()
    with pytest.raises(ValueError):
        asyncio.run(client_for(api).report_readiness(bad, "ready", owner_confirmed=True))
    assert api.calls == []


def test_report_readiness_surfaces_api_refusals():
    api = FakeApi({"readiness": error(409, "account_in_use")})
    with pytest.raises(ApiError) as info:
        asyncio.run(client_for(api).report_readiness("acct-01", "needs_login"))
    assert info.value.code == "account_in_use"


# ---------- serve loop heartbeat ----------

def provider(state):
    return {"state": state, "profile_count": 1, "disk_free_bytes": 5, "disk_total_bytes": 10}


def status_states(api):
    return [body["state"] for path, body in api.calls if path.endswith("/status")]


def test_serve_without_a_provider_sends_no_status():
    api = FakeApi({"claim": (200, {"claimed": False})})
    asyncio.run(serve(client_for(api), scheduler_for(CaptureAdapter()), asyncio.Event(), once=True))
    assert status_states(api) == []


def test_serve_reports_idle_busy_idle_and_stopping_around_a_job():
    api = FakeApi({"claim": [(200, claim_response()), (200, {"claimed": False})]})
    stop = asyncio.Event()
    ticks = iter(range(0, 10_000, 100))  # each clock() read jumps 100 s: every loop iteration is "due"

    async def run():
        task = asyncio.create_task(
            serve(
                client_for(api),
                scheduler_for(CaptureAdapter()),
                stop,
                poll_interval=0.01,
                heartbeat_interval=0.01,
                status_provider=provider,
                clock=lambda: float(next(ticks)),
                log=lambda _msg: None,
            )
        )
        for _ in range(200):
            await asyncio.sleep(0.01)
            if "complete" in api.suffixes():
                break
        await asyncio.sleep(0.05)
        stop.set()
        await task

    asyncio.run(run())
    states = status_states(api)
    assert states[0] == "idle" and states[-1] == "stopping" and "busy" in states
    # "busy" was reported before the job finished, and the job really ran.
    first_busy = next(i for i, (path, body) in enumerate(api.calls) if path.endswith("/status") and body["state"] == "busy")
    complete = next(i for i, (path, _body) in enumerate(api.calls) if path.endswith("/complete"))
    assert first_busy < complete


def test_serve_throttles_idle_reports_to_the_interval():
    api = FakeApi({"claim": (200, {"claimed": False})})
    stop = asyncio.Event()
    now = {"t": 0.0}

    async def run():
        task = asyncio.create_task(
            serve(client_for(api), scheduler_for(CaptureAdapter()), stop, poll_interval=0.005, status_provider=provider,
                  status_interval=30.0, clock=lambda: now["t"], log=lambda _msg: None)
        )
        await asyncio.sleep(0.1)  # many polls, but the fake clock has not moved
        now["t"] += 31.0
        await asyncio.sleep(0.1)
        stop.set()
        await task

    asyncio.run(run())
    assert status_states(api) == ["idle", "idle", "stopping"]


def test_a_failing_status_report_never_breaks_the_queue_loop():
    api = FakeApi({"status": error(500, "internal_error"), "claim": [(200, claim_response()), (200, {"claimed": False})]})
    logs = []
    asyncio.run(
        serve(client_for(api), scheduler_for(CaptureAdapter()), asyncio.Event(), once=True, heartbeat_interval=0.01,
              status_provider=provider, log=logs.append)
    )
    assert "complete" in api.suffixes(), "the job still ran and was reported"
    assert any("status report failed: ApiError" in line for line in logs)
    assert all("internal_error" not in line and "worker-test" not in line for line in logs)


# ---------- enrollment ----------

class FakeProfiles:
    def __init__(self):
        self.events = []

    async def open_for_manual_login(self, account_id, origin):
        self.events.append(("open", account_id, origin))

    async def close_account(self, account_id):
        self.events.append(("close", account_id))


def confirmer(answer):
    async def confirm(_account_id):
        return answer

    return confirm


def test_enroll_opens_only_the_selected_slot_then_reports_ready_after_closing():
    api, profiles = FakeApi(), FakeProfiles()
    result = asyncio.run(enroll("acct-05", profiles, client_for(api), confirm=confirmer(True), log=lambda _m: None))
    assert result == "ready"
    assert profiles.events == [("open", "acct-05", "https://accounts.google.com/"), ("close", "acct-05")]
    assert api.calls == [
        ("/api/worker/accounts/acct-05/readiness", {"worker_id": "worker-test", "status": "ready", "owner_confirmed": True})
    ]


def test_enroll_closes_the_browser_before_reporting_ready():
    profiles = FakeProfiles()

    def record_report(_body):
        profiles.events.append(("report",))
        return 200, {}

    api = FakeApi({"readiness": record_report})
    asyncio.run(enroll("acct-06", profiles, client_for(api), confirm=confirmer(True), log=lambda _m: None))
    assert [event[0] for event in profiles.events] == ["open", "close", "report"]


def test_enroll_cancelled_by_the_owner_reports_nothing_and_still_closes_the_browser():
    api, profiles = FakeApi(), FakeProfiles()
    assert asyncio.run(enroll("acct-05", profiles, client_for(api), confirm=confirmer(False), log=lambda _m: None)) == "cancelled"
    assert api.calls == []
    assert profiles.events[-1] == ("close", "acct-05")


def test_enroll_closes_the_browser_even_if_confirmation_crashes():
    async def broken(_account_id):
        raise RuntimeError("terminal closed")

    api, profiles = FakeApi(), FakeProfiles()
    with pytest.raises(RuntimeError):
        asyncio.run(enroll("acct-05", profiles, client_for(api), confirm=broken))
    assert profiles.events[-1] == ("close", "acct-05")
    assert api.calls == []


@pytest.mark.parametrize("bad", ["acct-1", "acct-11", "acct-01 ", "../acct-01"])
def test_enroll_rejects_invalid_slots_before_launching_a_browser(bad):
    api, profiles = FakeApi(), FakeProfiles()
    with pytest.raises(ValueError):
        asyncio.run(enroll(bad, profiles, client_for(api), confirm=confirmer(True)))
    assert profiles.events == [] and api.calls == []


def test_enroll_refuses_a_non_https_origin_before_launching_a_browser():
    api, profiles = FakeApi(), FakeProfiles()
    with pytest.raises(ValueError):
        asyncio.run(enroll("acct-01", profiles, client_for(api), origin="http://accounts.example", confirm=confirmer(True)))
    assert profiles.events == []
    assert validate_enroll_origin("https://accounts.google.com/") == "https://accounts.google.com/"


def test_enroll_propagates_an_api_refusal_after_the_session_is_saved():
    api, profiles = FakeApi({"readiness": error(409, "account_in_use")}), FakeProfiles()
    with pytest.raises(ApiError) as info:
        asyncio.run(enroll("acct-02", profiles, client_for(api), confirm=confirmer(True), log=lambda _m: None))
    assert info.value.code == "account_in_use"
    assert profiles.events[-1] == ("close", "acct-02")
