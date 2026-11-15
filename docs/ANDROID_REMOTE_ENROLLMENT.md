# Android Remote Google Account Enrollment

Status: **design only — not implemented or deployed** (2026-11-15).

## Goal

Allow the owner to enroll one of the ten Google account slots using only an Android phone. The phone is the control/display client; the actual persistent Chromium profile remains on the trusted Worker host.

This is not achievable with Cloudflare Pages + Workers alone. They do not provide a persistent interactive Chromium desktop or durable local browser profile storage. GitHub Actions runners are ephemeral and must not be used for this.

## Recommended architecture

- **Android PWA:** owner chooses one slot, starts enrollment, opens a time-limited remote desktop view, and confirms completion/cancellation.
- **Cloudflare Worker + D1:** owner-authenticated enrollment-session API, state machine, audit events, TTL/expiry, and one-active-session constraint.
- **Persistent Linux Worker host:** existing Python/Playwright worker, encrypted persistent volume, Xvfb display, x11vnc, and noVNC/websockify.
- **Cloudflare Tunnel + Access:** publish only the noVNC web endpoint through an authenticated Access application. No public inbound VNC port; never expose port 5900 or the noVNC origin directly.
- **Existing profile manager:** open only the selected slot's profile; do not export/import cookies or profile data to the phone, PWA, D1, R2, or GitHub.

## Owner flow from Android

1. Sign in to the PWA with the existing owner password.
2. Open Accounts, select a slot in `needs_login` (or an explicit re-auth state), and tap **Start enrollment**.
3. API creates a random enrollment session with a short expiry (suggested 10 minutes), records the selected account and state, and sends a command to the Worker through its authenticated worker channel.
4. Worker verifies no job/profile is active, acquires the existing host lock, opens exactly that slot's persistent Chromium profile in the virtual display, and reports the session as active.
5. PWA opens the noVNC page in a new browser tab. Owner completes Google sign-in manually using Android touch/keyboard.
6. Owner returns to the PWA and taps **I have finished**. The Worker closes the selected browser context first (flush profile to disk), then reports completion. The API marks the account ready only after explicit owner confirmation.
7. Owner can cancel at any time. Expired, cancelled, disconnected, or failed sessions close the browser and leave the account status unchanged unless the owner explicitly confirmed completion.
8. Worker resumes queue service only after enrollment lock is released.

## API / D1 design proposal

Add an `account_enrollment_sessions` table with:
- `id` random UUID, `account_id` constrained to the ten seeded slots,
- `status`: `requested | opening | active | finishing | completed | cancelled | expired | failed`,
- `created_at`, `expires_at`, `started_at`, `finished_at`,
- opaque worker/session correlation ID (never a VNC password or Google credential),
- owner audit references.

Owner routes (all session-cookie protected):
- `POST /api/accounts/:id/enrollment` — create one session; reject if another session/job/profile is active.
- `GET /api/enrollment/:id` — read status and a short-lived remote-view URL only while active.
- `POST /api/enrollment/:id/finish` — owner attests login is complete; ask worker to close browser, then set ready only after close succeeds.
- `POST /api/enrollment/:id/cancel` — close browser without changing readiness.
- `POST /api/enrollment/:id/renew-view` — if required, mint a very short-lived viewing authorization; never persist it.

Worker-only routes:
- claim/heartbeat/complete enrollment commands using the existing `WORKER_TOKEN` audience separation.
- Worker must reject stale/expired commands and enforce one profile at a time.

The exact API shape and D1 migration must be finalized with tests before implementation. Do not accept arbitrary account IDs, URLs, display numbers, or filesystem paths from the browser.

## Remote desktop security requirements

- Put noVNC behind Cloudflare Access (or an equivalent authenticated private tunnel); require owner identity and MFA where available.
- Tunnel only the HTTPS noVNC endpoint. Bind x11vnc to loopback; do not publish VNC TCP port 5900.
- Use a unique, random, one-session viewing credential with short expiry. Do not put long-lived VNC passwords or worker tokens in PWA JavaScript, URLs, D1, browser storage, logs, or QR codes.
- Add CSRF/origin validation and rate limits to every owner mutation; use existing owner session cookies.
- Restrict noVNC to the enrollment display; do not expose the host desktop, shell, clipboard, filesystem, or other account profiles.
- Disable clipboard/file transfer where supported. Do not record screen, keystrokes, or Google credentials.
- Use encrypted persistent storage for `FLOW_WORKER_DATA_DIR`; strict filesystem permissions and profile isolation audit remain mandatory.
- Stop queue processing before enrollment and hold a single-host lock until Chromium is closed. Never open the same profile twice.
- On timeout, owner cancel, worker crash, or host restart: close/kill the enrollment browser safely, mark session failed/expired, keep account not-ready, and release the lock only after process cleanup.
- Keep logs redacted: session ID, slot number, state and timestamps only.

## Host deployment shape

A persistent Linux VM/VPS is required. A container may be used only if its profile volume is persistent and encrypted, and the browser/display process is supervised. Run the existing Python Worker with a stable `DISPLAY` (for example Xvfb `:99`), and a separately supervised noVNC/websockify service reachable only through Cloudflare Tunnel + Access.

Do not assume the free Cloudflare plan supplies this VM. A free GitHub Actions runner is not a substitute. Confirm provider pricing, disk encryption, region, backup and restart behavior before choosing a host.

## Acceptance tests before release

- Android Chrome can open the remote display, interact with Google login, and return to the PWA.
- One enrollment session at a time; a concurrent job or second profile open is rejected.
- Only the selected slot's profile is opened and its marker/isolation audit passes.
- Successful owner confirmation closes Chromium before `ready` is persisted.
- Cancel, timeout, network loss, worker crash, and host restart never mark an account ready.
- Expired session URL cannot reconnect; unauthenticated users cannot reach noVNC.
- VNC/5900 is not reachable from the public internet; only Access-protected HTTPS is reachable.
- No Google password, cookie, browser profile, VNC secret, or worker token appears in PWA assets, D1, R2, GitHub, or logs.
- Queue serialization and lease recovery still pass the existing test suite.
- Real Android + staging Cloudflare + persistent-host end-to-end test passes.

## Current blocker / required owner decision

No persistent Linux host/VPS has been identified or provisioned in the repository configuration. Before implementing the remote desktop bridge and deploying it, the owner must choose/provide a persistent Linux host. Cloudflare Pages/Workers/D1/R2 can remain the control plane, but cannot host the interactive Chromium desktop themselves.
