#!/usr/bin/env bash
# the whole road on the local test chain (run in Linux): near/scripts/e2e_sandbox.sh
cd "$(dirname "$0")/../.." || exit 1
export SANDBOX_KEY="$(node -e "console.log(JSON.parse(require('fs').readFileSync(process.env.HOME+'/sandbox/home/validator_key.json','utf8')).secret_key)")"
exec node --no-warnings near/test/e2e.mjs sandbox test.near
