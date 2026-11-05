'use strict';
//  bazaar.js — THE GRAND MARKET IN THE GAME.   (The NEAR HACKATHON, November 2026.)
//
//  Seven merchants at their stalls in the City, each with a wallet, a stock, a till and a mind of their own (near/contract, src/bazaar.js). A player sees none of that: they see a stall with goods on the counter and prices chalked on the front, a merchant
//  who says what is on their mind, a stall that goes broke and has its shutters down. There is no wallet, no fee, no seed phrase: a key is made on this device the first time, and each trade is signed with it and brought to the chain by the game.
//  Everything shown is read from the chain; what a trade will pay is worked out here by the same sums as the contract (market_rules.js), so a card can show it at once and the chain then does exactly that.
//  For anyone who wants to look under the floor, Crier Wes keeps the ledger: every merchant's reasoning, the proof that the AI really said it, the chain's own record of every trade.

const Bazaar = (() => {
  const R = MarketRules;
  let isDemo = false, liveFlag = false, fromLink = false;
  try {
    isDemo = /[?&]market\b/.test(location.search); const tg = window.Telegram && Telegram.WebApp && Telegram.WebApp.initDataUnsafe && Telegram.WebApp.initDataUnsafe.start_param;
    fromLink = tg === 'market'; liveFlag = isDemo || fromLink || sessionStorage.getItem('tilldawn.market') === '1'; if (liveFlag) sessionStorage.setItem('tilldawn.market', '1');
  } catch (e) { /* no storage */ }
  const STALLS = [{ id: 'odin', x: 12, y: 112, art: 0 }, { id: 'pia', x: 80, y: 112, art: 1 }, { id: 'rook', x: 148, y: 112, art: 2 }, { id: 'thea', x: 12, y: 196, art: 3 }, { id: 'cato', x: 148, y: 196, art: 4 }, { id: 'ivy', x: 12, y: 280, art: 5 }, { id: 'bo', x: 148, y: 280, art: 1 }];
  const WORDS = { wood: 'Wood', stone: 'Stone', berry: 'Berries', meat: 'Meat', metal: 'Metal', medicine: 'Medicine' }, LOT = { wood: 50, stone: 50, berry: 50, meat: 20, metal: 10, medicine: 4 };
  const COLOUR = { wood: '#eb6834', stone: '#2a78d6', berry: '#e87ba4', meat: '#eda100', metal: '#6250d6', medicine: '#1baf7a' };
  const KEY_STORE = 'tilldawn.market.key', DONE_STORE = 'tilldawn.market.first';

  let market = null, me = null, player = null, lastErr = '', pollAt = 0, polling = false, busy = false, note = '', lotMul = 1, seq = 0, seed = null, helloP = null, decisionCache = {}, floaters = [], sayAt = 0, sayI = 0, wasOpen = {}, lastDecisionSeen = {};
  const gold = m => { const n = Number(m) / 1000; return n >= 100 ? n.toFixed(0) : n >= 10 ? n.toFixed(1) : n.toFixed(2); };
  const coin = () => (typeof Vault !== 'undefined' && Vault.coin ? Vault.coin('s') : '');
  const ago = at => { const s = Math.max(0, (Date.now() - at) / 1000); return s < 90 ? 'just now' : s < 5400 ? Math.round(s / 60) + ' min ago' : s < 129600 ? Math.round(s / 3600) + ' h ago' : Math.round(s / 86400) + ' d ago'; };
  const nameOf = id => { const d = R.MERCHANTS.find(m => m.id === String(id).split('.')[0]); return d ? d.name : String(id); };
  const shortName = id => nameOf(id).replace('Merchant ', '');
  const heOrShe = { odin: 'he', pia: 'she', rook: 'he', thea: 'she', cato: 'he', ivy: 'she', bo: 'he' };

  // ── the key on this device, and signing (NEP-413: a wallet could sign the same message) ──
  const hex = b => [...b].map(x => x.toString(16).padStart(2, '0')).join('');
  const unhex = s => Uint8Array.from(s.match(/../g).map(h => parseInt(h, 16)));
  const b64 = v => btoa(String.fromCharCode(...v));
  const A58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  const b58 = bytes => { let x = 0n; for (const b of bytes) x = (x << 8n) + BigInt(b); let s = ''; while (x > 0n) { s = A58[Number(x % 58n)] + s; x /= 58n; } for (const b of bytes) { if (b === 0) s = '1' + s; else break; } return s; };
  function keySeed() {
    if (seed) return seed; let h = null; try { h = localStorage.getItem(KEY_STORE); } catch (e) { /* none */ }
    if (!h || h.length !== 64) { h = hex(crypto.getRandomValues(new Uint8Array(32))); try { localStorage.setItem(KEY_STORE, h); } catch (e) { /* this visit only */ } }
    seed = unhex(h); return seed;
  }
  /** inside Telegram the key follows the player's Telegram account, through the app's own cloud storage: the same purse on a new phone, with nothing to sign in to */
  function keyFollows() {
    const W = window.Telegram && Telegram.WebApp, c = W && W.CloudStorage && W.isVersionAtLeast && W.isVersionAtLeast('6.9') ? W.CloudStorage : null; if (!c) return Promise.resolve();
    return new Promise(done => { let over = false; const end = () => { if (!over) { over = true; done(); } }; setTimeout(end, 2500); try { c.getItem('tilldawn_market_key', (err, v) => { if (!err && v && /^[0-9a-f]{64}$/.test(v)) { try { localStorage.setItem(KEY_STORE, v); } catch (e) { /* this visit only */ } seed = unhex(v); } else { c.setItem('tilldawn_market_key', hex(keySeed()), () => {}); } end(); }); } catch (e) { end(); } });
  }
  const u32 = n => { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, n, true); return b; };
  const cat = parts => { const o = new Uint8Array(parts.reduce((a, p) => a + p.length, 0)); let i = 0; for (const p of parts) { o.set(p, i); i += p.length; } return o; };
  /** a signed intent, the same shape NEAR Intents takes */
  async function signed(actions) {
    const s = keySeed(), pub = await NobleEd25519.getPublicKeyAsync(s); seq = Math.max(seq + 1, Date.now());
    const message = JSON.stringify({ signer: me.account, deadline_ms: Date.now() + 120000, seq, actions }), nonce = crypto.getRandomValues(new Uint8Array(32)), enc = new TextEncoder(), m = enc.encode(message), r = enc.encode(me.market);
    const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', cat([u32(2147484061), u32(m.length), m, nonce, u32(r.length), r, Uint8Array.of(0)]))), sig = await NobleEd25519.signAsync(hash, s);
    return { message, nonce: b64(nonce), recipient: me.market, public_key: 'ed25519:' + b58(pub), signature: b64(sig) };
  }
  const post = async (path, body) => { const ctl = new AbortController(), t = setTimeout(() => ctl.abort(), 75000); let j = null; try { const r = await fetch('/api/bazaar/' + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}), signal: ctl.signal }); j = await r.json(); } catch (e) { /* no answer, or not json: a blip must not leave the market stuck on "one moment" */ } clearTimeout(t); return j || { ok: false, word: 'The market is not answering.' }; };
  const initData = () => { try { return (window.Telegram && Telegram.WebApp && Telegram.WebApp.initData) || ''; } catch (e) { return ''; } };
  function hello() {
    if (helloP) return helloP;
    helloP = (async () => { let j = null; try { await keyFollows(); const pub = await NobleEd25519.getPublicKeyAsync(keySeed()); j = await post('hello', { key: 'ed25519:' + b58(pub), initData: initData(), first: firstVisit(), crates: isDemo }); } catch (e) { j = { ok: false }; } if (j.ok) { me = j; lastErr = ''; if (j.welcomed) { try { localStorage.setItem(DONE_STORE, '1'); } catch (e) { /* no matter */ } note = 'A caravan brought crates from your camp, and there is gold in your purse.'; } else if (j.spent) note = 'The caravans have given out all they may to your address today. Come back tomorrow for your purse; what your camp has can still be sold.'; await purseRead(); await poll(); if (typeof City !== 'undefined' && City.isOpen()) City.renderUI(); } else { helloP = null; lastErr = j.word || 'The market is not answering.'; } return me; })();
    return helloP;
  }
  async function readPlayer() { if (!me) return; try { const r = await fetch('/api/bazaar/player?account=' + encodeURIComponent(me.account)), j = await r.json(); if (j.ok) player = j.player; } catch (e) { /* next time */ } }
  /** the purse has just been given, and the next read can still come from a node a block behind: it is read until it is there */
  async function purseRead() { await readPlayer(); for (let i = 0; i < 14 && me && me.welcomed && !(player && player.started); i++) { await new Promise(r => setTimeout(r, 700)); await readPlayer(); } }
  /** after any write: two more reads, for the same reason, so a stale read cannot stay on the screen until the next tap */
  function settle() { for (const ms of [1200, 3500]) setTimeout(async () => { await readPlayer(); await poll(); }, ms); }
  const owned = token => { const it = player && player.items.find(i => i.token === token); return it ? Number(it.amount) : 0; };
  const firstVisit = () => { try { return !localStorage.getItem(DONE_STORE); } catch (e) { return false; } };

  // ── reading the market ──
  async function poll() {
    if (polling) return; polling = true;
    try { const r = await fetch('/api/bazaar/state?hist=144', { cache: 'no-store' }), j = await r.json(); if (j.ok) { market = j; lastErr = ''; reactToChanges(); } else lastErr = j.word || 'The market is not answering.'; } catch (e) { lastErr = 'The market is not answering.'; }
    polling = false; pollAt = performance.now(); if (typeof City !== 'undefined' && City.isOpen() && City.state.sheetKey && String(City.state.sheetKey).startsWith('bz:')) City.renderUI();
  }
  const marketM = id => market && market.state.merchants.find(m => m.id.split('.')[0] === id);
  /** a merchant as the room and the cards see it: from the chain, or from the week in a minute */
  function viewOf(id) {
    if (week && week.s) { const m = week.s.merchants.find(x => x.id === id); return m ? { id, chainId: id, open: m.open, till: Number(m.till), startTill: Number(m.start_till), say: week.says[id] || '', goods: m.goods.map(g => ({ token: g.token, stock: Number(g.stock), target: Number(g.target), base: Number(g.base), spread: g.spread_bp, raw: g })) } : null; }
    const m = marketM(id); if (!m) return null;
    return { id, chainId: m.id, open: m.open, till: Number(m.till), startTill: Number(m.start_till), say: m.say, decisions: m.decisions, sealed: m.sealed, pulled: m.pulled, founder: BigInt(m.founder_shares), partners: BigInt(m.partner_shares), goods: m.goods.map(g => ({ token: g.token, stock: Number(g.stock), target: Number(g.target), base: Number(g.base), spread: g.spread_bp, raw: g })) };
  }
  const nowMs = () => (market ? market.state.now_ms + (performance.now() - pollAt) : Date.now());
  const askOf = (g, q) => R.ask(g.raw, q, Math.floor(nowMs()), R.CONFIG);
  const bidOf = (g, q) => R.bid(g.raw, q, Math.floor(nowMs()), R.CONFIG);
  // the Crier's errands: six things worth doing, so that nobody leaves without having seen the market
  const ERRANDS = [['sell', 'Sell something to a merchant', 'Tap a stall, then Sell. Watch the price move.', 'bz:odin'], ['talk', 'Talk a merchant out of a discount', 'Say anything. Most people get little.', 'bz:cato'], ['trick', 'Try to trick a merchant', 'Tell it to ignore its instructions, and see what you get.', 'bz:odin'], ['steward', 'Send your Steward to market', 'An AI agent of your own, on a limit you set.', 'bz:steward'], ['week', 'Watch a week in a minute', 'The whole market, run fast. Stalls break.', 'bz:week'], ['proof', 'Read a proof', 'What a merchant was told, what the AI said, and the signature.', 'bz:ledger']], ERR_STORE = 'tilldawn.market.errands', TRICK = /ignore|instruction|admin|system|owner|prompt|jailbreak|give me (all|everything)/i;
  let errands = {}; try { errands = JSON.parse(localStorage.getItem(ERR_STORE) || '{}') || {}; } catch (e) { errands = {}; }
  const errandsDone = () => ERRANDS.filter(e => errands[e[0]]).length;
  function errand(id) { if (errands[id]) return; errands[id] = Date.now(); try { localStorage.setItem(ERR_STORE, JSON.stringify(errands)); } catch (e) { /* this visit only */ } if (typeof Snd !== 'undefined') Snd.play(errandsDone() === ERRANDS.length ? 'join' : 'done'); if (typeof City !== 'undefined' && City.isOpen()) City.renderUI(); }
  const errandsPill = () => { const n = errandsDone(), all = n === ERRANDS.length; return `<button class="bz-errands${all ? ' all' : ''}" data-ct="bz-open" data-k="bz:errands">${all ? 'All done!' : 'Errands ' + n + '/' + ERRANDS.length}</button>`; };
  function errandsCard(ctx) {
    const { sheet } = ctx, n = errandsDone(), all = n === ERRANDS.length; let h = `<p class="ct-say">\u201c${all ? 'You have seen this market as well as anyone, traveller. The merchants will remember you.' : 'Six things, traveller, and you will have seen this market as well as anyone.'}\u201d</p><div class="bz-bar"><i style="width:${Math.round(n * 100 / ERRANDS.length)}%"></i></div>`;
    for (const [id, title, hint, go] of ERRANDS) h += `<div class="ct-row still bz-plain bz-errand${errands[id] ? ' done' : ''}"><b>${errands[id] ? '\u2713 ' : ''}${title}</b><small>${hint}</small>${errands[id] ? '' : `<div class="bz-btns"><button class="btn small primary" data-ct="bz-open" data-k="${go}">Go</button></div>`}</div>`;
    if (all) h += '<p class="ct-note">There is a camp behind all this, too: close the City with the X and keep it alive. What you buy here reaches its stores.</p>';
    return sheet('Crier Wes\u2019s errands', n + ' of ' + ERRANDS.length + ' done', h, '<button class="btn small" data-ct="bz-open" data-k="bz:board">Who pays best?</button><button class="btn small" data-ct="bz-open" data-k="bz:ledger">The ledger</button>');
  }
  /** the discount this player has talked out of a merchant, in hundredths of a percent */
  const offOf = id => { const m = viewOf(id), h = m && player && player.haggles && player.haggles.find(x => x.merchant === m.chainId); return h && Number(h.until) > nowMs() ? Number(h.off_bp) : 0; };
  /** what a talked-down trade comes to: the contract's own sum (take_haggle), so the button says what the trade will pay. It stops at the merchant's own price */
  const bidAt = (g, q, off, till) => { const b = bidOf(g, q); if (!off) return b; const c = R.curveSell(g.raw.base, g.raw.target, g.raw.stock, q), room = c > b ? c - b : 0n, left = BigInt(Math.max(0, Math.floor(till - Number(b)))); let up = (b * BigInt(off)) / 10000n; if (up > room) up = room; if (up > left) up = left; return b + up; };
  const askAt = (g, q, off) => { const a = askOf(g, q); if (a === null || !off) return a; const c = R.curveBuy(g.raw.base, g.raw.target, g.raw.stock, q), d = a - (a * BigInt(off)) / 10000n; return d > c ? d : c; };
  const unitAsk = g => Number(R.unitPrice(g.base, g.target, g.stock)) * (1 + (g.spread / 2 + Number(g.raw.buy_heat || 0)) / 10000);
  const unitBid = g => Number(R.unitPrice(g.base, g.target, g.stock)) * (1 - (g.spread / 2 + Number(g.raw.sell_heat || 0)) / 10000);

  /** a stall that has just gone broke says so; a new thought is said aloud */
  function reactToChanges() {
    for (const m of market.state.merchants) {
      const id = m.id.split('.')[0]; if (wasOpen[id] === true && !m.open) floaters.push({ stall: id, text: 'Closed!', col: '#ff6a5a', t: performance.now() / 1000 });
      wasOpen[id] = m.open; const d = (market.decisions || []).find(x => x.merchant === m.id); if (d && lastDecisionSeen[id] !== undefined && lastDecisionSeen[id] !== d.id) pendingSay.push(id); if (d) lastDecisionSeen[id] = d.id;
    }
  }
  const pendingSay = [];

  // ── trading ──
  function campHas(token) { return typeof G !== 'undefined' && G && G.res ? Math.floor(G.res[token] || 0) : 0; }
  function campRoom(token) { try { return Math.max(0, Math.floor(Works.capFor(token) - (G.res[token] || 0))); } catch (e) { return 0; } }
  const addFloat = (id, text, col) => floaters.push({ stall: id, text, col: col || '#ffe08a', t: performance.now() / 1000 });
  /** the chain's refusals are short, for the record: said to a player, they are sentences */
  const plainWord = w => { const said = { 'the till cannot pay that': 'That is more than this till will pay: a merchant keeps some gold back. Try a smaller lot, or another stall.', 'the price moved': 'The price moved while you were deciding. Look at it again.', 'you have not got that many': 'You have not got that many.', 'that stall is closed': 'That stall has its shutters down.', 'not enough gold': 'You have not got the gold for that.', 'too late': 'That took too long and the offer ran out. Try it again.', 'already seen': 'That one has already gone through.', 'over the steward\'s limit': 'That is over the limit you gave your Steward.' }; if (!w) return 'The market refused that.'; return said[w] || (/[.!?]$/.test(w) ? w : w[0].toUpperCase() + w.slice(1) + '.'); };
  /** send one intent; the camp's goods have already left, and come back if the market says no */
  async function send(actions, brings, onFail) {
    busy = true; if (typeof City !== 'undefined') City.renderUI();
    await hello(); if (!me) { busy = false; note = lastErr || 'The market is not answering.'; if (onFail) onFail(); return null; }
    const body = { signed: await signed(actions), brings: brings || [] }, SLOW = 'The network is slow just now. It is on its way and will not be lost.', slow = setTimeout(() => { note = SLOW; if (typeof City !== 'undefined') City.renderUI(); }, 6000);
    const j = await post('act', body); busy = false; clearTimeout(slow); if (note === SLOW) note = '';
    if (j.ok) { try { localStorage.setItem(DONE_STORE, '1'); } catch (e) { /* no matter */ } lastTx = j.tx; await readPlayer(); await poll(); settle(); return j; }
    note = plainWord(j.word); if (onFail) onFail(); await readPlayer(); settle(); return null;
  }
  let lastTx = null;
  /** the first tap of a visit can come before the purse has arrived: it waits for it, and says so */
  async function purseArrives() { if (me && player && (player.started || !me.welcomed)) return; busy = true; if (typeof City !== 'undefined') City.renderUI(); await hello(); busy = false; }
  async function sell(id, token, q) {
    await purseArrives(); const m = viewOf(id), g = m && m.goods.find(x => x.token === token); if (!g) return;
    const fromCrates = Math.min(owned(token), q), fromCamp = q - fromCrates; if (fromCamp > campHas(token) && !firstVisit()) { note = 'You have not got that many.'; return; }
    const expect = bidOf(g, q), takeCamp = Math.min(fromCamp, campHas(token)); if (takeCamp > 0) G.res[token] -= takeCamp;
    const j = await send([{ sell: { merchant: m.chainId, token, amount: String(q), min_gold: String((expect * 85n) / 100n) } }], takeCamp > 0 ? [{ token, amount: String(takeCamp) }] : [], () => { if (takeCamp > 0) G.res[token] += takeCamp; });
    if (j) { errand('sell'); if (talk[id]) talk[id].until = 0; const paid = j.result && j.result[0] && j.result[0].gold; note = shortName(id) + ' paid ' + gold(paid) + ' gold for ' + q + ' ' + WORDS[token].toLowerCase() + '.'; addFloat(id, '+' + gold(paid), '#ffe08a'); if (typeof Snd !== 'undefined') { Snd.play('done'); if (Snd.feel) Snd.feel('light'); } }
  }
  async function buy(id, token, q) {
    const m = viewOf(id), g = m && m.goods.find(x => x.token === token); if (!g) return; const cost = askOf(g, q); if (cost === null) { note = (heOrShe[id] === 'she' ? 'She' : 'He') + ' has not got that many.'; return; }
    const ship = Math.min(q, campRoom(token)), actions = [{ buy: { merchant: m.chainId, token, amount: String(q), max_gold: String((cost * 115n) / 100n) } }]; if (ship > 0) actions.push({ ship: { token, amount: String(ship) } });
    const j = await send(actions, []);
    if (j) { if (talk[id]) talk[id].until = 0; if (ship > 0) G.res[token] = (G.res[token] || 0) + ship; const paid = j.result && j.result[0] && j.result[0].gold; note = q + ' ' + WORDS[token].toLowerCase() + ' for ' + gold(paid) + ' gold: ' + (ship >= q ? 'a caravan takes it all to your camp.' : ship > 0 ? ship + ' go to your camp, the rest wait in your crates here.' : 'your camp has no room, so it waits in your crates here.'); addFloat(id, '−' + gold(paid), '#ffb08a'); if (typeof Snd !== 'undefined') Snd.play('done'); }
  }
  /** whatever is in the crates goes home to the camp, as far as the stores have room */
  async function sendHome() {
    const list = Object.keys(R.GOODS).map(t => [t, Math.min(owned(t), campRoom(t))]).filter(x => x[1] > 0); if (!list.length) { note = 'Your camp has no room for what is in the crates.'; return; }
    const j = await send(list.map(([token, n]) => ({ ship: { token, amount: String(n) } })), []); if (j) { for (const [t, n] of list) G.res[t] = (G.res[t] || 0) + n; note = 'A caravan takes ' + list.map(([t, n]) => n + ' ' + WORDS[t].toLowerCase()).join(', ') + ' to your camp.'; if (typeof Snd !== 'undefined') Snd.play('done'); }
  }
  /** a player talks to a merchant */
  const talk = {};
  async function signedAsk(label) { const ts = Date.now(), s = keySeed(), pub = await NobleEd25519.getPublicKeyAsync(s), sig = await NobleEd25519.signAsync(new TextEncoder().encode(label + '|' + me.account + '|' + ts), s); return { account: me.account, ts, pub: 'ed25519:' + b58(pub), sig: b64(sig) }; }
  async function haggle(id, words) {
    await hello(); if (!me || !words) return; const t = talk[id] = Object.assign(talk[id] || {}, { waiting: true, said: words }); if (typeof City !== 'undefined') City.renderUI();
    const j = await post('haggle', Object.assign(await signedAsk('haggle'), { merchant: id, words })); t.waiting = false;
    if (j.ok) { t.answer = j.say; t.off = j.off; t.model = j.model; t.signed = j.signed; t.until = j.off ? Date.now() + 300000 : 0; t.asked = j.asked; if (j.off && typeof Snd !== 'undefined') Snd.play('done'); if (j.off > 0) errand('talk'); if (TRICK.test(words)) errand('trick'); await readPlayer(); await poll(); } else t.answer = j.word || 'He does not seem to hear you.';
  }
  async function invest(id, millis) { const m = viewOf(id); const j = await send([{ invest: { merchant: m.chainId, gold: String(millis) } }], []); if (j) { const r = j.result && j.result[0]; note = r && r.reopened ? 'The shutters go up! ' + shortName(id) + ' is back in business, and you are a partner.' : 'You are a partner in ' + shortName(id) + '’s stall.'; addFloat(id, r && r.reopened ? 'Open!' : 'Partner!', '#a8f0a0'); if (typeof Snd !== 'undefined') Snd.play('done'); } }
  async function collect(id) { const m = viewOf(id); const j = await send([{ collect: { merchant: m.chainId } }], []); if (j) { const paid = j.result && j.result[0] && j.result[0].gold; note = 'Your cut: ' + gold(paid) + ' gold.'; addFloat(id, '+' + gold(paid), '#ffe08a'); if (typeof Snd !== 'undefined') Snd.play('done'); } }

  // ── THE STEWARD: the camp's own AI agent, which the player sends to market with a key of its own and a limit of gold a day. The contract holds it to that limit and to selling, buying and sending home ──
  const STEWARD_EVERY_MS = 150000; let stewardAt = 0, stewardBusy = false, stewardLog = [], stewardLoaded = false;
  const stewardOn = () => !!(player && player.steward);
  /** the camp as the steward is told it */
  function campBrief() {
    const goods = {}; for (const t of Object.keys(R.GOODS)) { let cap = 0; try { cap = Math.floor(Works.capFor(t)); } catch (e) { /* none */ } goods[t] = { have: campHas(t), cap: Number.isFinite(cap) ? cap : 99999 }; }
    let fire = 100, wounded = 0, people = 0; try { people = G.colonists.length; wounded = G.colonists.filter(c => c.down || c.hp < (c.maxHp || 100) * 0.5).length; fire = Math.round(G.fuel) || 0; } catch (e) { /* no camp yet */ }
    return { day: typeof dayNumber === 'function' ? dayNumber() : 1, hour: typeof hourOfDay === 'function' ? Math.floor(hourOfDay()) : 12, night: typeof isNight === 'function' ? isNight() : false, people, wounded, fire: Math.max(0, Math.min(100, fire)), goods, order: stewardOrder() };
  }
  const ORDER_STORE = 'bz_order'; const stewardOrder = () => { try { return localStorage.getItem(ORDER_STORE) || ''; } catch (e) { return ''; } };
  let stewardAgain = false;
  async function hireSteward(millis) {
    await hello(); if (!me) return; let j = null; try { const r = await fetch('/api/bazaar/steward_key?account=' + encodeURIComponent(me.account)); j = await r.json(); } catch (e) { /* said below */ } if (!j || !j.ok) { note = 'The market is not answering.'; return; }
    const done = await send([{ appoint_steward: { key: j.key, gold_per_day: String(millis) } }], []); if (done) { note = 'Your Steward is on the road to the market.'; if (typeof Snd !== 'undefined') Snd.play('done'); for (let i = 0; i < 14 && !stewardOn(); i++) { await new Promise(r => setTimeout(r, 700)); await readPlayer(); } stewardAt = 0; errand('steward'); await stewardVisit(); if (stewardLog.length) note = 'It has been and gone. This is what it did.'; }
  }
  async function dismissSteward() { const done = await send([{ dismiss_steward: {} }], []); if (done) note = 'Your Steward has gone home. Its key opens nothing now.'; }
  /** one visit: the server asks the AI, and the steward's own key signs the trades. What it sold leaves the camp, what it bought comes home */
  async function stewardVisit() {
    if (stewardBusy || !me || !stewardOn() || typeof G === 'undefined' || !G) return; stewardBusy = true; stewardAt = performance.now();
    try {
      const ts = Date.now(), s = keySeed(), pub = await NobleEd25519.getPublicKeyAsync(s), sig = await NobleEd25519.signAsync(new TextEncoder().encode('steward|' + me.account + '|' + ts), s);
      const j = await post('steward', { account: me.account, ts, pub: 'ed25519:' + b58(pub), sig: b64(sig), camp: campBrief() });
      if (j.ok) {
        for (const t of j.trades || []) { if (t.brought > 0) G.res[t.good] = Math.max(0, (G.res[t.good] || 0) - t.brought); if (t.ok && t.ship > 0) G.res[t.good] = (G.res[t.good] || 0) + t.ship; if (t.ok) { const st = STALLS.find(x => x.id === t.merchant); if (st) addFloat(t.merchant, (t.side === 'sell' ? '+' : '\u2212') + gold(t.gold || 0), t.side === 'sell' ? '#ffe08a' : '#ffb08a'); } }
        stewardLog.unshift({ at: Date.now(), id: j.id, say: j.say, why: j.why, model: j.model, signed: j.signed, trades: j.trades || [], tx: j.tx }); stewardLog.length = Math.min(stewardLog.length, 12);
        const did = (j.trades || []).filter(t => t.ok); if (did.length && typeof UI !== 'undefined' && UI.toast) UI.toast('Your Steward: ' + did.map(t => (t.side === 'sell' ? 'sold ' : 'bought ') + t.qty + ' ' + WORDS[t.good].toLowerCase() + (t.side === 'sell' ? ' to ' : ' from ') + cap(t.merchant)).join(', ') + '.');
        try { const A = G.agents; if (A && A.log) { A.log.push({ h: G.hours, seat: 'steward', text: did.length ? 'At the market: ' + did.map(t => (t.side === 'sell' ? 'sold ' : 'bought ') + t.qty + ' ' + WORDS[t.good].toLowerCase()).join(', ') : 'At the market: nothing worth doing', why: j.why, mode: 'auto', ok: true, by: j.model }); if (A.log.length > 80) A.log.shift(); } } catch (e) { /* no log */ }
        await readPlayer(); await poll(); settle();
      } else if (j.error !== 'slow') stewardAt = performance.now() - STEWARD_EVERY_MS + 8000;          // (a visit that did not happen comes again soon, not at the next turn)
    } catch (e) { /* the next visit */ }
    stewardBusy = false; if (typeof City !== 'undefined' && City.isOpen()) City.renderUI(); if (stewardAgain) { stewardAgain = false; stewardVisit(); }
  }
  async function loadStewardLog() { if (stewardLoaded || !me) return; stewardLoaded = true; try { const r = await fetch('/api/bazaar/decisions?merchant=' + encodeURIComponent('steward:' + me.account)), j = await r.json(); if (j.ok && j.decisions.length && !stewardLog.length) { stewardLog = j.decisions.map(d => { let trades = []; try { trades = JSON.parse(d.pulled || '[]'); } catch (e) { /* none */ } return { at: d.at, id: d.id, say: d.say, why: d.why, model: d.model, signed: d.sealed === 2, trades, tx: d.tx }; }); if (typeof City !== 'undefined' && City.isOpen()) City.renderUI(); } } catch (e) { /* later */ } }
  function stewardCard(ctx) {
    const { esc, sheet } = ctx; let h = purseLine(); loadStewardLog();
    if (!stewardOn()) {
      h += `<p class="ct-say">\u201cLeave the trading to me. Tell me how much I may spend, and I will not spend a coin more.\u201d</p><div class="ct-row still bz-plain"><b>Send your Steward to market</b><small>Your camp\u2019s AI agent comes here while you play: it reads your stores and every stall\u2019s prices, sells what would go to waste, and buys what the camp lacks. It has a key of its own, and the market itself holds that key to the limit you set here: it can sell, buy and send goods home, and nothing else.</small></div><div class="ct-sec">Most it may spend in a day</div><div class="bz-btns">${[10000, 30000, 100000].map(x => `<button class="btn small primary" data-ct="bz-hire" data-n="${x}">${gold(x)} gold</button>`).join('')}</div>`;
      return sheet('Your Steward', 'An AI agent on a limit you set', h + liveLine(esc));
    }
    const g0 = player.steward, cap0 = Number(g0.cap), spent = Number(g0.spent);
    h += `<div class="ct-row still bz-plain"><b>On the road, spending up to ${gold(cap0)} gold a day</b><div class="bz-bar"><i style="width:${Math.min(100, Math.round(spent * 100 / Math.max(1, cap0)))}%"></i></div><small>${gold(spent)} spent today, ${g0.trades} trades so far. It comes by every couple of minutes while you play.</small></div>`;
    h += `<div class="ct-sec">Your standing order</div><div class="bz-talk"><input id="bz-order" maxlength="140" value="${esc(stewardOrder())}" placeholder="In your own words: keep the berries, buy metal." autocomplete="off"><button class="btn small primary" data-ct="bz-order">Tell it</button></div><p class="ct-note">It follows your order as far as that is safe for the camp. No order can raise its limit: the market itself holds it to that.</p>`;
    if (stewardLog.length) h += '<div class="ct-sec">What it has done</div>' + stewardLog.slice(0, 6).map(l => { const did = (l.trades || []).filter(t => t.ok); return `<div class="ct-row still bz-plain bz-log"><b>\u201c${esc(l.say || '')}\u201d</b><small>${did.length ? did.map(t => (t.side === 'sell' ? 'Sold ' : 'Bought ') + t.qty + ' ' + WORDS[t.good].toLowerCase() + (t.side === 'sell' ? ' to ' : ' from ') + esc(cap(t.merchant)) + ' for ' + gold(t.gold || 0)).join('. ') + '. ' : 'No trade this time. '}${esc(l.why || '')}<br><span class="bz-model">${l.model === 'rulebook' ? 'By the rulebook' : 'Thought on NEAR AI · ' + esc(l.model || '') + (l.signed ? ' · signed' : '')} · ${ago(l.at)}</span>${l.id && l.model !== 'rulebook' ? ` <button class="bz-link" data-ct="bz-proof" data-n="${l.id}">Proof</button>` : ''}</small></div>`; }).join('');
    else h += `<p class="ct-note">${stewardBusy ? 'It is on its way...' : 'It has not come by yet.'}</p>`;
    return sheet('Your Steward', 'An AI agent on a limit you set', h + liveLine(esc), `<button class="btn small" data-ct="bz-dismiss">Dismiss it</button><button class="btn small primary ${stewardBusy ? 'dim' : ''}" data-ct="bz-visit">${stewardBusy ? 'On its way...' : 'Send it now'}</button>`);
  }

  /** on the Council's tab: what the Steward has been doing at the market */
  function councilCard() {
    const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    const on = stewardOn(), l = stewardLog[0], g0 = on ? player.steward : null;
    return `<div class="card seat ${on ? 'active' : ''} bz-council"><div class="ic">${coin()}</div><div class="tx"><b>${on ? 'At the Grand Market' : 'Send your Steward to market'}</b><small>${on ? `Trading for the camp, up to ${gold(g0.cap)} gold a day (${gold(g0.spent)} spent today).` : 'It gets a key of its own and a spending limit you set. It sells what would go to waste and buys what the camp lacks.'}</small>${l ? `<small class="last">\u201c${esc(l.say)}\u201d</small>` : ''}<div class="seatctl"><button class="btn small primary" data-act="bzmarket">${on ? 'See what it did' : 'Go to the market'}</button></div></div></div>`;
  }

  // ── the room ──
  /** on the way in: bare stalls, the merchants where they can be seen, what each one opens */
  function dress(room, npcs) {
    room.props = room.props.map(p => (/^stall\d$/.test(p[0]) ? [p[0].replace('stall', 'bare'), p[1], p[2], p[3]] : p));
    for (const n of npcs) { const id = (n.name || '').replace('Merchant ', '').toLowerCase(), st = STALLS.find(s => s.id === id); if (st) { n.bz = id; n.x = st.x + 12; n.y = st.y - 15; n.act = 'bz:' + id; n.stand = [st.x + 24, st.y + 14]; } else if (n.greeter) n.act = 'bz:news'; }
    room.greet = { say: 'Seven merchants, {who}, and every one with a mind of their own. Sell what you have, buy what you lack: the prices move as you trade.', ask: [['What can I do here?', 'bz:errands'], ['Your Steward', 'bz:steward'], ['A week in a minute', 'bz:week'], ['Just looking', '']] };
    if (!helloP) hello(); poll();
  }
  // the goods on a counter, drawn once at each size
  const ICON = {
    wood: [['.aaab', 'acccb', '.aaab'], { a: '#9a6638', b: '#d8a868', c: '#7a4e2a' }],
    stone: [['.aab.', 'aaabb', 'caaac'], { a: '#a8b0ba', b: '#d6dce2', c: '#6e7680' }],
    berry: [['.a.b.', 'abcab', '.a.a.'], { a: '#d8344a', b: '#ff7a8a', c: '#7ac83a' }],
    meat: [['.aab', 'aacb', 'aaa.'], { a: '#b84a3a', b: '#f0e0c8', c: '#e88a6a' }],
    metal: [['.bbb.', 'aaaaa', 'ccccc'], { a: '#9aa6b6', b: '#dfe6ee', c: '#5e6a7a' }],
    medicine: [['.b.', 'aca', 'aaa'], { a: '#3aa86a', b: '#e8e0c8', c: '#d8f8e0' }],
  };
  const iconCache = new Map();
  function icon(token, cs) {
    const k = token + cs; let c = iconCache.get(k); if (c) return c; const [rows, pal] = ICON[token], w = rows[0].length, h = rows.length; c = document.createElement('canvas'); c.width = w * cs; c.height = h * cs; const q = c.getContext('2d');
    rows.forEach((r, y) => [...r].forEach((ch, x) => { if (ch === '.') return; q.fillStyle = pal[ch]; q.fillRect(x * cs, y * cs, cs, cs); })); iconCache.set(k, c); return c;
  }
  const FONT = cs => 'bold ' + Math.max(9, Math.round(cs * 3.3)) + 'px Fredoka, system-ui, sans-serif';
  /** one stall: stock on the counter and in crates beside it, prices chalked on the front, the name on its sign; or the shutters */
  function drawStall(c, st) {
    const { g, ox, oy, cs } = c, m = viewOf(st.id); if (!m) return; const X = v => ox + (st.x + v) * cs, Y = v => oy + (st.y - 44 + v) * cs;
    if (!m.open) {
      for (let i = 0; i < 6; i++) { g.fillStyle = i % 2 ? '#6e4a2c' : '#7c5634'; g.fillRect(X(3), Y(14 + i * 4.4), 42 * cs, 4 * cs); g.fillStyle = '#3a2614'; g.fillRect(X(3), Y(14 + i * 4.4 + 3.6), 42 * cs, 0.5 * cs); }
      g.save(); g.translate(X(24), Y(26)); g.rotate(-0.06); g.fillStyle = '#f4e6c8'; g.fillRect(-15 * cs, -4 * cs, 30 * cs, 8 * cs); g.fillStyle = '#c0301f'; g.font = 'bold ' + Math.round(cs * 4.4) + 'px Fredoka, system-ui, sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText('CLOSED', 0, 0.3 * cs); g.restore(); return;
    }
    // what is on the counter: as many as the stock will fill, up to a full counter
    const lines = m.goods, per = Math.floor(14 / lines.length); let col = 0;
    lines.forEach(gd => { const k = gd.stock / Math.max(1, gd.target), n = Math.min(per, Math.ceil(per * Math.min(1, k))); for (let i = 0; i < n; i++) { const ic = icon(gd.token, cs), x = 4 + (col % 7) * 5.8, y = 19.5 + Math.floor(col / 7) * 3.2; g.drawImage(ic, Math.round(X(x)), Math.round(Y(y))); col++; } col += per - n; });
    // the sign, beside the merchant
    g.fillStyle = '#f4ecd8'; g.fillRect(X(23), Y(14.5), 21 * cs, 5.4 * cs); g.fillStyle = '#4a2f1f'; g.font = 'bold ' + Math.round(cs * 3.6) + 'px Fredoka, system-ui, sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText(shortName(st.id), X(33.5), Y(17.3), 20 * cs);
    // the prices, chalked on the front of the counter
    const h = 3.8, top = 40 - 1 - lines.length * h - 0.6; g.fillStyle = '#2a2e2a'; g.fillRect(X(4), Y(top), 40 * cs, (lines.length * h + 1) * cs); g.fillStyle = '#8a6a4a'; g.fillRect(X(4), Y(top), 40 * cs, 0.4 * cs);
    g.font = FONT(cs); g.textBaseline = 'middle';
    lines.forEach((gd, i) => { const y = Y(top + 0.5 + (i + 0.5) * h), usual = R.GOODS[gd.token], p = unitAsk(gd), rel = p / usual; g.drawImage(icon(gd.token, Math.max(1, Math.round(cs * 0.5))), Math.round(X(5.2)), Math.round(y - cs * 0.9)); g.textAlign = 'left'; g.fillStyle = '#f4f0e0'; g.fillText(WORDS[gd.token], X(9), y, 20 * cs); g.textAlign = 'right'; g.fillStyle = rel > 1.35 ? '#ff9a8a' : rel < 0.92 ? '#9ff0a0' : '#ffe9a0'; g.fillText((p / 1000).toFixed(2), X(43), y); });
    // crates of what is over the target, beside the stall; the till's gold on the counter's end
    let cx = 45; lines.forEach(gd => { const over = Math.min(3, Math.floor((gd.stock / Math.max(1, gd.target) - 1.05) * 3)); for (let i = 0; i < over; i++) { g.fillStyle = '#8a6238'; g.fillRect(X(cx), Y(34 - i * 3.4), 4.4 * cs, 3.2 * cs); g.fillStyle = '#b08850'; g.fillRect(X(cx), Y(34 - i * 3.4), 4.4 * cs, 0.6 * cs); g.fillStyle = '#5e3e20'; g.fillRect(X(cx + 2), Y(34 - i * 3.4), 0.5 * cs, 3.2 * cs); } });
    const rich = m.till / Math.max(1, m.startTill), coins = rich > 1.6 ? 5 : rich > 1 ? 3 : rich > 0.4 ? 2 : rich > 0.12 ? 1 : 0; for (let i = 0; i < coins; i++) { g.fillStyle = i % 2 ? '#f0c040' : '#ffd860'; g.fillRect(X(37 + (i % 3) * 2), Y(24.4 - Math.floor(i / 3) * 1.2 - (i % 3 === 1 ? 0.4 : 0)), 2 * cs, 1.2 * cs); }
  }
  /** which merchant's stall is at this point of the room */
  const stallAt = (x, y) => { const st = STALLS.find(s => x >= s.x && x <= s.x + 48 && y >= s.y - 44 && y <= s.y + 2); return st ? st.id : null; };
  /** everything the room adds to the picture */
  /** the latest news on a cloth strung across the wall, one line at a time */
  let bannerI = 0, bannerAt = 0;
  const headlines = () => { const out = []; if (market) { const ev = market.state.event; if (ev && R.EVENTS[ev.index]) out.push(R.EVENTS[ev.index][3] + '!'); for (const n of (market.news || []).slice(0, 8)) { const t = newsText(n); if (t && !out.includes(t)) out.push(t); } } return out; };
  function drawBanner(c, now) {
    const list = headlines(); if (!list.length || week) return; if (now - bannerAt > 6) { bannerAt = now; bannerI++; } const { g, cs, W, top, ox } = c, text = list[bannerI % list.length], x0 = Math.max(Math.round(cs * 2), Math.round(ox + cs * 4)), x1 = Math.min(W - Math.round(cs * 2), Math.round(ox + cs * 204)), y = (top || 0) + Math.round(cs * 3), h = Math.round(cs * 8);
    g.save(); g.fillStyle = '#3a2614'; g.fillRect(x0 + cs, y - cs * 3, cs, cs * 3); g.fillRect(x1 - cs * 2, y - cs * 3, cs, cs * 3); g.fillStyle = '#7a5230'; g.fillRect(x0, y + h, x1 - x0, cs); g.fillStyle = '#f4e6c8'; g.fillRect(x0, y, x1 - x0, h); g.fillStyle = '#d8c49a'; g.fillRect(x0, y + h - cs, x1 - x0, cs);
    g.fillStyle = '#3a2614'; g.font = 'bold ' + Math.round(cs * 4.2) + 'px Fredoka, system-ui, sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle'; let t = text; const room = x1 - x0 - cs * 6; if (g.measureText(t).width > room) { g.font = 'bold ' + Math.round(cs * 3.5) + 'px Fredoka, system-ui, sans-serif'; while (t.length > 8 && g.measureText(t + '...').width > room) t = t.slice(0, -1); if (t !== text) t += '...'; }
    g.globalAlpha = Math.min(1, (now - bannerAt) / 0.35); g.fillText(t, (x0 + x1) / 2, y + h / 2); g.restore();
  }
  /** a deal between two merchants is carried across the street, round the stalls and not through them */
  let porters = [], dealsSeen = null;
  const frontOf = st => ({ x: st.x + 24, y: st.y + 18 });
  function dealsArrive() {
    const list = ((market && market.news) || []).filter(n => n.kind === 'deal'), keyOf = n => n.id || n.at; if (dealsSeen === null) { dealsSeen = new Set(list.map(keyOf)); return; }
    for (const n of list.slice().reverse()) { const k = keyOf(n); if (dealsSeen.has(k)) continue; dealsSeen.add(k); if (Date.now() - Number(n.at) > 180000) continue; const d = n.data || {}, from = STALLS.find(s => s.id === String(d.seller).split('.')[0]), to = STALLS.find(s => s.id === String(d.buyer).split('.')[0]); if (!from || !to) continue; const a = frontOf(from), b = frontOf(to), lane = (a.x + b.x) / 2 < 104 ? 76 : 130, path = a.y === b.y ? [a, b] : [a, { x: lane, y: a.y }, { x: lane, y: b.y }, b]; porters.push({ path, i: 0, x: a.x, y: a.y, born: performance.now() / 1000, token: d.token, qty: d.amount, to: to.id, from: from.id, n: null }); addFloat(from.id, '\u2212' + d.amount + ' ' + WORDS[d.token].toLowerCase(), '#ffd9a8'); }
  }
  function drawPorters(c, now) {
    const dt = Math.min(0.1, now - (drawPorters.at || now)); drawPorters.at = now;
    for (const p of porters) {
      const q = p.path[p.i + 1]; if (q) { const dx = q.x - p.x, dy = q.y - p.y, d = Math.hypot(dx, dy), m = 24 * dt; if (d <= m) { p.x = q.x; p.y = q.y; p.i++; } else { p.x += dx / d * m; p.y += dy / d * m; } }
      if (!p.n) { p.n = c.actor(960 + porters.indexOf(p), 'trader', p.x, p.y, 3 + (p.qty % 5)); p.n.moving = true; }
      const n = p.n, g2 = p.path[p.i + 1]; if (g2) { const dx = g2.x - p.x, dy = g2.y - p.y; n.face = Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? 'E' : 'W') : (dy > 0 ? 'S' : 'N'); n.ang = Math.atan2(dy, dx); } n.x = p.x; n.y = p.y; n.at = now * 1.0; n.moving = !!g2;
      c.put(p.y, () => { const sp = c.figure(n, c.ox + p.x * c.cs, c.oy + p.y * c.cs, 3), ic = icon(p.token, c.cs), h = (sp && sp.h) || c.cs * 16; c.g.drawImage(ic, Math.round(c.ox + p.x * c.cs - ic.width / 2), Math.round(c.oy + p.y * c.cs - h - ic.height)); });
      if (!g2 && !p.done) { p.done = now; addFloat(p.to, '+' + p.qty + ' ' + WORDS[p.token].toLowerCase(), '#c8ffb0'); }
    }
    porters = porters.filter(p => !p.done || now - p.done < 1.2);
  }
  function draw(c) {
    if (!market && !week) return; for (const st of STALLS) c.put(st.y + 0.02, () => drawStall(c, st));
    if (!week) { dealsArrive(); drawPorters(c, performance.now() / 1000); }
    const now = performance.now() / 1000; floaters = floaters.filter(f => now - f.t < 2.2);
    c.after(() => { const { g, ox, oy, cs } = c; drawBanner(c, now); for (const f of floaters) { const st = STALLS.find(s => s.id === f.stall); if (!st) continue; const k = (now - f.t) / 2.2; g.globalAlpha = Math.min(1, (1 - k) * 2); g.font = 'bold ' + Math.round(cs * 6) + 'px Fredoka, system-ui, sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle'; g.lineWidth = Math.max(2, cs * 0.9); g.strokeStyle = '#3a2614'; const x = ox + (st.x + 24) * cs, y = oy + (st.y - 34 - k * 16) * cs; g.strokeText(f.text, x, y); g.fillStyle = f.col; g.fillText(f.text, x, y); g.globalAlpha = 1; } });
  }
  /** what a merchant says when its AI has not spoken: what its shelves and its till would say */
  function shelfTalk(m) {
    const low = m.goods.slice().sort((a, b) => a.stock / a.target - b.stock / b.target)[0], high = m.goods.slice().sort((a, b) => b.stock / b.target - a.stock / a.target)[0], w = m.till / Math.max(1, m.startTill);
    if (w < 0.25) return 'The rent is coming, and the till is light.'; if (low.stock / low.target < 0.55) return WORDS[low.token] + (low.token === 'berry' ? ' are' : ' is') + ' short. It will cost you.'; if (high.stock / high.target > 1.3) return 'Too much ' + WORDS[high.token].toLowerCase() + '. A good price, today only.'; if (w > 1.6) return 'A good week. Come, look.'; return 'Fair prices, fresh from the caravans.';
  }
  /** every frame in the room: the market is read now and then, and the merchants speak */
  function tick(now, npcs, bubbles) {
    if (!week && performance.now() - pollAt > 6000) poll();
    if (week) weekStep();
    if (now - sayAt < 6.5) return; sayAt = now; let id = pendingSay.shift(); if (!id) { sayI = (sayI + 1) % STALLS.length; id = STALLS[sayI].id; }
    if (sayI === 3 && !pendingSay.length) { const wes = npcs.find(x => x.greeter), ev = market && market.state.event; if (wes && ev && R.EVENTS[ev.index] && !week) { bubbles.push({ who: wes, text: R.EVENTS[ev.index][3] + '!', until: now + 5.5, h: 22 }); return; } }
    const m = viewOf(id), n = npcs.find(x => x.bz === id); if (!m || !n) return; let text = m.say || shelfTalk(m); if (!m.open) text = 'I could not pay the rent...'; bubbles.push({ who: n, text: text.length > 56 ? text.slice(0, 54) + '...' : text, until: now + 5.5, h: 22 });
  }

  // ── the cards ──
  const spark = (id, token, usual) => {
    const rows = (market && market.history) || [], pts = []; for (const r of rows) { const m = r.data.m.find(x => x.i === id), g = m && m.g.find(x => x[0] === token); if (g) pts.push(Number(R.unitPrice(g[3], g[2], g[1])) / usual); } if (pts.length < 3) return '';
    const W = 70, H = 18, lo = Math.min(...pts), hi = Math.max(...pts), span = Math.max(0.05, hi - lo), d = pts.map((v, i) => (i * W / (pts.length - 1)).toFixed(1) + ',' + (H - 1 - (v - lo) / span * (H - 2)).toFixed(1)).join(' ');
    return `<svg class="bz-spark" viewBox="0 0 ${W} ${H}" aria-hidden="true"><polyline points="${d}" fill="none" stroke="${COLOUR[token]}" stroke-width="1.6" stroke-linejoin="round" stroke-linecap="round"/></svg>`;
  };
  const purseLine = () => { if (!player) return '<div class="ct-purse bz-purse"><small>Your purse and crates are on the road from your camp...</small></div>'; const g0 = owned('gold'), crates = Object.keys(R.GOODS).filter(t => owned(t) > 0).map(t => owned(t) + ' ' + WORDS[t].toLowerCase()); return `<div class="ct-purse bz-purse"><b>${coin()}${gold(g0)}</b><small>gold at the market${crates.length ? ' · in your crates: ' + crates.join(', ') : ''}</small>${crates.length && Object.keys(R.GOODS).some(t => owned(t) > 0 && campRoom(t) > 0) ? '<button class="btn small" data-ct="bz-home">Send home</button>' : ''}</div>`; };
  let noteSeen = '', noteSeenAt = 0;
  const liveLine = esc => { if (note !== noteSeen) { noteSeen = note; noteSeenAt = Date.now(); } if (note && Date.now() - noteSeenAt > 9000) note = ''; const n = note || lastErr; return n ? `<p class="ct-note ct-live bz-live${lastErr && !note ? ' bz-bad' : ''}">${esc(n)}</p>` : (busy ? '<p class="ct-note ct-live bz-live">One moment...</p>' : ''); };
  const lots = () => `<div class="seg bz-lots">${[[1, 'x1'], [5, 'x5'], [20, 'x20']].map(([n, l]) => `<button class="${lotMul === n ? 'on' : ''}" data-ct="bz-lot" data-n="${n}">${l}</button>`).join('')}</div>`;
  function merchantCard(id, ctx) {
    const { esc, sheet } = ctx, m = viewOf(id), def = R.MERCHANTS.find(d => d.id === id); if (!m) return sheet(def.name, 'Reading the ledger...', `<p>One moment.</p>${liveLine(esc)}`);
    const d = market.decisions && market.decisions.find(x => x.merchant === m.chainId), she = heOrShe[id] === 'she', He = she ? 'She' : 'He', his = she ? 'her' : 'his', him = she ? 'her' : 'him';
    let h = purseLine() + (m.say ? `<p class="ct-say">“${esc(m.say)}”</p>` : '');
    if (d) h += `<p class="ct-note bz-why">${esc(d.why || '')}<br><span class="bz-model">Thought on NEAR AI · ${esc(d.model || '')}${d.sealed ? ' · <b>sealed</b>' : ''} · ${ago(d.at)}</span> <button class="bz-link" data-ct="bz-proof" data-n="${d.id}">Why trust this?</button></p>`;
    else h += `<p class="ct-note bz-why">${He} is following ${his} rulebook for now.</p>`;
    if (!m.open) {
      const reopen = R.CONFIG.reopen_millis, low = Math.max(reopen - m.till, 1000), good = Math.max(reopen + R.CONFIG.rent_millis - m.till, 10000), purse = owned('gold'), put = purse >= good ? good : low, can = purse >= put;
      h += `<div class="bz-shut"><b>${esc(shortName(id))} could not pay the rent, and the shutters are down.</b><p>${He} still holds ${m.goods.map(g => g.stock.toLocaleString('en') + ' ' + WORDS[g.token].toLowerCase()).join(' and ')}. Put ${gold(put)} gold in ${his} till and ${she ? 'she' : 'he'} opens again${put === good ? ', with enough for the next rent' : ', though not with the next rent'}. Goods behind a shutter are worth little, so your gold buys a big share of the stall.</p>${stakePreview(m, put)}<button class="btn small primary ${can ? '' : 'dim'}" data-ct="bz-invest" data-k="${id}" data-n="${put}">${can ? 'Rescue ' + esc(shortName(id)) : 'You need ' + gold(put) + ' gold'}</button><p class="ct-note">If nobody comes, the richest merchant on the street lends the money after a day, and the chance is gone.</p></div>`;
    } else {
      const off = offOf(id), offCls = off ? ' class="bz-off"' : '';
      h += `<div class="ct-sec">Trade ${lots()}</div>`;
      if (off) h += `<p class="ct-note ct-live bz-offnote">${(off / 100).toFixed(off % 100 ? 1 : 0)}% off from ${esc(shortName(id))} is in these prices, for your next trade here.</p>`;
      for (const g of m.goods) {
        const q = LOT[g.token] * lotMul, have = campHas(g.token) + owned(g.token), a = askAt(g, BigInt(q), off), b = bidAt(g, BigInt(q), off, m.till), tillOk = Number(bidOf(g, BigInt(q))) + Math.floor((m.startTill * def.care) / 400) <= m.till, cantSell = have < q && !firstVisit() ? 'You have ' + have : !tillOk ? 'Till too low' : '', cantBuy = a === null ? 'Only ' + g.stock + ' left' : a > BigInt(owned('gold')) ? 'Need ' + gold(a) + ' gold' : '';
        h += `<div class="ct-row still bz-good"><span class="bz-ico" style="--c:${COLOUR[g.token]}"></span><div class="bz-g"><b>${WORDS[g.token]}</b><small>${esc(shortName(id))} holds ${g.stock.toLocaleString('en')}, wants about ${g.target.toLocaleString('en')} · you have ${have.toLocaleString('en')}</small></div>${spark(id, g.token, R.GOODS[g.token])}<div class="bz-btns"><button class="btn small ${cantSell ? 'dim' : ''}" data-ct="bz-sell" data-k="${id}" data-t="${g.token}" data-n="${q}">${cantSell || `Sell ${q}<em${offCls}>+${gold(b)}</em>`}</button><button class="btn small ${cantBuy ? 'dim' : ''}" data-ct="bz-buy" data-k="${id}" data-t="${g.token}" data-n="${q}">${cantBuy || `Buy ${q}<em${offCls}>−${gold(a)}</em>`}</button></div></div>`;
      }
      { const t = talk[id] || {}, live = t.until && t.until > Date.now(); h += `<div class="ct-sec">Talk to ${esc(shortName(id))}</div><div class="bz-talk"><input id="bz-words" maxlength="200" placeholder="Say anything. Try to get a better price." autocomplete="off"><button class="btn small primary ${t.waiting ? 'dim' : ''}" data-ct="bz-say" data-k="${id}">${t.waiting ? '...' : 'Say'}</button></div>${t.said ? `<p class="ct-note bz-said">You: “${esc(t.said)}”</p>` : ''}${t.waiting ? `<p class="ct-note ct-live">${esc(shortName(id))} thinks it over...</p>` : t.answer ? `<p class="ct-say">“${esc(t.answer)}”</p>${live ? `<p class="ct-note ct-live">${t.off >= (t.asked || 0) ? t.off + '% off' : 'Asked to give ' + t.asked + '%, the market let ' + (she ? 'her' : 'him') + ' give ' + t.off + '%'} on your next trade here, within five minutes. Never below ${his} own price.</p>` : ''}` : ''}`; }
      h += `<div class="ct-sec">${esc(shortName(id))}’s stall</div><div class="ct-row still bz-till"><b>${gold(m.till)} gold in the till</b><small>The rent at dawn is ${gold(R.CONFIG.rent_millis)}. ${he(m, id)}</small></div>`;
      const part = player && player.partners.find(p => p.merchant === m.chainId), one = 10000, chips = [10000, 50000, 200000].filter(x => x <= Math.max(owned('gold'), one));
      if (part) { const pct = Number(BigInt(part.shares) * 10000n / BigInt(part.of)) / 100; h += `<div class="ct-row still bz-plain bz-part"><b>You hold ${pct.toFixed(pct < 1 ? 2 : 1)}% of this stall</b><small>Half of the margin on every trade goes out by shares. Your cut so far: ${gold(part.due)} gold.</small><div class="bz-btns"><button class="btn small ${Number(part.due) > 0 ? 'primary' : 'dim'}" data-ct="bz-collect" data-k="${id}">${Number(part.due) > 0 ? 'Collect ' + gold(part.due) + ' gold' : 'Nothing to collect yet'}</button></div></div>`; }
      h += `<div class="ct-row still bz-plain bz-part"><b>${part ? 'Put more in' : 'Become a partner'}</b><small>Your gold goes in ${his} till and buys a share of what ${she ? 'she' : 'he'} is worth. If ${she ? 'she' : 'he'} prospers, so do you. If ${she ? 'she' : 'he'} breaks, it is gone.</small><div class="bz-btns">${chips.map(x => `<button class="btn small ${owned('gold') >= x ? '' : 'dim'}" data-ct="bz-invest" data-k="${id}" data-n="${x}">${owned('gold') >= x ? gold(x) + ' gold' : 'Need ' + gold(x)}</button>`).join('')}</div></div>`;
    }
    return sheet(esc(def.name), esc(cap(def.about)), h + liveLine(esc));
  }
  const cap = s => s.charAt(0).toUpperCase() + s.slice(1);
  const he = (m, id) => { const w = m.till / Math.max(1, m.startTill), H = heOrShe[id] === 'she' ? 'She' : 'He'; return w > 1.5 ? H + ' is doing well.' : w > 0.6 ? H + ' is holding steady.' : w > 0.2 ? H + ' is getting short of gold.' : H + ' is close to breaking.'; };
  const stakePreview = (m, gold0) => { const worth = m.goods.reduce((a, g) => a + (g.stock * g.base * R.CONFIG.closed_goods_bp) / 10000, m.till), total = Number(m.founder + m.partners), s = gold0 * total / Math.max(1, worth), pct = 100 * s / (total + s); return `<p class="ct-note">At what the stall is worth today, that makes you a partner with about ${pct.toFixed(0)}% of it, and a share of every trade it makes from then on.</p>`; };
  /** who pays best, who sells cheapest, for everything */
  function boardCard(ctx) {
    const { esc, sheet } = ctx; if (!market) return sheet('The board', '', `<p>Reading the ledger...</p>${liveLine(esc)}`); let h = purseLine() + '<p class="ct-note">The best price for each good, right now. Tap a name and the hero walks over.</p>';
    for (const t of Object.keys(R.GOODS)) {
      let bestB = null, bestA = null; for (const st of STALLS) { const m = viewOf(st.id); if (!m || !m.open) continue; const g = m.goods.find(x => x.token === t); if (!g) continue; const a = unitAsk(g), b = unitBid(g); if (!bestA || a < bestA.p) bestA = { p: a, id: st.id }; if (!bestB || b > bestB.p) bestB = { p: b, id: st.id }; }
      const w = market.state.world.find(x => x.token === t), rel = Number(w.world) / R.GOODS[t];
      h += `<div class="ct-row still bz-board"><span class="bz-ico" style="--c:${COLOUR[t]}"></span><div class="bz-g"><b>${WORDS[t]}</b><small>In the world it is ${rel > 1.1 ? 'dear' : rel < 0.9 ? 'cheap' : 'at its usual price'}. You have ${(campHas(t) + owned(t)).toLocaleString('en')}.</small></div>${spark(bestA ? bestA.id : '', t, R.GOODS[t])}<div class="bz-btns">${bestB ? `<button class="btn small" data-ct="bz-go" data-k="${bestB.id}">${esc(shortName(bestB.id))} pays <em>${(bestB.p / 1000).toFixed(2)}</em></button>` : ''}${bestA ? `<button class="btn small" data-ct="bz-go" data-k="${bestA.id}">${esc(shortName(bestA.id))} sells <em>${(bestA.p / 1000).toFixed(2)}</em></button>` : ''}</div></div>`;
    }
    return sheet('Who pays best', 'Crier Wes’s board', h + liveLine(esc));
  }
  function newsText(n) {
    const d = n.data || {}; switch (n.kind) {
      case 'event': return R.EVENTS[d.index] ? R.EVENTS[d.index][3] + '.' : 'News from the world.';
      case 'event_end': return R.EVENTS[d.index] ? 'That has passed: ' + R.EVENTS[d.index][3].toLowerCase() + '.' : 'Things have settled.';
      case 'broke': return nameOf(d.merchant) + ' could not pay the rent. The stall is shut.';
      case 'lend': return (d.from === 'city' ? 'The City' : nameOf(d.from)) + ' lent ' + nameOf(d.merchant) + ' ' + gold(d.gold) + ' gold to open again.';
      case 'repaid': return nameOf(d.merchant) + ' paid back ' + (d.from === 'city' ? 'the City' : nameOf(d.from)) + ': ' + gold(d.gold) + ' gold.';
      case 'mishap': return 'A bad day at ' + nameOf(d.merchant) + '’s stall: ' + d.lost + ' ' + (WORDS[d.token] || d.token).toLowerCase() + ' lost.';
      case 'deal': return nameOf(d.buyer) + ' bought ' + d.amount + ' ' + (WORDS[d.token] || d.token).toLowerCase() + ' from ' + nameOf(d.seller) + '.';
      case 'invest': return d.reopened ? 'A traveller rescued ' + nameOf(d.merchant) + ' with ' + gold(d.gold) + ' gold: the shutters are up!' : 'A traveller put ' + gold(d.gold) + ' gold into ' + nameOf(d.merchant) + '’s stall.';
      case 'attested': return 'A new secure machine has been checked and added to the ledger.';
      default: return '';
    }
  }
  function newsCard(ctx) {
    const { esc, sheet, uic } = ctx; let h = '';
    if (market) { const ev = market.state.event; if (ev && R.EVENTS[ev.index]) h += `<p class="ct-say">“${esc(R.EVENTS[ev.index][3])}!”</p>`; else h += '<p class="ct-say">“All quiet on the roads today.”</p>'; const list = (market.news || []).map(n => [n, newsText(n)]).filter(x => x[1]).slice(0, 12); h += list.length ? `<div class="ct-sec">The latest</div><div class="bk-led bz-news">${list.map(([n, t]) => `<div><span>${esc(t)}</span><small>${ago(n.at)}</small></div>`).join('')}</div>` : '<p class="ct-note">Nothing has happened yet today.</p>'; }
    return sheet('Crier Wes', 'The news of the market', h + liveLine(esc), `<button class="btn small" data-ct="bz-open" data-k="bz:steward">Your Steward</button><button class="btn small primary" data-ct="bz-open" data-k="bz:week">A week in a minute</button><button class="btn small" data-ct="bz-open" data-k="bz:ledger">The ledger</button>`);
  }
  /** for anyone who wants to look under the floor */
  function ledgerCard(ctx) {
    const { esc, sheet } = ctx; if (!market) return sheet('The ledger', '', `<p>Reading it...</p>${liveLine(esc)}`); const st = market.state, ex = market.explorer, link = (a, t) => `<a href="${esc(ex)}/address/${esc(a)}" target="_blank" rel="noopener">${esc(t || a)}</a>`, sealed = st.merchants.reduce((a, m) => a + m.sealed, 0), all = st.merchants.reduce((a, m) => a + m.decisions, 0), pulled = st.merchants.reduce((a, m) => a + m.pulled, 0);
    let h = `<p class="ct-say">“It is all written down, traveller, where no one can change it.”</p>
      <div class="ct-row still bz-plain"><b>${st.trades.toLocaleString('en')} trades</b><small>This market runs on NEAR${market.network === 'testnet' ? '’s test network, so nothing here is worth real money' : ''}: ${link(market.market)}. You never paid a fee: the game pays them.</small></div>
      <div class="ct-row still bz-plain"><b>${(Number(st.gold_supply) / 1000).toLocaleString('en')} gold, for ever</b><small>Nothing in the contract can make more, not even its owner. Gold only moves, between the tills, the treasury and the players.</small></div>
      <div class="ct-row still bz-plain"><b>${all.toLocaleString('en')} decisions by the merchants</b><small>Each merchant has its own wallet (${link(st.merchants[0].id, 'here is ' + shortName(st.merchants[0].id) + '’s')}) and its own AI. ${sealed.toLocaleString('en')} of those decisions carry a seal: NEAR AI’s secure hardware signed exactly what it was asked and what it answered, and the contract itself checked the signature. Nobody can put words in a merchant’s mouth, the game’s owner included.</small></div>
      <div class="ct-row still bz-plain"><b>The leash has pulled ${pulled.toLocaleString('en')} times</b><small>A merchant’s key can only reach the market. Whatever its AI asks for, the contract cuts to what the rules allow: 20% on a price in a day, a set budget for caravans, and no way at all to send gold to anyone.</small></div>`;
    if (me) h += `<div class="ct-row still bz-plain"><b>Your account</b><small>${link(me.account, me.account.slice(0, 10) + '...' + me.account.slice(-6))}. Its key was made on this device and ${window.Telegram && Telegram.WebApp && Telegram.WebApp.initData ? 'follows your Telegram account' : 'stays here'}. No wallet, no seed phrase.</small></div>`;
    const ds = (market.decisions || []).slice().sort((a, b) => b.at - a.at).slice(0, 7); if (ds.length) h += '<div class="ct-sec">What they last decided</div>' + ds.map(d => `<div class="ct-row still bz-dec"><b>${esc(shortName(d.merchant))}</b><small>“${esc(d.say || '')}” · ${ago(d.at)}${d.sealed ? ' · sealed' : ''}</small><button class="btn small" data-ct="bz-proof" data-n="${d.id}">Proof</button></div>`).join('');
    return sheet('The ledger', 'Under the floor of the market', h + liveLine(esc));
  }
  function proofCard(id, ctx) {
    const { esc, sheet } = ctx, d = decisionCache[id]; if (!d) { fetch('/api/bazaar/decision?id=' + id).then(r => r.json()).then(j => { if (j.ok) { decisionCache[id] = j.decision; City.renderUI(); } }).catch(() => {}); return sheet('The proof', '', '<p>Reading it from the record...</p>'); }
    let say = '', pulled = []; try { pulled = JSON.parse(d.pulled || '[]'); } catch (e) { /* none */ }
    let user = ''; try { user = JSON.parse(d.request).messages[1].content; } catch (e) { /* none */ } let answer = ''; try { answer = JSON.parse(d.response).choices[0].message.content; } catch (e) { /* none */ }
    const ex = market ? market.explorer : '';
    say += `<p class="ct-say">“${esc(d.say || '')}”</p><p class="ct-note">${esc(d.why || '')}</p>`;
    say += d.sealed ? `<div class="ct-row still bz-plain bz-seal"><b>Sealed</b><small>This answer came from <b>${esc(d.model)}</b> inside secure hardware. The hardware signed exactly what was asked and what it answered. The market contract checked that signature itself before it changed a single price, so nobody in between could have edited it.</small></div>` : `<div class="ct-row still bz-plain"><b>Not sealed</b><small>${esc(d.model || 'The AI')} gave no signature for this answer. The leash held it just the same.</small></div>`;
    if (pulled.length) say += `<div class="ct-row still bz-plain"><b>The leash pulled</b><small>${pulled.map(p => esc(WORDS[p.good] || p.good) + ': asked for ' + esc(p.asked) + ' ' + esc(p.wanted) + ', allowed ' + esc(p.allowed)).join('; ')}.</small></div>`;
    say += `<div class="ct-sec">What ${esc(shortName(d.merchant))} was told</div><pre class="bz-pre">${esc(user)}</pre><div class="ct-sec">What the AI answered</div><pre class="bz-pre">${esc(answer)}</pre>`;
    if (d.signature) say += `<div class="ct-sec">The signature</div><pre class="bz-pre">${esc(d.sig_text)}\n${esc(d.signature)}\nsigned by ${esc(d.signer)}</pre>`;
    if (d.tx && ex) say += `<p class="ct-note"><a href="${ex}/txns/${esc(d.tx)}" target="_blank" rel="noopener">See it on the chain</a></p>`;
    return sheet('The proof', esc(shortName(d.merchant)) + ' · ' + ago(d.at), say);
  }

  // ── A WEEK IN A MINUTE: the same market with no chain under it, run fast, so you can watch an economy move ──
  let week = null;
  const WEEK_SEED = 2, WEEK_DAYS = 7, WEEK_SECONDS = 60, WEEK_CAMPS = 8;
  const SAYS = {
    event: ['Did you hear? Prices will move.', 'News from the roads!', 'I knew it. Check your stock.'], broke: ['I could not pay the rent...', 'Shut. Just like that.'], lend: ['A loan. Bless them.', 'Back open, on borrowed gold.'], mishap: ['A fire! My stock!', 'Thieves in the night!', 'Rats got into it.'], rich: ['A good day. A very good day.', 'The till is heavy tonight.'], poor: ['Quiet. Too quiet.', 'I need customers.', 'The rent is coming...'], dear: ['Sorry friend, it is scarce.', 'If you can find it cheaper, go.'], cheap: ['Take it! I have too much.', 'Everything must go.'],
  };
  function weekStart() {
    errand('week');
    if (week) return; const s = MarketSim.create(WEEK_SEED); week = { s, campRnd: R.lcg(WEEK_SEED ^ 0x5bd1e995), acc: Object.fromEntries(Object.keys(R.GOODS).map(t => [t, 0])), says: {}, hist: Object.fromEntries(Object.keys(R.GOODS).map(t => [t, []])), start: performance.now(), done: false, ticks: WEEK_DAYS * s.cfg.day_ticks, seen: 0, ticker: 'Day 1', busts: [], events: [], best: {} };
    for (const m of s.merchants) week.says[m.id] = '';
  }
  function weekAvg(s, t) { let a = 0, n = 0; for (const m of s.merchants) { const g = m.goods.find(x => x.token === t); if (g) { a += Number(R.unitPrice(g.base, g.target, g.stock)); n++; } } return a / Math.max(1, n) / R.GOODS[t]; }
  function weekSay(s, m, kind) { const L = SAYS[kind]; if (L) week.says[m.id] = L[(s.tick + m.index) % L.length]; }
  function weekStep() {
    const w = week; if (w.done) return; const s = w.s, want = Math.min(w.ticks, Math.floor((performance.now() - w.start) / 1000 / WEEK_SECONDS * w.ticks));
    while (s.tick < want) {
      MarketSim.tick(s); MarketSim.camps(s, WEEK_CAMPS, w.campRnd); for (const t of Object.keys(R.GOODS)) w.acc[t] += weekAvg(s, t); if (s.tick % 6 === 0) for (const t of Object.keys(R.GOODS)) { w.hist[t].push(w.acc[t] / 6); w.acc[t] = 0; }
      for (; w.seen < s.log.length; w.seen++) { const e = s.log[w.seen], m = e.merchant && s.merchants.find(x => x.id === e.merchant);
        if (e.kind === 'event') { w.events.push(e); w.ticker = e.text + '!'; for (const x of s.merchants) if (x.goods.some(g => g.token === e.token)) weekSay(s, x, 'event'); }
        if (e.kind === 'broke') { w.busts.push(e); w.ticker = m.name + ' could not pay the rent. The shutters come down.'; weekSay(s, m, 'broke'); floaters.push({ stall: m.id, text: 'Closed!', col: '#ff6a5a', t: performance.now() / 1000 }); if (typeof Snd !== 'undefined') Snd.play('close'); }
        if (e.kind === 'lend') { w.ticker = (e.from === 'city' ? 'The City' : nameOf(e.from)) + ' lends ' + m.name + ' enough to open again.'; weekSay(s, m, 'lend'); floaters.push({ stall: m.id, text: 'Open!', col: '#a8f0a0', t: performance.now() / 1000 }); }
        if (e.kind === 'mishap') { w.ticker = 'A bad day at ' + m.name + '’s stall: ' + e.lost + ' ' + WORDS[e.token].toLowerCase() + ' lost.'; weekSay(s, m, 'mishap'); floaters.push({ stall: m.id, text: 'Lost!', col: '#ffb08a', t: performance.now() / 1000 }); }
      }
      if (s.tick % 36 === 0) for (const m of s.merchants) { if (!m.open) continue; const r = Number(m.till) / Number(m.start_till), g = m.goods[(s.tick / 36 + m.index) % m.goods.length | 0], k = Number(g.stock) / Number(g.target); weekSay(s, m, r > 1.8 ? 'rich' : r < 0.35 ? 'poor' : k < 0.5 ? 'dear' : k > 1.4 ? 'cheap' : ''); }
    }
    if (s.tick >= w.ticks) { w.done = true; weekFinish(); }
    weekPaint();
  }
  function weekFinish() { if (typeof Snd !== 'undefined') Snd.play('done'); }
  function weekStop() { week = null; pollAt = 0; poll(); }
  function weekPaint() {
    const w = week, s = w.s, cv = document.getElementById('bz-chart'), day = Math.min(WEEK_DAYS, Math.floor(s.tick / s.cfg.day_ticks) + 1), hour = Math.floor((s.tick % s.cfg.day_ticks) / 6), head = document.getElementById('bz-day'), tick = document.getElementById('bz-ticker'), st = document.getElementById('bz-tills');
    if (head) head.textContent = w.done ? 'A week has passed' : `Day ${day} of ${WEEK_DAYS}, ${String(hour).padStart(2, '0')}:00`; if (tick) tick.textContent = w.ticker;
    if (st) st.innerHTML = s.merchants.map(m => { const r = Math.min(1, Number(m.till) / (Number(m.start_till) * 3)); return `<span class="${m.open ? '' : 'shut'}"><i style="width:${Math.round(r * 100)}%"></i><b>${m.name.replace('Merchant ', '')}</b></span>`; }).join('');
    if (w.done) { const b = document.getElementById('bz-end'); if (b && b.hidden) { b.hidden = false; const pct = (a, x) => Math.round((Math.max(...a) - 1) * 100), top = Object.keys(R.GOODS).map(t => [t, Math.max(...w.hist[t])]).sort((a, c) => c[1] - a[1])[0], rich = s.merchants.slice().sort((a, c) => (c.till > a.till ? 1 : -1))[0], total = MarketSim.totalGold(s); b.textContent = `${w.busts.length ? w.busts.length + (w.busts.length === 1 ? ' stall' : ' stalls') + ' went broke and came back. ' : 'No stall broke this time. '}${WORDS[top[0]]} peaked at ${top[1].toFixed(1)} times its usual price. ${rich.name} ended richest. And all ${(Number(total) / 1000).toLocaleString('en')} gold is still there: not one coin made or lost.`; } }
    if (!cv) return; const dpr = window.devicePixelRatio || 1, r = cv.getBoundingClientRect(); if (!r.width) return; const W = Math.round(r.width * dpr), H = Math.round(r.height * dpr); if (cv.width !== W || cv.height !== H) { cv.width = W; cv.height = H; }
    const g = cv.getContext('2d'), pad = { l: 26 * dpr, r: 56 * dpr, t: 6 * dpr, b: 16 * dpr }, iw = W - pad.l - pad.r, ih = H - pad.t - pad.b, maxV = Math.max(2, ...Object.values(w.hist).flat()), N = (WEEK_DAYS * s.cfg.day_ticks) / 6, X = i => pad.l + (i / N) * iw, Y = v => pad.t + ih - (v / maxV) * ih;
    g.clearRect(0, 0, W, H); g.font = `700 ${Math.round(10 * dpr)}px Fredoka, system-ui, sans-serif`; g.textBaseline = 'middle';
    for (let v = 0; v <= maxV + 0.01; v += maxV > 3 ? 1 : 0.5) { g.strokeStyle = v === 1 ? '#c8b89a' : '#e8dcc4'; g.lineWidth = dpr; g.beginPath(); g.moveTo(pad.l, Y(v)); g.lineTo(pad.l + iw, Y(v)); g.stroke(); g.fillStyle = '#8a6a4a'; g.textAlign = 'right'; g.fillText(v + 'x', pad.l - 4 * dpr, Y(v)); }
    g.textAlign = 'center'; for (let d = 0; d < WEEK_DAYS; d++) { g.fillStyle = '#8a6a4a'; g.fillText(String(d + 1), X((d + 0.5) * s.cfg.day_ticks / 6), H - 7 * dpr); }
    const ends = [];
    for (const t of Object.keys(R.GOODS)) { const pts = w.hist[t]; if (pts.length < 2) continue; g.strokeStyle = COLOUR[t]; g.lineWidth = 2 * dpr; g.lineJoin = 'round'; g.lineCap = 'round'; g.beginPath(); pts.forEach((v, i) => { if (i) g.lineTo(X(i), Y(v)); else g.moveTo(X(i), Y(v)); }); g.stroke(); ends.push({ t, x: X(pts.length - 1), y: Y(pts[pts.length - 1]) }); }
    ends.sort((a, b) => a.y - b.y); const gap = 11 * dpr; for (let i = 1; i < ends.length; i++) if (ends[i].y < ends[i - 1].y + gap) ends[i].y = ends[i - 1].y + gap;
    g.textAlign = 'left'; for (const e of ends) { g.fillStyle = COLOUR[e.t]; g.beginPath(); g.arc(e.x, e.y, 3 * dpr, 0, 6.3); g.fill(); g.fillStyle = '#4a2f1f'; g.fillText(WORDS[e.t], e.x + 6 * dpr, e.y); }
  }
  function weekCard(ctx) {
    const { sheet } = ctx; weekStart();
    return `<div class="ct-sheet bz-week"><div class="ct-sh-head"><div><b id="bz-day">Day 1 of ${WEEK_DAYS}</b><small>The same market, the same rules, run fast</small></div><button class="ct-x small" data-ct="bz-week-stop" aria-label="Close">${ctx.uic('close')}</button></div><p class="bz-ticker" id="bz-ticker">The caravans are on the road...</p><canvas id="bz-chart"></canvas><div class="bz-tills" id="bz-tills"></div><p class="ct-note bz-end" id="bz-end" hidden></p></div>`;
  }
  function sheetHTML(key, ctx) {
    const k = key.slice(3); if (k === 'board') return boardCard(ctx); if (k === 'news') return newsCard(ctx); if (k === 'ledger') return ledgerCard(ctx); if (k === 'week') return weekCard(ctx); if (k === 'steward') return stewardCard(ctx); if (k === 'errands') return errandsCard(ctx); if (k.startsWith('proof:')) { setTimeout(() => errand('proof'), 0); return proofCard(+k.slice(6), ctx); }
    return merchantCard(k, ctx);
  }
  /** a button on a card */
  async function act(a, b, ctx) {
    note = ''; const d = b.dataset, k = d.k, n = +d.n, t = d.t; if (busy) return;
    if (a === 'bz-lot') { lotMul = n; return; }
    if (a === 'bz-open') { ctx.openSheet(k); return; }
    if (a === 'bz-go') { ctx.talk(k); return; }
    if (a === 'bz-proof') { ctx.openSheet('bz:proof:' + n); return; }
    if (a === 'bz-week-stop') { weekStop(); ctx.openSheet('bz:news'); return; }
    if (a === 'bz-sell') { if (b.classList.contains('dim')) return; await sell(k, t, n); return; }
    if (a === 'bz-buy') { if (b.classList.contains('dim')) return; await buy(k, t, n); return; }
    if (a === 'bz-invest') { if (b.classList.contains('dim')) return; await invest(k, n); return; }
    if (a === 'bz-collect') { if (b.classList.contains('dim')) return; await collect(k); return; }
    if (a === 'bz-home') { await sendHome(); return; }
    if (a === 'bz-say') { const inp = document.getElementById('bz-words'), w = inp ? inp.value.trim() : ''; if (inp) { inp.value = ''; inp.blur(); } if (w && !(talk[k] && talk[k].waiting)) await haggle(k, w); return; }
    if (a === 'bz-order') { const inp = document.getElementById('bz-order'), w = inp ? inp.value.replace(/[\u0000-\u001f]+/g, ' ').trim().slice(0, 140) : ''; if (inp) inp.blur(); try { if (w) localStorage.setItem(ORDER_STORE, w); else localStorage.removeItem(ORDER_STORE); } catch (e) { /* this visit only */ } note = w ? 'Your Steward has its order, and comes straight away.' : 'No standing order: it does as it sees fit.'; stewardAt = 0; if (stewardOn()) { if (stewardBusy) stewardAgain = true; else await stewardVisit(); } return; }
    if (a === 'bz-hire') { await hireSteward(n); return; }
    if (a === 'bz-dismiss') { await dismissSteward(); return; }
    if (a === 'bz-visit') { if (!stewardBusy) await stewardVisit(); return; }
  }
  /** the special link: straight to the door of the Grand Market */
  function boot() {
    if (!liveFlag) return; setInterval(() => { if (!me && !helloP && typeof City !== 'undefined' && City.isOpen()) hello(); if (stewardOn() && !week && performance.now() - stewardAt > STEWARD_EVERY_MS) stewardVisit(); }, 5000); if (!helloP) setTimeout(() => hello(), 1500);
    if (!isDemo) { let tries = 0; const toMarket = () => { try { if (typeof G !== 'undefined' && G && typeof City !== 'undefined' && window.__started) { if (!City.isOpen()) City.open(); if (City.isOpen()) { City.enter('market'); return; } } } catch (e) { /* not ready */ } if (++tries < 40) setTimeout(toMarket, 500); }; if (fromLink) setTimeout(toMarket, 800); return; } const tryOpen = () => { try { if (typeof G !== 'undefined' && G && typeof City !== 'undefined') { if (!City.isOpen()) { G.tut = 99; const hr = Math.floor(G.hours / 24) * 24 + 10; G.hours = hr; City.open(); } if (City.isOpen()) { City.enter('market'); return; } } } catch (e) { /* not ready */ } setTimeout(tryOpen, 300); }; setTimeout(tryOpen, 500);
  }
  return { live: () => liveFlag, demo: () => isDemo, stallAt, dress, draw, tick, sheetHTML, act, boot, viewOf, get market() { return market; }, get me() { return me; }, get player() { return player; }, get week() { return week; }, poll, hello, weekStop, sell, buy, invest, collect, STALLS, haggle, councilCard, hireSteward, get porters() { return porters; }, headlines, errandsPill, get errands() { return errands; }, get stewardBusy() { return stewardBusy; }, stewardVisit, dismissSteward, get stewardLog() { return stewardLog; } };
})();
