# Deployment from Android

1. Create a Cloudflare account and an API token limited to the intended Workers, D1 and R2 resources.
2. Create D1 database `google-flow-auto` and R2 bucket `google-flow-auto-media`.
3. Replace `REPLACE_WITH_D1_DATABASE_ID` in `apps/api/wrangler.toml`.
4. Apply `cloudflare/schema.sql` with Wrangler.
5. Add GitHub Actions secrets `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`.
6. Configure a secure user authentication layer such as Cloudflare Access/OAuth before exposing the PWA or API.
7. Deploy the API workflow. Deploy `apps/pwa` to Cloudflare Pages with build command `npm install && npm run build` and output directory `dist`.
8. Install the PWA from Chrome Android using Add to Home screen.

## Browser worker
Run the Python worker on a trusted persistent host with a browser display. The owner manually signs in to each isolated account profile. The current scaffold does not provide remote desktop enrollment or secure remote profile upload.

## Production blockers
- A tested and permitted Google Flow adapter.
- Durable global lease/locking across worker instances.
- Secure manual enrollment and profile backup lifecycle.
- Private R2 upload and signed download URLs.
- Production authentication; never embed a privileged bearer token in browser JavaScript.

GitHub-hosted runners are ephemeral and are not a persistent interactive browser. Do not upload browser profiles or credentials to GitHub.