from __future__ import annotations
import argparse, asyncio, getpass, json, os, re, signal, socket, sys
from dotenv import load_dotenv
from accounts.profile_manager import ProfileManager
from scheduler.sequential import SequentialScheduler, Job
from adapters.dry_run import DryRunAdapter
from adapters.base import NotConfiguredAdapter
from worker import health, profile_audit
from worker.api_client import HttpxTransport, WorkerApiClient
from worker.enroll import DEFAULT_ENROLL_URL, enroll
from worker.host_lock import HostLock, HostLocked
from worker.loop import serve
from worker.profile_backup import ProfileBackupError, create_backup, restore_backup

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


def audit_or_exit(data_dir):
    """Refuses to open any browser profile while an isolation problem exists. Reports slot numbers and codes only."""
    result = profile_audit.audit(data_dir)
    if not result.ok:
        detail = ", ".join(p["code"] + (f" (slot {p['slot']})" if p["slot"] else "") for p in result.problems)
        sys.exit(f"Profile isolation check failed: {detail}")


async def run(args, data_dir, headless):
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


def run_profile_backup(args, data_dir):
    if args.backup_profiles:
        passphrase = getpass.getpass("Backup passphrase (minimum 12 characters): ")
        confirm = getpass.getpass("Confirm passphrase: ")
        if passphrase != confirm:
            raise ProfileBackupError("Passphrases do not match")
        return create_backup(data_dir, args.backup_profiles, passphrase)
    passphrase = getpass.getpass("Backup passphrase: ")
    return restore_backup(data_dir, args.restore_profiles, passphrase)


async def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--job-id")
    parser.add_argument("--account-id", default="acct-01")
    parser.add_argument("--engine", default="dry-run", choices=["dry-run", "flowkit", "gflow"])
    parser.add_argument("--serve", action="store_true", help="poll the queue API until stopped")
    parser.add_argument("--once", action="store_true", help="poll the queue API for at most one job")
    parser.add_argument("--enroll", metavar="ACCOUNT_ID", help="open ONLY this slot's profile so the owner can sign in by hand (stop --serve first)")
    parser.add_argument("--audit-profiles", action="store_true", help="read-only profile isolation check; prints JSON (slot numbers and codes only), exit 1 on a problem")
    backup = parser.add_mutually_exclusive_group()
    backup.add_argument("--backup-profiles", metavar="FILE", help="create a new owner-encrypted profile backup (worker must be stopped)")
    backup.add_argument("--restore-profiles", metavar="FILE", help="restore an encrypted backup only into an empty profile directory")
    args = parser.parse_args()
    data_dir = os.getenv("FLOW_WORKER_DATA_DIR", "./.worker-data")
    headless = os.getenv("FLOW_HEADLESS", "false").lower() == "true"
    if args.audit_profiles:
        result = profile_audit.audit(data_dir)
        print(json.dumps(result.as_dict()))
        sys.exit(0 if result.ok else 1)
    if args.backup_profiles or args.restore_profiles:
        if args.serve or args.once or args.enroll or args.job_id:
            parser.error("profile backup/restore cannot be combined with worker or job actions")
        try:
            with HostLock(data_dir):
                print(json.dumps(run_profile_backup(args, data_dir)))
        except (HostLocked, ProfileBackupError) as exc:
            sys.exit(str(exc))
        return
    if args.enroll and headless:
        sys.exit("--enroll needs a visible browser window; set FLOW_HEADLESS=false")
    try:
        lock = HostLock(data_dir).acquire()
    except HostLocked as exc:
        sys.exit(str(exc))
    try:
        audit_or_exit(data_dir)
        await run(args, data_dir, headless)
    finally:
        lock.release()


if __name__ == "__main__":
    asyncio.run(main())
