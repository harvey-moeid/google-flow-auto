# Handoff — Google Flow Auto

## Project identity
- Repository: harvey-moeid/google-flow-auto
- Base branch: main
- Product: Android-first control plane for ten manually managed Google account slots.
- Fixed constraints: manual enrollment and selection; one global sequential job; dry-run default; live adapters disabled; owner-controlled persistent browser host; no quota/rate-limit evasion, CAPTCHA/security challenge bypass, or undocumented/protected endpoints.

## Verified repository baseline — 2026-11-15
- `main`: `a4e35e4` (Phase 4E merged by PR #17).
- Latest main Test workflow: run #51 / ID `43681274295`, completed successfully.
- Open PRs: 0. Open issues: 0.
- Phase 4E encrypted local profile backup/restore is merged. Automated CI does not prove encrypted-volume use, real systemd operation, persistent Google sessions, or separate-host recovery.
- Only `dry-run` is a verified functional engine. `flowkit` and `gflow` are placeholders; live generation remains disabled.
- Branch `feat/phase-6a-r2-media` is unmerged and parked. It contains commits `857b94a` and `db82bd2`; the current branch source does not contain the referenced `apps/api/src/media-routes.ts`, and its route table does not register media routes. Do not treat Phase 6A as complete or merge it without a full audit and tests.
- The implementation plan's recommended next gate remains owner-run Phase 4 operational verification. Phase 5 cannot be declared complete until the gate is satisfied and an adapter meets the permitted-interface criteria.

## Security and product invariants
- Never put Google passwords, cookies, browser profiles, session state, API secrets, or private assets in GitHub, D1, R2, CI artifacts, issues, or chat.
- Profiles stay on owner-controlled encrypted persistent storage; owner manually signs in.
- No reverse engineering or calling undocumented/protected Google endpoints; no CAPTCHA/reCAPTCHA or security-challenge bypass.
- No production deploy, live-mode enablement, or production data migration as part of code-only phase work.
- Keep dry-run as default and preserve the explicit live kill switch.
- Use feature branches and PRs; do not push directly to main.

## Session 10 — Phase 5 adapter qualification gate (documentation/research)
- Starting point: main `a4e35e4`; PR #17 merged; Test run #51 passed.
- Branch: `docs/phase-5-adapter-qualification`.
- Scope: record the current Phase 4/5 gate and evidence-based adapter assessment; no adapter installation, code execution, credential handling, live generation, or deployment.
- Findings are recorded in `docs/PHASE_5_ADAPTER_QUALIFICATION.md`.
- Flow Kit and gflow-cli are not approved as production adapters under the current project constraints: their documented integration depends on private/undocumented Flow RPC/batchexecute flows or reverse-engineered interfaces and an authenticated browser session. MIT licensing of project code does not grant rights to Google Flow services or override Google terms.
- Next: owner completes Phase 4 host/staging verification. Then re-evaluate only an official, documented, permitted integration surface; otherwise keep the product honestly labeled manual-assisted/dry-run.

## Owner-run Phase 4 verification — still BLOCKED / NOT RUN
These require the owner's host, disk, accounts and Cloudflare environment; CI cannot prove them:
- [ ] Confirm `FLOW_WORKER_DATA_DIR` is on an encrypted volume.
- [ ] Enroll at least two owner-controlled accounts; restart host and confirm isolated sessions persist.
- [ ] Populate all ten slots and repeat isolation/restart checks if ten accounts are available.
- [ ] Test `kill -9` during a test job and verify lease expiry/recovery.
- [ ] Run the systemd unit under the real service user and verify filesystem permissions.
- [ ] Create encrypted backup; copy over an owner-controlled encrypted channel; restore on a separate owner-controlled host; run `--audit-profiles`.
- [ ] Run staging smoke against real Worker API, D1 and worker token.
- Do not mark Phase 4 operational exit complete until evidence is recorded.

## Session handoff template
- Current phase / gate:
- Branch / PR / commit:
- Files changed:
- Tests and exact results:
- CI run and result:
- Deployment/staging:
- Security review:
- Owner-run blockers:
- Next concrete task:
