#!/usr/bin/env bash
set -euo pipefail
cd apps/api
npx wrangler d1 create google-flow-auto
echo 'Copy the returned database_id into apps/api/wrangler.toml.'
npx wrangler r2 bucket create google-flow-auto-media
echo 'Then apply the versioned migrations (cloudflare/migrations) from apps/api:'
echo '  npx wrangler d1 migrations apply google-flow-auto --remote'
