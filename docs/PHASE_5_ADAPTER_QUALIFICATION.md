# Phase 5 — Adapter Qualification Assessment

Date: 2026-11-15  
Repository baseline: `harvey-moeid/google-flow-auto` main `a4e35e4`  
Decision: **BLOCKED — no candidate approved for a production adapter.**

## Scope and acceptance gate

This assessment checks whether a candidate can be integrated without violating the product's fixed constraints:
- supported/documented integration surface;
- no undocumented or private/protected endpoint calls;
- no CAPTCHA/reCAPTCHA or security-challenge bypass;
- manual owner authentication and reauthentication;
- no quota/rate-limit evasion;
- stable enough contract for validate/submit/poll/result/error handling;
- explicit kill switch and dry-run default.

An open-source code license applies to the candidate's code. It does not grant rights to Google Flow, Veo, generated output, or Google's service terms.

## Candidate: FLOW KIT (`crisng95/flowkit`)

Evidence reviewed:
- Upstream repository: https://github.com/crisng95/flowkit
- Upstream README/release notes describe a Chrome extension bridge that runs Flow batchexecute calls inside a signed-in `flow.google.com` tab.
- Upstream notes state the previous REST transport was removed after Flow stopped minting the bearer token it required.
- The browser page/extension is responsible for signing calls; this is not a documented public Flow API contract.

Assessment:
- Code license: MIT (candidate code only).
- Integration surface: browser bridge plus private/internal Flow RPC/batchexecute behavior.
- Authentication: owner must keep a signed-in browser tab open.
- Headless/serverless suitability: not suitable as a stable headless adapter; a real browser tab remains required.
- Project policy: **FAIL** for direct adapter approval because the required Flow call contract is not a documented public API and relies on internal RPC behavior.
- Action: do not vendor, install or invoke it from the production worker as a live adapter under the current constraints.

## Candidate: gflow-cli (`ffroliva/gflow-cli`)

Evidence reviewed:
- Upstream repository: https://github.com/ffroliva/gflow-cli
- Upstream README labels the project unofficial and alpha.
- Upstream documentation describes real Chrome/Playwright browser automation and account-owned sessions.
- Upstream project material describes reverse-engineered/private Flow transport details; the MIT license covers the CLI code only, not Flow or Google service rights.

Assessment:
- Code license: MIT (candidate code only).
- Integration surface: unofficial browser automation and private/reverse-engineered Flow behavior, not a Google-supported public API.
- Authentication: real user browser session/profile; generation consumes the owner's Flow entitlement/credits.
- Stability: alpha; upstream implementation and Flow UI behavior can change.
- Project policy: **FAIL** for direct production adapter approval under the current no-undocumented-endpoints constraint.
- Action: do not install, vendor or invoke it from the production worker as a live adapter under the current constraints.

## Result

| Candidate | Code license | Documented public Flow API | Meets project policy | Decision |
|---|---|---|---|---|
| FLOW KIT | MIT | No; internal browser-signed RPC bridge | No | Reject for production adapter |
| gflow-cli | MIT | No; unofficial browser automation/private transport | No | Reject for production adapter |
| dry-run (in-repo) | In-repo | Local adapter contract | Yes | Keep as only verified engine |

## Next steps

1. Complete the owner-run Phase 4 operational verification recorded in `docs/HOST_LIFECYCLE.md`.
2. Continue using `dry-run` while Phase 4 is blocked.
3. Re-open Phase 5 only if Google publishes a supported, documented integration surface or a candidate can demonstrate a permitted surface that passes security/legal review.
4. If no such surface becomes available, label the release manual-assisted. Do not describe the product as fully automated.
5. Re-audit candidates against current upstream documentation before any future implementation; this assessment is time-bound.

## Non-goals

- No reverse engineering of protected endpoints.
- No extraction, replay or storage of browser cookies/session tokens.
- No CAPTCHA/reCAPTCHA bypass.
- No quota evasion or multi-account rotation to bypass limits.
- No live generation or production deployment in this phase.
