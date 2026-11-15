# Handoff — Google Flow Auto

## Project identity
- Repository: harvey-moeid/google-flow-auto
- Default branch: main
- Product: Android-first control plane for ten manually managed Google account slots.
- Fixed constraints: manual enrollment and selection; one global sequential job; dry-run default; live adapters disabled; owner-controlled persistent browser host; no quota/rate-limit evasion, CAPTCHA/security challenge bypass, or undocumented/protected endpoints.

## Verified baseline — 2026-11-15
- `main`: includes squash-merge of PR #25 (`a53cceed71b19b519f248fae39f570f7a527602e`) — Phase 6B steps 1, 2, 3 and 4a (media delete) merged (PR #21 `fda18325e38a62be7517c09b810f52e33f3540cf`, PR #22 `4a3f9fd9505f7f98f091d0d46cff50f9a64458e4`, PR #24 included in `67b3ab7`, PR #25 `a53cceed71b19b519f248fae39f570f7a527602e`).
- PR #25 CI (head `ef24aeb81d0171094f77df2107a6854e9a1a367e`, run ID `43688486560`): success (pwa-build and python-check).
- Open PR: #26 (Phase 6B step 4b, PWA delete control), originally stacked on `feat/phase-6b-media-delete`; retargeted to `main` after that branch was deleted post-merge. PR #23 (older handoff) is superseded by this document.
- Phase 4E encrypted local profile backup/restore is merged. Automated CI does not prove encrypted-volume use, real systemd operation, persistent Google sessions, or separate-host recovery.
- Only `dry-run` is a verified functional engine. `flowkit` and `gflow` remain unapproved; live generation remains disabled.
- Phase 6A/6B code is covered by CI only: Python tests use fake transports; the PWA media panel has NOT been exercised in a real browser against a real Worker/R2/D1.
- Upload is a one-request buffered path capped at 25 MiB to bound Worker memory use. Resumable uploads, orphan detection/cleanup, retention policy, and production R2/D1 verification remain future work. PWA delete control is in PR #26.
- Old branch `feat/phase-6a-r2-media` is stale/parked; do not merge it.
- No production deployment or remote D1 migration was performed. Migrations 0005 and 0006 exist in the repo but have not been applied to any remote D1.

## Security and product invariants
- Never put Google passwords, cookies, browser profiles, session state, API secrets, or private assets in GitHub, D1, CI artifacts, issues, or chat.
- Profiles stay on owner-controlled encrypted persistent storage; owner manually signs in.
- No reverse engineering or calling undocumented/protected Google endpoints; no CAPTCHA/reCAPTCHA or security-challenge bypass.
- No production deploy, live-mode enablement, or production data migration without explicit authorization.
- Keep dry-run as default and preserve the explicit live kill switch.
- R2 must remain private. Media download is streamed through the owner-authenticated API; no public bucket URLs or unauthenticated links. The R2 key is never returned by the API and never written to the audit log.
- Upload requires worker bearer identity and the current running job's worker ID + fencing token. Metadata publication is guarded by the same live lease in D1.
- Worker output files are uploaded only from `FLOW_OUTPUT_DIR` (symlinks resolved, `..` traversal rejected). With it unset, every output upload is refused.
- Every new API route must be added to `SAMPLES` in `apps/api/test/auth.test.ts`; CI fails otherwise.
- Use feature branches and PRs; do not push directly to main.

## Session 10 — Phase 5 qualification (merged)
- PR #18 updated handoff/roadmap and documented why FLOW KIT and gflow-cli do not meet the project's permitted documented-interface gate.
- Phase 5 remains BLOCKED; only dry-run is verified.

## Session 11 — Phase 6A private R2 media API (merged)
- Branch: `feat/phase-6a-private-r2-media`. PR #19, merge commit `c1c7dc2a531fdbbfc827f9ca35d37e7b4eb6d61f`.
- Files: `cloudflare/migrations/0005_media.sql`, `apps/api/src/media-routes.ts`, `apps/api/src/routes.ts`, `apps/api/test/media.test.ts`, `apps/api/test/auth.test.ts`.
- Routes: worker POST `/api/worker/jobs/:jobId/media`; owner GET `/api/jobs/:jobId/media`; owner GET `/api/media/:mediaId`.
- Allowed media: MP4, WebM, PNG, JPEG, WebP. Checks content type, magic signature, declared/actual length, 25 MiB cap and SHA-256.
- Server generates object keys. Owner download response is no-store and attachment disposition.
- Worker lease/fencing is verified before upload and atomically again when inserting metadata. If the lease is lost after R2 put, the object is deleted and no media row is published.

## Session 12 — Phase 6B step 1: worker uploads outputs (merged)
- Branch: `feat/phase-6b-worker-media-upload`. PR #21 (squash-merged as `fda18325e38a62be7517c09b810f52e33f3540cf`).
- Files: `engine/worker/media.py` (new), `engine/worker/api_client.py`, `engine/worker/loop.py`, `engine/worker/main.py`, `engine/.env.example`, `engine/tests/test_worker_media.py` (new, 24 tests).
- Adapter contract: `run()` may return a dict with `outputs: [path, ...]` (max 10). A result without `outputs` (dry-run) uploads nothing.
- Outputs are uploaded before `complete`, with heartbeats and cancel handling kept running during the upload (`_supervise` in `loop.py`).
- Failure semantics: transport error, 429 and 5xx are retried (3 attempts total) then `fail(media_upload_failed, retryable=true)`; other 4xx, bad path, unsupported type, empty, >25 MiB or unset `FLOW_OUTPUT_DIR` give `fail(<fixed code>, retryable=false)`; LeaseLost sends nothing further. A job is never reported complete without its media. Reports carry fixed codes only, never paths or file names.
- Not verified: a real worker against a real Worker/R2/D1, and a real (non-dry-run) adapter producing outputs.

## Session 13 — Phase 6B step 2: PWA media panel (merged)
- Branch: `feat/phase-6b-pwa-media-panel`. PR #22 (squash-merged as `4a3f9fd9505f7f98f091d0d46cff50f9a64458e4`).
- Files: `apps/pwa/src/screens/MediaPanel.tsx` (new), `apps/pwa/src/screens/Jobs.tsx`, `apps/pwa/src/api.ts`, `apps/pwa/public/_headers`.
- The job screen lists media (kind, MIME, size) and offers Preview and Download on demand. Files are fetched with the owner session cookie and held only as in-memory object URLs (revoked on hide, job change, unmount).
- CSP in `_headers` allows `blob:` for `img-src` and `media-src`; no remote image/media origin is allowed.
- Not verified: behavior in a real browser (preview of video/images, download, CSP not blocking `blob:`). The PWA has no component test harness.

## Session 14 — Phase 6B step 3: media metadata (merged)
- Branch: `feat/phase-6b-media-metadata`. PR #24 (merged; main HEAD `67b3ab7`).
- Additive migration `cloudflare/migrations/0006_media_metadata.sql` adds nullable width/height/duration_ms with bounds; old media rows remain valid.
- API validates optional worker headers (paired dimensions, max 16384 each, duration 1..86400000 ms; image duration rejected), stores them and returns them in owner listing/upload responses. Idempotent checksum replay also requires matching metadata.
- Python adapter result stays backward-compatible with string paths and accepts records `{path,width,height,duration_ms}`. PWA shows dimensions/duration when supplied.
- Metadata is trusted adapter/worker-supplied, not extracted from media bytes. Do not claim it is verified from the encoded file.

## Session 15 — Phase 6B step 4a: owner-authorized media delete (merged)
- Branch: `feat/phase-6b-media-delete`. PR #25 squash-merged as `a53cceed71b19b519f248fae39f570f7a527602e`.
- Files: `apps/api/src/media-delete.ts` (new), `apps/api/src/media-routes.ts` (registers the route), `apps/api/test/media-delete.test.ts` (new, 5 tests), `apps/api/test/auth.test.ts` (SAMPLES entry). No schema change; no migration.
- Route: owner `POST /api/media/:mediaId/delete` (same action-route convention as job cancel/resume; no router, CORS or ALLOWED_METHODS change). Worker token gets 403, anonymous 401.
- Semantics: one atomic D1 batch removes the `media` row and writes `media.deleted` (only if a row was removed). The R2 object is deleted AFTER that commit; success is audited as `media.object_deleted`, failure as `media.object_delete_failed` and the response reports `object_deleted:false` (an invisible orphan remains; cost only). Media of a job in `claimed`/`running` is refused with 409 `job_active`. Second delete or unknown id: 404 and no extra audit rows. R2 key is neither returned nor audited.
- CI: head `ef24aeb81d0171094f77df2107a6854e9a1a367e`, run ID `43688486560`: success (pwa-build including API typecheck/tests, and python-check).
- Not done: PWA delete control (PR #26, in review), orphan detection, retention policy, deployment, remote D1 migration, real R2 verification.

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

## Next work — Phase 6B (steps 1–3 and 4a merged, 4b in PR #26)
1. DONE (PR #21): worker uploads outputs before complete.
2. DONE (PR #22): PWA media listing, preview and authenticated download.
3. DONE (PR #24): trusted worker-supplied dimensions/duration.
4a. DONE (PR #25): owner-authorized, audited media delete.
4b. IN REVIEW (PR #26): PWA delete control in `MediaPanel.tsx` with an explicit confirmation step; shows the `object_deleted:false` case honestly.
4c. Orphan detection as a dry-run report only. Open design question: R2 objects without a D1 row have no media id, and the API must not expose R2 keys. Decide on an identifier (for example a truncated hash of the key, or project/job/size/uploaded only) before implementing; do not add automatic deletion until retention semantics are agreed and tested.
4d. Retention policy (owner decision required): manual-only deletion versus an age limit. Nothing is deleted automatically today.
5. Design resumable/multipart uploads for outputs above the 25 MiB one-shot cap.
6. Integration tests and staging smoke only after the owner supplies/authorizes the Cloudflare environment. Include the manual browser check of the PWA media panel and the CSP `blob:` allowance, and applying migrations 0005/0006 to a staging D1.
7. Preserve dry-run default and do not enable live engines.

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
