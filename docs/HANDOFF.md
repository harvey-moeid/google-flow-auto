# Handoff — Google Flow Auto

## Project identity
- Repository: harvey-moeid/google-flow-auto
- Default branch: main
- Product: Android-first control plane for ten manually managed Google account slots.
- Fixed constraints: manual enrollment and selection; one global sequential job; dry-run default; live adapters disabled; owner-controlled persistent browser host; no quota/rate-limit evasion, CAPTCHA/security challenge bypass, or undocumented/protected endpoints.

## Verified baseline — 2026-11-15
- `main`: `c1c7dc2a531fdbbfc827f9ca35d37e7b4eb6d61f` — Phase 6A merged by PR #19.
- PR #18 (documentation/handoff and Phase 5 qualification) merged at `4ec401cfcf8b51dd5f2f098f09cbbfe51412e24a`.
- PR #19 (private R2 media upload/read API) merged at `c1c7dc2a531fdbbfc827f9ca35d37e7b4eb6d61f`.
- PR #19 branch CI run #56 / ID `43683628688`: success (python-check and pwa-build).
- Post-merge main CI run #57 / ID `43683700717`: success.
- Open PRs: 0. Open issues: 0.
- Phase 4E encrypted local profile backup/restore is merged. Automated CI does not prove encrypted-volume use, real systemd operation, persistent Google sessions, or separate-host recovery.
- Only `dry-run` is a verified functional engine. `flowkit` and `gflow` remain unapproved; live generation remains disabled.
- Phase 6A API foundation is merged: D1 media metadata table, worker-only fenced R2 upload, SHA-256/MIME/signature/size validation, owner-only media listing/download, audit event and regression tests.
- Upload is a one-request buffered path capped at 25 MiB to bound Worker memory use. Larger/resumable uploads, UI wiring, worker client integration, media deletion/retention/orphan cleanup and production R2/D1 verification remain future work.
- Old branch `feat/phase-6a-r2-media` is stale/parked; do not merge it. The implemented replacement branch was `feat/phase-6a-private-r2-media`, merged via PR #19.
- No production deployment or remote D1 migration was performed.

## Security and product invariants
- Never put Google passwords, cookies, browser profiles, session state, API secrets, or private assets in GitHub, D1, CI artifacts, issues, or chat.
- Profiles stay on owner-controlled encrypted persistent storage; owner manually signs in.
- No reverse engineering or calling undocumented/protected Google endpoints; no CAPTCHA/reCAPTCHA or security-challenge bypass.
- No production deploy, live-mode enablement, or production data migration without explicit authorization.
- Keep dry-run as default and preserve the explicit live kill switch.
- R2 must remain private. Media download is streamed through the owner-authenticated API; no public bucket URLs or unauthenticated links.
- Upload requires worker bearer identity and the current running job's worker ID + fencing token. Metadata publication is guarded by the same live lease in D1.
- Use feature branches and PRs; do not push directly to main.

## Session 10 — Phase 5 qualification (merged)
- PR #18 updated handoff/roadmap and documented why FLOW KIT and gflow-cli do not meet the project's permitted documented-interface gate.
- Phase 5 remains BLOCKED; only dry-run is verified.

## Session 11 — Phase 6A private R2 media API (merged)
- Branch: `feat/phase-6a-private-r2-media`.
- PR: #19 (merged).
- Merge commit: `c1c7dc2a531fdbbfc827f9ca35d37e7b4eb6d61f`.
- Feature commit before merge: `1f1b715f499c18950ec3ce406264d8f0d82987c7`.
- Files: `cloudflare/migrations/0005_media.sql`, `apps/api/src/media-routes.ts`, `apps/api/src/routes.ts`, `apps/api/test/media.test.ts`, `apps/api/test/auth.test.ts`.
- Routes: worker POST `/api/worker/jobs/:jobId/media`; owner GET `/api/jobs/:jobId/media`; owner GET `/api/media/:mediaId`.
- Allowed media: MP4, WebM, PNG, JPEG, WebP. Checks content type, magic signature, declared/actual length, 25 MiB cap and SHA-256.
- Server generates object keys; API never exposes the R2 key. Owner download response is no-store and attachment disposition.
- Worker lease/fencing is verified before upload and atomically again when inserting metadata. If the lease is lost after R2 put, the object is deleted and no media row is published.
- CI: run #56 success; post-merge main run #57 success.
- Deployment and remote migration: NOT RUN.

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

## Next work — Phase 6B
1. Wire the Python worker result lifecycle to upload supported output files before calling worker complete; handle upload failure/retry without losing the job result.
2. Add frontend media listing, preview and authenticated download controls.
3. Add metadata needed by UI (dimensions/duration) with server-side extraction or trusted worker metadata validation.
4. Design safe delete/retention/orphan cleanup and audit it; do not delete objects automatically until retention semantics are tested.
5. Design resumable/multipart uploads for outputs above the 25 MiB one-shot cap.
6. Add integration tests and staging smoke only after owner supplies/authorizes the configured Cloudflare environment.
7. Preserve dry-run default and do not enable live engines.

## Session 14 — Phase 6B step 3: media metadata (PR open)
- Branch: `feat/phase-6b-media-metadata`. PR #24: https://github.com/harvey-moeid/google-flow-auto/pull/24 (open; not merged).
- Latest commit: `736b63b56f708b33edf5e17fbdceabc69b1dded0`.
- Additive migration: `cloudflare/migrations/0006_media_metadata.sql` adds nullable width/height/duration_ms with bounds; old media rows remain valid.
- API validates optional worker headers (paired dimensions, max 16384 each, duration 1..86400000 ms; image duration rejected), stores metadata with D1 and includes it in owner listing/upload responses. Idempotent checksum replay also requires metadata to match.
- Python adapter result remains backward-compatible with string paths and accepts records `{path,width,height,duration_ms}`; worker validates fields and forwards metadata. Video may include dimensions + duration; images may include dimensions only.
- PWA media panel displays dimensions and duration when supplied. Missing metadata remains explicitly absent.
- Metadata is trusted adapter/worker-supplied, not independently extracted from media bytes. Do not claim it is verified from the encoded file.
- CI run #66 / run ID `43685537736`: success. Both `pwa-build` (API typecheck/tests, script tests, PWA build, secret scan) and `python-check` (compileall, pytest, dry-run smoke) passed.
- No merge, remote D1 migration, R2/Worker deployment, or real-browser test performed.

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