'use strict';
// node near/test/make_vectors.js     the fixed inputs the contract's tests read: the market's opening (the same function the live opening uses), and intents signed the way the game signs them
const fs = require('fs'), path = require('path'), crypto = require('crypto'), { initArgs } = require('../scripts/init_args.js');
const OUT = path.join(__dirname, 'vectors'); fs.mkdirSync(OUT, { recursive: true });
fs.writeFileSync(path.join(OUT, 'init.json'), JSON.stringify(initArgs('test.near', { owner: 'owner.near', warden: 'warden.near', seed: 7 })));
// a fixed ed25519 key: the seed is all sevens
const seed = Buffer.alloc(32, 7), der = Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), seed]), priv = crypto.createPrivateKey({ key: der, format: 'der', type: 'pkcs8' }), pubRaw = crypto.createPublicKey(priv).export({ format: 'der', type: 'spki' }).subarray(-32);
const b58 = b => { const A = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'; let x = BigInt('0x' + Buffer.from(b).toString('hex')), s = ''; while (x > 0n) { s = A[Number(x % 58n)] + s; x /= 58n; } for (const c of b) { if (c === 0) s = '1' + s; else break; } return s; };
const account = pubRaw.toString('hex'), publicKey = 'ed25519:' + b58(pubRaw), RECIPIENT = 'alice.near';
/** NEP-413: sha256 of the tag and the borsh of the payload */
function signIntent(message, nonce, recipient) {
  const m = Buffer.from(message), r = Buffer.from(recipient), u32 = n => { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b; };
  const hash = crypto.createHash('sha256').update(Buffer.concat([u32(2147484061), u32(m.length), m, nonce, u32(r.length), r, Buffer.from([0])])).digest();
  return { message, nonce: nonce.toString('base64'), recipient, public_key: publicKey, signature: crypto.sign(null, hash, priv).toString('base64') };
}
const intent = (seq, actions, deadline = 9e12) => signIntent(JSON.stringify({ signer: account, deadline_ms: deadline, seq, actions }), crypto.createHash('sha256').update('nonce' + seq).digest(), RECIPIENT);
// the steward's key: another fixed seed
const seedS = Buffer.alloc(32, 9), privS = crypto.createPrivateKey({ key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), seedS]), format: 'der', type: 'pkcs8' }), pubS = crypto.createPublicKey(privS).export({ format: 'der', type: 'spki' }).subarray(-32), stewardKey = 'ed25519:' + b58(pubS);
function byStewardKey(seq, actions) {
  const message = JSON.stringify({ signer: account, deadline_ms: 9e12, seq, actions }), nonce = crypto.createHash('sha256').update('s' + seq).digest(), m = Buffer.from(message), r = Buffer.from(RECIPIENT), u32 = n => { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b; };
  const hash = crypto.createHash('sha256').update(Buffer.concat([u32(2147484061), u32(m.length), m, nonce, u32(r.length), r, Buffer.from([0])])).digest();
  return { message, nonce: nonce.toString('base64'), recipient: RECIPIENT, public_key: stewardKey, signature: crypto.sign(null, hash, privS).toString('base64') };
}
const odin = 'odin.test.near', out = {
  account, public_key: publicKey,
  sell: intent(1, [{ sell: { merchant: odin, token: 'wood', amount: '200', min_gold: '0' } }]),
  replay_same_seq: intent(1, [{ sell: { merchant: odin, token: 'wood', amount: '200', min_gold: '0' } }]),
  buy: intent(2, [{ buy: { merchant: odin, token: 'metal', amount: '5', max_gold: '100000' } }]),
  too_late: intent(3, [{ sell: { merchant: odin, token: 'wood', amount: '1', min_gold: '0' } }], 1),
  invest: intent(4, [{ invest: { merchant: odin, gold: '1000' } }]),
  collect: intent(5, [{ collect: { merchant: odin } }]),
  wrong_recipient: signIntent(JSON.stringify({ signer: account, deadline_ms: 9e12, seq: 6, actions: [] }), Buffer.alloc(32, 1), 'someone-else.near'),
  tampered: Object.assign(intent(7, [{ sell: { merchant: odin, token: 'wood', amount: '1', min_gold: '0' } }]), { message: JSON.stringify({ signer: account, deadline_ms: 9e12, seq: 7, actions: [{ sell: { merchant: odin, token: 'wood', amount: '999', min_gold: '0' } }] }) }),
  someone_elses: signIntent(JSON.stringify({ signer: 'bob.near', deadline_ms: 9e12, seq: 8, actions: [] }), Buffer.alloc(32, 2), RECIPIENT),
  appoint: intent(20, [{ appoint_steward: { key: stewardKey, gold_per_day: '5000' } }]),
  st_sell: byStewardKey(21, [{ sell: { merchant: odin, token: 'wood', amount: '100', min_gold: '0' } }]),
  st_buy: byStewardKey(22, [{ buy: { merchant: odin, token: 'metal', amount: '2', max_gold: '4000' } }]),
  st_over: byStewardKey(23, [{ buy: { merchant: odin, token: 'metal', amount: '2', max_gold: '4900' } }]),
  st_invest: byStewardKey(24, [{ invest: { merchant: odin, gold: '1' } }]),
  st_give: byStewardKey(25, [{ give: { to: 'thief.near', token: 'gold', amount: '1' } }]),
  dismiss: intent(26, [{ dismiss_steward: {} }]),
  st_after: byStewardKey(27, [{ sell: { merchant: odin, token: 'wood', amount: '1', min_gold: '0' } }]),
};
fs.writeFileSync(path.join(OUT, 'intents.json'), JSON.stringify(out, null, 1));
console.log('vectors written; the test account is', account);
