// src/near.js — talking to NEAR from the Worker, with nothing but what the platform gives: base58, the borsh of a transaction, an ed25519 signature from WebCrypto, and the RPC.
// (No library: this runs inside a Cloudflare Worker on every trade, and it is short enough to read. The same file runs in Node for the setup script and the tests.)

const A58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
export function b58encode(bytes) {
  let x = 0n; for (const b of bytes) x = (x << 8n) + BigInt(b); let s = '';
  while (x > 0n) { s = A58[Number(x % 58n)] + s; x /= 58n; }
  for (const b of bytes) { if (b === 0) s = '1' + s; else break; } return s;
}
export function b58decode(str) {
  let x = 0n; for (const c of str) { const i = A58.indexOf(c); if (i < 0) throw new Error('not base58'); x = x * 58n + BigInt(i); }
  let hex = x.toString(16); if (hex.length % 2) hex = '0' + hex; const body = x === 0n ? [] : hex.match(/../g).map(h => parseInt(h, 16)); let zeros = 0; for (const c of str) { if (c === '1') zeros++; else break; }
  return Uint8Array.from([...new Array(zeros).fill(0), ...body]);
}
const b64 = bytes => { let s = ''; for (const b of bytes) s += String.fromCharCode(b); return btoa(s); };
const unb64 = str => Uint8Array.from(atob(str), c => c.charCodeAt(0));
const utf8 = s => new TextEncoder().encode(s);
export const toHex = b => [...b].map(x => x.toString(16).padStart(2, '0')).join('');
const cat = parts => { const n = parts.reduce((a, p) => a + p.length, 0), out = new Uint8Array(n); let i = 0; for (const p of parts) { out.set(p, i); i += p.length; } return out; };

// ── borsh, as much of it as a transaction needs ──
const u8 = n => Uint8Array.of(n);
const u32 = n => { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, n, true); return b; };
const u64 = n => { const b = new Uint8Array(8); new DataView(b.buffer).setBigUint64(0, BigInt(n), true); return b; };
const u128 = n => { const v = BigInt(n), b = new Uint8Array(16), d = new DataView(b.buffer); d.setBigUint64(0, v & 0xffffffffffffffffn, true); d.setBigUint64(8, v >> 64n, true); return b; };
const str = s => { const e = utf8(s); return cat([u32(e.length), e]); };
const bytes = v => cat([u32(v.length), v]);
const vec = (items, f) => cat([u32(items.length), ...items.map(f)]);
const pk = p => cat([u8(0), b58decode(p.replace(/^ed25519:/, ''))]);

/** the actions of a transaction */
export const Act = {
  create: () => ({ t: 0 }),
  deploy: code => ({ t: 1, code }),
  call: (method, args, tgas = 100, yocto = 0) => ({ t: 2, method, args: utf8(typeof args === 'string' ? args : JSON.stringify(args)), gas: BigInt(tgas) * 1000000000000n, yocto }),
  transfer: yocto => ({ t: 3, yocto }),
  addFullKey: key => ({ t: 5, key, full: true }),
  addCallKey: (key, receiver, methods, allowance) => ({ t: 5, key, receiver, methods, allowance }),
  del: key => ({ t: 6, key }),
};
function encodeAction(a) {
  switch (a.t) {
    case 0: return u8(0);
    case 1: return cat([u8(1), bytes(a.code)]);
    case 2: return cat([u8(2), str(a.method), bytes(a.args), u64(a.gas), u128(a.yocto)]);
    case 3: return cat([u8(3), u128(a.yocto)]);
    case 5: return cat([u8(5), pk(a.key), u64(0), a.full ? u8(1) : cat([u8(0), a.allowance == null ? u8(0) : cat([u8(1), u128(a.allowance)]), str(a.receiver), vec(a.methods, str)])]);
    case 6: return cat([u8(6), pk(a.key)]);
    default: throw new Error('action');
  }
}
const PK8 = Uint8Array.from([0x30, 0x2e, 2, 1, 0, 0x30, 5, 6, 3, 0x2b, 0x65, 0x70, 4, 0x22, 4, 0x20]);
const toB64Url = v => b64(v).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const fromB64Url = s => unb64(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4));
/** a signing key from a 32-byte seed */
export async function keyFromSeed(seed) {
  const k = await crypto.subtle.importKey('pkcs8', cat([PK8, seed]), { name: 'Ed25519' }, true, ['sign']), jwk = await crypto.subtle.exportKey('jwk', k), pub = fromB64Url(jwk.x);
  return { publicKey: 'ed25519:' + b58encode(pub), raw: pub, sign: async m => new Uint8Array(await crypto.subtle.sign({ name: 'Ed25519' }, k, m)) };
}
/** the same, from the "ed25519:<base58 of 64 bytes>" a NEAR keychain file holds */
export async function keyFromSecret(secret) { return keyFromSeed(b58decode(secret.replace(/^ed25519:/, '')).slice(0, 32)); }
export async function sha256(data) { return new Uint8Array(await crypto.subtle.digest('SHA-256', typeof data === 'string' ? utf8(data) : data)); }
/** a key made from the game's one secret and a label: only the secret has to be kept */
export async function derivedKey(secret, label) { return keyFromSeed(await sha256(secret + '|' + label)); }

/** a NEAR client over a list of RPC addresses, best first. The list is an order of preference: an address that fails or falls behind is left alone for a while and then the best is used again, so that one hiccup cannot leave a copy of the server on its slowest address for good */
export function nearClient(rpcs, fetchFn, opts = {}) {
  const list = Array.isArray(rpcs) ? rpcs : [rpcs], f = fetchFn || (typeof fetch !== 'undefined' ? fetch : null), restUntil = new Map(), REST_MS = opts.restMs || 30000, sleep = ms => new Promise(r => setTimeout(r, ms));
  const inOrder = () => { const now = Date.now(), up = list.filter(u => !(restUntil.get(u) > now)); return up.concat(list.filter(u => !up.includes(u))); };
  /** one address, one question. An error with a NEAR name on it is the chain's own answer (e.rpc); anything else only says that this address could not be asked */
  async function ask(url, method, params, signal) {
    const r = await f(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 'td', method, params }), signal });
    if (r.status === 429 || r.status >= 500) throw new Error('rpc ' + r.status);
    const j = await r.json(); if (j.error) { const e = new Error(JSON.stringify(j.error.data || j.error).slice(0, 600)); if (j.error.name === 'HANDLER_ERROR' || j.error.cause) e.rpc = j.error; throw e; }
    return j.result;
  }
  /** ask the best address; if it has not answered within hedgeMs ask the next as well, and take the first real answer. A slow address costs a moment, not the player's patience */
  function round(method, params, timeoutMs, hedgeMs) {
    return new Promise((resolve, reject) => {
      const urls = inOrder(), live = new Map(); let next = 0, done = false, last = null, timer = null;
      const end = (fn, v) => { if (done) return; done = true; clearTimeout(timer); for (const c of live.keys()) c.abort(); fn(v); };
      const start = () => {
        if (done || next >= urls.length) return;
        const at = next++, url = urls[at], c = new AbortController(), kill = setTimeout(() => c.abort(), timeoutMs); live.set(c, at);
        ask(url, method, params, c.signal).then(v => { clearTimeout(kill); live.delete(c); for (const [, i] of live) if (i < at) restUntil.set(urls[i], Date.now() + REST_MS / 2); end(resolve, v); }, e => {
          clearTimeout(kill); live.delete(c); if (done) return;
          if (e.rpc) return end(reject, e);
          last = e; restUntil.set(url, Date.now() + REST_MS); clearTimeout(timer);
          if (next < urls.length) start(); else if (!live.size) end(reject, last);
        });
        clearTimeout(timer); if (next < urls.length) timer = setTimeout(start, hedgeMs);
      };
      start();
    });
  }
  /** a question for the chain: if no address could be asked at all, once more after a breath */
  async function rpc(method, params, timeoutMs, hedgeMs = 1500) {
    const solo = list.length === 1, wait = solo ? Math.max(timeoutMs || 0, 20000) : timeoutMs || 7000, tries = solo ? 3 : 2;          // (one address, a local chain perhaps on a busy machine, has nowhere to turn: more time and more tries)
    for (let i = 0; ; i++) { try { return await round(method, params, wait, hedgeMs); } catch (e) { if (e.rpc || i + 1 >= tries) throw e; await sleep(400 * (i + 1)); } }
  }
  /** read a contract's view method */
  async function view(contract, method, args) {
    const r = await rpc('query', { request_type: 'call_function', finality: 'optimistic', account_id: contract, method_name: method, args_base64: b64(utf8(JSON.stringify(args || {}))) });
    if (r.error) throw new Error(r.error); return JSON.parse(new TextDecoder().decode(Uint8Array.from(r.result)));
  }
  const accountExists = async id => { try { await rpc('query', { request_type: 'view_account', finality: 'optimistic', account_id: id }); return true; } catch (e) { if (/UNKNOWN_ACCOUNT|does not exist/.test(String(e.message))) return false; throw e; } };
  const accountOf = id => rpc('query', { request_type: 'view_account', finality: 'optimistic', account_id: id });
  /** has the chain got this very transaction? Its outcome if so, null if nobody can say yet */
  const outcomeOf = (hash, signer, wait) => rpc('tx', { tx_hash: hash, sender_account_id: signer, wait_until: wait }, 12000, 4000).catch(() => null);
  /** sign and send a transaction. `key` is a signing key of `signer`. One signed transaction has one hash: a slow answer is not a failure, so it is asked about by that hash and sent again exactly as it was, never signed anew, because signing anew would do the work twice (a player's trade would come back "already seen" although it went through, and crates brought along would arrive twice). Only a nonce another transaction of this key took means signing again */
  async function tx(signer, key, receiver, actions, wait = 'EXECUTED_OPTIMISTIC', limitMs = 40000) {
    let bump = 0, lastErr = null; const t0 = Date.now(), trace = { signs: 0, sends: 0, asks: 0, why: '' }, finish = o => Object.assign(summarize(o), { trace: Object.assign(trace, { ms: Date.now() - t0 }) });
    for (let attempt = 0; attempt < 5; attempt++) {
      trace.signs++; const ak = await rpc('query', { request_type: 'view_access_key', finality: 'optimistic', account_id: signer, public_key: key.publicKey });
      const body = cat([str(signer), pk(key.publicKey), u64(BigInt(ak.nonce) + 1n + BigInt(bump)), str(receiver), b58decode(ak.block_hash), vec(actions, encodeAction)]);
      const digest = await sha256(body), signed = b64(cat([body, u8(0), await key.sign(digest)])), hash = b58encode(digest), until = Date.now() + limitMs;
      for (let tries = 0; ; tries++) {
        trace.sends++; try { return finish(await rpc('send_tx', { signed_tx_base64: signed, wait_until: wait }, 15000, 5000)); }
        catch (e) {
          lastErr = e; const m = String(e.message), taken = /InvalidNonce/.test(m), stale = /Expired/.test(m);
          if (e.rpc && !taken && !stale && !/TIMEOUT_ERROR|Timeout|ShardCongested|ShardStuck/i.test(m)) throw e;
          trace.asks++; trace.why = m.slice(0, 60); const seen = await outcomeOf(hash, signer, wait); if (seen) return finish(seen);
          if (taken) { bump += attempt + 1; break; }
          if (stale) break;
          if (Date.now() > until) throw e;
          await sleep(Math.min(3000, 500 * (tries + 1)));
        }
      }
    }
    throw lastErr;
  }
  return { rpc, view, tx, accountExists, accountOf };
}
/** what a transaction did, in a form that is easy to use: did it work, what it returned, and its logs */
export function summarize(out) {
  const hash = out.transaction && out.transaction.hash, st = (out.status || (out.final_execution_status && {})) || {}, logs = [];
  for (const r of out.receipts_outcome || []) for (const l of r.outcome.logs || []) logs.push(l);
  if (out.transaction_outcome) for (const l of out.transaction_outcome.outcome.logs || []) logs.push(l);
  const failure = st.Failure ? JSON.stringify(st.Failure).slice(0, 500) : null; let value = null;
  if (typeof st.SuccessValue === 'string' && st.SuccessValue) { try { value = JSON.parse(new TextDecoder().decode(unb64(st.SuccessValue))); } catch (e) { value = st.SuccessValue; } }
  const gas = (out.transaction_outcome ? out.transaction_outcome.outcome.gas_burnt : 0) + (out.receipts_outcome || []).reduce((a, r) => a + r.outcome.gas_burnt, 0);
  return { hash, ok: !failure, failure, value, logs, tgas: Math.round(gas / 1e11) / 10, events: logs.filter(l => l.startsWith('EVENT_JSON:')).map(l => { try { return JSON.parse(l.slice(11)); } catch (e) { return null; } }).filter(Boolean) };
}
/** a NEP-413 signed intent, by any key: the same message the game signs on a player's device */
export async function signIntent(key, recipient, signer, seq, actions, ttlMs = 120000) {
  const message = JSON.stringify({ signer, deadline_ms: Date.now() + ttlMs, seq, actions }), nonce = crypto.getRandomValues(new Uint8Array(32)), hash = await sha256(cat([u32(2147484061), str(message), nonce, str(recipient), u8(0)]));
  return { message, nonce: b64(nonce), recipient, public_key: key.publicKey, signature: b64(await key.sign(hash)) };
}
/** does this ed25519 key's signature hold for this text? */
export async function verifyText(pubBytes, sigBytes, text) { try { const k = await crypto.subtle.importKey('raw', pubBytes, { name: 'Ed25519' }, false, ['verify']); return await crypto.subtle.verify({ name: 'Ed25519' }, k, sigBytes, utf8(text)); } catch (e) { return false; } }

