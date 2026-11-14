# Deployment from Android

> **Verification status:** the API authentication, CORS, validation, rate-limit and audit logic is covered by automated tests
> (`npm run test:api`). The Cloudflare-side wiring below (Access application, Worker route, rate-limit bindings, Pages) has **not**
> yet been exercised against a real Cloudflare account; treat the first deployment as a staging run and use the verification
> checklist at the end.

## Security model (Phase 1)
- **Cloudflare Access** is the only way in. It authenticates the owner and attaches a signed JWT (`Cf-Access-Jwt-Assertion`) to every request.
- The **Worker verifies that JWT itself** (RS256 signature against the team JWKS, `iss`, `aud`, `exp`/`nbf`, `kid`) and then requires the `email` claim
  to be in the `ALLOWED_EMAILS` allowlist. If Access is misconfigured or bypassed, requests are still rejected with `401`/`403`.
- There is **no shared bearer token** and no secret in the PWA. Everything in the PWA bundle is public. `npm run check:secrets` fails CI if a secret-looking value or `VITE_*` secret is introduced.
- Recommended topology: PWA (Pages) and API (Worker route `/api/*`) on the **same hostname**, so the browser needs no CORS and the Access cookie is first-party.
- The Worker **fails closed**: if any required setting is missing or still a `REPLACE_WITH_...` placeholder, every `/api/*` call returns `503 server_misconfigured` and `/health` reports `{"ok":false}`.

## One-time setup
1. Create a Cloudflare account and an API token limited to the intended Workers, D1, R2 and Pages resources.
2. Create D1 database `google-flow-auto` and R2 bucket `google-flow-auto-media` (`scripts/bootstrap-cloudflare.sh`).
3. Replace `REPLACE_WITH_D1_DATABASE_ID` in `apps/api/wrangler.toml` and apply `cloudflare/schema.sql` with Wrangler (it is idempotent).
4. **Zero Trust → Access → Applications → Add → Self-hosted.** Application domain = your PWA hostname (for example `app.example.com`, no path, so it covers `/api/*` too).
   Add a policy that allows only your own email (the free One-time PIN login works). Copy the **Application Audience (AUD) tag** and note your **team domain**
   (`<team>.cloudflareaccess.com`).
5. Edit `apps/api/wrangler.toml`:
   - set `CF_ACCESS_TEAM_DOMAIN` and `CF_ACCESS_AUD`;
   - uncomment `routes` and set it to `app.example.com/api/*` with your `zone_name`;
   - make sure the two `namespace_id` values under `[[ratelimits]]` are unique in your account.
6. Set the owner allowlist as a **secret** (keeps your email out of git and survives deploys):
   `cd apps/api && npx wrangler secret put ALLOWED_EMAILS` (comma separated).
7. Add GitHub Actions secrets `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`, then run the **Deploy Cloudflare API** workflow (it typechecks and runs the API tests first).
8. Deploy `apps/pwa` to Cloudflare Pages (root directory `apps/pwa`, build command `npm install && npm run build`, output directory `dist`) and attach the custom domain `app.example.com`.
   Do **not** set `VITE_API_URL` in production (the PWA calls `/api` on its own origin). Do not set any other `VITE_*` variable.
9. Protect or disable the `*.pages.dev` hostname (Pages project → Settings → Access policy / disable preview deployments) so the PWA is only served behind Access.
10. Install the PWA from Chrome Android using Add to Home screen.

## Verification checklist (run on staging before relying on it)
- `curl -i https://app.example.com/api/me` → redirect to the Access login (Access is in front). In a signed-in browser, `GET /api/me` returns your email.
- Signing in with an email **not** in the policy is blocked by Access; if you temporarily add it to the policy but not to `ALLOWED_EMAILS`, the API returns `403 forbidden`.
- `https://google-flow-auto-api.<account>.workers.dev` is unreachable (`workers_dev = false`).
- `GET https://app.example.com/health` returns `{"ok":true}`; it returns `503` if configuration is incomplete.
- Rapid repeated writes return `429` with `Retry-After`. (Workers rate limiting is approximate and per Cloudflare location.)
- `GET /api/audit` shows `account.updated` / `project.created` / `job.queued` / `job.cancelled` events with the actor and a request id.

## Local development
1. `cp apps/api/.dev.vars.example apps/api/.dev.vars` (gitignored). It sets `APP_ENV=development` and `DEV_AUTH_EMAIL`, which is honoured **only** when `APP_ENV` is exactly `development` and the request host is `localhost`/`127.0.0.1`.
2. `cd apps/api && npm run dev` (Worker on `http://127.0.0.1:8787`) and `cd apps/pwa && npm run dev` (Vite on `http://localhost:5173`, proxying `/api` to the Worker).
3. Checks: `npm run check` from the repository root (typecheck, API tests, script tests, PWA build, secret scan).

## Operations notes
- API errors use one shape: `{"error":{"code","message","request_id","details?"}}`; every response carries `x-request-id`.
- Cloudflare rotates Access signing keys; the Worker refetches the JWKS hourly and on an unknown `kid` (at most once per minute) and tolerates a short JWKS outage with cached keys.
- Changing the allowlist: `wrangler secret put ALLOWED_EMAILS` (no redeploy of code needed).
- Live engines stay disabled (`LIVE_ENGINES_ENABLED = "false"`); only `dry-run` jobs can be queued until Phase 5.

## Browser worker
Run the Python worker on a trusted persistent host with a browser display. The owner manually signs in to each isolated account profile. The current scaffold does not provide remote desktop enrollment or secure remote profile upload.
The worker does not call the API yet. When Phase 2 adds worker endpoints, they will use a Cloudflare Access **service token** (not a shared static bearer token) with its own narrow authorization.

## Production blockers (unchanged by Phase 1)
- A tested and permitted Google Flow adapter.
- Durable global lease/locking across worker instances.
- Secure manual enrollment and profile backup lifecycle.
- Private R2 upload and signed download URLs.
- Real Cloudflare resource IDs and secrets, and a verified staging deployment.

GitHub-hosted runners are ephemeral and are not a persistent interactive browser. Do not upload browser profiles or credentials to GitHub.
