"""End-to-end smoke tests of `python -m worker.main`. No browser is launched and no Google login is needed."""
import os
import subprocess
import sys
from pathlib import Path

ENGINE_DIR = Path(__file__).resolve().parents[1]


def run_worker(tmp_path, *args):
    env = dict(os.environ)
    env["FLOW_WORKER_DATA_DIR"] = str(tmp_path / "worker-data")
    env["FLOW_HEADLESS"] = "true"
    return subprocess.run(
        [sys.executable, "-m", "worker.main", *args],
        cwd=ENGINE_DIR,
        env=env,
        capture_output=True,
        text=True,
        timeout=120,
    )


def test_dry_run_succeeds_and_opens_no_profile(tmp_path):
    proc = run_worker(tmp_path, "--engine", "dry-run", "--job-id", "smoke-1", "--account-id", "acct-02")
    assert proc.returncode == 0, proc.stderr
    assert "'mode': 'dry-run'" in proc.stdout
    assert "'job_id': 'smoke-1'" in proc.stdout
    profiles = tmp_path / "worker-data" / "profiles"
    assert profiles.is_dir()
    assert list(profiles.iterdir()) == []


def test_live_engine_refuses_to_run(tmp_path):
    proc = run_worker(tmp_path, "--engine", "flowkit", "--job-id", "smoke-2")
    assert proc.returncode != 0
    assert "not configured" in proc.stderr
