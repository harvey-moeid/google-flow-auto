# Google Flow Auto — Implementation Plan to Final Version

**Repository:** harvey-moeid/google-flow-auto  
**Product target:** Android-first PWA control plane for 10 manually managed Google Flow account slots.  
**Fixed operating decisions:** manual account enrollment; manual account selection per job; one global sequential execution lane; hybrid engine adapters; free-first deployment.  
**Status:** roadmap for implementation. Existing code is a starter scaffold, not production-ready.

## Product and architecture decisions
- PWA: React + TypeScript + Vite, installable from Android Chrome.
- Control plane: Cloudflare Worker; metadata: D1; private media: R2.
- Queue: durable queue plus one authoritative global lease/lock. Use a Durable Object if it is the clearest reliable serialization authority.
- Browser execution: Python + Playwright on a trusted persistent host with encrypted storage. GitHub Actions is for CI/deploy, not persistent browser sessions.
- Profiles: one isolated persistent profile per account slot; owner manually signs in. Never move profiles/cookies into GitHub, D1, CI artifacts, or logs.
- Engines: adapter contract supports FLOW KIT and gflow-cli, but live adapters stay disabled until current interfaces, licenses, terms and reliability are verified.
- Auth: Cloudflare Access/OIDC or equivalent server-verified identity. No privileged token in frontend build variables.
- Platform policy: do not evade quotas/rate limits through account rotation; do not bypass CAPTCHA/security checks or use undocumented protected endpoints. Pause for manual reauthentication. If no permitted stable interface exists, ship manual-assisted mode and state the limitation.

## Baseline status and known gaps
The repository currently has a basic PWA, Worker API, D1 bootstrap schema, Python Playwright profile isolation and in-process sequential scheduler, dry-run adapter, placeholder live adapters, deployment notes and basic CI.
Known gaps:
1. CI/build has not been proven green end-to-end.
2. PWA uses a build-time bearer-token pattern; frontend secrets are public and must be removed.
3. API CORS reflects request origin; replace with strict allowlist.
4. Production identity verification, input validation, rate limiting and consistent error responses are incomplete.
5. Project/scene editing and full job submission workflow are incomplete.
6. No durable queue consumer/global lease protocol exists; process-local asyncio lock is insufficient.
7. Live Google Flow adapters are placeholders, not verified.
8. R2 private upload/download, expiring links, checksum and retention are missing.
9. Manual enrollment and remote worker lifecycle are incomplete.
10. Production resource IDs, secrets, monitoring, backup and restore are not configured.

## Phased roadmap and exit criteria

### Phase 0 — Stabilize the starter
Tasks:
- Run existing GitHub Actions workflows and inspect actual logs.
- Fix TypeScript, PWA build, Python import and workflow errors.
- Add deterministic dependency lockfiles and pinned runtime versions.
- Add tests for slot validation, profile isolation, scheduler serialization and dry-run.
- Add one reproducible smoke-test procedure.
Exit: clean checkout builds; CI green; dry-run passes without Google login; no credentials/profile data tracked.

### Phase 1 — Secure API and identity
Tasks:
- Choose Cloudflare Access/OIDC and define trusted identity claims.
- Verify identity and authorize every mutating endpoint at Worker boundary.
- Remove VITE_API_TOKEN and all privileged browser-side secrets.
- Configure strict origin allowlist, security headers, request limits, rate limits and request IDs.
- Add schema validation, pagination, stable error codes and audit events.
Exit: unauthenticated writes rejected; no secret in built assets; security tests cover all write routes.

### Phase 2 — Durable queue and single global execution
Tasks:
- Replace bootstrap-only schema evolution with versioned D1 migrations.
- Define states: queued, claimed, running, waiting_for_user, succeeded, failed, cancelled.
- Implement atomic claim and global lease with expiry, heartbeat and fencing token.
- Add stale-worker recovery, bounded retries/backoff, idempotency and safe cancellation.
- Enforce manual account choice and at most one live job globally.
- Test concurrent claim attempts, worker crash, lease expiry, duplicate submissions and cancellation.
Exit: two workers cannot execute simultaneously; stale workers cannot mutate a newer lease; jobs recover predictably without duplicate execution.

### Phase 3 — Complete Android project workflow
Tasks:
- Project CRUD/archive screens and API.
- Scene CRUD, prompt validation, ordering, duration, aspect ratio and reference assets.
- Manual account selection and readiness check.
- Review/confirm screen before submission.
- Job details, progress timeline, safe logs, retry and cancel.
- Private R2 asset upload and output gallery.
Exit: user can create project, edit scenes, choose one ready account, submit and track job entirely from Android.

### Phase 4 — Browser worker and account lifecycle
Tasks:
- Choose persistent worker host and encrypted disk.
- Isolated profile path and permissions for each of 10 slots.
- Manual enrollment flow that opens only the selected profile for owner login.
- Readiness and reauthentication detection; pause jobs in waiting_for_user.
- Encrypted owner-controlled backup/restore; never upload profile state to GitHub.
- Worker health, heartbeat, graceful shutdown, restart and disk monitoring.
Exit: 10 profiles remain isolated through restart; reauth pauses safely; no silent account switching.

### Phase 5 — Qualify a permitted live engine adapter
Tasks:
- Audit current FLOW KIT and gflow-cli source, license, auth and supported integration surface.
- Record permitted workflows and manual interaction requirements.
- Define versioned adapter contract: capabilities, validate, submit, poll, cancel-if-supported, fetch result, classify errors.
- Implement one adapter behind feature flag; do not assume undocumented endpoints/selectors.
- Add mock contract tests and supervised integration test on one owner-controlled account.
- Test a small generation, output integrity, quota handling, transient failures and reauth.
- Keep dry-run default and add explicit live-mode confirmation and kill switch.
Exit: documented permitted adapter passes supervised integration tests and safe error handling.
**Blocker gate:** if no stable permitted interface exists, do not reverse-engineer protected endpoints. Release as manual-assisted, not fully automated.

### Phase 6 — Private media pipeline
Tasks:
- Upload results to private R2 with MIME/size checks and checksum.
- Retry uploads independently of generation where possible.
- Store object key, MIME, dimensions, duration, checksum and provenance.
- Issue short-lived authorized download URLs.
- Add retention, deletion and orphan cleanup.
Exit: completed jobs expose verified private outputs; retry does not needlessly rerun completed generation.

### Phase 7 — Production hardening and release
Tasks:
- Structured redacted logs, metrics and alerts for queue age, worker health, lease and error rates.
- D1 backup/export and demonstrated restore; R2 retention/backup policy.
- Dependency/secret scanning, lint, typecheck, test thresholds.
- Staging deployment, manual approval and rollback workflow.
- Android Chrome end-to-end acceptance tests.
- Load test within provider limits; document real free-tier constraints and potential costs.
- Runbooks for onboarding, reauth, stuck jobs, restore, rollback, credential rotation and live kill switch.
- Tag release and publish operator guide.
Exit: security review has no unresolved critical/high findings; staging E2E, restore and rollback demonstrated; actual costs and limitations documented.

## Final acceptance checklist
- [ ] PWA installs and normal control works from Android.
- [ ] Production identity/auth works; no privileged secret in frontend. (Implemented and CI-tested in Phase 1, PR #4; not yet verified against a real Cloudflare Access staging deployment.)
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

## Recommended next work
Start at Phase 0. Do not implement live generation before Phases 0–4 pass. Use feature branches and PRs per phase; update this plan with evidence, not assumptions.