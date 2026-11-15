# Handoff — Google Flow Auto

## Project identity
- Repository: harvey-moeid/google-flow-auto
- Default branch: main
- Product: Android-first control plane for ten manually managed Google account slots.
- Fixed constraints: manual enrollment and selection; one global sequential job; dry-run default; live adapters disabled; owner-controlled persistent browser host; no quota/rate-limit evasion, CAPTCHA/security challenge bypass, or undocumented/protected endpoints.

## Verified baseline — 2026-11-15
- `main`: `4a3f9fd9505f7f98f091d0d46cff50f9a64458e4` — Phase 6B steps 1 and 2 merged (PR #21 `fda18325e38a62be7517c09b810f52e33f3540cf`, PR #22 `4a3f9fd9505f7f98f091d0d46cff50f9a64458e4`).
- Post-merge main CI run ID `43684803312`: success (python-check and pwa-build).
- PR #21 head `1fb8f2f8dca33e8b9598b56bb5df9c3a2fc46b10` CI run ID `43684544529`: success. PR #22 head `7edda3c44cdfc54a590427607449846c51fc510d` CI run ID `43684745426`: success.
- Earlier baseline: Phase 6A merged by PR #19 (`c1c7dc2a531fdbbfc827f9ca35d37e7b4eb6d61f`); PR #18 (documentation and Phase 5 qualification) at `4ec401cfcf8b51dd5f2f098f09cbbfe51412e24a`; PR #20 handoff at `1b40336`.
- Phase 4E encrypted local profile backup/restore is merged. Automated CI does not prove encrypted-volume use, real systemd operation, persistent Google sessions, or separate-host recovery.
- Only `dry-run` is a verified functional engine. `flowkit` and `gflow` remain unapproved; live generation remains disabled.
- Phase 6A API foundation is merged: D1 media metadata table, worker-only fenced R2 upload, SHA-256/MIME/signature/size validation, owner-only media listing/download, audit event and regression tests.
- Phase 6B step 1 (worker uploads outputs) and step 2 (PWA media panel) are merged. They are covered by CI only: the Python tests use fake transports, and the PWA panel has NOT been exercised in a real browser against a real Worker/R2.
- Upload is a one-request buffered path capped at 25 MiB to bound Worker memory use. Larger/resumable uploads, media deletion/retention/orphan cleanup, media dimension/duration metadata and production R2/D1 verification remain future work.
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
- Worker output files are uploaded only from `FLOW_OUTPUT_DIR` (symlinks resolved, `..` traversal rejected). With it unset, every output upload is refused.
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

## Session 12 — Phase 6B step 1: worker uploads outputs (merged)
- Branch: `feat/phase-6b-worker-media-upload`. PR: #21 (squash-merged as `fda18325e38a62be7517c09b810f52e33f3540cf`).
- Files: `engine/worker/media.py` (new), `engine/worker/api_client.py`, `engine/worker/loop.py`, `engine/worker/main.py`, `engine/.env.example`, `engine/tests/test_worker_media.py` (new, 24 tests).
- Adapter contract: `run()` may return a dict with `outputs: [path, ...]` (max 10). A result without `outputs` (dry-run) uploads nothing.
- Outputs are uploaded before `complete`, with heartbeats and cancel handling kept running during the upload (`_supervise` in `loop.py`).
- Failure semantics: transport error, 429 and 5xx are retried (3 attempts total) then `fail(media_upload_failed, retryable=true)`; other 4xx, bad path, unsupported type, empty, >25 MiB or unset `FLOW_OUTPUT_DIR` give `fail(<fixed code>, retryable=false)`; LeaseLost sends nothing further. A job is never reported complete without its media. Reports carry fixed codes only, never paths or file names.
- Not verified: a real worker against a real Worker/R2/D1, and a real (non-dry-run) adapter producing outputs. `flowkit`/`gflow` remain unapproved.

## Session 13 — Phase 6B step 2: PWA media panel (merged)
- Branch: `feat/phase-6b-pwa-media-panel`. PR: #22 (squash-merged as `4a3f9fd9505f7f98f091d0d46cff50f9a64458e4`).
- Files: `apps/pwa/src/screens/MediaPanel.tsx` (new), `apps/pwa/src/screens/Jobs.tsx`, `apps/pwa/src/api.ts`, `apps/pwa/public/_headers`.
- The job screen lists media (kind, MIME, size) and offers Preview and Download on demand. Files are fetched with the owner session cookie and held only as in-memory object URLs (revoked on hide, job change, unmount).
- CSP in `_headers` now allows `blob:` for `img-src` and `media-src`; no remote image/media origin is allowed.
- Not verified: behavior in a real browser (preview of video/images, download, CSP not blocking `blob:`). The PWA has no component test harness.

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

## Next work — Phase 6B (steps 1 and 2 done)
1. DONE (PR #21): wire the Python worker result lifecycle to upload supported output files before worker complete; upload failure/retry does not lose the job result.
2. DONE (PR #22): frontend media listing, preview and authenticated download controls.
3. Add metadata needed by UI (dimensions/duration) with server-side extraction or trusted worker metadata validation.
4. Design safe delete/retention/orphan cleanup and audit it; do not delete objects automatically until retention semantics are tested.
5. Design resumable/multipart uploads for outputs above the 25 MiB one-shot cap.
6. Add integration tests and staging smoke only after owner supplies/authorizes the configured Cloudflare environment. Include the manual browser check of the PWA media panel and the CSP `blob:` allowance.
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