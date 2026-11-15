# Google Flow Auto — Multi-Account Starter

Android-first control-plane scaffold for up to 10 manually enrolled Google accounts. Account selection is manual and jobs are sequential.

## Project roadmap and handoff
- [Implementation plan to final version](docs/IMPLEMENTATION_PLAN.md)
- [Handoff for the next coding session/agent](docs/HANDOFF.md)
- [Android deployment notes](docs/DEPLOY_ANDROID.md)

## Components
- `apps/pwa`: React + Vite Android-friendly PWA dashboard.
- `apps/api`: Cloudflare Worker API (owner password login with a signed session cookie, worker bearer token, validation, pagination, rate limits, audit).
- `cloudflare/schema.sql`: D1 schema for accounts, projects, scenes, jobs, lease and audit events; seeds 10 account slots.
- `engine`: Python worker, Playwright persistent-profile isolation, sequential scheduler and adapter contract.
- `.github/workflows`: CI and Cloudflare deploy workflows.

## Important limits
The Google Flow live adapter is intentionally not implemented or verified. `flowkit` and `gflow` are safe placeholders; only `dry-run` is functional. Do not assume undocumented endpoints or UI selectors. A persistent browser worker is required; GitHub Actions runners are ephemeral. Free Cloudflare can host parts of the control plane but cannot guarantee free persistent browser execution or video rendering.

## Security
Never store Google passwords, cookies, Playwright profiles, or session state in GitHub. Keep browser profiles on encrypted persistent storage controlled by the account owner.

The API does **not** use Cloudflare Access. It has two separate credentials, both stored only as Worker secrets:

- **Owner:** logs in with `OWNER_PASSWORD` (`POST /api/login`) and receives a signed, expiring, `HttpOnly` + `SameSite=Strict` session cookie (7 days, signed with `SESSION_SECRET`). The PWA never stores the password or a token.
- **Browser worker:** authenticates with `Authorization: Bearer <WORKER_TOKEN>`. The token is accepted only on `/api/worker/*`; the owner session cannot call those endpoints and the worker token cannot call owner endpoints.

On top of that the Worker enforces a strict origin policy for writes, per-identity rate limits (logins are throttled per client address before any password comparison), request-size limits, input validation, and audits every mutation. If `OWNER_PASSWORD` or `SESSION_SECRET` is missing or invalid, the API fails closed with `503`. The PWA contains no secrets (`npm run check:secrets` enforces this). See [deployment notes](docs/DEPLOY_ANDROID.md) for the setup and what is still unverified against a real Cloudflare account.

## Local development
API: `cp apps/api/.dev.vars.example apps/api/.dev.vars && cd apps/api && npm run dev` (sign in with the `OWNER_PASSWORD` from `.dev.vars`)  
PWA: `cd apps/pwa && npm run dev` (proxies `/api` to the local Worker)  
Checks: `npm run check` from the repository root (API typecheck + tests, script tests, PWA build, secret scan)  
Worker: `cd engine && python -m venv .venv && pip install -r requirements.txt && playwright install chromium && python -m worker.main` (configure `API_BASE_URL`, `WORKER_TOKEN` and `WORKER_ID` as in `engine/.env.example`; the token must match the API's `WORKER_TOKEN` secret)

Start in dry-run mode and test one account before expanding. This is a starter scaffold, not production-ready.
