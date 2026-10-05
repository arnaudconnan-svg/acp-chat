#!/bin/bash
set -euo pipefail
repo_dir=$(cd "$(dirname "$0")/../.." && pwd)
cd "$repo_dir"
safe_env=(env -i PATH="$PATH" TMPDIR=/tmp NODE_ENV=test REFRESH_EMERGENCY_ON_BOOT=false LOG_PERSIST=false LOG_PRETTY=false MISTRAL_API_KEY=synthetic-unused FIREBASE_DATABASE_URL=https://synthetic.example.test FIREBASE_SERVICE_ACCOUNT='{}' NODE_OPTIONS="--require=$repo_dir/scripts/synthetic/guard.cjs")
"${safe_env[@]}" /bin/bash -c 'npm run verify:synthetic'
