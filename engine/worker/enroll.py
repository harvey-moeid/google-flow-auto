"""Manual enrollment of ONE account slot (Phase 4b).

The owner signs in by hand in a visible Chromium window that uses only the selected slot's profile.
This module never types credentials, never reads cookies and never decides by itself that a login
worked: the account becomes `ready` only after the owner explicitly confirms, and that confirmation
is passed to the API as `owner_confirmed=True`.

Operational rule (also in docs/WORKER_OPERATIONS.md): stop `--serve` before enrolling. One browser
profile cannot be open twice, and the API refuses a readiness change while a job of the account runs.
"""
from __future__ import annotations

import asyncio
from typing import Awaitable, Callable
from urllib.parse import urlsplit

from accounts.slots import slot_from_account_id
from worker.api_client import WorkerApiClient

# Google's public sign-in page. Override with FLOW_ENROLL_URL; it is only where the window opens.
DEFAULT_ENROLL_URL = "https://accounts.google.com/"

Confirm = Callable[[str], Awaitable[bool]]


def validate_enroll_origin(url: str) -> str:
    parts = urlsplit(url)
    if parts.scheme != "https" or not parts.hostname:
        raise ValueError("FLOW_ENROLL_URL must be an https URL")
    return url


async def confirm_from_terminal(account_id: str) -> bool:
    answer = await asyncio.to_thread(
        input, f"Login {account_id} sudah selesai di jendela browser? Ketik 'ya' untuk menandai ready (lainnya = batal): "
    )
    return answer.strip().lower() in ("ya", "y", "yes")


async def enroll(
    account_id: str,
    profile_manager,
    client: WorkerApiClient,
    *,
    origin: str = DEFAULT_ENROLL_URL,
    confirm: Confirm = confirm_from_terminal,
    log: Callable[[str], None] = print,
) -> str:
    """Returns "ready" (reported) or "cancelled" (nothing reported, status unchanged)."""
    slot_from_account_id(account_id)  # fail before any browser is launched
    origin = validate_enroll_origin(origin)
    await profile_manager.open_for_manual_login(account_id, origin)
    try:
        confirmed = await confirm(account_id)
    finally:
        # Close first so the session is flushed to the profile directory before anything is reported.
        await profile_manager.close_account(account_id)
    if not confirmed:
        log(f"enrollment of {account_id} cancelled; account status unchanged")
        return "cancelled"
    await client.report_readiness(account_id, "ready", owner_confirmed=True)
    log(f"{account_id}: reported ready (owner confirmed)")
    return "ready"
