# Handoff — Google Flow Auto

## Project identity
- Repository: harvey-moeid/google-flow-auto
- Base branch: main
- Product: Android-first control plane for ten manually managed account slots.
- Fixed constraints: manual enrollment and selection; one global sequential job; dry-run default; live adapters disabled; owner-controlled persistent browser host; no quota evasion, CAPTCHA/security challenge bypass or undocumented protected endpoints.

## Current verified baseline
- main at 737c0ca (merge PR #16, Phase 4D).
- Phase 4A–4D are merged. Latest GitHub Test run #47 / run ID 43675197524 on main completed successfully.
- Phase 4D adds OS host lock, profile isolation audit, per-slot marker and systemd template.
- Important: systemd, real Chromium profile restart, encrypted-volume state, separate-host restore, real D1/API staging and Android E2E have not been owner-run or verified.
- Only dry-run is functional. FLOW KIT and gflow adapters remain placeholders; do not describe live generation as working.

## Continuation rules
- Create a feature branch from current main for each coherent phase; PR rather than direct main edits.
- Inspect before editing, preserve existing behavior and secrets, run tests and report exact evidence.
- Never put Google passwords, cookies, browser profiles, session state, API secrets or private assets in GitHub, D1, R2, CI artifacts, issues or chat.
- Do not enable live adapters or deploy production as part of code-only phase work.
- Update roadmap and session record only when evidence supports the status.

## Session 9 — Phase 4E (encrypted local profile backup/restore)
- Starting point: main 737c0ca; PR #16 merged; Test run #47 (43675197524) success.
- Branch: feat/phase-4e-encrypted-profile-backup.
- Scope: owner-controlled local encrypted backup/restore only; no remote transfer, API, D1, R2, PWA or live-engine changes.
- Intended files: engine/worker/profile_backup.py, engine/worker/main.py, engine/tests/test_profile_backup.py, docs/HOST_LIFECYCLE.md, docs/IMPLEMENTATION_PLAN.md, docs/HANDOFF.md.
- Security contract: scrypt-derived AES-256-GCM authenticated encryption; passphrase prompt only; no overwrite; refuse symlinks/unsafe archive paths; restore only to an empty profile tree; host lock required; temporary plaintext stays mode 0600 under configured data directory and is deleted.
- Verification: pending implementation and CI. Do not claim phase code complete until tests and review pass.
- Owner-run requirements still pending: encrypted volume, real systemd service, two/ten real profiles across restart, kill recovery, backup and restore on a separate owner-controlled host, real D1/API staging smoke.
- Next after Phase 4E: owner-run operational verification. Only then assess Phase 5 permitted live adapter feasibility; if no stable permitted interface exists, keep product manual-assisted.

## Session handoff template
- Current phase:
- Branch / PR / commit:
- Files changed:
- Tests and exact results:
- CI run and result:
- Deployment/staging:
- Security review:
- Owner-run blockers:
- Next concrete task:
