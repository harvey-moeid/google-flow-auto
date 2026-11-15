"""Claim -> run -> report loop for one worker.

Rules this module enforces (see apps/api/src/queue.ts for the server side):
  * One job at a time. The server also enforces a single global lease; this loop never overlaps itself.
  * The lease is kept alive by heartbeats while the adapter runs.
  * After LeaseLost the worker stops the adapter and sends NOTHING further for that job.
  * Nothing sensitive is reported: error messages carry only the exception class name, and logs carry
    only job ids and outcomes (never prompts, tokens or profile paths).
"""
from __future__ import annotations

import asyncio
import time
from typing import Callable

from adapters.base import AuthRequired, EngineNotConfigured
from scheduler.sequential import Job
from worker.api_client import CancelRequested, Claim, LeaseLost, WorkerApiClient


async def _stop(task: asyncio.Task) -> None:
    task.cancel()
    await asyncio.gather(task, return_exceptions=True)


async def process_claim(
    client: WorkerApiClient,
    scheduler,
    claim: Claim,
    *,
    heartbeat_interval: float = 20.0,
    lease_seconds: int = 60,
) -> str:
    """Runs one claimed job and reports the outcome. Returns the outcome label."""
    job = claim.job
    job_id: str = job["id"]
    token = claim.fencing_token
    try:
        try:
            await client.start(job_id, token)
        except CancelRequested:
            await client.cancel_ack(job_id, token)
            return "cancelled"

        scene = job.get("scene")
        if scene is None:
            # The scene was deleted after queuing. Never invent a prompt; retrying cannot help.
            await client.fail(job_id, token, "scene_missing", "The scene for this job no longer exists", retryable=False)
            return "failed"

        run = asyncio.create_task(
            scheduler.execute(
                Job(
                    id=job_id,
                    account_id=job["account_id"],
                    engine=job["engine"],
                    payload={"aspect_ratio": job["aspect_ratio"], "scene": scene, "attempt": job["attempt"]},
                )
            )
        )
        try:
            while True:
                done, _ = await asyncio.wait({run}, timeout=heartbeat_interval)
                if done:
                    break
                try:
                    cancel_requested = await client.heartbeat(job_id, token, lease_seconds)
                except LeaseLost:
                    await _stop(run)
                    return "lease_lost"
                except Exception:
                    continue  # transient network/API error: try again next tick; the server expires the lease if it lasts
                if cancel_requested:
                    await _stop(run)
                    await client.cancel_ack(job_id, token)
                    return "cancelled"
        except BaseException:
            await _stop(run)  # shutdown or unexpected error: never leave the adapter running
            raise

        try:
            run.result()
        except AuthRequired:
            await client.wait_for_user(job_id, token)
            return "waiting_for_user"
        except EngineNotConfigured:
            await client.fail(job_id, token, "engine_not_configured", "The selected engine is not configured", retryable=False)
            return "failed"
        except Exception as exc:
            await client.fail(job_id, token, "adapter_error", type(exc).__name__, retryable=True)
            return "failed"
        await client.complete(job_id, token)
        return "succeeded"
    except LeaseLost:
        return "lease_lost"


async def _sleep(stop: asyncio.Event, seconds: float) -> None:
    try:
        await asyncio.wait_for(stop.wait(), timeout=seconds)
    except asyncio.TimeoutError:
        pass


async def _report_status(client: WorkerApiClient, provider, state: str, log: Callable[[str], None]) -> None:
    """Best-effort process heartbeat. A failure here must never affect a job, so only the class name is logged."""
    if provider is None:
        return
    try:
        await client.report_status(**provider(state))
    except Exception as exc:
        log(f"status report failed: {type(exc).__name__}")


async def serve(
    client: WorkerApiClient,
    scheduler,
    stop: asyncio.Event,
    *,
    once: bool = False,
    poll_interval: float = 5.0,
    max_backoff: float = 60.0,
    heartbeat_interval: float = 20.0,
    lease_seconds: int = 60,
    log: Callable[[str], None] = print,
    status_provider: Callable[[str], dict] | None = None,
    status_interval: float = 30.0,
    clock: Callable[[], float] = time.monotonic,
) -> None:
    """Polls the queue until `stop` is set. A job in progress is always finished (or reported) first.

    `status_provider(state)` returns the keyword arguments of WorkerApiClient.report_status; when given,
    the worker reports idle every `status_interval` seconds, busy while a job runs and stopping on exit.
    """
    backoff = 1.0
    last_report = float("-inf")
    try:
        while not stop.is_set():
            if clock() - last_report >= status_interval:
                await _report_status(client, status_provider, "idle", log)
                last_report = clock()
            try:
                claim = await client.claim(lease_seconds)
            except Exception as exc:
                if once:
                    raise
                log(f"claim failed: {type(exc).__name__}; retrying in {backoff:.0f}s")
                await _sleep(stop, backoff)
                backoff = min(backoff * 2, max_backoff)
                continue
            backoff = 1.0
            if claim is None:
                if once:
                    return
                await _sleep(stop, poll_interval)
                continue
            await _report_status(client, status_provider, "busy", log)
            outcome = await process_claim(
                client, scheduler, claim, heartbeat_interval=heartbeat_interval, lease_seconds=lease_seconds
            )
            log(f"job {claim.job['id']}: {outcome}")
            last_report = float("-inf")  # report idle again on the next iteration
            if once:
                return
    finally:
        await _report_status(client, status_provider, "stopping", log)
