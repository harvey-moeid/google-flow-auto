# Google Flow Auto — Implementation Plan to Final Version

Repository: harvey-moeid/google-flow-auto  
Product target: Android-first PWA control plane for 10 manually managed Google account slots.  
Fixed decisions: manual account enrollment and selection, one global sequential execution lane, hybrid architecture, free-first deployment.  
Verified baseline (2026-11-15): see current main branch and GitHub Actions. No live adapter is enabled.

## Product and architecture decisions
- PWA: React + TypeScript + Vite, installable from Android Chrome.
- Control plane: Cloudflare Worker; metadata: D1; private media: R2.
- Queue: durable queue plus one authoritative global lease/lock.
- Browser execution: existing Python + Playwright worker requires a trusted persistent host and isolated persistent profiles. This is not available under the current no-VPS constraint.
- Android no-VPS enrollment: Google Identity Services (GIS) in Android Chrome verifies the Google identity linked to a slot. It does not transfer Chrome cookies or create a Google Flow session. See `docs/ANDROID_ENROLLMENT_NO_VPS.md`.
- GitHub Actions: CI, security checks, tests, and deployment only; never use it as persistent browser storage or a Google-login relay.
- Profiles: never move profiles/cookies into GitHub, D1, CI artifacts, or logs.
- Engines: FLOW KIT and gflow-cli are unapproved research candidates. No adapter is enabled until a documented and permitted integration gate is met.
- Auth: owner password and signed expiring HttpOnly cookie; browser worker bearer token accepted only on worker endpoints.
- Policy: no quota/rate-limit evasion, CAPTCHA/security challenge bypass, or undocumented/protected endpoints. Pause for manual reauthentication.
- Storage: R2 bucket is private; owner media reads go through the authenticated Worker API. No public object URLs.

## Android enrollment status
**Identity enrollment can be implemented without VPS. Automated Flow authentication cannot.** GIS proves the selected Google identity and links it to a slot. The slot must not become `ready` for Playwright jobs from this proof alone. The existing terminal-based Playwright enrollment remains unavailable without a persistent worker host.

## Phase progress
| Phase | Status | Evidence / remaining work |
|---|---|---|
| 0–3B | Implemented in repository | Project/scene workflow and reference media foundations. |
| 4A | Implemented | Worker claims, dry-run and queue reporting. |
| 4B | Implemented | Heartbeat, health endpoint and owner-attested manual enrollment (terminal). |
| 4C | Implemented | Android worker monitoring and manual enrollment runbook. |
| 4D | Implemented | Host lock, profile isolation audit, marker and systemd template; real-host verification remains. |
| 4E | Implemented | Encrypted local backup/restore CLI; separate-host restore and encrypted-volume proof remain owner-run. |
| 4F Android identity enrollment | **Design only** | Add GIS client, D1 identity/challenge migration, server-side ID-token verification, owner API, PWA UI, replay/security tests, Android E2E. |
| 4G Flow session authorization | **Blocked** | Requires a documented/permitted Flow API or an approved persistent browser execution environment. No VPS is currently allowed. |
| 5 | Qualification gate / blocked | FLOW KIT and gflow-cli do not currently meet documented/permitted-interface requirements. Only dry-run is functional. |
| 6 | Media pipeline in progress | Review current PRs and run staging verification; see repository docs and open PRs. |
| 7 | Not started | Production hardening, backups, Android E2E, staging and release. |

## Phase 4F implementation sequence
1. Configure a Google OAuth Web client for exact PWA origins; enable GIS and request identity only, with no unnecessary scopes.
2. Add D1 migrations for identity links and single-use enrollment challenges.
3. Implement owner-only challenge and verify/unlink routes with server-side JWKS signature and claim validation, nonce, replay protection, strict validation, audit and rate limiting.
4. Add PWA slot linking, Google account selection, verification states, unlink action, and explicit Flow-not-connected notice.
5. Keep account job eligibility unchanged: identity verification must never set `accounts.status='ready'`.
6. Add unit/security tests and run Android Chrome staging E2E.
7. Document the manual Google Flow link separately; do not claim the PWA can observe or transfer its login state.

## Final acceptance checklist
- [ ] PWA installs and normal control works from Android.
- [ ] Owner authentication works; no privileged secret in frontend.
- [ ] Ten account slots are manageable; manual enrollment and manual selection.
- [ ] Android GIS identity linking works and is protected against token replay.
- [ ] Identity linking never stores Google tokens/cookies or marks a Flow account ready.
- [ ] Google Flow automation is disabled until a documented/permitted auth and execution path exists.
- [ ] Ten isolated persistent profiles remain protected if a trusted worker host is added in a future deployment.
- [ ] One global sequential lane survives worker restarts.
- [ ] Projects and ordered scenes can be created/edited.
- [ ] Dry-run/live modes separated; live has a kill switch.
- [ ] Live adapter verified and permitted, or release honestly labeled manual-assisted.
- [ ] Jobs have traceable states, audit history, safe retry and cancellation where supported.
- [ ] Private R2 outputs and owner-authenticated download access.
- [ ] Worker-to-R2 and PWA media lifecycle works end-to-end.
- [ ] Monitoring, backup/restore, rollback and runbooks tested.
- [ ] CI, security checks and Android staging E2E are green.
- [ ] Free-tier limits, actual costs and operational dependencies are documented.
