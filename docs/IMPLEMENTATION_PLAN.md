# Google Flow Auto — Implementation Plan to Final Version

Repository: harvey-moeid/google-flow-auto  
Product target: Android-first PWA control plane for 10 manually managed Google Flow account slots.  
Fixed decisions: manual account enrollment and selection, one global sequential execution lane, hybrid adapters, free-first deployment.  
Current baseline: Phase 4B merged to main (commit 9682efc); Phase 4C Worker Operations UI is in progress on feat/phase-4c-worker-operations.

## Product and architecture decisions

- PWA: React + TypeScript + Vite, installable from Android Chrome.
- Control plane: Cloudflare Worker; metadata: D1; private media: R2.
- Queue: durable queue plus one authoritative global lease/lock.
- Browser execution: Python + Playwright on a trusted persistent host with encrypted storage. GitHub Actions is for CI/deploy, not persistent browser sessions.
- Profiles: one isolated persistent profile per account slot; owner manually signs in. Never move profiles/cookies into GitHub, D1, CI artifacts, or logs.
- Engines: FLOW KIT and gflow-cli adapters remain disabled until current interfaces, licenses, terms and reliability are verified.
- Auth: owner password and signed expiring HttpOnly cookie; browser worker bearer token accepted only on worker endpoints. No privileged token in frontend build variables.
- Policy: do not evade quotas/rate limits through account rotation; do not bypass CAPTCHA/security checks or use undocumented protected endpoints. Pause for manual reauthentication.

## Phase progress

| Phase | Status | Evidence / remaining work |
|---|---|---|
| 0–3B | Implemented and merged | See session records in docs/HANDOFF.md; private R2 media pipeline remains incomplete. |
| 4A | Implemented and merged | Python worker claims and reports jobs; dry-run only. |
| 4B | Implemented and merged | Worker heartbeat, health endpoint and owner-attested manual enrollment CLI. PR #14 / commit 9682efc. |
| 4C | In progress | Android worker monitoring and manual enrollment runbook; persistent host, encrypted backup/restore and real staging smoke remain. |
| 5 | Not started | Qualify one permitted live adapter; blocker gate applies. |
| 6 | Not started | Private R2 output/reference media pipeline. |
| 7 | Not started | Production hardening, backup/restore proof, Android E2E, staging and release. |

## Phase 4 — Browser worker and account lifecycle

- [x] Python worker claims, executes dry-run and reports queue outcomes (4A).
- [x] Worker process heartbeat, online/offline state, disk/profile count and owner status API (4B).
- [x] Manual owner-confirmed enrollment for one selected isolated profile (4B).
- [ ] Android PWA worker monitoring and clear manual enrollment instructions (4C).
- [ ] Persistent host/service supervisor, graceful restart and operational monitoring.
- [ ] Encrypted owner-controlled profile backup and demonstrated restore.
- [ ] Verify 10 isolated profiles survive a host restart without shared profile access.
- [ ] Real Cloudflare staging smoke with worker token, API and D1.

Phase 4 exit: all ten profiles remain isolated and recoverable through restart; reauth pauses safely; one global sequential lane remains authoritative; operational status and recovery are verified on staging.

## Phase 5 — Qualify a permitted live engine adapter

- Audit FLOW KIT and gflow-cli source, license, authentication and supported integration surface.
- Record permitted workflows and manual interaction requirements.
- Define versioned adapter contract: capabilities, validate, submit, poll, cancel-if-supported, fetch result and classify errors.
- Implement one adapter behind a feature flag; never assume undocumented endpoints/selectors.
- Add mock contract tests and supervised integration on one owner-controlled account.
- Test output integrity, quota handling, transient failures and reauthentication.
- Keep dry-run default; require explicit live-mode confirmation and retain the kill switch.

Blocker gate: if no stable permitted interface exists, do not reverse-engineer protected endpoints. Release as manual-assisted, not fully automated.

## Phase 6 — Private media pipeline

- Upload results to private R2 with MIME/size checks and checksum.
- Retry uploads independently of generation where possible.
- Store object key, MIME, dimensions, duration, checksum and provenance.
- Issue short-lived authorized download URLs.
- Add retention, deletion and orphan cleanup.

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

Recommended next work: finish Phase 4C, then verify worker-host lifecycle and staging acceptance before Phase 5. Do not enable live generation before Phases 0–4 are verified.
