# Google Flow Auto — Multi-Account Starter

Android-first control-plane scaffold for up to 10 manually enrolled Google accounts. Account selection is manual and jobs are sequential.

## Components
- `apps/pwa`: React + Vite Android-friendly PWA dashboard.
- `apps/api`: Cloudflare Worker API.
- `cloudflare/schema.sql`: D1 schema for accounts, projects, scenes, jobs, lease and audit events; seeds 10 account slots.
- `engine`: Python worker, Playwright persistent-profile isolation, sequential scheduler and adapter contract.
- `.github/workflows`: CI and Cloudflare deploy workflows.

## Important limits
The Google Flow live adapter is intentionally not implemented or verified. `flowkit` and `gflow` are safe placeholders; only `dry-run` is functional. Do not assume undocumented endpoints or UI selectors. A persistent browser worker is required; GitHub Actions runners are ephemeral. Free Cloudflare can host parts of the control plane but cannot guarantee free persistent browser execution or video rendering.

## Security
Never store Google passwords, cookies, Playwright profiles, or session state in GitHub. Keep browser profiles on encrypted persistent storage controlled by the account owner. The current PWA token setting is for local development only: do not expose a privileged shared API token in a public frontend. Add Cloudflare Access/OAuth before production use.

## Local development
PWA: `cd apps/pwa && npm install && npm run dev`
API: `cd apps/api && npm install && npm run dev`
Worker: `cd engine && python -m venv .venv && pip install -r requirements.txt && playwright install chromium && python -m worker.main`

Start in dry-run mode and test one account before expanding. This is a starter scaffold, not production-ready automation.