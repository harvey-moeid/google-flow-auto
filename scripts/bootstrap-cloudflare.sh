#!/usr/bin/env bash
set -euo pipefail
cd apps/api
npx wrangler d1 create google-flow-auto
echo 'Copy the returned database_id into wrangler.toml.'
npx wrangler r2 bucket create google-flow-auto-media
echo 'Apply cloudflare/schema.sql using Wrangler from the repository root.'