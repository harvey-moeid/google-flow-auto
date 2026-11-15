# Worker host lifecycle (Phase 4D)

Status: code and unit tests only. The systemd unit and the procedures below have NOT been run on a real host,
and no real Chromium profile has been restarted. Do not tick the Phase 4 host checkboxes until the
verification steps at the end are done and recorded in `docs/HANDOFF.md`.

## What the code guarantees

| Guard | Where | Behaviour |
|---|---|---|
| One process per data directory | `engine/worker/host_lock.py` | `--serve`, `--once`, `--enroll` and the local single-job run take an OS advisory lock on `<data_dir>/worker.lock`. A second process exits with an error. The OS drops the lock when the holder dies (including SIGKILL), so there is nothing stale to clean up. |
| Profile isolation audit | `engine/worker/profile_audit.py` | Rejects aliases/copies (`slot-1`, `slot-01.bak`), symlinked or out-of-root slot dirs, two slots resolving to one directory, and a slot whose `.flow-slot` marker names another slot. Output is slot numbers and codes only. |
| Fail closed at startup | `engine/worker/main.py` | The same audit runs before any browser profile is opened; a failure exits non-zero. `--audit-profiles` runs it alone (read-only, safe while the worker runs). |
| Marker on first use | `engine/accounts/profile_manager.py` | Writes `.flow-slot` into a profile the first time it is opened (legacy profiles are adopted); refuses a directory marked for a different slot and refuses symlinks. |

None of this changes the queue, lease, D1 schema or API. Live engines stay disabled.

Known limits: the `shared_directory` check has no test (it needs a bind mount to trigger); the audit cannot
prove the disk is encrypted; the marker detects a copied profile only if the `.flow-slot` file was not also
rewritten by hand.

## Install on the trusted host (owner-run)

1. Use an encrypted volume for `FLOW_WORKER_DATA_DIR` (for example LUKS or an encrypted home on the host). Confirm the encryption yourself.
2. Create a dedicated user, a virtualenv under `/opt/google-flow-auto/engine/.venv`, install `engine/requirements.txt`, run `playwright install chromium`.
3. Create `/etc/google-flow-auto/worker.env` (mode 0600) with `API_BASE_URL`, `WORKER_TOKEN`, `WORKER_ID`, `FLOW_WORKER_DATA_DIR`, `FLOW_HEADLESS=true`. Never commit this file.
4. Copy `engine/deploy/google-flow-worker.service` to `/etc/systemd/system/`, adjust paths/user, then `systemctl daemon-reload` and `systemctl enable --now google-flow-worker`.

## Operate

- Status: `systemctl status google-flow-worker` and the Accounts tab (online/idle/busy).
- Graceful restart: `systemctl restart google-flow-worker`. SIGTERM stops claiming and lets the current job finish or report; raise `TimeoutStopSec` if jobs can run longer than 15 minutes.
- Manual enrollment (needs a visible window, so not under the headless service): `systemctl stop google-flow-worker`, run `python -m worker.main --enroll acct-NN` with `FLOW_HEADLESS=false`, sign in by hand, then start the service again.
- Check isolation any time: `python -m worker.main --audit-profiles`. `"ok": false` lists slot numbers and codes: `symlink`, `outside_root`, `shared_directory`, `not_a_directory`, `unreadable`, `marker_mismatch`, `marker_unreadable`, `unexpected_entry`, `profiles_unreadable`. `unmarked` lists legacy slots that will be adopted on first open.
- "Another worker process already holds this data directory": stop the other process (often the service, while a manual run was attempted). Do not delete `worker.lock`.

## Verification still required (Phase 4 exit)

- [ ] Real host: enroll at least two slots manually, restart the host, confirm each slot is still signed in to its own account and `--audit-profiles` is clean.
- [ ] Ten slots populated and the same restart check repeated (needs ten owner-controlled accounts).
- [ ] `kill -9` of the worker mid-job: the server lease expires and the job is recovered; a new worker starts without manual lock cleanup.
- [ ] systemd unit run under the real service user with a real encrypted data volume.
- [ ] Encrypted owner-controlled backup and demonstrated restore of profiles (not started; never to GitHub, D1, R2, CI artifacts or logs).
- [ ] Staging smoke with `wrangler dev` or a staging Worker, real D1 and `WORKER_TOKEN`.
