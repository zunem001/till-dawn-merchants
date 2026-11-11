// src/bazaar.js — THE GRAND MARKET'S SERVER. It holds no gold and sets no price: the market is on NEAR (near/contract). What it does:
//   · brings players' signed trades to the chain and pays the gas, so a player never sees a wallet, a fee or a seed phrase (the warden's keys can do nothing else)
//   · turns the market's clock (anybody could: `crank` is open to all)
//   · lets each merchant think: it asks NEAR AI what the merchant would do, and the merchant's own key brings the answer, with NEAR AI's proof, to the chain, which checks it and cuts it to the leash
//   · remembers what the chain did, for the news and the charts (the chain's own logs are the record; this is only so a card opens quickly)
import { Act, derivedKey, nearClient, sha256, toHex, b58decode, signIntent, verifyText } from './near.js';
import R from '../market_rules.js';

const RPCS = { testnet: ['https://test.rpc.fastnear.com', 'https://near-testnet.drpc.org', 'https://rpc.testnet.near.org'], mainnet: ['https://free.rpc.fastnear.com', 'https://near.drpc.org'] };          // (best first: measured 2026-11-05, a trade takes 2 s through the first two and 8 s through the last)
const EXPLORER = { testnet: 'https://testnet.nearblocks.io', mainnet: 'https://nearblocks.io' };
const AI_BASE = 'https://cloud-api.near.ai', DEFAULT_MODEL = 'Qwen/Qwen3.8-27B', AI_EVERY_TICKS = 6, WARDEN_KEYS = 8;
let clientMemo = null, stateMemo = { at: 0, v: null, p: null };

const cfgOf = env => { const root = env.NEAR_ROOT, network = env.NEAR_NETWORK || 'testnet'; return root && env.NEAR_KEY_SEED ? { root, network, market: 'market.' + root, warden: 'warden.' + root, explorer: EXPLORER[network] || '' } : null; };
const clientOf = (env, c) => { const rpcs = env.NEAR_RPC ? [env.NEAR_RPC] : RPCS[c.network]; if (!clientMemo || clientMemo.key !== rpcs.join()) clientMemo = { key: rpcs.join(), client: nearClient(rpcs) }; return clientMemo.client; };
const hashNum = async s => { const h = await sha256(s); return (h[0] << 8) | h[1]; };
const wardenKey = async (env, label) => derivedKey(env.NEAR_KEY_SEED, 'warden:' + ((await hashNum(label)) % WARDEN_KEYS));

/** a limit that holds across the Worker's copies: at most n in the window */
async function limited(env, key, n, windowMs) {
  const now = Date.now(); const r = await env.DB.prepare('SELECT n, until FROM bazaar_limits WHERE k = ?').bind(key).first();
  if (r && r.until > now) { if (r.n >= n) return true; await env.DB.prepare('UPDATE bazaar_limits SET n = n + 1 WHERE k = ?').bind(key).run(); return false; }
  await env.DB.prepare('INSERT INTO bazaar_limits (k, n, until) VALUES (?1, 1, ?2) ON CONFLICT(k) DO UPDATE SET n = 1, until = ?2').bind(key, now + windowMs).run(); return false;
}
const ipOf = req => req.headers.get('cf-connecting-ip') || 'local';
/** what the chain said it did goes into the news */
async function remember(env, summary) {
  const rows = (summary.events || []).filter(e => e.standard === 'tilldawn-market' && ['trade', 'invest', 'broke', 'lend', 'repaid', 'mishap', 'event', 'event_end', 'deal', 'collect', 'haggle'].includes(e.event));
  if (!rows.length) return; const now = Date.now(), st = env.DB.prepare('INSERT INTO bazaar_news (at, kind, data, tx) VALUES (?, ?, ?, ?)');
  try { await env.DB.batch(rows.slice(0, 20).map(e => st.bind(now, e.event, JSON.stringify(e.data[0] || {}), summary.hash || null))); } catch (e) { console.log('news:', e.message); }
}
/** the market's state, a moment old at most: many players read it, and the chain is not asked for each */
async function marketState(env, c) {
  const now = Date.now(); if (stateMemo.v && now - stateMemo.at < 2500) return stateMemo.v; if (stateMemo.p) return stateMemo.p;
  stateMemo.p = clientOf(env, c).view(c.market, 'state', {}).then(v => { stateMemo = { at: Date.now(), v, p: null }; return v; }, e => { stateMemo.p = null; throw e; }); return stateMemo.p;
}

/** The routes under /api/bazaar/ */
export async function handleBazaar(req, env, url, h) {
  const c = cfgOf(env), json = h.json, path = url.pathname.slice('/api/bazaar/'.length);
  if (!c) return json({ ok: false, error: 'closed', word: 'The Grand Market is not open on this server.' }, 503);
  try {
    if (req.method === 'GET' && path === 'state') {
      const st = await marketState(env, c), [news, hist, last] = await Promise.all([
        env.DB.prepare('SELECT id, at, kind, data, tx FROM bazaar_news WHERE kind NOT IN (\'trade\', \'collect\', \'haggle\') ORDER BY id DESC LIMIT 24').all(),
        env.DB.prepare('SELECT tick, at, data FROM bazaar_ticks ORDER BY tick DESC LIMIT ?').bind(Math.min(600, Math.max(12, +url.searchParams.get('hist') || 96))).all(),
        env.DB.prepare("SELECT d.id, d.merchant, d.tick, d.at, d.model, d.sealed, d.say, d.why, d.tx, d.pulled FROM bazaar_decisions d JOIN (SELECT merchant, MAX(id) AS id FROM bazaar_decisions WHERE merchant NOT LIKE 'steward:%' GROUP BY merchant) x ON x.id = d.id").all(),
      ]);
      return json({ ok: true, market: c.market, network: c.network, explorer: c.explorer, state: st, news: (news.results || []).map(r => ({ id: r.id, at: r.at, kind: r.kind, data: JSON.parse(r.data), tx: r.tx })), history: (hist.results || []).reverse().map(r => ({ tick: r.tick, at: r.at, data: JSON.parse(r.data) })), decisions: last.results || [] });
    }
    if (req.method === 'GET' && path === 'player') { const a = url.searchParams.get('account') || ''; if (!/^[a-z0-9._-]{2,64}$/.test(a)) return json({ ok: false, error: 'account' }, 400); return json({ ok: true, player: await clientOf(env, c).view(c.market, 'player', { account: a }) }); }
    if (req.method === 'GET' && path === 'decisions') { const m = url.searchParams.get('merchant') || ''; const r = await env.DB.prepare('SELECT id, merchant, tick, at, model, sealed, say, why, tx, pulled FROM bazaar_decisions WHERE merchant = ? ORDER BY id DESC LIMIT 20').bind(m).all(); return json({ ok: true, decisions: r.results || [] }); }
    /** the whole of one decision, so anyone can check its proof: what the merchant was told, what the model answered, and the signature */
    if (req.method === 'GET' && path === 'decision') { const r = await env.DB.prepare('SELECT * FROM bazaar_decisions WHERE id = ?').bind(+url.searchParams.get('id') || 0).first(); return r ? json({ ok: true, decision: r }) : json({ ok: false, error: 'none' }, 404); }
    if (req.method === 'POST' && path === 'hello') return await hello(req, env, c, h);
    if (req.method === 'GET' && path === 'steward_key') { const a = url.searchParams.get('account') || ''; if (!/^[a-z0-9._-]{2,64}$/.test(a)) return json({ ok: false, error: 'account' }, 400); return json({ ok: true, key: (await derivedKey(env.NEAR_KEY_SEED, 'steward:' + a)).publicKey }); }
    if (req.method === 'POST' && path === 'steward') return await stewardVisits(req, env, c, h);
    if (req.method === 'POST' && path === 'haggle') return await haggle(req, env, c, h);
    if (req.method === 'POST' && path === 'act') return await act(req, env, c, h);
    return json({ ok: false, error: 'not found' }, 404);
  } catch (e) { console.log('bazaar:', e && e.message); return json({ ok: false, error: 'chain', word: 'The market’s ledger is not answering. Try again in a moment.' }, 503); }
}

/** a device says who it is: a Telegram player's second device gets its key added; anyone else's account is simply their key */
async function hello(req, env, c, h) {
  const t0 = Date.now(), body = await h.readJson(req, 4096), json = h.json, key = String(body.key || ''); if (!/^ed25519:[1-9A-HJ-NP-Za-km-z]{32,52}$/.test(key)) return json({ ok: false, error: 'key' }, 400);
  const own = toHex(b58decode(key.slice(8))); let account = own, guest = true;
  const v = await h.authUser(req, env, body, Date.now()).catch(() => null);
  if (v && v.user) {
    guest = false; const row = await env.DB.prepare('SELECT account FROM bazaar_players WHERE uid = ?').bind(v.user.id).first();
    if (row) { account = row.account; if (account !== own) { const wk = await wardenKey(env, account), have = await clientOf(env, c).view(c.market, 'player', { account }).catch(() => null); if (have) await clientOf(env, c).tx(c.warden, wk, c.market, [Act.call('add_device_key', { account, key }, 30)]); } }
    else await env.DB.prepare('INSERT INTO bazaar_players (uid, account, created_at) VALUES (?, ?, ?)').bind(v.user.id, own, Date.now()).run();
  }
  let welcomed = false, slow = null, spent = false, full = false;
  if (body.first === true && c.network !== 'sandbox' && (await limited(env, 'new:' + ipOf(req), 100, 86400000))) spent = true;          // (a local chain, on a developer's or a judge's own machine, has no such limit: its address is always the same)
  else if (body.first === true) {          // (a new player's purse, from the treasury, and on the demo link crates to trade with: at most so many from one address in a day)
    const brings = body.crates === true ? Object.entries(R.DEMO_CRATES).map(([token, amount]) => ({ account, token, amount: String(amount) })) : [];
    const r = await clientOf(env, c).tx(c.warden, await wardenKey(env, account), c.market, [Act.call('serve', { brings, starters: [account], signed: [] }, 60)]); welcomed = r.ok; stateMemo.at = 0; if (Date.now() - t0 > 5000) slow = Object.assign({ ms: Date.now() - t0 }, r.trace);
    // A REFUSED WELCOME IS SAID (round 63). On 2026-11-11 the contract's account held no more NEAR than its storage locks, the chain refused every new player's purse, and nothing said so:
    // not the log, not the answer, not the screen. `full` tells the page that the market has no room; near/scripts/storage_room.mjs reports the room and sends NEAR.
    if (!r.ok) { full = /LackBalanceForState/i.test(String(r.failure || '')); console.log('hello: no purse for a new player' + (full ? ' (THE MARKET ACCOUNT IS OUT OF STORAGE: send NEAR to ' + c.market + ')' : '') + ': ' + String(r.failure || '').slice(0, 240)); }
  }
  if (slow) console.log('slow hello:', JSON.stringify(slow));
  return json(Object.assign({ ok: true, account, market: c.market, network: c.network, explorer: c.explorer, guest, welcomed, spent }, full ? { full } : {}, slow ? { slow } : {}));
}

/** a signed trade comes in; the warden brings it to the chain, with what the camp sent, and pays */
async function act(req, env, c, h) {
  const body = await h.readJson(req, 6144), json = h.json, si = body.signed; if (!si || typeof si.message !== 'string' || si.message.length > 1500) return json({ ok: false, error: 'bad' }, 400);
  let msg; try { msg = JSON.parse(si.message); } catch (e) { return json({ ok: false, error: 'bad' }, 400); }
  const who = String(msg.signer || ''); if (!/^[a-z0-9._-]{2,64}$/.test(who) || si.recipient !== c.market) return json({ ok: false, error: 'bad' }, 400);
  if (await limited(env, 'who:' + who, 40, 60000) || await limited(env, 'ip:' + ipOf(req), 180, 60000)) return json({ ok: false, error: 'slow', word: 'Slow down a little: the merchants can only count so fast.' }, 429);
  const brings = (Array.isArray(body.brings) ? body.brings : []).slice(0, 6).filter(b => b && R.GOODS[b.token] && /^[0-9]{1,7}$/.test(String(b.amount))).map(b => ({ account: who, token: b.token, amount: String(b.amount) }));
  const r = await clientOf(env, c).tx(c.warden, await wardenKey(env, who), c.market, [Act.call('serve', { brings, starters: [], signed: [si] }, 100)]);
  stateMemo.at = 0; if (!r.ok) { console.log('act failed:', r.failure); return json({ ok: false, error: 'refused', word: 'The market refused that.' }, 409); }
  await remember(env, r); const out = r.value && r.value[0]; if (out && out.err) return json({ ok: false, error: 'trade', word: out.err, tx: r.hash });
  return json({ ok: true, result: out && out.ok, tx: r.hash, tgas: r.tgas });
}

/** how a merchant's thinking is asked for: its character is pinned on the chain, the facts are of this moment */
export function factsFor(st, m) {
  const name = id => id.split('.')[0], world = t => st.world.find(w => w.token === t), eventText = st.event ? R.EVENTS[st.event.index][3] : 'nothing unusual', lines = [];
  const left = ((BigInt(m.day_till) * BigInt(R.CONFIG.caravan_day_bp)) / 10000n) - BigInt(m.caravan_spent), toDawn = Math.ceil((R.CONFIG.day_ticks - (st.tick % R.CONFIG.day_ticks)) * 24 / R.CONFIG.day_ticks);
  lines.push(`tick ${st.tick}`, `Your till: ${(Number(m.till) / 1000).toFixed(0)} gold. Dawn is in ${toDawn} hours, and the rent then is ${R.CONFIG.rent_millis / 1000} gold. You may still spend ${(Number(left > 0n ? left : 0n) / 1000).toFixed(0)} gold on caravans and deals today. In the world: ${eventText}.`);
  for (const g of m.goods) {
    const rivals = st.merchants.filter(o => o.id !== m.id && o.open && o.goods.some(x => x.token === g.token)).map(o => { const x = o.goods.find(y => y.token === g.token); return `${name(o.id)} sells at ${(Number(R.unitPrice(x.base, x.target, x.stock)) * (1 + x.spread_bp / 20000) / 1000).toFixed(3)}`; }).join(', ');
    lines.push(`${g.token}: you hold ${g.stock} and aim for ${g.target}; you sold ${g.sold_yesterday} yesterday and ${g.sold_today} so far today; base price ${(Number(g.base) / 1000).toFixed(3)}, margin ${(g.spread_bp / 100).toFixed(0)}%; a customer pays you ${(Number(R.unitPrice(g.base, g.target, g.stock)) * (1 + g.spread_bp / 20000) / 1000).toFixed(3)}. Caravans sell at ${(Number(world(g.token).world) * (1 + R.CONFIG.tariff_bp / 10000) / 1000).toFixed(3)} and buy at ${(Number(world(g.token).world) * (1 - R.CONFIG.tariff_bp / 10000) / 1000).toFixed(3)}. ${rivals || 'No other stall deals in it now.'}`);
  }
  const shut = st.merchants.filter(o => !o.open).map(o => name(o.id)); if (shut.length) lines.push('Closed stalls: ' + shut.join(', ') + '.');
  return lines.join('\n');
}
/** a request with an end: no answer by then, or when the caller stops it, counts as no answer */
async function timedText(url, init, ms, outer) {
  const c = new AbortController(), t = setTimeout(() => c.abort(), ms), stop = () => c.abort(); if (outer) outer.addEventListener('abort', stop);
  try { const r = await fetch(url, Object.assign({}, init, { signal: c.signal })); return { ok: r.ok, status: r.status, text: await r.text() }; } finally { clearTimeout(t); if (outer) outer.removeEventListener('abort', stop); }
}
/** ask NEAR AI: the exact request and answer, and the proof it gives for them, if it gives one. A machine that is slow or stuck costs a moment, not the player's patience (measured 2026-11-05: 1.4 s as a rule, 7 s at worst, and now and then no answer in 40 s): after hedgeMs, or at once if it fails, the same question goes again and the first good answer wins; after limitMs the caller goes on without one, and the proof gets proofMs */
export async function askNearAI(env, system, user, o = {}) {
  const limitMs = o.limitMs || 90000, hedgeMs = o.hedgeMs || 30000, proofMs = o.proofMs || 30000, t0 = Date.now(), model = env.NEAR_MODEL || DEFAULT_MODEL, base = env.NEARAI_BASE || AI_BASE, auth = { authorization: 'Bearer ' + env.NEARAI_KEY, 'content-type': 'application/json' };
  const request = JSON.stringify({ model, messages: [{ role: 'system', content: system }, { role: 'user', content: user }], temperature: 0.7, max_tokens: 400, chat_template_kwargs: { enable_thinking: false } });
  const stop = new AbortController(); let timer = null, asked = 0;
  const response = await new Promise(resolve => {
    let failed = 0;
    const go = () => { asked++; timedText(base + '/v1/chat/completions', { method: 'POST', headers: auth, body: request }, Math.max(100, limitMs - (Date.now() - t0)), stop.signal).then(r => { if (r.ok) resolve(r.text); else { console.log('near ai', r.status, r.text.slice(0, 200)); no(); } }, no); };
    const no = () => { if (++failed >= 2) return resolve(null); if (asked < 2) { clearTimeout(timer); go(); } };
    timer = setTimeout(() => { if (asked < 2) go(); }, hedgeMs); go();
  });
  clearTimeout(timer); stop.abort(); if (response === null) { console.log('near ai: no answer in', Date.now() - t0, 'ms'); return null; }
  const chatMs = Date.now() - t0;
  let id = null, used = model, content = ''; try { const j = JSON.parse(response); id = j.id; used = j.model || model; content = j.choices[0].message.content || ''; } catch (e) { console.log('near ai answer unreadable'); return null; }
  const open = content.indexOf('{'), close = content.lastIndexOf('}'); if (open < 0 || close < open) { console.log('no decision in the answer'); return null; }
  let decision = null; try { decision = JSON.parse(content.slice(open, close + 1)); } catch (e) { console.log('the decision is not JSON'); return null; }
  let proof = null; const proofEnd = Date.now() + proofMs;
  for (let i = 0; i < 4 && !proof && Date.now() < proofEnd; i++) { const s = await timedText(`${base}/v1/signature/${encodeURIComponent(id)}?model=${encodeURIComponent(model)}&signing_algo=ecdsa`, { headers: auth }, Math.max(100, Math.min(8000, proofEnd - Date.now()))).catch(() => null); if (s && s.ok) { let p = null; try { p = JSON.parse(s.text); } catch (e) { /* not yet */ } if (p && p.signature && p.text) proof = p; } if (!proof && Date.now() + 900 < proofEnd) await new Promise(r => setTimeout(r, 900)); }
  return { model, used, request, response, content: content.slice(open, close + 1), decision, proof, auth, base, took: { chat: chatMs, all: Date.now() - t0, asked } };
}
/** one merchant thinks, on NEAR AI, and its own key brings the answer to the chain */
async function merchantThinks(env, c, st, m) {
  const client = clientOf(env, c), def = R.MERCHANTS.find(d => m.id === d.id + '.' + c.root); if (!def) return;
  const a = await askNearAI(env, R.merchantPrompt(def), factsFor(st, m)); if (!a) return; const { proof, request, response, used, model, auth, base } = a;
  const key = await derivedKey(env.NEAR_KEY_SEED, 'merchant:' + def.id); let sealed = false, out = null;
  if (proof) {
    const signer = String(proof.signing_address || '').toLowerCase();
    if (!st.signers.includes(signer)) { const rep = await fetch(`${base}/v1/attestation/report?model=${encodeURIComponent(model)}&signing_algo=ecdsa&nonce=${toHex(crypto.getRandomValues(new Uint8Array(32)))}`, { headers: auth }).catch(() => null), text = rep && rep.ok ? await rep.text() : ''; if (text && text.toLowerCase().includes(signer)) { await client.tx(c.warden, await wardenKey(env, 'signer'), c.market, [Act.call('add_signer', { address: signer, report_sha256: toHex(await sha256(text)) }, 30)]); st.signers.push(signer); await env.DB.prepare('INSERT INTO bazaar_news (at, kind, data, tx) VALUES (?, ?, ?, ?)').bind(Date.now(), 'attested', JSON.stringify({ signer, report: text.slice(0, 4000) }), null).run(); } }
    if (st.signers.includes(signer)) { try { out = await client.tx(m.id, key, c.market, [Act.call('decide_sealed', { answer: { request, response, text: proof.text, signature: proof.signature, signer } }, 40)]); sealed = out.ok; if (!out.ok) { console.log('sealed refused:', out.failure); if (/already decided/.test(JSON.stringify(out.failure))) return; } } catch (e) { console.log('sealed:', e.message); } }
  }
  if (!sealed) out = await client.tx(m.id, key, c.market, [Act.call('decide', { decision: a.content, model: used }, 60)]);
  if (!out || !out.ok) { console.log('decide failed', out && out.failure); return; }
  console.log('thought:', m.id, sealed ? 'sealed' : 'by its key', out.tgas + ' Tgas');
  const ev = (out.events || []).find(e => e.event === 'decision'), d = ev ? ev.data[0] : {};
  await env.DB.prepare('INSERT INTO bazaar_decisions (merchant, tick, at, model, sealed, say, why, request, response, sig_text, signature, signer, tx, pulled) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)').bind(m.id, st.tick, Date.now(), used, sealed ? 1 : 0, d.say || '', d.why || '', request, response, proof ? proof.text : null, proof ? proof.signature : null, proof ? proof.signing_address : null, out.hash, JSON.stringify(d.pulled || [])).run();
  await remember(env, out);
}

// ── THE STEWARD: the camp's AI agent goes to market. It has a key of its own, which the player has given a limit of gold a day: the contract holds it to that, and to selling, buying and sending home ──
const num = (x, lo, hi) => { const n = Math.floor(Number(x)); return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : lo; };
/** the best stall for a good, right now: who pays most for q, who sells q cheapest */
function bestBuyer(st, token, q) { let best = null; for (const m of st.merchants) { if (!m.open) continue; const g = m.goods.find(x => x.token === token); if (!g) continue; const b = R.bid(g, q, st.now_ms, R.CONFIG); if (b + (BigInt(m.start_till) * BigInt(m.care)) / 400n > BigInt(m.till)) continue; if (!best || b > best.gold) best = { m, gold: b }; } return best; }
function bestSeller(st, token, q) { let best = null; for (const m of st.merchants) { if (!m.open) continue; const g = m.goods.find(x => x.token === token); if (!g) continue; const a = R.ask(g, q, st.now_ms, R.CONFIG); if (a === null) continue; if (!best || a < best.gold) best = { m, gold: a }; } return best; }
function stewardFacts(st, camp, me, left) {
  const purse = Number((me.items.find(i => i.token === 'gold') || {}).amount || 0), lines = [`The camp: day ${camp.day}, ${String(camp.hour).padStart(2, '0')}:00, ${camp.night ? 'night' : 'dusk in ' + Math.max(0, 20 - camp.hour) + ' hours'}. ${camp.people} people, ${camp.wounded} wounded. The fire is at ${camp.fire}%.`, `Gold: ${(purse / 1000).toFixed(1)} in the purse; you may spend ${(Number(left) / 1000).toFixed(1)} more today.`, `In the world: ${st.event ? R.EVENTS[st.event.index][3] : 'nothing unusual'}.`]; if (camp.order) lines.push(`Your leader's standing order: ${JSON.stringify(camp.order)}`);
  for (const t of Object.keys(R.GOODS)) {
    const g = camp.goods[t] || { have: 0, cap: 0 }, crates = Number((me.items.find(i => i.token === t) || {}).amount || 0), q = BigInt(Math.max(1, Math.round(5000 / R.GOODS[t]))), b = bestBuyer(st, t, q), a = bestSeller(st, t, q), full = g.cap > 0 ? Math.round(g.have * 100 / g.cap) : 0, per = v => (Number(v) / Number(q) / 1000).toFixed(3);
    lines.push(`${t}: stores hold ${g.have} of ${g.cap} (${full}% full)${crates ? `, ${crates} more in crates at the market` : ''}. ${b ? `${b.m.id.split('.')[0]} pays ${per(b.gold)} a unit.` : 'Nobody is buying.'} ${a ? `${a.m.id.split('.')[0]} sells at ${per(a.gold)}.` : 'Nobody has any.'} Usually ${(R.GOODS[t] / 1000).toFixed(3)}.`);
  }
  return lines.join('\n');
}
/** with no AI to ask, the plain sense of a good storekeeper */
function stewardRules(camp) {
  const sell = [], buy = []; for (const t of Object.keys(R.GOODS)) { const g = camp.goods[t]; if (!g || !g.cap) continue; if (g.have > g.cap * 0.7) sell.push({ good: t, qty: Math.floor(g.have - g.cap * 0.55) }); else if (g.have < g.cap * 0.12) buy.push({ good: t, qty: Math.ceil(g.cap * 0.2 - g.have) }); }
  return { sell, buy, say: sell.length ? 'The stores are filling, so I sold what we cannot keep.' : buy.length ? 'We were running short, so I bought what we can afford.' : 'Nothing worth doing at these prices.', why: 'By the rulebook: sell above seven tenths full, buy below a tenth.' };
}
/** a player's words prove nothing about who they are: their key's signature does */
async function ownsAccount(body, account, label) { try { const ts = Number(body.ts) || 0; if (Math.abs(Date.now() - ts) > 300000) return false; const pub = b58decode(String(body.pub || '').replace(/^ed25519:/, '')), sig = Uint8Array.from(atob(String(body.sig || '')), x => x.charCodeAt(0)); return pub.length === 32 && toHex(pub) === account && await verifyText(pub, sig, label + '|' + account + '|' + ts); } catch (e) { return false; } }
/** A PLAYER TALKS TO A MERCHANT, in their own words. The merchant's AI answers, and may give up some of its margin on that player's next trade: the contract holds it to that, so anything can be said to it. The last words between them are kept, so that the merchant remembers (bazaar_talk) */
async function haggle(req, env, c, h) {
  const t0 = Date.now(), body = await h.readJson(req, 3000), json = h.json, account = String(body.account || ''), id = String(body.merchant || ''), def = R.MERCHANTS.find(d => d.id === id), words = String(body.words || '').replace(/[\u0000-\u001f]+/g, ' ').trim().slice(0, 220);
  if (!def || !words || !/^[a-z0-9._-]{2,64}$/.test(account) || !(await ownsAccount(body, account, 'haggle'))) return json({ ok: false, error: 'bad' }, 400);
  if (await limited(env, 'haggle:' + account + ':' + id, 3, 300000) || await limited(env, 'haggle-ip:' + ipOf(req), 120, 3600000)) return json({ ok: false, error: 'slow', word: shortOf(def) + ' waves you off. Give it a few minutes.' }, 429);
  const st = await marketState(env, c), m = st.merchants.find(x => x.id === id + '.' + c.root); if (!m || !m.open) return json({ ok: false, word: 'That stall is closed.' });
  if (!env.NEARAI_KEY || await limited(env, 'haggle-ai', 800, 86400000)) return json({ ok: true, say: 'My price is my price, friend.', off: 0, model: 'rulebook' });
  const past = await env.DB.prepare('SELECT said, answered, off FROM bazaar_talk WHERE account = ? AND merchant = ? ORDER BY id DESC LIMIT 4').bind(account, id).all().then(r => (r.results || []).reverse()).catch(() => []), me = await clientOf(env, c).view(c.market, 'player', { account }).catch(() => null), part = me && me.partners && me.partners.find(p => p.merchant === m.id), share = part ? Number((BigInt(part.shares) * 1000n) / BigInt(part.of)) / 10 : 0;
  const memory = (past.length ? 'What has passed between you before:\n' + past.map(p => `They said ${JSON.stringify(p.said)}. You said ${JSON.stringify(p.answered)} and gave ${p.off}%.`).join('\n') : 'You have not talked to this customer before.') + (share > 0 ? `\nThis customer owns ${share}% of your stall.` : '');
  const gold = v => (Number(v) / 1000).toFixed(2), prices = (m.goods || []).map(g => { const lot = BigInt((R.LOT || {})[g.token] || 1), a1 = R.ask(g, 1n, st.now_ms, R.CONFIG), aL = R.ask(g, lot, st.now_ms, R.CONFIG), b1 = R.bid(g, 1n, st.now_ms, R.CONFIG); return `${g.token}: you sell it at ${a1 === null ? '(none left)' : gold(a1)} each, ${aL === null ? 'not a whole lot left' : 'a lot of ' + lot + ' for ' + gold(aL)}; you buy it at ${gold(b1)} each; you hold ${g.stock}`; }).join('\n');          // (the owner's screenshot, 2026-11-05: asked the price of one medicine, Cato said twenty gold; it was 4.1)
  const a = await askNearAI(env, R.hagglePrompt(def), `Your till holds ${(Number(m.till) / 1000).toFixed(0)} gold. You deal in ${def.goods.join(' and ')}.\nYour prices right now, in gold:\n${prices}\n${memory}\nThe customer says: ${JSON.stringify(words)}`, { limitMs: 28000, hedgeMs: 9000, proofMs: 5000 }).catch(() => null); if (!a) return json({ ok: true, say: 'Not today, friend.', off: 0, model: 'rulebook' });
  const asked = num(a.decision.give, 0, 100), say = String(a.decision.say || '').slice(0, 160); let tx = null;
  const aiAt = Date.now(); if (asked > 0) { const r = await Promise.race([clientOf(env, c).tx(m.id, await derivedKey(env.NEAR_KEY_SEED, 'merchant:' + id), c.market, [Act.call('give_haggle', { buyer: account, off_bp: asked * 100 }, 30)]), new Promise(res => setTimeout(() => res(null), 14000))]).catch(e => { console.log('haggle tx:', e.message); return null; }); if (r && r.ok) tx = r.hash; }          // (the answer does not wait on the chain for ever: a discount that lands late is still found on the next read)
  await env.DB.prepare('INSERT INTO bazaar_talk (account, merchant, at, said, answered, off) VALUES (?, ?, ?, ?, ?, ?)').bind(account, id, Date.now(), words, say, tx ? Math.min(asked, 30) : 0).run().catch(e => console.log('talk not kept:', e.message));
  const slow = Date.now() - t0 > 8000 ? { ms: Date.now() - t0, before: t0 && aiAt - a.took.all - t0, ai: a.took, tx: Date.now() - aiAt } : null; if (slow) console.log('slow haggle:', JSON.stringify(slow));
  return json(Object.assign({ ok: true, say, off: tx ? Math.min(asked, 30) : 0, asked, model: a.used, signed: !!a.proof, tx, knew: past.length }, slow ? { slow } : {}));
}
const shortOf = d => d.name.replace('Merchant ', '');
/** the steward's visit: it reads the camp and the market, decides, and its own key signs the trades */
async function stewardVisits(req, env, c, h) {
  const body = await h.readJson(req, 4096), json = h.json, account = String(body.account || ''), ts = Number(body.ts) || 0; if (!/^[a-z0-9._-]{2,64}$/.test(account) || Math.abs(Date.now() - ts) > 300000) return json({ ok: false, error: 'bad' }, 400);
  if (!(await ownsAccount(body, account, 'steward'))) return json({ ok: false, error: 'not yours' }, 403);
  if (await limited(env, 'steward:' + account, 40, 3600000) || await limited(env, 'steward-ip:' + ipOf(req), 200, 3600000)) return json({ ok: false, error: 'slow', word: 'Your steward is on the road. It will be back.' }, 429);
  const client = clientOf(env, c); let me = await client.view(c.market, 'player', { account });
  for (let i = 0; i < 6 && !me.steward; i++) { await new Promise(r => setTimeout(r, 700)); me = await client.view(c.market, 'player', { account }); }          // (it has just been hired, and a read can still come from a node a block behind)
  const grant = me.steward; if (!grant) return json({ ok: false, error: 'none', word: 'You have no steward at the market.' }, 409);
  const st = await marketState(env, c), left = BigInt(grant.cap) - BigInt(grant.spent); const camp = { day: num(body.camp && body.camp.day, 0, 99999), hour: num(body.camp && body.camp.hour, 0, 23), night: !!(body.camp && body.camp.night), people: num(body.camp && body.camp.people, 0, 9999), wounded: num(body.camp && body.camp.wounded, 0, 9999), fire: num(body.camp && body.camp.fire, 0, 100), goods: {}, order: String((body.camp && body.camp.order) || '').replace(/[\u0000-\u001f]+/g, ' ').trim().slice(0, 140) };
  for (const t of Object.keys(R.GOODS)) { const g = body.camp && body.camp.goods && body.camp.goods[t]; camp.goods[t] = { have: num(g && g.have, 0, 9999999), cap: num(g && g.cap, 0, 9999999) }; }
  const ai = env.NEARAI_KEY && !(await limited(env, 'steward-ai', 800, 86400000)) ? await askNearAI(env, R.stewardPrompt(), stewardFacts(st, camp, me, left), { limitMs: 30000, hedgeMs: 12000, proofMs: 6000 }).catch(e => { console.log('steward ai:', e.message); return null; }) : null; const d = ai ? ai.decision : stewardRules(camp);
  const crates = t => Number((me.items.find(i => i.token === t) || {}).amount || 0), key = await derivedKey(env.NEAR_KEY_SEED, 'steward:' + account), brings = [], intents = [], plan = []; let seq = Date.now(), budget = left, purse = BigInt((me.items.find(i => i.token === 'gold') || {}).amount || 0);
  for (const it of (Array.isArray(d.sell) ? d.sell : []).slice(0, 4)) {
    const t = it && it.good; if (!R.GOODS[t]) continue; const held = camp.goods[t].have + crates(t), q = Math.min(num(it.qty, 0, 100000), held); if (q <= 0) continue; const b = bestBuyer(st, t, BigInt(q)); if (!b) continue;
    const fromCamp = Math.max(0, q - crates(t)); if (fromCamp > 0) brings.push({ account, token: t, amount: String(fromCamp) });
    intents.push(await signIntent(key, c.market, account, ++seq, [{ sell: { merchant: b.m.id, token: t, amount: String(q), min_gold: String((b.gold * 80n) / 100n) } }])); plan.push({ side: 'sell', good: t, qty: q, merchant: b.m.id.split('.')[0], brought: fromCamp, ship: 0 }); purse += b.gold;
  }
  for (const it of (Array.isArray(d.buy) ? d.buy : []).slice(0, 4)) {
    const t = it && it.good; if (!R.GOODS[t]) continue; let q = num(it.qty, 0, 100000); if (q <= 0) continue; let a = bestSeller(st, t, BigInt(q));
    while (q > 1 && (!a || (a.gold * 110n) / 100n > budget || a.gold > purse)) { q = Math.floor(q * 0.7); a = bestSeller(st, t, BigInt(q)); }          // (an AI that asks for more than anyone holds or the limit allows gets what can be had)
    if (!a || (a.gold * 110n) / 100n > budget || a.gold > purse) continue;
    const room = Math.max(0, camp.goods[t].cap - camp.goods[t].have), ship = Math.min(q, room), actions = [{ buy: { merchant: a.m.id, token: t, amount: String(q), max_gold: String((a.gold * 110n) / 100n) } }]; if (ship > 0) actions.push({ ship: { token: t, amount: String(ship) } });
    intents.push(await signIntent(key, c.market, account, ++seq, actions)); plan.push({ side: 'buy', good: t, qty: q, merchant: a.m.id.split('.')[0], brought: 0, ship }); budget -= (a.gold * 110n) / 100n; purse -= a.gold;
  }
  let out = null, results = [];
  if (intents.length) { out = await client.tx(c.warden, await wardenKey(env, account), c.market, [Act.call('serve', { brings, starters: [], signed: intents }, 150)]); if (!out.ok) { console.log('steward refused:', out.failure); return json({ ok: false, error: 'refused', word: 'The market refused your steward.' }, 409); } results = out.value || []; stateMemo.at = 0; await remember(env, out); }
  const trades = plan.map((p, i) => { const r = results[i] || {}, okv = r.ok && r.ok[0]; return Object.assign({}, p, { ok: !!r.ok, gold: okv && okv.gold, err: r.err }); });
  const say = String(d.say || '').slice(0, 140), why = String(d.why || '').slice(0, 400), model = ai ? ai.used : 'rulebook';
  const row = await env.DB.prepare('INSERT INTO bazaar_decisions (merchant, tick, at, model, sealed, say, why, request, response, sig_text, signature, signer, tx, pulled) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14) RETURNING id').bind('steward:' + account, st.tick, Date.now(), model, ai && ai.proof ? 2 : 0, say, why, ai ? ai.request : null, ai ? ai.response : null, ai && ai.proof ? ai.proof.text : null, ai && ai.proof ? ai.proof.signature : null, ai && ai.proof ? ai.proof.signing_address : null, out ? out.hash : null, JSON.stringify(trades)).first();
  return json({ ok: true, id: row && row.id, say, why, model, signed: !!(ai && ai.proof), trades, tx: out ? out.hash : null });
}
/** Every minute: the market's clock, one merchant's thinking when one is due, and the record for the charts */
export async function bazaarCron(env) {
  const c = cfgOf(env); if (!c) return; const client = clientOf(env, c);
  const st = await client.view(c.market, 'state', {}); stateMemo.at = 0;
  if (st.now_ms >= st.last_tick_ms + (R.CONFIG.tick_ms)) {
    const r = await client.tx(c.warden, await derivedKey(env.NEAR_KEY_SEED, 'warden:7'), c.market, [Act.call('crank', {}, 100)]); if (r.ok) { await remember(env, r); const s2 = await client.view(c.market, 'state', {});
      const compact = { tr: s2.treasury, w: s2.world.map(w => w.world), m: s2.merchants.map(m => ({ i: m.id.split('.')[0], t: m.till, o: m.open ? 1 : 0, g: m.goods.map(g => [g.token, g.stock, g.target, g.base, g.spread_bp]) })) };
      await env.DB.prepare('INSERT OR REPLACE INTO bazaar_ticks (tick, at, data) VALUES (?, ?, ?)').bind(s2.tick, Date.now(), JSON.stringify(compact)).run(); await env.DB.prepare('DELETE FROM bazaar_ticks WHERE tick < ?').bind(s2.tick - 2016).run(); stateMemo.at = 0; Object.assign(st, s2); }
  }
  if (env.NEARAI_KEY) {
    const due = st.merchants.filter(m => m.open && st.tick - m.last_ai_tick >= AI_EVERY_TICKS).sort((a, b) => a.last_ai_tick - b.last_ai_tick)[0];
    if (due) { try { await merchantThinks(env, c, st, due); } catch (e) { console.log('thinking:', e && e.message); } }
  }
}
