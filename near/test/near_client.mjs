// node near/test/near_client.mjs      The hand-written NEAR client against a misbehaving network, with no network at all: a slow address, a dead address, an answer lost on the way, a nonce taken. What it must never do is sign the same work twice.
import { nearClient, keyFromSeed, Act } from '../../src/near.js';

let fails = 0; const ok = (c, m) => { console.log((c ? '  ok   ' : '  FAIL ') + m); if (!c) fails++; };
const OUTCOME = { transaction: { hash: 'H' }, status: { SuccessValue: '' }, transaction_outcome: { outcome: { gas_burnt: 1, logs: [] } }, receipts_outcome: [] };
const named = (cause, data) => ({ status: 200, body: { error: { name: 'HANDLER_ERROR', cause: { name: cause }, code: -32000, message: 'Server error', data } } });
const SLOW = ms => ({ wait: ms }); const BLOCK = '11111111111111111111111111111111';

/** a network: each address is a function of (method, params, try number) giving {status, body, wait}. It records every call */
function network(addresses) {
  const log = [], tries = {};
  const f = async (url, init) => {
    const q = JSON.parse(init.body), t = (tries[url + q.method] = (tries[url + q.method] || 0) + 1); log.push({ url, method: q.method, params: q.params });
    const a = addresses[url](q.method, q.params, t) || {};
    if (a.wait) await new Promise((res, rej) => { const h = setTimeout(res, a.wait); init.signal.addEventListener('abort', () => { clearTimeout(h); const e = new Error('aborted'); e.name = 'AbortError'; rej(e); }); });
    if (a.dead) throw new TypeError('fetch failed');
    const body = a.body || { result: a.result }; return { status: a.status || 200, json: async () => { if (a.notJson) throw new Error('not json'); return body; } };
  };
  return { f, log, signed: () => [...new Set(log.filter(c => c.method === 'send_tx').map(c => c.params.signed_tx_base64))], count: m => log.filter(c => c.method === m).length };
}
const fine = (m, p) => { if (m === 'query') return { result: { nonce: 7, block_hash: BLOCK } }; if (m === 'send_tx' || m === 'tx') return { result: OUTCOME }; return { result: {} }; };
const key = await keyFromSeed(new Uint8Array(32).fill(1)), run = c => c.tx('w.test', key, 'm.test', [Act.call('serve', { a: 1 }, 30)]);
const timed = async p => { const t = Date.now(); let v = null, e = null; try { v = await p(); } catch (x) { e = x; } return { v, e, ms: Date.now() - t }; };

console.log('reading');
{ const n = network({ a: () => SLOW(5000), b: fine }), c = nearClient(['a', 'b'], n.f), r = await timed(() => c.rpc('query', {}, 7000, 100)); ok(r.v && r.ms < 1000, `a slow address costs a moment: the next one answered in ${r.ms} ms`); }
{ const n = network({ a: () => ({ dead: true }), b: fine }), c = nearClient(['a', 'b'], n.f), r = await timed(() => c.rpc('query', {})); ok(r.v && r.ms < 500, `a dead address costs nothing: ${r.ms} ms`); await c.rpc('query', {}); ok(n.log.filter(x => x.url === 'a').length === 1, 'and it is left alone for a while'); }
{ let bad = true; const n = network({ a: (m, p) => (bad ? { dead: true } : fine(m, p)), b: fine }), c = nearClient(['a', 'b'], n.f, { restMs: 60 }); await c.rpc('query', {}); bad = false; await new Promise(r => setTimeout(r, 90)); n.log.length = 0; await c.rpc('query', {}); ok(n.log[0].url === 'a', 'then the best address is used again: one hiccup does not leave the server on its slowest for good'); }
{ const n = network({ a: () => ({ status: 429 }), b: fine }), c = nearClient(['a', 'b'], n.f), r = await timed(() => c.rpc('query', {})); ok(r.v, 'an address that is rationing passes to the next'); }
{ const n = network({ a: () => ({ body: { error: { code: -32000, message: 'daily quota' } } }), b: fine }), c = nearClient(['a', 'b'], n.f), r = await timed(() => c.rpc('query', {})); ok(r.v, 'an error with no NEAR name on it (a provider talking, not the chain) passes to the next'); }
{ const n = network({ a: () => named('UNKNOWN_ACCOUNT', 'no such account'), b: fine }), c = nearClient(['a', 'b'], n.f), r = await timed(() => c.rpc('query', {})); ok(r.e && r.e.rpc && n.log.length === 1, "the chain's own answer is an answer: nobody else is asked"); }
{ let t = 0; const n = network({ a: (m, p) => (++t === 1 ? { dead: true } : fine(m, p)) }), c = nearClient(['a'], n.f), r = await timed(() => c.rpc('query', {})); ok(r.v && t === 2, 'with one address only, it is tried once more'); }
{ const n = network({ a: () => ({ dead: true }), b: () => ({ dead: true }) }), c = nearClient(['a', 'b'], n.f), r = await timed(() => c.rpc('query', {})); ok(r.e && r.ms < 1500, `when nobody answers it says so, in ${r.ms} ms`); }

console.log('sending: one signed transaction, one hash');
{ const n = network({ a: fine }), c = nearClient(['a'], n.f), r = await timed(() => run(c)); ok(r.v && r.v.ok && n.count('send_tx') === 1 && n.count('tx') === 0, 'the plain case: one send, no questions'); }
{ const n = network({ a: (m, p) => (m === 'send_tx' ? named('TIMEOUT_ERROR', 'Timeout') : fine(m, p)) }), c = nearClient(['a'], n.f), r = await timed(() => run(c)); ok(r.v && r.v.ok && n.signed().length === 1 && n.count('query') === 1 && n.count('tx') === 1, 'the network says "timeout": it asks by the hash, and is told it went through. Signed once'); }
{ const hash = []; const n = network({ a: (m, p) => { if (m === 'tx') hash.push(p.tx_hash); return m === 'send_tx' ? named('TIMEOUT_ERROR', 'Timeout') : fine(m, p); } }), c = nearClient(['a'], n.f); await run(c); ok(/^[1-9A-HJ-NP-Za-km-z]{43,44}$/.test(hash[0] || ''), 'the hash it asks about looks like one: ' + hash[0]); }
{ const n = network({ a: (m, p, t) => { if (m === 'send_tx') return t === 1 ? { dead: true } : { result: OUTCOME }; if (m === 'tx') return named('UNKNOWN_TRANSACTION', 'unknown'); return fine(m, p); } }), c = nearClient(['a'], n.f), r = await timed(() => run(c)); ok(r.v && r.v.ok && n.count('send_tx') >= 2 && n.signed().length === 1, 'the answer was lost and the chain has not heard of it: the same bytes go again, not a new signature'); }
{ let sends = 0; const n = network({ a: (m, p) => { if (m === 'send_tx' && ++sends === 1) return named('INVALID_TRANSACTION', { TxExecutionError: { InvalidTxError: { InvalidNonce: { tx_nonce: 8, ak_nonce: 8 } } } }); return fine(m, p); } }), c = nearClient(['a'], n.f), r = await timed(() => run(c)); ok(r.v && r.v.ok && n.signed().length === 1 && n.count('tx') === 1 && n.count('query') === 1, 'the nonce is taken, and by this very transaction (its answer got lost): that is success, signed once'); }
{ let sends = 0; const n = network({ a: (m, p) => { if (m === 'send_tx' && ++sends === 1) return named('INVALID_TRANSACTION', { TxExecutionError: { InvalidTxError: { InvalidNonce: { tx_nonce: 8, ak_nonce: 8 } } } }); if (m === 'tx') return named('UNKNOWN_TRANSACTION', 'unknown'); return fine(m, p); } }), c = nearClient(['a'], n.f), r = await timed(() => run(c)); ok(r.v && r.v.ok && n.signed().length === 2 && n.count('query') === 2, 'the nonce was taken by another transaction of this key: only then is it signed again, with a higher nonce'); }
{ const n = network({ a: (m, p) => (m === 'send_tx' ? SLOW(5000) : fine(m, p)), b: fine }), c = nearClient(['a', 'b'], n.f), real = c.rpc; const r = await timed(() => c.rpc('send_tx', { signed_tx_base64: 'x' }, 15000, 80)); ok(r.v && r.ms < 1000 && n.signed().length === 1 && n.count('send_tx') === 2, `an address stuck on a send: the same bytes go to the next as well, and the first answer wins (${r.ms} ms)`); void real; }
{ const n = network({ a: (m, p) => (m === 'send_tx' ? named('INVALID_TRANSACTION', { TxExecutionError: { InvalidTxError: { NotEnoughBalance: { balance: '1' } } } }) : fine(m, p)) }), c = nearClient(['a'], n.f), r = await timed(() => run(c)); ok(r.e && /NotEnoughBalance/.test(r.e.message) && n.count('send_tx') === 1 && r.ms < 500, 'a real refusal is final: it says why at once and tries nothing else'); }
{ const failed = Object.assign({}, OUTCOME, { status: { Failure: { ActionError: { kind: 'x' } } } }); const n = network({ a: (m, p) => (m === 'send_tx' ? { result: failed } : fine(m, p)) }), c = nearClient(['a'], n.f), r = await timed(() => run(c)); ok(r.v && r.v.ok === false && /ActionError/.test(r.v.failure) && n.count('send_tx') === 1, 'a contract that said no is an answer, and it is not sent again'); }
{ const n = network({ a: (m, p) => (m === 'send_tx' || m === 'tx' ? { dead: true } : fine(m, p)) }), c = nearClient(['a'], n.f), r = await timed(() => c.tx('w.test', key, 'm.test', [Act.call('serve', {}, 30)], 'EXECUTED_OPTIMISTIC', 300)); ok(r.e && n.signed().length === 1, `when nothing can be told at all it gives up after its limit, still signed once (${r.ms} ms, ${n.count('send_tx')} sends)`); }

console.log(fails ? `\n${fails} check(s) FAILED` : '\nAll checks passed.'); process.exit(fails ? 1 : 0);
