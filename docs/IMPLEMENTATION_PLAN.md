# Google Flow Auto — Implementation Plan to Final Version

Repository: harvey-moeid/google-flow-auto  
Product target: Android-first PWA control plane for 10 manually managed Google Flow account slots.  
Fixed decisions: manual account enrollment and selection, one global sequential execution lane, hybrid architecture, free-first deployment.  
Verified baseline (2026-11-15): main `c1c7dc2a531fdbbfc827f9ca35d37e7b4eb6d61f`; Phase 6A merged by PR #19; main Test run #57 (`43683700717`) passed. No deployment was performed and no live adapter is enabled.

## Product and architecture decisions
- PWA: React + TypeScript + Vite, installable from Android Chrome.
- Control plane: Cloudflare Worker; metadata: D1; private media: R2.
- Queue: durable queue plus one authoritative global lease/lock.
- Browser execution: Python + Playwright on a trusted persistent host with encrypted storage. GitHub Actions is for CI/deploy, not persistent browser sessions.
- Profiles: one isolated persistent profile per account slot; owner manually signs in. Never move profiles/cookies into GitHub, D1, CI artifacts, or logs.
- Engines: FLOW KIT and gflow-cli are unapproved research candidates. No adapter is enabled until a documented and permitted integration gate is met.
- Auth: owner password and signed expiring HttpOnly cookie; browser worker bearer token accepted only on worker endpoints.
- Policy: no quota/rate-limit evasion, CAPTCHA/security challenge bypass, or undocumented/protected endpoints. Pause for manual reauthentication.
- Storage: R2 bucket is private; owner media reads go through the authenticated Worker API. No public object URLs.

## Phase progress
| Phase | Status | Evidence / remaining work |
|---|---|---|
| 0–3B | Implemented and merged | Project/scene workflow and reference media foundations. |
| 4A | Merged | Worker claims and reports jobs; dry-run only. |
| 4B | Merged | Heartbeat, health endpoint and owner-attested manual enrollment. |
| 4C | Merged | Android worker monitoring and manual enrollment runbook. |
| 4D | Merged | Host lock, profile isolation audit, marker and systemd template; real-host verification remains. |
| 4E | Merged | Encrypted local backup/restore CLI; separate-host restore and encrypted-volume proof remain owner-run. |
| 4 operational exit | BLOCKED — owner-run | Encrypted disk, service lifecycle, profile persistence/isolation, kill recovery, separate-host restore and real D1/API staging smoke not evidenced. |
| 5 | Qualification gate / BLOCKED | FLOW KIT and gflow-cli do not currently meet documented/permitted-interface requirements. Only dry-run is functional. |
| 6A | Merged — API foundation | PR #19: private R2 upload, D1 metadata, owner-only list/download, SHA-256 and file signature validation, lease fencing and tests. One-shot upload cap 25 MiB. |
| 6B | In progress | Worker output upload and PWA media UI merged; trusted optional dimensions/duration metadata being implemented; resumable uploads, retention/deletion/orphan cleanup and staging verification remain. |
| 7 | Not started | Production hardening, backups, Android E2E, staging and release. |

## Phase 4 — Browser worker and account lifecycle
- [x] Python worker claims, executes dry-run and reports queue outcomes (4A).
- [x] Worker process heartbeat, online/offline state, disk/profile count and owner status API (4B).
- [x] Manual owner-confirmed enrollment for one selected isolated profile (4B).
- [x] Android PWA worker monitoring and clear manual enrollment instructions (4C).
- [x] Host single-process lock, profile isolation audit and systemd service template (4D; code/CI only).
- [x] Owner-controlled encrypted local backup/restore CLI (4E; code/CI only).
- [ ] Prove encrypted volume, persistent isolated profiles, service supervision, kill recovery, and backup restore on a separate owner-controlled host.
- [ ] Real Cloudflare staging smoke with worker token, API and D1.

Phase 4 exit: all ten profiles remain isolated and recoverable through restart; reauth pauses safely; one global sequential lane remains authoritative; operational status and recovery are verified on staging. Code completion alone does not satisfy the operational exit.

## Phase 5 — Qualify a permitted live engine adapter
- Audit candidate source, license, authentication, documented integration surface and current maintenance.
- Reject any integration requiring undocumented/private endpoints, replaying protected calls, CAPTCHA/reCAPTCHA workarounds, or bypassing security challenges.
- Define versioned adapter contract: capabilities, validate, submit, poll, cancel-if-supported, fetch result and classify errors.
- Implement one adapter behind a feature flag only after the documented/permitted interface gate passes.
- Add mock contract tests and supervised integration on one owner-controlled account.
- Test output integrity, quota handling, transient failures and reauthentication.
- Keep dry-run default; require explicit live-mode confirmation and retain the kill switch.

**Current gate result:** BLOCKED. See `docs/PHASE_5_ADAPTER_QUALIFICATION.md`. If no stable permitted interface exists, do not reverse-engineer protected endpoints. Release as manual-assisted, not fully automated.

## Phase 6 — Private media pipeline

### Phase 6A — API foundation (merged)
- [x] D1 `media` metadata table and indexes (`0005_media.sql`).
- [x] Worker-only upload route guarded by bearer identity and the active job fencing lease.
- [x] MIME allowlist, file magic validation, 25 MiB bounded upload, and SHA-256 verification.
- [x] Server-generated R2 keys; object metadata and D1 metadata linked by media UUID.
- [x] Owner-only media listing per job and authenticated streamed download.
- [x] Audit event and idempotent replay handling.
- [x] Regression tests for valid upload/download, replay, bad checksum/signature, lease expiry, orphan cleanup and audience separation.
- [ ] Remote D1 migration and R2 binding verified in an authorized staging environment.

### Phase 6B — End-to-end media lifecycle (next)
- [ ] Python worker uploads generated outputs before marking a job succeeded.
- [ ] Worker handles upload retry and checksum idempotency without completing a job whose output has not been persisted.
- [ ] PWA shows media per job/project with preview, size/type and authenticated download.
- [x] Add optional width/height/duration metadata fields with strict Worker-side validation; trusted adapter metadata is accepted and surfaced to owner UI (implementation in progress on feature branch).
- [ ] Add authorized delete and retention policy; audit all deletes.
- [ ] Add orphan detection/cleanup with dry-run mode and explicit retention safety.
- [ ] Add resumable/multipart upload path for media larger than 25 MiB.
- [ ] Integration tests cover upload failure, retry, duplicate upload, expired lease, missing R2 object and owner access.
- [ ] Staging smoke test uses private R2 and D1; no production deployment without approval.

## Phase 7 — Production hardening and release
- Structured redacted logs, metrics and alerts for queue age, worker health, lease and error rates.
- D1 backup/export and demonstrated restore; R2 retention/backup policy.
- Dependency/secret scanning, lint, typecheck, tests and thresholds.
- Staging deployment, manual approval and rollback workflow.
- Android Chrome end-to-end acceptance tests.
- Load test within provider limits; document free-tier constraints and actual costs.
- Runbooks for onboarding, reauth, stuck jobs, restore, rollback, credential rotation and live kill switch.
- Tag release and publish operator guide.

## Final acceptance checklist
- [ ] PWA installs and normal control works from Android.
- [ ] Production identity/auth works; no privileged secret in frontend (logic CI-tested; staging not verified).
- [ ] Ten account slots are manageable; manual enrollment and manual selection.
- [ ] Ten isolated persistent profiles, safely stored and recoverable.
- [ ] One global sequential lane survives worker restarts.
- [ ] Projects and ordered scenes can be created/edited.
- [ ] Dry-run/live modes separated; live has a kill switch.
- [ ] Live adapter verified and permitted, or release honestly labeled manual-assisted.
- [ ] Jobs have traceable states, audit history, safe retry and cancellation where supported.
- [ ] Private R2 outputs and owner-authenticated download access.
- [ ] Worker-to-R2 and PWA media lifecycle works end-to-end.
- [ ] Monitoring, backup/restore, rollback and runbooks tested.
- [ ] CI, security checks and Android staging E2E are green.
- [ ] Free-tier limits, actual costs and operational dependencies are documented.