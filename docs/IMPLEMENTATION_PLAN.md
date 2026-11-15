# Google Flow Auto — Implementation Plan to Final Version

Repository: harvey-moeid/google-flow-auto  
Product target: Android-first PWA control plane for 10 manually managed Google Flow account slots.  
Fixed decisions: manual account enrollment and selection, one global sequential execution lane, hybrid architecture, free-first deployment.  
Verified baseline (2026-11-15): main `a4e35e4`; Phase 4E merged by PR #17; main Test run #51 (`43681274295`) passed. No live adapter is enabled.

## Product and architecture decisions
- PWA: React + TypeScript + Vite, installable from Android Chrome.
- Control plane: Cloudflare Worker; metadata: D1; private media: R2.
- Queue: durable queue plus one authoritative global lease/lock.
- Browser execution: Python + Playwright on a trusted persistent host with encrypted storage. GitHub Actions is for CI/deploy, not persistent browser sessions.
- Profiles: one isolated persistent profile per account slot; owner manually signs in. Never move profiles/cookies into GitHub, D1, CI artifacts, or logs.
- Engines: FLOW KIT and gflow-cli are unapproved research candidates, not supported/production adapters. No adapter is enabled until the documented and permitted integration gate is met.
- Auth: owner password and signed expiring HttpOnly cookie; browser worker bearer token accepted only on worker endpoints.
- Policy: no quota/rate-limit evasion, CAPTCHA/security challenge bypass, or undocumented/protected endpoints. Pause for manual reauthentication.

## Phase progress
| Phase | Status | Evidence / remaining work |
|---|---|---|
| 0–3B | Implemented and merged | Private R2 output/reference media pipeline remains incomplete. |
| 4A | Merged | Worker claims and reports jobs; dry-run only. |
| 4B | Merged | Heartbeat, health endpoint and owner-attested manual enrollment. |
| 4C | Merged | Android worker monitoring and manual enrollment runbook. |
| 4D | Merged | Host lock, profile isolation audit, marker and systemd template; real-host verification remains. |
| 4E | Merged | Encrypted local backup/restore CLI; separate-host restore and encrypted-volume proof remain owner-run. |
| 4 operational exit | BLOCKED — owner-run | Encrypted disk, service lifecycle, profile persistence/isolation, kill recovery, separate-host restore and real D1/API staging smoke not yet evidenced. |
| 5 | Qualification gate / BLOCKED | FLOW KIT and gflow-cli research documented; neither currently meets the project's documented/permitted-interface rule. Only dry-run is functional. |
| 6A | PARKED — unmerged branch | `feat/phase-6a-r2-media` has two commits but is incomplete: referenced media route module is absent from the branch source and route registration/tests are not verified. |
| 6 | Not accepted | Complete private R2 media pipeline only after phase sequencing and API security review; don't merge the parked branch as-is. |
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
- Upload results to private R2 with MIME/size checks and checksum.
- Retry uploads independently of generation where possible.
- Store object key, MIME, dimensions, duration, checksum and provenance.
- Issue short-lived authorized download URLs.
- Add retention, deletion and orphan cleanup.
- Security requirements: owner/worker/signed-link audiences must be disjoint; signed links must be scoped, short-lived, tamper-resistant and non-cacheable; object keys must be server-generated; deletion must be authorized and auditable.

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
- [ ] Private R2 outputs and expiring download access.
- [ ] Monitoring, backup/restore, rollback and runbooks tested.
- [ ] CI, security checks and Android staging E2E are green.
- [ ] Free-tier limits, actual costs and operational dependencies are documented.
