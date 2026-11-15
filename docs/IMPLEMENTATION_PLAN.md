# Google Flow Auto — Implementation Plan to Final Version

Repository: harvey-moeid/google-flow-auto  
Product target: Android-first PWA control plane for 10 manually managed Google Flow account slots.  
Fixed decisions: manual account enrollment and selection, one global sequential execution lane, hybrid architecture, free-first deployment.  
Verified baseline (2026-11-15): see current main branch and GitHub Actions. No live adapter is enabled.

## Product and architecture decisions
- PWA: React + TypeScript + Vite, installable from Android Chrome.
- Control plane: Cloudflare Worker; metadata: D1; private media: R2.
- Queue: durable queue plus one authoritative global lease/lock.
- Browser execution: Python + Playwright on a trusted persistent host with encrypted storage. GitHub Actions is for CI/deploy, not persistent browser sessions.
- Profiles: one isolated persistent profile per account slot; owner manually signs in. Never move profiles/cookies into GitHub, D1, CI artifacts, or logs.
- Android-only enrollment target: use a private remote desktop (Xvfb + x11vnc + noVNC) on the persistent Worker host, reached from Android through Cloudflare Tunnel + Access. Cloudflare Pages/Workers alone cannot run the persistent interactive Chromium browser.
- Engines: FLOW KIT and gflow-cli are unapproved research candidates. No adapter is enabled until a documented and permitted integration gate is met.
- Auth: owner password and signed expiring HttpOnly cookie; browser worker bearer token accepted only on worker endpoints.
- Policy: no quota/rate-limit evasion, CAPTCHA/security challenge bypass, or undocumented/protected endpoints. Pause for manual reauthentication.
- Storage: R2 bucket is private; owner media reads go through the authenticated Worker API. No public object URLs.

## Android remote enrollment status
**BLOCKED — host prerequisite.** Existing enrollment requires a visible Chromium window and terminal confirmation on the Worker host. It cannot currently be completed from Android alone. See `docs/ANDROID_REMOTE_ENROLLMENT.md` for the proposed architecture, state machine, security controls, and acceptance tests. No remote desktop service or PWA remote-enrollment control has been deployed.

## Phase progress
| Phase | Status | Evidence / remaining work |
|---|---|---|
| 0–3B | Implemented in repository | Project/scene workflow and reference media foundations. |
| 4A | Implemented | Worker claims, dry-run and queue reporting. |
| 4B | Implemented | Heartbeat, health endpoint and owner-attested manual enrollment (terminal). |
| 4C | Implemented | Android worker monitoring and manual enrollment runbook. |
| 4D | Implemented | Host lock, profile isolation audit, marker and systemd template; real-host verification remains. |
| 4E | Implemented | Encrypted local backup/restore CLI; separate-host restore and encrypted-volume proof remain owner-run. |
| 4F Android remote enrollment | **Not implemented — blocked** | Provision persistent Linux host; add Xvfb/noVNC + Access/Tunnel; implement enrollment session D1/API state machine and worker command loop; add PWA remote view/finish/cancel; test Android E2E and recovery. |
| 5 | Qualification gate / blocked | FLOW KIT and gflow-cli do not currently meet documented/permitted-interface requirements. Only dry-run is functional. |
| 6 | Media pipeline in progress | Review current PRs and run staging verification; see repository docs and open PRs. |
| 7 | Not started | Production hardening, backups, Android E2E, staging and release. |

## Phase 4F implementation sequence
1. **Host decision:** choose persistent Linux VPS/VM, encrypted persistent volume, region, backup and budget. Do not use GitHub Actions as a browser host.
2. **Remote desktop baseline:** run Xvfb, x11vnc bound to loopback, noVNC/websockify, and Cloudflare Tunnel. Protect noVNC with Cloudflare Access; do not expose VNC port 5900.
3. **Session API:** add D1 enrollment session migration, owner create/status/finish/cancel routes, worker command claim/heartbeat/complete routes, TTL and audit. Enforce one active session globally and reject active queue/profile work.
4. **Worker lifecycle:** safely open exactly one slot profile on the virtual display, keep it open only while session active, close before marking ready, and recover safely on timeout/crash/restart.
5. **Android PWA:** slot-specific Start enrollment, status polling, open remote view, finish/cancel controls, clear timeout and error states.
6. **Verification:** automated tests for state transitions and authorization; real Android Chrome + Cloudflare Access + persistent host E2E; prove no public VNC exposure and no secrets in client bundle/logs.
7. **Release:** only mark 4F complete after operational tests and encrypted backup/restore pass.

## Final acceptance checklist
- [ ] PWA installs and normal control works from Android.
- [ ] Owner authentication works; no privileged secret in frontend.
- [ ] Ten account slots are manageable; manual enrollment and manual selection.
- [ ] Android-only remote enrollment works through an Access-protected browser view.
- [ ] Ten isolated persistent profiles, safely stored and recoverable.
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
