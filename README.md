# Google Flow Auto — Multi-Account Starter

Android-first control-plane scaffold for up to 10 manually enrolled Google accounts. Account selection is manual and jobs are sequential.

## Project roadmap and handoff
- [Implementation plan to final version](docs/IMPLEMENTATION_PLAN.md)
- [Handoff for the next coding session/agent](docs/HANDOFF.md)
- [Android deployment notes](docs/DEPLOY_ANDROID.md)

## Components
- `apps/pwa`: React + Vite Android-friendly PWA dashboard.
- `apps/api`: Cloudflare Worker API (Access JWT auth, validation, pagination, rate limits, audit).
- `cloudflare/schema.sql`: D1 schema for accounts, projects, scenes, jobs, lease and audit events; seeds 10 account slots.
- `engine`: Python worker, Playwright persistent-profile isolation, sequential scheduler and adapter contract.
- `.github/workflows`: CI and Cloudflare deploy workflows.

## Important limits
The Google Flow live adapter is intentionally not implemented or verified. `flowkit` and `gflow` are safe placeholders; only `dry-run` is functional. Do not assume undocumented endpoints or UI selectors. A persistent browser worker is required; GitHub Actions runners are ephemeral. Free Cloudflare can host parts of the control plane but cannot guarantee free persistent browser execution or video rendering.

## Security
Never store Google passwords, cookies, Playwright profiles, or session state in GitHub. Keep browser profiles on encrypted persistent storage controlled by the account owner.
The API is protected by Cloudflare Access: the Worker verifies the Access JWT, checks an owner email allowlist, enforces a strict origin policy, rate limits and request-size limits, validates all input and audits every mutation. There is no shared API token and the PWA contains no secrets (`npm run check:secrets` enforces this). See [deployment notes](docs/DEPLOY_ANDROID.md) for the setup and what is still unverified against a real Cloudflare account.

## Local development
API: `cp apps/api/.dev.vars.example apps/api/.dev.vars && cd apps/api && npm run dev`  
PWA: `cd apps/pwa && npm run dev` (proxies `/api` to the local Worker)  
Checks: `npm run check` from the repository root (API typecheck + tests, script tests, PWA build, secret scan)  
Worker: `cd engine && python -m venv .venv && pip install -r requirements.txt && playwright install chromium && python -m worker.main`

Start in dry-run mode and test one account before expanding. This is a starter scaffold, not production-ready.
