"""CLI guards in worker.main. They exit before any browser is launched, so no Chromium is needed."""
import json
import os
import subprocess
import sys

import pytest

pytest.importorskip("dotenv")
pytest.importorskip("playwright")
pytest.importorskip("httpx")

from worker.host_lock import HostLock
from worker.profile_audit import MARKER_NAME


def run_main(data_dir, *args):
    env = {**os.environ, "FLOW_WORKER_DATA_DIR": str(data_dir), "FLOW_HEADLESS": "true", "API_BASE_URL": "https://example.invalid", "WORKER_TOKEN": "x"}
    return subprocess.run([sys.executable, "-m", "worker.main", *args], env=env, capture_output=True, text=True, timeout=60)


def test_audit_profiles_reports_ok_on_empty_dir(tmp_path):
    proc = run_main(tmp_path, "--audit-profiles")
    assert proc.returncode == 0
    assert json.loads(proc.stdout) == {"ok": True, "checked": 0, "problems": [], "unmarked": []}


def test_audit_profiles_exits_1_and_hides_paths(tmp_path):
    d = tmp_path / "profiles" / "slot-02"
    d.mkdir(parents=True)
    (d / MARKER_NAME).write_text("slot-01\n")
    proc = run_main(tmp_path, "--audit-profiles")
    assert proc.returncode == 1
    out = json.loads(proc.stdout)
    assert out["problems"] == [{"slot": 2, "code": "marker_mismatch"}]
    assert str(tmp_path) not in proc.stdout + proc.stderr


def test_serve_refuses_to_start_when_data_dir_is_locked(tmp_path):
    lock = HostLock(tmp_path).acquire()  # keep the reference alive
    try:
        proc = run_main(tmp_path, "--once")
    finally:
        lock.release()
    assert proc.returncode != 0
    assert "already holds this data directory" in proc.stderr


def test_serve_refuses_to_start_on_failed_isolation_audit(tmp_path):
    (tmp_path / "profiles" / "slot-1").mkdir(parents=True)  # alias directory
    proc = run_main(tmp_path, "--once")
    assert proc.returncode != 0
    assert "Profile isolation check failed: unexpected_entry" in proc.stderr
    assert str(tmp_path) not in proc.stderr
