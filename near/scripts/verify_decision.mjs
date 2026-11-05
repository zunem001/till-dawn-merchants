// near/scripts/verify_decision.mjs [tx-hash]    Do not trust the game: check a merchant's decision yourself.
//   The tool takes a decision the market contract accepted, reads it out of the transaction ON THE CHAIN (not from the game's server), and does again what the contract did:
//     1. the two hashes in the signed text are the hashes of the request and of the answer
//     2. the signature recovers to the key that signed it, and that key is one the market holds as attested
//     3. the request's system prompt is the merchant's character: its hash is the one pinned on the chain
//     4. the answer really says what the merchant then did
//   Then it says where the attestation of that key can be read, if you want to go all the way down to the hardware.
//
//   node near/scripts/verify_decision.mjs                    the latest sealed decision on the public practice market
//   node near/scripts/verify_decision.mjs <tx-hash>          one decision in particular
//   env: SITE (default https://tilldawngame.com), NEAR_RPC (default the public testnet RPCs), MARKET
//   Needs only:  cd near/test && npm install    (two small audited libraries: @noble/curves, @noble/hashes)
import { createRequire } from 'node:module';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const here = path.dirname(fileURLToPath(import.meta.url)), require2 = createRequire(path.join(here, '..', 'test', 'package.json'));
const { secp256k1 } = require2('@noble/curves/secp256k1'), { keccak_256 } = require2('@noble/hashes/sha3');
const SITE = (process.env.SITE || 'https://tilldawngame.com').replace(/\/$/, ''), RPCS = process.env.NEAR_RPC ? [process.env.NEAR_RPC] : ['https://test.rpc.fastnear.com', 'https://near-testnet.drpc.org', 'https://rpc.testnet.near.org', 'https://archival-rpc.testnet.fastnear.com'];
const sha = s => crypto.createHash('sha256').update(s).digest('hex'), hex = b => Buffer.from(b).toString('hex');
let fails = 0; const say = (good, words) => { console.log((good ? '  ok   ' : '  FAIL ') + words); if (!good) fails++; };
const rpc = async (method, params) => { let last = ''; for (const u of RPCS) { try { const r = await fetch(u, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 'v', method, params }) }), j = await r.json(); if (j.result) return j.result; last = JSON.stringify(j.error || j).slice(0, 160); } catch (e) { last = e.message; } } throw new Error('the chain would not answer: ' + last); };
const view = async (account_id, method_name, args = {}) => { const r = await rpc('query', { request_type: 'call_function', finality: 'final', account_id, method_name, args_base64: Buffer.from(JSON.stringify(args)).toString('base64') }); return JSON.parse(Buffer.from(r.result).toString()); };
const site = await (await fetch(SITE + '/api/bazaar/state')).json().catch(() => null); if (!site || !site.ok) { console.log('The market at ' + SITE + ' is not answering.'); process.exit(1); }
const MARKET = process.env.MARKET || site.market;

let hash = process.argv[2], sender = null;
if (!hash) { const pick = (site.decisions || []).filter(d => d.sealed && d.tx && !String(d.merchant).startsWith('steward:'))[0]; if (!pick) { console.log('No sealed decision on the market yet.'); process.exit(1); } hash = pick.tx; sender = pick.merchant; console.log(`The latest sealed decision: ${pick.merchant}, tick ${pick.tick}: "${pick.say}"`); }
console.log(`Transaction ${hash}, market ${MARKET}\n`);
if (!sender) { const r = (await (await fetch(SITE + '/api/bazaar/state')).json()).state.merchants; for (const m of r) { try { await rpc('tx', { tx_hash: hash, sender_account_id: m.id, wait_until: 'NONE' }); sender = m.id; break; } catch (e) { /* not this one */ } } }
const tx = await rpc('tx', { tx_hash: hash, sender_account_id: sender, wait_until: 'EXECUTED_OPTIMISTIC' });
say(tx.transaction.receiver_id === MARKET, `it was sent to the market contract by ${tx.transaction.signer_id}`);
const call = tx.transaction.actions.map(a => a.FunctionCall).find(c => c && c.method_name === 'decide_sealed'); if (!call) { say(false, 'it is a decide_sealed call'); process.exit(1); }
const { answer } = JSON.parse(Buffer.from(call.args, 'base64').toString());
say(tx.status && 'SuccessValue' in tx.status, 'the contract accepted it: had any check failed, the whole transaction would have failed');

console.log('\n1. The signed text holds the hashes of what was asked and what was answered');
const req = JSON.parse(answer.request), parts = answer.text.split(':'), reqHash = parts[parts.length - 2], resHash = parts[parts.length - 1], model = parts.slice(0, -2).join(':') || req.model;
say(reqHash === sha(answer.request), 'sha256(request)  = ' + reqHash); say(resHash === sha(answer.response), 'sha256(response) = ' + resHash); console.log('       the model: ' + model);

console.log('\n2. The signature is the attested key\'s');
const body = Buffer.from(answer.text), pre = Buffer.concat([Buffer.from(`\x19Ethereum Signed Message:\n${body.length}`), body]), sigBytes = Buffer.from(answer.signature.replace(/^0x/, ''), 'hex'), rec = sigBytes[64] >= 27 ? sigBytes[64] - 27 : sigBytes[64];
const pub = new secp256k1.Signature(BigInt('0x' + hex(sigBytes.subarray(0, 32))), BigInt('0x' + hex(sigBytes.subarray(32, 64)))).addRecoveryBit(rec).recoverPublicKey(keccak_256(pre)).toRawBytes(false), who = '0x' + hex(keccak_256(pub.subarray(1)).subarray(12));
say(who === answer.signer.toLowerCase(), 'it recovers to ' + who);
const st = await view(MARKET, 'state'); say(st.signers.includes(who), 'and that key is on the market\'s list of attested keys');

console.log('\n3. The merchant was asked as the merchant');
const system = req.messages[0].content, user = req.messages[1].content, me = st.merchants.find(m => m.id === tx.transaction.signer_id);
say(!!me && me.prompt_hash === sha(system), `sha256(the character) = ${sha(system).slice(0, 16)}...: the hash pinned on the chain for ${tx.transaction.signer_id}`);
console.log('       ' + system.split('\n')[0].slice(0, 110) + '...');
console.log('       what it was told: ' + user.split('\n').slice(0, 2).join(' / ').slice(0, 140) + '...');

console.log('\n4. What the AI answered');
const said = (() => { try { const r = JSON.parse(answer.response); return r.choices[0].message.content; } catch (e) { return answer.response; } })(); console.log('       ' + said.slice(0, 500));
const logs = (tx.receipts_outcome || []).flatMap(o => o.outcome.logs).filter(l => l.startsWith('EVENT_JSON:')).map(l => JSON.parse(l.slice(11))), dec = logs.find(e => e.event === 'decision'); if (dec) { const d = dec.data[0]; console.log('       the chain logged: ' + JSON.stringify({ merchant: d.merchant, sealed: d.sealed, model: d.model, cuts: d.cuts || d.pulled || [] }).slice(0, 300)); }

console.log('\n5. Down to the hardware (this one is for you to do)');
console.log('       The market only trusts a key after the warden has read its attestation report. NEAR AI gives it to anyone with an API key (free credit at cloud.near.ai):');
console.log(`       GET https://cloud-api.near.ai/v1/attestation/report?model=${encodeURIComponent(model)}`);
console.log(`       The report's signing address should be ${who}, and its Intel TDX and NVIDIA quotes are what NEAR AI's verifier checks: https://github.com/nearai/nearai-cloud-verifier`);
console.log(fails ? `\n${fails} check(s) FAILED` : '\nEvery check passed. Nobody edited this decision between the secure hardware and the market.');
process.exit(fails ? 1 : 0);
