#!/bin/bash
set -euo pipefail
repo_dir=$(cd "$(dirname "$0")/../.." && pwd)
cd "$repo_dir"
# Only PATH and the synthetic screenshot destination survive. The worker itself
# additionally requires guard.cjs before it can load the application runtime.
exec env -i PATH="$PATH" QA_CHAT_OUTPUT="${QA_CHAT_OUTPUT:-/tmp/qa-chat-renders}" \
  timeout 120 node scripts/synthetic/qa-chat-browser.cjs
