#!/usr/bin/env bash
# near/scripts/local_demo.sh    THE WHOLE THING FROM NOTHING, ON THIS MACHINE (Linux or WSL, Node 22+): a local NEAR chain, the contract deployed and opened, a stand-in for NEAR AI with its own signing key, the market's server, one every-minute tick, then the terminal walk-through and the signature check.
#   Do:   bash near/scripts/local_demo.sh
#   See:  "Every step held." and "Every check passed." It takes about two minutes, most of it the first download of the chain binary. Nothing here costs money or touches the live game.
#   The contract comes prebuilt (near/contract/res/). To build it yourself: cd near/contract && cargo near build non-reproducible-wasm, then WASM=<the file> bash near/scripts/local_demo.sh
set -e
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"; cd "$ROOT"
export WASM="${WASM:-$ROOT/near/contract/res/tilldawn_market.wasm}"
(cd near/test && [ -d node_modules ] || npm install --silent)
bash near/scripts/sandbox.sh
export NEAR_KEY_SEED=sandbox-test-secret
node --no-warnings near/test/fake_nearai.mjs 8795 > /tmp/tdm_fake.log 2>&1 &
FAKE=$!
cd near/worker
npx --yes wrangler@4.157.0 d1 execute till-dawn-market --local --file=../../db/market.sql > /tmp/tdm_db.log 2>&1
npx --yes wrangler@4.157.0 dev --port 8791 --local --test-scheduled --var NEAR_KEY_SEED:sandbox-test-secret --var NEARAI_KEY:stand-in > /tmp/tdm_worker.log 2>&1 &
WORKER=$!
cd "$ROOT"
trap 'kill $FAKE $WORKER 2>/dev/null; pkill -x near-sandbox 2>/dev/null; true' EXIT
for i in $(seq 1 40); do sleep 2; curl -s --max-time 4 http://127.0.0.1:8791/api/bazaar/state | grep -q '"ok":true' && break; done
curl -s -o /dev/null "http://127.0.0.1:8791/__scheduled?cron=*+*+*+*+*"; sleep 3
export SITE=http://127.0.0.1:8791 NEAR_RPC=http://127.0.0.1:3030
node --no-warnings near/scripts/judge_demo.mjs
echo
node --no-warnings near/scripts/verify_decision.mjs
