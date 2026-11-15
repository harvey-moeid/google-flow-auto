# Worker host lifecycle (Phase 4D–4E)

Status: host-lock/profile-isolation code, systemd template, and encrypted backup/restore implementation are covered by automated tests. The systemd unit, encrypted volume, real Chromium restart, and restore on a separate host have NOT been verified on an owner-controlled host. Do not mark the Phase 4 operational exit criteria complete until the owner-run checks below are recorded in docs/HANDOFF.md.

## What the code guarantees

| Guard | Where | Behaviour |
|---|---|---|
| One process per data directory | engine/worker/host_lock.py | --serve, --once, --enroll, local jobs and backup/restore take an OS advisory lock on worker.lock; a second process is refused. |
| Profile isolation audit | engine/worker/profile_audit.py | Rejects aliases/copies, symlinked or out-of-root slot dirs, shared directories and wrong slot markers. |
| Fail closed at startup | engine/worker/main.py | Audit runs before browser profiles open. --audit-profiles is read-only. |
| Encrypted backup | engine/worker/profile_backup.py | ZIP archive encrypted locally with scrypt-derived AES-256-GCM; authenticated header and ciphertext; temporary plaintext archive is mode 0600 inside the configured data directory and removed on exit. |
| Safe restore | engine/worker/profile_backup.py | Authenticates the full archive before extraction, rejects unsafe paths/symlinks/duplicate entries/oversized archives, validates slot markers, and refuses to overwrite existing profile content. |
| Marker on first use | engine/accounts/profile_manager.py | Writes .flow-slot on first open; refuses a profile marked for another slot. |

The backup passphrase is entered interactively and is never saved. Use a unique passphrase of at least 12 characters; store it separately in an owner-controlled password manager. Losing it makes the backup unrecoverable. The archive is not uploaded anywhere.

## Backup and restore commands

Stop the worker first. The CLI lock provides an additional guard and refuses to run while the worker owns the data directory.

From engine/:

```bash
python -m worker.main --audit-profiles
python -m worker.main --backup-profiles /path/to/google-flow-profiles-2026-11-15.gfab
```

To restore on a new host with the same version of the app:

```bash
python -m worker.main --restore-profiles /path/to/google-flow-profiles-2026-11-15.gfab
python -m worker.main --audit-profiles
```

Restore is allowed only when FLOW_WORKER_DATA_DIR/profiles is absent or empty. It never merges or overwrites an existing profile tree. Backups should be copied only over an owner-controlled encrypted channel and kept on encrypted storage. Never place them in GitHub, D1, R2, CI artifacts, issue attachments, or chat.

## Install on the trusted host (owner-run)

1. Use an encrypted volume for FLOW_WORKER_DATA_DIR (for example LUKS or an encrypted home on the host). Confirm the encryption yourself.
2. Create a dedicated user and a virtualenv under /opt/google-flow-auto/engine/.venv; install engine/requirements.txt and run playwright install chromium.
3. Create /etc/google-flow-auto/worker.env (mode 0600) with API_BASE_URL, WORKER_TOKEN, WORKER_ID, FLOW_WORKER_DATA_DIR, and FLOW_HEADLESS=true. Never commit this file.
4. Copy engine/deploy/google-flow-worker.service to /etc/systemd/system/, adjust paths/user, then systemctl daemon-reload and systemctl enable --now google-flow-worker.

## Operate

- Status: systemctl status google-flow-worker and the Accounts tab (online/idle/busy).
- Graceful restart: systemctl restart google-flow-worker. SIGTERM stops claiming and lets the current job finish or report; raise TimeoutStopSec if jobs can run longer than 15 minutes.
- Manual enrollment: systemctl stop google-flow-worker, run python -m worker.main --enroll acct-NN with FLOW_HEADLESS=false, sign in by hand, then start the service again.
- Check isolation: python -m worker.main --audit-profiles. Output contains slot numbers and codes only.
- Do not delete worker.lock; the OS releases the advisory lock when the process exits.

## Owner-run verification still required (Phase 4 exit)

- [ ] Confirm FLOW_WORKER_DATA_DIR resides on an encrypted volume.
- [ ] Enroll at least two owner-controlled accounts, restart the host, and confirm each profile remains signed in to its own account.
- [ ] Populate all ten slots and repeat the restart/isolation check (requires ten owner-controlled accounts).
- [ ] Run kill -9 against a test worker mid-job; confirm the server lease expires and a new worker recovers safely.
- [ ] Run the systemd unit under the real service user with correct filesystem permissions.
- [ ] Create an encrypted backup, copy it to a separate owner-controlled host, restore there, and confirm all expected profiles pass --audit-profiles and remain isolated. Never restore over existing profile data.
- [ ] Run staging smoke with wrangler dev or a staging Worker, real D1 and WORKER_TOKEN.

These checks require the owner's host, accounts, disk and Cloudflare credentials. CI cannot prove encryption-at-rest, real Google login persistence, or host recovery.
