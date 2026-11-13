# Google Flow Auto

Android-first starter project for managing up to 10 manually enrolled Google account slots with sequential job execution.

## Repository status

This repository is the initial project landing page. The complete starter source archive is available from the ChatGPT conversation as google-flow-auto-starter.zip.

The starter includes:
- React + Vite PWA dashboard
- Cloudflare Worker API scaffold
- Cloudflare D1 schema with 10 account slots
- Python Playwright worker scaffold with isolated persistent browser profiles
- Sequential scheduler and dry-run adapter
- GitHub Actions test/deploy workflow templates

## Important limitations

This is a scaffold, not a production-ready Google Flow integration:
- The live Google Flow adapter is not implemented or verified.
- Remote manual account enrollment is not complete.
- Production authentication, encrypted profile storage, global concurrency locking, and R2 media transfer need implementation.
- Do not commit passwords, cookies, browser profiles, or session state.
- Use only accounts you own or are authorized to operate, and comply with Google service limits and terms.

## Intended architecture

- Control plane: Android PWA
- API/database: Cloudflare Workers + D1
- Media storage: Cloudflare R2 (integration pending)
- Execution: persistent worker host running Playwright
- Scheduling: sequential, one active job at a time
- Account selection: manual selection from 10 isolated slots

See the deployment notes and starter archive for the implementation scaffold.
