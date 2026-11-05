// near/scripts/check_code.mjs     IS THE CONTRACT ON THE CHAIN THE ONE IN THIS REPOSITORY? It hashes near/contract/res/tilldawn_market.wasm, asks the chain for the market's code hash, and reads the source link the contract itself declares (NEP-330).
//   Do:   node near/scripts/check_code.mjs
//   See:  both hashes, the link, and "The chain runs this file." It exits with 0 only if the two hashes are the same. It signs nothing and costs nothing.
//   Needs Node 20 or newer and nothing else.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { b58encode, nearClient, sha256 } from '../../src/near.js';

const MARKET = process.env.MARKET || 'market.tilldawn.testnet', RPCS = process.env.NEAR_RPC ? [process.env.NEAR_RPC] : ['https://test.rpc.fastnear.com', 'https://near-testnet.drpc.org', 'https://rpc.testnet.near.org'];
const file = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'contract', 'res', 'tilldawn_market.wasm'), client = nearClient(RPCS, fetch);
const here = b58encode(await sha256(fs.readFileSync(file))), there = (await client.accountOf(MARKET)).code_hash, source = await client.view(MARKET, 'contract_source_metadata', {}).catch(() => null);
console.log(`  this repository:    ${here}\n  ${MARKET}: ${there}`);
if (source && source.link) console.log(`  the contract says its source is at: ${source.link}`);
console.log(here === there ? '\nThe chain runs this file.' : '\nNOT THE SAME: the chain runs something else.');
process.exit(here === there ? 0 : 1);
