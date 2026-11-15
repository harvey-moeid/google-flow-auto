# Handoff — Google Flow Auto

Read this document and `docs/IMPLEMENTATION_PLAN.md` before making changes.

## Project identity
- Repo: `harvey-moeid/google-flow-auto`
- Base branch: `main`
- Target: Android-first Google Flow multi-account control plane.
- Account policy: 10 slots; manual enrollment and manual account selection.
- Execution policy: one global sequential live job.
- Deployment preference: free-first, without promising unlimited free browser execution.
- Engine strategy: hybrid adapters; live execution remains disabled until verified.

## Current code baseline
- `apps/pwa`: basic React/Vite mobile dashboard.
- `apps/api`: basic Cloudflare Worker endpoints.
- `cloudflare/schema.sql`: initial D1 schema and 10 seeded slots.
- `engine`: Python Playwright profile manager, in-process scheduler, dry-run and placeholder live adapters.
- `.github/workflows`: starter PWA build/Python compile and deployment workflows.
- `docs/DEPLOY_ANDROID.md`: initial deployment instructions.

This is a scaffold, not a final or production-ready implementation. The plan file contains full phases and acceptance criteria.

## Critical known blockers
1. Run CI and inspect real workflow results before feature work.
2. PWA currently uses build-time `VITE_API_TOKEN`; remove it. Frontend build variables are public.
3. API CORS currently reflects the request origin; configure a strict allowlist.
4. API production identity, full validation, rate limits and consistent errors are incomplete.
5. Project UI/API do not yet support complete scene management and job submission.
6. API does not have a durable queue consumer or global lease.
7. Python asyncio lock only serializes within one process; it is not a global lock.
8. FLOW KIT and gflow adapters are placeholders. Do not claim live generation works.
9. R2 private upload/download, signed URLs and cleanup are missing.
10. Remote manual enrollment, persistent worker host operations, backup and restore are incomplete.
11. Production Cloudflare IDs/secrets/auth are not configured.

## Immediate next task: Phase 3B (Phase 0-2 and Phase 3A are done in git history; 3A pending merge of its PR)
Phase 3A (API + PWA for projects, scenes, review/submit, job detail, retry) is implemented. Still open in Phase 3:
- Private R2 upload of reference assets and the output gallery (also needs Phase 6 download URLs).
- Scene reference assets and per-scene aspect-ratio/duration limits once Phase 5 verifies real engine limits (current 1-60 s is a generic bound).
- ~~Worker claim payload must also carry the scene prompt/duration and project aspect ratio~~ Done in Session 4 (PR #10). Still open: the Python `engine/` worker does not call the API or consume these fields yet (Phase 4).
- PWA screens were type-checked and built but never exercised in a real browser or on Android; add an Android Chrome check (Phase 7 E2E).
- Keep live adapters disabled.

## Rules for every continuation session
- Work from current `main`; create a feature branch and PR for each coherent phase.
- Before editing, state phase, target files and exit criteria.
- After editing, run relevant tests and inspect actual outputs.
- Update roadmap checkboxes/status only when evidence supports completion.
- Never claim a push, test, deploy, feature or adapter works without verification.
- Never commit passwords, Google cookies, Playwright profiles, session state, API secrets or private user assets.
- Do not put privileged secrets in PWA env vars or browser storage.
- Use D1 migrations, not destructive schema rewrites.
- Preserve fixed manual account selection and global sequential execution.
- No quota/rate-limit evasion, CAPTCHA bypass, security challenge bypass or undocumented protected endpoint automation.
- If a permitted stable Google Flow interface cannot be verified, stop live adapter work and release manual-assisted mode with explicit limitations.
- Keep browser execution replaceable and isolated from Cloudflare control plane.

## Definition of final
Only call it final when the acceptance checklist in `docs/IMPLEMENTATION_PLAN.md` is checked with test/deployment evidence. If live automation is blocked, clearly label the product manual-assisted, not fully automated.

## Session handoff record
At the end of each work session update:
- Current phase:
- Branch / PR / commits:
- Files changed:
- Tests run and exact results:
- Deployment/staging status:
- Security review:
- Blockers and decisions:
- Next concrete task:

## Session log

### Session 1 — Phase 0 (stabilize the starter)
- Current phase: Phase 0 complete pending merge of PR #3; next is Phase 1.
- Branch / PR / commits: `fix/phase-0-stabilize`, PR #3; `18bff81` (build/lockfile), `207edb3` (strict slots + tests), `5ea1efb` (CI, gitignore).
- Root cause of red CI: `@cloudflare/workers-types@^4.20261114.0` does not exist on npm (ETARGET); npm workspaces made it fail every `npm install`. `deploy.yml` had the same defect.
- Files changed: `package.json`, `package-lock.json`, `.nvmrc`, `apps/api/package.json`, `apps/pwa/package.json`, `apps/pwa/src/App.tsx` (type `slots` as `Account[]`), `apps/pwa/src/vite-env.d.ts`, `engine/accounts/slots.py`, `engine/accounts/profile_manager.py`, `engine/tests/*`, `engine/pytest.ini`, `engine/requirements-dev.txt`, package `__init__.py` files, `.github/workflows/{test,deploy}.yml`, `.gitignore`.
- Bug fixed: `acct-1` / `acct-001` previously aliased onto the `slot-01` profile directory. Only `acct-01`..`acct-10` (ASCII) are accepted now.
- Tests run and exact results: GitHub Actions `Test` run 43527002541 on `5ea1efb` = success (`pwa-build`: npm ci, typecheck API, build PWA; `python-check`: compileall, pytest, dry-run smoke). Local on Python 3.11.18: 70 passed.
- Deployment/staging status: none; `deploy.yml` was changed but not run (needs Cloudflare secrets and a real D1 id).
- Security review: `.worker-data/`, `.dev.vars`, `.wrangler/` are now gitignored; no credentials or profile data tracked. Still open: `VITE_API_TOKEN` is baked into the PWA bundle, CORS reflects the request origin, no real auth (all Phase 1).
- Blockers and decisions: `workers-types` moved to major 5 (latest on npm); `tsc --noEmit` passes on the current API code. Live adapters remain disabled.
- Next concrete task: Phase 1 — Cloudflare Access/OIDC identity, remove `VITE_API_TOKEN`, strict CORS allowlist, input validation, rate limits.

### Session 2 — Phase 1 (secure API and identity)
- Current phase: Phase 1 implemented, CI green; pending merge of PR #4. Next is Phase 2.
- Branch / PR / commits: `feat/phase-1-secure-api`, PR #4; `4d013dd` (API), `0e90b3b` (PWA), `f66ddff` (CI/scanner), `7b3a7c1` (docs), `13bf322` (fix `ignoreBOM` for real workers-types).
- Design: Cloudflare Access is the identity provider. The Worker verifies `Cf-Access-Jwt-Assertion` itself (RS256, team JWKS cached 1h, refetch on unknown `kid` at most once/min, 24h stale tolerance; checks `iss`, `aud`, `exp`, `nbf`, `kid`) then requires the `email` claim in `ALLOWED_EMAILS` (a secret). Only `/health` is public. Config fails closed (503) on missing or `REPLACE_WITH_*` values. `workers_dev`/`preview_urls` disabled. Recommended topology: PWA and `/api/*` on one hostname (same-origin).
- Also done: strict origin allowlist and CSRF Origin check on writes, security headers, `x-request-id`, 16 KiB body and JSON content-type limits, per-identity read/write rate limits (Workers binding), hand-written validation (unknown fields rejected), keyset pagination, stable error codes `{error:{code,message,request_id,details?}}`, atomic audit events for every mutation plus `GET /api/audit`, live engines refused unless `LIVE_ENGINES_ENABLED=true`, account status not writable via API, idempotency keys replay or conflict.
- Frontend: `VITE_API_TOKEN` and Authorization header removed; new `apps/pwa/src/api.ts`; `_headers` with CSP; `scripts/check-bundle-secrets.mjs` scans built assets and wiring (never prints values); only `VITE_API_URL` is allowlisted.
- API contract changes: list endpoints return `{items,next_cursor}`; `GET /api/me`, `GET /api/audit`, `POST /api/jobs/:id/cancel` added; `error_message` is no longer exposed by `GET /api/jobs`.
- Tests run and exact results: GitHub Actions `Test` run 43562864947 on `13bf322` = success (typecheck with real workers-types, API tests, script tests, PWA build, secret scan, python-check). Run 43562775248 on `7b3a7c1` failed only on `TextDecoder` `ignoreBOM` typing; fixed in `13bf322`. Local: 56 API tests, 8 scanner tests pass. 15 manual mutations of the security controls (skip aud/iss/signature/alg/exp/allowlist/origin/rate-limit checks, CORS wildcard, etc.) were all caught by tests. API tests use real RSA-signed JWTs and SQLite loaded from `cloudflare/schema.sql` as a D1 stand-in, so D1-specific behaviour (batch atomicity semantics, `meta.changes`) is simulated, not proven.
- Deployment/staging status: none. The Access application, Worker route, rate-limit bindings (`namespace_id` 7101/7102 must be unique in the account), Pages and `*.pages.dev` protection have not been exercised on a real Cloudflare account. Checklist in `docs/DEPLOY_ANDROID.md`.
- Security review: no secrets in git or bundle (scanner). Known gaps: Workers rate limiting is approximate/per-location; engine worker does not call the API yet; the PWA has no UI for audit/cancel; R2 is still unused.
- Blockers and decisions: owner must create the Access app and fill `CF_ACCESS_TEAM_DOMAIN`, `CF_ACCESS_AUD`, route, and `wrangler secret put ALLOWED_EMAILS` before any deploy. Local `engine` pytest shows 12 async failures only when `pytest-asyncio` is missing; identical on `main`, green in CI.
- Next concrete task: Phase 2 — versioned D1 migrations, atomic claim and global lease with fencing, service-token auth for the worker.

### Session 3 — Phase 3A (project workflow API + PWA)
- Current phase: Phase 3A implemented and verified locally; Phase 3B (R2 assets, gallery) not started.
- State found at start: `main` already contained Phase 2 (PR #5, durable queue/lease), PR #6 (D1 id) and PRs #7/#8, which replaced Cloudflare Access with owner password + signed session cookie and a worker bearer token (`OWNER_PASSWORD`, `SESSION_SECRET`, `WORKER_TOKEN`, `RL_LOGIN`). Those sessions were not logged here; `Test` run 43611401360 on `main` was green. `README.md` and `docs/DEPLOY_ANDROID.md` still describe Access and are stale (not fixed in this session).
- Branch / PR: `feat/phase-3a-projects`.
- New: `cloudflare/migrations/0003_projects_scenes.sql` (jobs.retry_of, indexes, project-status and 50-scene triggers; must be applied with `wrangler d1 migrations apply`, not run by the deploy workflow as far as read). API: `project-routes.ts` (list with scene_count/status filter, GET/PATCH project with archive, scene create/patch/`POST /api/scenes/:id/delete`/reorder, readiness, submit = one job per scene in scene order with per-scene idempotency keys and `expected_scene_count` stale-review guard), `job-routes.ts` (`GET /api/jobs/:id` with allow-listed timeline that hides worker id and lease data, `POST /api/jobs/:id/retry` creating a new job linked by retry_of), `paging.ts` (helpers moved out of `routes.ts`), multi-line prompt support in `validate.ts`, `GET /api/jobs?project_id=`. PWA: `screens/{Projects,ProjectEditor,Review,Jobs}.tsx`, `screens.css`, Android Back via history stack.
- Behavioural rules enforced by the API: scenes with a queued/claimed/running/waiting job cannot be edited or deleted; archived projects refuse edits, new scenes and submits; archive and aspect-ratio change are refused while jobs are active; submit and retry only use engine dry-run unless `LIVE_ENGINES_ENABLED=true`; a retry needs a Ready account and no active job on the scene.
- Tests run and exact results (local, Node 22, clean `npm ci`): `npm run check` = 95 API tests pass (74 existing + 21 new), 8 script tests pass, PWA `tsc -b && vite build` OK, bundle secret scan OK. Eight deliberate code mutations (reorder offset, scene lock, archived check on submit, stale-review guard, submit idempotency, worker id in timeline, retry of non-final jobs, multi-line prompts) each made at least one test fail. D1 batch/trigger behaviour is simulated with SQLite, not proven on real D1.
- Deployment/staging status: none.
- Security review: no secrets added; audit rows store field names and ids, never prompt text; the timeline exposes only allow-listed audit keys.
- Blockers and decisions: delete is a POST action so the method allow-list stays GET/POST/PATCH; scene gaps after delete are allowed (reorder renumbers 1..N); the unverified real limits of Google Flow remain unverified.
- Next concrete task: apply migration 0003 to the real D1, merge the Phase 3A PR after CI, then Phase 3B (worker claim payload with scene data, R2 asset upload, gallery).

### Session 4 — Phase 3B part 1 (worker claim payload)
- Current phase: Phase 3B in progress. Done: claim payload. Not started: R2 reference assets, output gallery, per-scene limits from a verified engine.
- State found at start: `main` at `b7f187b` (PR #9 / Phase 3A merged); `Test` run 43666181385 on `main` = success.
- Branch / PR / commits: `feat/phase-3b-claim-payload`, PR #10; `ff45bc3`.
- Files changed: `apps/api/src/queue.ts` (claim SELECT now joins `projects` and `LEFT JOIN scenes`), `apps/api/src/worker-routes.ts` (response adds `job.aspect_ratio` and `job.scene {id,order,prompt,duration_seconds}`), `apps/api/test/claim-payload.test.ts` (new). No migration, no schema change, no lease/fencing logic touched.
- Contract: `job.scene` is `null` when the job has no scene (direct `POST /api/jobs`) or the scene row was deleted after queuing. A worker must fail such a job as non-retryable and must not invent a prompt.
- Tests run and exact results: local (Node 22.23, no npm install) 101/101 pass (95 existing + 6 new). With the old `queue.ts`/`worker-routes.ts` restored, 5 of the 6 new tests fail (the empty-queue test passes by design). GitHub Actions `Test` run 43666660597 on `ff45bc3` = success (includes typecheck, which was not run locally because workers-types could not be installed offline).
- Deployment/staging status: none.
- Security review: the claim response is worker-token only and exposes exactly the allow-listed keys (asserted by test); the prompt is user content sent only to the authenticated worker. Audit rows still hold no prompt text.
- Blockers and decisions: unchanged. Migration 0003 must still be applied to the real D1 by the owner. `README.md` and `docs/DEPLOY_ANDROID.md` still describe Cloudflare Access (stale since PRs #7/#8).
- Next concrete task: Phase 3B R2 reference-asset upload (needs the `MEDIA` bucket binding and size/MIME rules), or Phase 4 so the Python worker actually calls `/api/worker/claim`; fix the stale README/DEPLOY docs when touching deployment.

### Session 5 — Phase 4a (worker uses the queue API)
- Current phase: Phase 4 started. Done: the Python worker can claim, run (dry-run only) and report jobs through `/api/worker/*`. Not done: persistent host + encrypted disk, enrollment, readiness/reauth detection, backup/restore, health/disk monitoring, opening real browser profiles for queue jobs.
- State found at start: PR #10 (Phase 3B claim payload) open with green CI, not merged. This work is stacked on `feat/phase-3b-claim-payload` because it needs the `scene` / `aspect_ratio` claim fields; merge #10 first, then retarget PR #11 to `main`.
- Branch / PR / commits: `feat/phase-4a-worker-api-loop`, PR #11; `2f327c1`.
- Files changed: `engine/worker/api_client.py` (new), `engine/worker/loop.py` (new), `engine/adapters/base.py` (`EngineNotConfigured`, still a `RuntimeError`; `AuthRequired`), `engine/worker/main.py` (`--serve`, `--once`; single-job CLI unchanged), `engine/.env.example` (`WORKER_TOKEN`, `WORKER_ID`), `engine/tests/test_worker_loop.py` (new, 22 tests).
- Behaviour: after `LeaseLost` the worker stops the adapter and sends nothing more for that job; owner cancel -> adapter stopped + `cancel-ack`; `scene: null` -> non-retryable `scene_missing`; unconfigured engine -> non-retryable `engine_not_configured`; adapter error -> retryable `adapter_error` carrying only the exception class name; `AuthRequired` -> `wait` (waiting_for_user); claim errors back off 1s doubling to 60s. The bearer token is only sent over https (http only for localhost). Logs hold job ids and outcomes only.
- Tests run and exact results: local Python 3.13 without `httpx` / `pytest-asyncio` (offline): 22 new tests pass; full suite 80 passed / 12 failed, and the same 12 fail on `main` ("async def tests not supported", plugin missing). With a temporary shim plugin running coroutines via `asyncio.run`: 92 passed. Three deliberate mutations (leak exception text, continue after lease lost, retryable missing-scene) each failed exactly the intended test. GitHub Actions `Test` run 43666976820 on `2f327c1` (merged with #10 head `d13c5a6`) = success: every step of `python-check` (Python 3.11.18, `pytest-asyncio` 1.5.0, compileall, pytest, dry-run smoke) and `pwa-build`. The job log was truncated before the pytest step, so a CI test count is not recorded here.
- Cross-language contract smoke (local, scratch scripts, not committed): the real Worker app (`createApp`, SQLite standing in for D1, injectable clock) served over local HTTP and driven by the real Python `WorkerApiClient` + `serve` loop through a stdlib `urllib` transport. Proven: two submitted jobs run in scene order with the right prompt, duration and `16:9` ratio, both end `succeeded`, the lease is released and the audit trail is claimed/started/succeeded; owner cancel (HTTP 202) during a run -> heartbeat reports it, adapter stopped, `cancel-ack`, job `cancelled`; clock advanced past the lease -> heartbeat 409, worker stops and sends nothing further (the job stays `running` until the next claim's `recoverStale`, as designed); scene row deleted after queuing -> job `failed` with `scene_missing`, attempts stay 1.
- NOT verified: `HttpxTransport` (real httpx; neither httpx nor wrangler nor network exist in the build sandbox), `wrangler dev`, real D1 (batch atomicity and `changes()` are SQLite-simulated), and any deployed Worker. Missing proof: the same smoke with `wrangler dev` + `python -m worker.main --once` and a `WORKER_TOKEN`.
- Deployment/staging status: none.
- Security review: no secrets added; token never logged; errors reported to the API cannot carry cookies, paths or prompts. `.worker-data/` is still gitignored.
- Blockers and decisions: unchanged (migration 0003 not yet applied to the real D1; README and `docs/DEPLOY_ANDROID.md` still describe Cloudflare Access).
- Next concrete task: repeat the smoke with `wrangler dev` + `--once` on a machine with network (real httpx and miniflare D1); then Phase 4 host/profile work (enrollment flow, readiness and reauth detection feeding `AuthRequired`).

