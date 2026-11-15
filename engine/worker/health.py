"""Local worker health: disk space and profile directories. Read-only and free of Playwright.

What is reported to the API (see apps/api/src/worker-health.ts) is deliberately small: a state label,
byte counts for the worker data disk and how many `slot-NN` profile directories exist. Paths, file
names, account e-mails and profile contents never leave the host.
"""
from __future__ import annotations

import re
import shutil
from pathlib import Path

# Same pattern ProfileManager uses to name profile directories: slot-01 .. slot-10.
_PROFILE_DIR = re.compile(r"slot-(0[1-9]|10)")

WORKER_STATES = ("idle", "busy", "stopping")


def count_profiles(data_dir: str | Path) -> int:
    """Number of existing slot-NN directories under <data_dir>/profiles (0 if none or unreadable)."""
    root = Path(data_dir) / "profiles"
    try:
        return sum(1 for entry in root.iterdir() if entry.is_dir() and _PROFILE_DIR.fullmatch(entry.name))
    except OSError:
        return 0


def collect(data_dir: str | Path, state: str) -> dict:
    """Keyword arguments for WorkerApiClient.report_status.

    Disk numbers are omitted (never guessed) when the disk cannot be read; the API then stores NULL
    and never raises a low-disk flag from missing data.
    """
    if state not in WORKER_STATES:
        raise ValueError("Unknown worker state")
    status: dict = {"state": state, "profile_count": count_profiles(data_dir)}
    try:
        usage = shutil.disk_usage(Path(data_dir))
    except OSError:
        return status
    status["disk_free_bytes"] = int(usage.free)
    status["disk_total_bytes"] = int(usage.total)
    return status
