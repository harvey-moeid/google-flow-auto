from __future__ import annotations
import argparse, asyncio, os, re, signal, socket, sys
from dotenv import load_dotenv
from accounts.profile_manager import ProfileManager
from scheduler.sequential import SequentialScheduler, Job
from adapters.dry_run import DryRunAdapter
from adapters.base import NotConfiguredAdapter
from worker import health
from worker.api_client import HttpxTransport, WorkerApiClient
from worker.enroll import DEFAULT_ENROLL_URL, enroll
from worker.loop import serve

load_dotenv()


def default_worker_id():
    return re.sub(r"[^A-Za-z0-9._:-]", "-", os.getenv("WORKER_ID") or f"worker-{socket.gethostname()}")[:64]


def make_transport():
    return HttpxTransport(os.getenv("API_BASE_URL", ""), os.getenv("WORKER_TOKEN", ""))


async def run_queue(scheduler, data_dir, once=False):
    transport = make_transport()
    client = WorkerApiClient(transport, default_worker_id())
    stop = asyncio.Event()
    if not once:
        loop = asyncio.get_running_loop()
        for sig in (signal.SIGINT, signal.SIGTERM):
            try:
                loop.add_signal_handler(sig, stop.set)
            except NotImplementedError:
                pass
    try:
        await serve(client, scheduler, stop, once=once, status_provider=lambda state: health.collect(data_dir, state))
    finally:
        await transport.aclose()


async def run_enroll(account_id, pm):
    transport = make_transport()
    try:
        return await enroll(account_id, pm, WorkerApiClient(transport, default_worker_id()), origin=os.getenv("FLOW_ENROLL_URL", DEFAULT_ENROLL_URL))
    finally:
        await transport.aclose()


async def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--job-id")
    parser.add_argument("--account-id", default="acct-01")
    parser.add_argument("--engine", default="dry-run", choices=["dry-run", "flowkit", "gflow"])
    parser.add_argument("--serve", action="store_true", help="poll the queue API until stopped")
    parser.add_argument("--once", action="store_true", help="poll the queue API for at most one job")
    parser.add_argument("--enroll", metavar="ACCOUNT_ID", help="open ONLY this slot's profile so the owner can sign in by hand (stop --serve first)")
    args = parser.parse_args()
    data_dir = os.getenv("FLOW_WORKER_DATA_DIR", "./.worker-data")
    headless = os.getenv("FLOW_HEADLESS", "false").lower() == "true"
    if args.enroll and headless:
        sys.exit("--enroll needs a visible browser window; set FLOW_HEADLESS=false")
    pm = ProfileManager(data_dir, headless=headless)
    await pm.start()
    if args.enroll:
        try:
            print(await run_enroll(args.enroll, pm))
        finally:
            await pm.close()
        return
    scheduler = SequentialScheduler(pm, {"dry-run": DryRunAdapter(), "flowkit": NotConfiguredAdapter(), "gflow": NotConfiguredAdapter()})
    if args.serve or args.once:
        try:
            await run_queue(scheduler, data_dir, once=args.once)
        finally:
            await pm.close()
        return
    job = Job(args.job_id or "local-test", args.account_id, args.engine, {})
    try:
        print(await scheduler.execute(job))
    finally:
        await pm.close()


if __name__ == "__main__":
    asyncio.run(main())
