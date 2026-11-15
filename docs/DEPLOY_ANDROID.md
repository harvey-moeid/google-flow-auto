# Deployment from Android

> **Verification status:** the Cloudflare-side wiring below (Worker route, secrets, rate-limit bindings, Pages) has **not**
> yet been exercised against a real Cloudflare account; treat the first deployment as a staging run and use the verification
> checklist at the end. The API logic itself is covered by the automated tests (`npm run test:api`).

## Security model
There is no Cloudflare Access in front of the app. The Worker authenticates every request itself, with two separate credentials:

- **Owner password.** `POST /api/login {"password": ...}` is compared in constant time against the `OWNER_PASSWORD` secret. On success the Worker sets the
  `__Host-gfa_session` cookie (`HttpOnly`, `Secure`, `SameSite=Strict`, 7 days). The cookie is an HMAC-SHA256 signed, expiring token
  (key: `SESSION_SECRET`); nothing is stored server-side. The PWA only ever sends the password to `/api/login` and keeps no token.
- **Worker token.** The browser worker sends `Authorization: Bearer <WORKER_TOKEN>`. It is accepted **only** on `/api/worker/*`. The owner session cannot call
  worker endpoints (`403 forbidden`) and the worker token cannot call owner endpoints (`403 forbidden`). Any other bearer value is rejected with `401`.
  If `WORKER_TOKEN` is not set, the worker API is disabled.
- Logins are rate limited per client address (`RL_LOGIN`) **before** the password is compared. Writes also pass a strict origin check and per-identity rate limits.
- Everything in the PWA bundle is public. `npm run check:secrets` fails CI if a secret-looking value or `VITE_*` secret is introduced.
- Recommended topology: PWA (Pages) and API (Worker route `/api/*`) on the **same hostname**, so the browser needs no CORS and the session cookie is first-party.
  `workers_dev` and `preview_urls` are disabled in `wrangler.toml`, so the API is only reachable on that hostname.
- The Worker **fails closed**: if `OWNER_PASSWORD`, `SESSION_SECRET` (or `WORKER_TOKEN`, when set) is missing, too short or still a `REPLACE_WITH_...` placeholder,
  or a rate-limit binding is missing, every `/api/*` call returns `503 server_misconfigured` and `/health` reports `{"ok":false}`.

## One-time setup
1. Create a Cloudflare account and an API token limited to the intended Workers, D1, R2 and Pages resources.
2. Create D1 database `google-flow-auto` and R2 bucket `google-flow-auto-media` (`scripts/bootstrap-cloudflare.sh`).
3. Set `database_id` in `apps/api/wrangler.toml` to the ID of **your** D1 database, then apply the versioned migrations:
   `cd apps/api && npx wrangler d1 migrations apply google-flow-auto --remote` (migrations live in `cloudflare/migrations`).
4. In `apps/api/wrangler.toml`, uncomment `routes` and set it to `app.example.com/api/*` with your `zone_name`, and make sure the four `namespace_id` values under
   `[[ratelimits]]` (`RL_READ`, `RL_WRITE`, `RL_WORKER`, `RL_LOGIN`) are unique in your account.
5. Set the secrets (never put them in `wrangler.toml` or git; each is set once and survives deploys). Run from `apps/api`:
   - `npx wrangler secret put OWNER_PASSWORD`: the owner login password, at least 10 characters (use a long random one).
   - `npx wrangler secret put SESSION_SECRET`: key that signs session cookies, at least 32 characters; generate with `openssl rand -base64 48`.
   - `npx wrangler secret put WORKER_TOKEN`: bearer token for the browser worker, at least 32 characters, using only letters, digits and `. _ ~ + / = -`
     (for example `openssl rand -base64 48`). Optional until you run a worker.
   - Optional: `ALLOWED_ORIGINS` (extra exact origins, comma separated) for CORS and writes. Not needed for the same-hostname topology.
6. Add GitHub Actions secrets `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`, then run the **Deploy Cloudflare API** workflow (it typechecks and runs the API tests first).
7. Deploy `apps/pwa` to Cloudflare Pages (root directory `apps/pwa`, build command `npm install && npm run build`, output directory `dist`) and attach the custom domain `app.example.com`.
   Do **not** set `VITE_API_URL` in production (the PWA calls `/api` on its own origin). Do not set any other `VITE_*` variable.
8. The API is not routed on the `*.pages.dev` hostname, so sign-in cannot work there. The static PWA shell holds no secrets, but you can still disable the `*.pages.dev`
   hostname and preview deployments (Pages project settings) so there is a single entry point.
9. Open `https://app.example.com`, sign in with the owner password, then install the PWA from Chrome Android using Add to Home screen.

## Verification checklist (run on staging before relying on it)
- `GET https://app.example.com/health` returns `{"ok":true}`; it returns `503` if `OWNER_PASSWORD`, `SESSION_SECRET` or a required rate-limit binding is missing or invalid.
- `curl -i https://app.example.com/api/me` without a cookie returns `401 unauthorized`.
- `POST /api/login` with a wrong password returns `401 invalid_credentials`; with the correct password it returns `200` and sets the `__Host-gfa_session` cookie,
  after which `GET /api/me` in that browser returns `{"name":"owner","source":"password"}`.
- More than 10 login attempts per minute from one address return `429` with `Retry-After`. (Workers rate limiting is approximate and per Cloudflare location.)
- Worker token: `Authorization: Bearer <WORKER_TOKEN>` on `POST /api/worker/claim` works, the same token on `GET /api/me` returns `403 forbidden`,
  and a wrong bearer value returns `401`. An owner session cookie on `/api/worker/claim` returns `403 forbidden`.
- `https://google-flow-auto-api.<account>.workers.dev` is unreachable (`workers_dev = false`).
- Rapid repeated writes return `429` with `Retry-After`.
- `GET /api/audit` shows events such as `account.updated` / `project.created` / `job.queued` / `job.cancelled`.

## Local development
1. `cp apps/api/.dev.vars.example apps/api/.dev.vars` (gitignored). It sets `APP_ENV=development`, a dev `OWNER_PASSWORD` and `SESSION_SECRET`, and `ALLOWED_ORIGINS=http://localhost:5173`.
   `APP_ENV=development` only makes the rate-limit bindings optional; it does not weaken authentication. Uncomment `WORKER_TOKEN` there to enable `/api/worker/*` for a local worker.
2. `cd apps/api && npm run dev` (Worker on `http://127.0.0.1:8787`) and `cd apps/pwa && npm run dev` (Vite on `http://localhost:5173`, proxying `/api` to the Worker). Sign in with the `OWNER_PASSWORD` from `.dev.vars`.
3. Checks: `npm run check` from the repository root (typecheck, API tests, script tests, PWA build, secret scan).

## Operations notes
- API errors use one shape: `{"error":{"code","message","request_id","details?"}}`; every response carries `x-request-id`.
- Changing the owner password: `wrangler secret put OWNER_PASSWORD`. Sessions are stateless and signed only with `SESSION_SECRET`, so existing sessions stay valid until they expire (7 days).
- To log out every session immediately (for example after a leaked cookie), rotate `SESSION_SECRET`. `POST /api/logout` only clears the cookie in that browser.
- Rotating the worker token: `wrangler secret put WORKER_TOKEN`, then update `WORKER_TOKEN` on the worker host. Until both match, the worker gets `401`.
- A cron trigger (every minute) recovers stale leases even when no worker is polling, so a crashed worker's job is requeued or failed after the retry limit.
- Live engines stay disabled (`LIVE_ENGINES_ENABLED = "false"`); only `dry-run` jobs can be queued until Phase 5.

## Browser worker
Run the Python worker on a trusted persistent host with a browser display. The owner manually signs in to each isolated account profile. The current scaffold does not provide remote desktop enrollment or secure remote profile upload.
The worker talks to the API under `/api/worker/*` (claim, start, heartbeat, complete, fail, wait, cancel-ack) using the bearer `WORKER_TOKEN`. Configure it in `engine/.env`
(see `engine/.env.example`): `API_BASE_URL` must be `https` (plain `http` is accepted only for localhost, so the token never travels unencrypted), `WORKER_TOKEN` must equal the Worker secret, and `WORKER_ID` identifies this worker.
Keep the token on the worker host only; never commit it or put it in GitHub.

## Production blockers
- A tested and permitted Google Flow adapter.
- Durable global lease/locking across worker instances.
- Secure manual enrollment and profile backup lifecycle.
- Private R2 upload and signed download URLs.
- Real Cloudflare resource IDs and secrets, and a verified staging deployment.

GitHub-hosted runners are ephemeral and are not a persistent interactive browser. Do not upload browser profiles or credentials to GitHub.
