# Android-Only Account Enrollment Without VPS

Status: **design decision — no-VPS path** (2026-11-15).

## Product constraint

The owner wants to manage ten Google account slots from Android only, with no VPS, no PC, and Cloudflare Free. The current execution engine is Python + Playwright and expects a persistent browser profile on a trusted worker host.

A PWA running in Android Chrome cannot read or export Chrome's Google cookies/profile. A Cloudflare Worker cannot host a persistent interactive Chromium process. GitHub Actions runners are temporary and are not a supported persistent browser host. Therefore Android sign-in cannot be copied into the existing Playwright worker.

This design separates:
1. **Account identity enrollment** — prove which Google account the owner selected, using Google Identity Services (GIS) from the Android PWA.
2. **Flow execution authorization** — a separate capability. Identity verification alone does not create a Google Flow browser session and must never mark the account `ready` for the Playwright worker.

## Supported no-VPS architecture

- **Android PWA:** owner selects one of ten slots and invokes Google Identity Services in the browser. The user chooses and consents to the Google identity directly; no password is entered into this app.
- **Cloudflare Worker:** validates the short-lived Google ID token, checks signature and claims, enforces a one-time nonce, and links the verified Google subject to the selected slot.
- **Cloudflare D1:** stores only the Google subject, verified email, timestamps, and enrollment challenge state. Never store ID tokens, access tokens, refresh tokens, passwords, cookies, or browser profiles.
- **Cloudflare Pages:** serves the PWA.
- **GitHub Actions:** CI, tests, security checks, and deployment only. It does not receive Google credentials and does not act as a browser host.
- **Google Flow:** may be opened by an explicit Android link for manual use. The PWA cannot inspect its Chrome session or claim that Flow automation is authenticated.

## Enrollment flow

1. Owner signs in to the existing PWA.
2. Owner chooses an account slot and taps **Link Google identity**.
3. Worker creates a short-lived, single-use challenge with a cryptographically random nonce and stores only its hash, slot ID, expiry, and consumed state.
4. PWA starts GIS sign-in using the configured Google OAuth Web client ID and the challenge nonce. Authorized origins are restricted to the production/staging PWA origins.
5. Owner selects the intended Google account in Google's UI. The PWA sends the returned ID token and challenge ID to the Worker over HTTPS.
6. Worker validates the ID token signature against Google's published JWKS and validates `iss`, exact `aud`, `exp`, nonce, and `email_verified`. It consumes the challenge atomically and rejects replay, expiry, wrong audience, or a Google subject already linked to another slot.
7. Worker stores only `sub`, verified email, and timestamps. PWA displays **Identity verified — Flow session not connected**.
8. Owner may open Google Flow separately in Android Chrome for manual use. This action does not alter worker readiness.

## Proposed data model

Add a table such as `account_google_identities`:
- `account_id` primary/unique foreign key to one of the ten seeded account slots,
- `google_sub` unique opaque Google subject identifier,
- `email` verified email address,
- `verified_at`, `created_at`, `updated_at`.

Add `account_enrollment_challenges`:
- `id`, `account_id`, `nonce_hash`, `expires_at`, `consumed_at`, `created_at`.

Do not add token columns. Do not change account status to `ready` after identity verification. Keep the existing job-creation guard requiring `accounts.status='ready'` until a separately approved and technically supported Flow execution authorization exists.

## Proposed API

Owner-session protected:
- `POST /api/accounts/:id/google-identity/challenge` — create one short-lived challenge; enforce one unconsumed challenge per slot and rate limits.
- `POST /api/accounts/:id/google-identity/verify` — accept only `challenge_id` and the transient ID token; validate it server-side and consume the challenge.
- `DELETE /api/accounts/:id/google-identity` — unlink the identity after explicit owner confirmation.
- `GET /api/accounts` — expose safe identity metadata (linked email and verification timestamp), never tokens.

All mutations use existing owner session, CSRF/origin protections, strict schemas, audit events, and rate limits. Do not accept arbitrary redirect URLs, OAuth client IDs, account IDs outside the ten fixed slots, or user-supplied Google subject IDs.

## PWA changes

- Replace terminal/host instructions in the enrollment panel with **Link Google identity**.
- Show slot state distinctly: Not linked, Verification pending, Identity verified, or Verification failed.
- Show the verified email and last verification time.
- Add **Open Google Flow** as a normal external link for manual Android use, if the product URL is confirmed.
- Display a persistent warning that identity verification does not enable automated Flow jobs.
- Keep job creation disabled unless the existing backend account status is independently `ready`.

## Security and privacy

- Use GIS only for identity assertion; request no unnecessary Google scopes.
- Validate the ID token on the server; never trust decoded client-side claims.
- Use nonce, one-time challenge, short expiry, replay protection, exact OAuth audience, and verified email.
- Never log or persist the raw ID token. Redact request bodies in errors and telemetry.
- Do not store Google passwords, access/refresh tokens, cookies, browser profile data, or session exports in D1, R2, GitHub Secrets, artifacts, or PWA storage.
- Do not attempt to bypass CAPTCHA, MFA, device checks, or Google security challenges.
- Unlinking an identity removes the mapping and audit-logs the action; it does not alter a Flow session on Google's side.

## What this design does not solve

This design securely registers and verifies the Google identity associated with a slot. It does **not** authenticate the existing remote Playwright worker to Google Flow. Chrome Android's login state is isolated from the PWA and cannot be transferred to GitHub Actions or the Python worker. Cloudflare Free has no persistent Chromium desktop. GitHub Actions is not a persistent browser host.

Automated Flow execution remains blocked until one of these becomes available:
- a documented, permitted Google Flow API or OAuth integration that the worker can use; or
- a supported execution environment that can securely maintain the browser profile (which conflicts with the current no-VPS constraint).

Until then, the product must label the capability as **Android identity enrollment + manual Flow access**, not automated account enrollment for Flow.

## Acceptance tests

- Android Chrome can link the selected Google identity without entering a password into the PWA.
- Invalid signature, wrong issuer/audience, expired token, nonce mismatch, replay, and unverified email are rejected.
- A Google subject cannot be linked to two slots.
- Expired/consumed challenges cannot be reused.
- Raw ID tokens never appear in D1, R2, logs, audit details, frontend storage, or GitHub.
- Linking/unlinking never changes `accounts.status` to `ready`.
- Job creation still rejects slots that are not independently ready.
- PWA accurately distinguishes identity verification from Flow execution authorization.
- GIS works on real Android Chrome against staging and production origins.
- GitHub Actions only runs CI/deploy and never handles Google sign-in state.
