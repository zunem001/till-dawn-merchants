// node near/scripts/setup.mjs <network> <root account> [--seed-file <file>]        OPENS THE MARKET: makes the accounts under the root account, puts the contract on `market.<root>` and opens it with the numbers of market_rules.js.
//   network: sandbox (the local test chain) or testnet.   The root account's key is read from its keychain file and is never printed.
//   What it makes:  market.<root>   the contract                  warden.<root>   the game's server: function-call keys to the contract only, each with a gas allowance, so a stolen key can do no more than the warden's own work
//                   <merchant>.<root>   each merchant's own wallet, with a function-call key limited to `decide` and `decide_sealed`
//   The keys of the warden and the merchants all come from one secret (NEAR_KEY_SEED, in .dev.vars and in Cloudflare), so that one secret is all there is to keep.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';
import { Act, derivedKey, keyFromSecret, nearClient } from '../../src/near.js';
const require = createRequire(import.meta.url), { initArgs } = require('./init_args.js'), R = require('../../market_rules.js');
const [network, root] = process.argv.slice(2), NEAR = 10n ** 24n, near = x => BigInt(Math.round(x * 1000)) * 10n ** 21n;
const RPC = { sandbox: ['http://127.0.0.1:3030'], testnet: ['https://test.rpc.fastnear.com', 'https://near-testnet.drpc.org', 'https://rpc.testnet.near.org'] }[network]; if (!RPC || !root) { console.log('usage: setup.mjs <sandbox|testnet> <root account>'); process.exit(1); }
const WASM = process.env.WASM || (process.platform === 'win32' ? null : path.join(os.homedir(), 'tdm-target', 'near', 'tilldawn_market.wasm')), client = nearClient(RPC);
const secretFile = process.env.ROOT_KEY_FILE || path.join(os.homedir(), '.near-credentials', network, root + '.json');
const rootSecret = network === 'sandbox' ? JSON.parse(fs.readFileSync(path.join(os.homedir(), 'sandbox', 'home', 'validator_key.json'), 'utf8')).secret_key : JSON.parse(fs.readFileSync(secretFile, 'utf8')).private_key;
const rootKey = await keyFromSecret(rootSecret), seed = process.env.NEAR_KEY_SEED; if (!seed) { console.log('NEAR_KEY_SEED is not set'); process.exit(1); }
const MARKET = 'market.' + root, WARDEN = 'warden.' + root, WARDEN_KEYS = 8, wardenMethods = ['serve', 'crank', 'add_device_key', 'add_signer', 'execute_intents'];
const prompts = Object.fromEntries(R.MERCHANTS.map(m => [m.id, R.merchantPrompt(m)]));          // (each merchant's character is pinned on the chain by its hash)
const say = m => console.log('  ' + m);
async function ensureAccount(id, balance, actions) {
  if (await client.accountExists(id)) { say(id + ' is already there'); return false; }
  const r = await client.tx(root, rootKey, id, [Act.create(), Act.transfer(balance), ...actions]); if (!r.ok) throw new Error(id + ': ' + r.failure); say(id + ' made (' + r.hash + ')'); return true;
}
console.log(`Opening the market on ${network} under ${root}`);
const bal = await client.accountOf(root); say('the root account holds ' + (Number(BigInt(bal.amount) / 10n ** 21n) / 1000).toFixed(2) + ' NEAR');
const wardenKeys = []; for (let i = 0; i < WARDEN_KEYS; i++) wardenKeys.push(await derivedKey(seed, 'warden:' + i));
await ensureAccount(WARDEN, near(+process.env.WARDEN_NEAR || 2), [Act.addFullKey(rootKey.publicKey), ...wardenKeys.map(k => Act.addCallKey(k.publicKey, MARKET, wardenMethods, null))]);
for (const m of R.MERCHANTS) { const k = await derivedKey(seed, 'merchant:' + m.id); await ensureAccount(m.id + '.' + root, near(+process.env.MERCHANT_NEAR || 0.15), [Act.addFullKey(rootKey.publicKey), Act.addCallKey(k.publicKey, MARKET, ['decide', 'decide_sealed', 'give_haggle'], null)]); }
const code = new Uint8Array(fs.readFileSync(WASM)), args = initArgs(root, { prompts, seed: Number(process.env.MARKET_SEED) || (Date.now() % 2147483647) });
if (await client.accountExists(MARKET)) {
  if (process.env.REDEPLOY) { const r = await client.tx(root, rootKey, MARKET, [Act.deploy(code)]); say('the contract replaced: ' + (r.ok ? r.hash : r.failure)); }
  else say(MARKET + ' is already there: nothing changed there');
} else {
  const r = await client.tx(root, rootKey, MARKET, [Act.create(), Act.transfer(near(+process.env.MARKET_NEAR || (code.length / 100000 + 1.2))), Act.addFullKey(rootKey.publicKey), Act.deploy(code), Act.call('new', args, 200)], 'FINAL');
  if (!r.ok) throw new Error('opening the market: ' + r.failure); say(`${MARKET} opened, ${code.length} bytes of contract, ${r.tgas} Tgas (${r.hash})`);
}
const st = await client.view(MARKET, 'state', {}); say(`the market: ${st.merchants.length} merchants, ${(Number(st.gold_supply) / 1000).toLocaleString('en')} gold in all, tick ${st.tick}`);
const left = await client.accountOf(root); say('the root account now holds ' + (Number(BigInt(left.amount) / 10n ** 21n) / 1000).toFixed(2) + ' NEAR');
