#!/usr/bin/env bash
# near/scripts/sandbox.sh      in Linux (or WSL): a fresh local test chain, with the market opened on it. It runs until stopped: pkill -x near-sandbox
set -e
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
[ -f "$HOME/.cargo/env" ] && source "$HOME/.cargo/env"
mkdir -p "$HOME/sandbox"; cd "$HOME/sandbox"
if [ ! -x ./near-sandbox ]; then curl -s "https://s3-us-west-1.amazonaws.com/build.nearprotocol.com/nearcore/Linux-x86_64/2.14.0/near-sandbox.tar.gz" -o s.tgz; tar xzf s.tgz; find . -name near-sandbox -type f -exec cp {} ./near-sandbox \; ; chmod +x near-sandbox; fi
pkill -x near-sandbox 2>/dev/null || true; sleep 1; rm -rf home; ./near-sandbox --home home init >/dev/null 2>&1
nohup ./near-sandbox --home home run > sandbox.log 2>&1 &
for i in $(seq 1 30); do sleep 1; curl -s --max-time 2 -X POST http://127.0.0.1:3030 -H 'content-type: application/json' -d '{"jsonrpc":"2.0","id":"x","method":"status","params":[]}' | grep -q chain_id && break; done
cd "$ROOT"
NEAR_KEY_SEED=sandbox-test-secret WARDEN_NEAR=50 MERCHANT_NEAR=5 MARKET_NEAR=20 MARKET_SEED=7 node --no-warnings near/scripts/setup.mjs sandbox test.near
