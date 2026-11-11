// node near/scripts/storage_room.mjs <network> <root account> [NEAR to send]        THE MARKET'S ROOM TO REMEMBER.
//   A NEAR account must hold 1 NEAR for every 100,000 bytes it stores (the contract's code and everything it remembers: every player's purse and crates, every share, every
//   Steward). When the market's account holds no more than that, the chain refuses whatever would make it remember more: a new player gets no purse (the server's hello says
//   "welcomed": false) while every old player still trades. Nothing in the contract or the server can add NEAR by itself; somebody has to send it.
//   Without an amount this only reports, signs nothing and needs no key: what the account holds, what its storage locks, and how many bytes of room are left.
//   With an amount it sends that much NEAR from the root account to market.<root> (a plain transfer, signed with the root's key from its keychain file, which is never printed).
//   On testnet a faucet can send to market.<root> directly; no key is needed for that.
//   network: sandbox (the local test chain) or testnet.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { Act, keyFromSecret, nearClient } from '../../src/near.js';
const [network, root, amount] = process.argv.slice(2), near = x => BigInt(Math.round(x * 1000)) * 10n ** 21n, show = y => (Number(BigInt(y) / 10n ** 18n) / 1e6).toFixed(4);
const RPC = { sandbox: ['http://127.0.0.1:3030'], testnet: ['https://test.rpc.fastnear.com', 'https://near-testnet.drpc.org', 'https://rpc.testnet.near.org'] }[network]; if (!RPC || !root) { console.log('usage: storage_room.mjs <sandbox|testnet> <root account> [NEAR to send]'); process.exit(1); }
const client = nearClient(RPC), MARKET = 'market.' + root, PER_BYTE = 10n ** 19n;
const room = async () => { const a = await client.accountOf(MARKET), need = BigInt(a.storage_usage) * PER_BYTE, free = BigInt(a.amount) - need; return { holds: a.amount, bytes: a.storage_usage, free, room: free / PER_BYTE }; };
const say = r => console.log(`  ${MARKET} holds ${show(r.holds)} NEAR and stores ${r.bytes} bytes, which lock ${show(BigInt(r.bytes) * PER_BYTE)} NEAR: room for ${r.room} more bytes` + (r.room < 20000n ? '   <-- LOW: a new player needs about 1,000' : ''));
const before = await room(); say(before);
if (amount == null) process.exit(before.room < 20000n ? 2 : 0);
const n = Number(amount); if (!(n > 0) || n > 50) { console.log('the amount is in NEAR, more than 0 and at most 50'); process.exit(1); }
const secretFile = process.env.ROOT_KEY_FILE || path.join(os.homedir(), '.near-credentials', network, root + '.json');
const rootSecret = network === 'sandbox' ? JSON.parse(fs.readFileSync(path.join(os.homedir(), 'sandbox', 'home', 'validator_key.json'), 'utf8')).secret_key : JSON.parse(fs.readFileSync(secretFile, 'utf8')).private_key;
const rootKey = await keyFromSecret(rootSecret), has = BigInt((await client.accountOf(root)).amount);
if (has < near(n) + near(0.05)) { console.log(`  ${root} holds ${show(has)} NEAR: not enough to send ${n} and keep 0.05 for itself`); process.exit(1); }
const r = await client.tx(root, rootKey, MARKET, [Act.transfer(near(n))], 'FINAL'); if (!r.ok) { console.log('  the transfer failed: ' + r.failure); process.exit(1); }
console.log(`  sent ${n} NEAR from ${root} (${r.hash})`); say(await room());
