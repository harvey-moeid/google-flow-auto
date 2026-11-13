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

## Immediate next task: Phase 0
- Trigger/run the existing CI workflows.
- Fix actual TypeScript/PWA and Python package/import failures.
- Add deterministic lockfiles.
- Add tests for slot validation, profile isolation, sequential serialization and dry-run.
- Keep live adapters disabled.
- Commit small, reviewable changes and report exact workflow run and test outcomes.

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
