// node near/test/e2e.mjs [sandbox|testnet] [root]        THE WHOLE ROAD, ON A REAL CHAIN, WITH NO WALLET: a new player makes a key, signs a trade (NEP-413), the warden brings it to the chain, the price moves, a merchant decides, the market ticks.
//   On the sandbox it also sets the clock of the market short so ticks can be watched. Every step prints the gas it cost.
import { createRequire } from 'node:module';
import { Act, b58encode, derivedKey, keyFromSeed, nearClient, sha256, toHex } from '../../src/near.js';
const require = createRequire(import.meta.url), R = require('../../market_rules.js');
const network = process.argv[2] || 'sandbox', root = process.argv[3] || 'test.near', seed = process.env.NEAR_KEY_SEED || 'sandbox-test-secret';
const client = nearClient(network === 'sandbox' ? ['http://127.0.0.1:3030'] : ['https://test.rpc.fastnear.com', 'https://near-testnet.drpc.org', 'https://rpc.testnet.near.org']), MARKET = 'market.' + root, WARDEN = 'warden.' + root;
let fails = 0; const ok = (c, m) => { console.log((c ? '  ok   ' : '  FAIL ') + m); if (!c) fails++; };
const warden = await derivedKey(seed, 'warden:0');
const nep413 = async (key, account, seq, actions) => {
  const message = JSON.stringify({ signer: account, deadline_ms: Date.now() + 120000, seq, actions }), nonce = crypto.getRandomValues(new Uint8Array(32)), m = new TextEncoder().encode(message), r = new TextEncoder().encode(MARKET);
  const u32 = n => { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, n, true); return b; }, parts = [u32(2147484061), u32(m.length), m, nonce, u32(r.length), r, Uint8Array.of(0)], all = new Uint8Array(parts.reduce((a, p) => a + p.length, 0)); let i = 0; for (const p of parts) { all.set(p, i); i += p.length; }
  const sig = await key.sign(await sha256(all)), b64 = v => btoa(String.fromCharCode(...v));
  return { message, nonce: b64(nonce), recipient: MARKET, public_key: key.publicKey, signature: b64(sig) };
};
console.log(`The whole road on ${network}, market ${MARKET}`);
const key = await keyFromSeed(crypto.getRandomValues(new Uint8Array(32))), account = toHex(key.raw); ok(account.length === 64, 'a new player: a key made here, no account made anywhere, no wallet: ' + account.slice(0, 12) + '...');
const st0 = await client.view(MARKET, 'state', {}), odin = st0.merchants[0], wood0 = odin.goods.find(g => g.token === 'wood');
const quote = await client.view(MARKET, 'quote', { merchant: odin.id, token: 'wood', side: 'sell', amount: '200' });
const g = Object.assign({}, wood0, { heat_ms: st0.now_ms }), jsQuote = R.bid(g, 200n, st0.now_ms, R.CONFIG); ok(String(jsQuote) === String(quote), `the game's own sums say ${jsQuote} for 200 wood, the contract says ${quote}`);
const sold = await client.tx(WARDEN, warden, MARKET, [Act.call('serve', { brings: [{ account, token: 'wood', amount: '500' }], starters: [account], signed: [await nep413(key, account, 1, [{ sell: { merchant: odin.id, token: 'wood', amount: '200', min_gold: '0' } }])] }, 120)]);
ok(sold.ok && sold.value && sold.value[0].ok, `a signed sale comes to the chain and the warden pays: ${sold.tgas} Tgas (${(sold.tgas / 10000).toFixed(5)} NEAR), tx ${sold.hash}` + (sold.ok ? '' : ' ' + sold.failure));
const trade = sold.events.find(e => e.event === 'trade'); ok(!!trade && trade.data[0].gold === String(quote), 'the trade paid exactly the quote: ' + (trade && trade.data[0].gold) + ' millis');
ok(sold.events.some(e => e.standard === 'nep245' && e.event === 'mt_transfer'), 'and the chain says so in NEP-245 events');
const st1 = await client.view(MARKET, 'state', {}), wood1 = st1.merchants[0].goods.find(x => x.token === 'wood'); ok(BigInt(wood1.stock) === BigInt(wood0.stock) + 200n && R.unitPrice(wood1.base, wood1.target, wood1.stock) < R.unitPrice(wood0.base, wood0.target, wood0.stock), `Odin holds 200 more wood, and the price of wood fell from ${R.unitPrice(wood0.base, wood0.target, wood0.stock)} to ${R.unitPrice(wood1.base, wood1.target, wood1.stock)}`);
const me = await client.view(MARKET, 'player', { account }), purse = me.items.find(i => i.token === 'gold').amount, crates = me.items.find(i => i.token === 'wood').amount; ok(BigInt(purse) === BigInt(R.CONFIG.starter_gold_millis) + BigInt(quote) && crates === '300', `the player's purse holds ${purse}, the crates ${crates} wood`);
ok(await client.view(MARKET, 'mt_balance_of', { account_id: account, token_id: 'wood' }) === '300', 'NEP-245 says the same');
const again = await client.tx(WARDEN, warden, MARKET, [Act.call('execute_intents', { signed: [await nep413(key, account, 1, [{ sell: { merchant: odin.id, token: 'wood', amount: '200', min_gold: '0' } }])] }, 60)]); ok(again.ok && again.value[0].err === 'already seen', 'the same number signed twice is refused: ' + JSON.stringify(again.value && again.value[0]));
const bo = st1.merchants.find(m => m.id.startsWith('bo.')); const inv = await client.tx(WARDEN, warden, MARKET, [Act.call('execute_intents', { signed: [await nep413(key, account, 2, [{ invest: { merchant: bo.id, gold: '10000' } }])] }, 60)]); ok(inv.ok && inv.value[0].ok, `investing in Bo: ${inv.tgas} Tgas`);
const oKey = await derivedKey(seed, 'merchant:odin'); const dec = await client.tx(odin.id, oKey, MARKET, [Act.call('decide', { model: 'test-model', decision: JSON.stringify({ goods: [{ good: 'wood', price: 300, margin: 95 }, { good: 'metal', stock: 20 }], caravan: [{ good: 'metal', buy: 20 }], deal: { from: 'thea', good: 'stone', qty: 30 }, say: 'Wood is everywhere. I will pay less for it.', why: 'test' }) }, 60)]);
ok(dec.ok, `a merchant's own key brings its decision: ${dec.tgas} Tgas` + (dec.ok ? '' : ' ' + dec.failure)); const de = dec.events.find(e => e.event === 'decision'); ok(de && de.data[0].pulled.length >= 2, 'the leash cut what it asked for: ' + JSON.stringify(de && de.data[0].pulled.map(p => p.asked + ' ' + p.wanted + ' to ' + p.allowed)));
let refused = false; try { const steal = await client.tx(odin.id, oKey, MARKET, [Act.call('mt_transfer', { receiver_id: WARDEN, token_id: 'gold', amount: '1' }, 30, 1)]); refused = !steal.ok; } catch (e) { refused = true; } ok(refused, "a merchant's key cannot move gold to anybody");
refused = false; try { await client.tx(odin.id, oKey, MARKET, [Act.call('act', { actions: [] }, 30)]); } catch (e) { refused = true; } ok(refused, "a merchant's key can only call `decide` and `decide_sealed`");
refused = false; try { await client.tx(WARDEN, warden, WARDEN, [Act.transfer(1n)]); } catch (e) { refused = true; } ok(refused, "the warden's key cannot spend the warden's own NEAR");
if (network === 'sandbox') {
  const rootKeyJson = process.env.SANDBOX_KEY; if (rootKeyJson) {
    const cfg = await client.view(MARKET, 'get_config', {}); cfg.tick_ms = 2000; const { keyFromSecret } = await import('../../src/near.js'), rk = await keyFromSecret(rootKeyJson); await client.tx(root, rk, MARKET, [Act.call('set_config', { cfg }, 30)]);
    await new Promise(r => setTimeout(r, 2500)); let worst = 0, worstKind = '', ticks = 0;
    for (let i = 0; i < 12; i++) { try { const c = await client.tx(WARDEN, warden, MARKET, [Act.call('crank', {}, 280)]); if (c.ok) { ticks++; if (c.tgas > worst) { worst = c.tgas; } } } catch (e) { /* not yet */ } await new Promise(r => setTimeout(r, 2100)); }
    ok(ticks >= 8, `${ticks} ticks: the dearest cost ${worst} Tgas (a day of ticks at that price: ${(worst * 144 / 10000).toFixed(3)} NEAR)`);
    cfg.tick_ms = 600000; await client.tx(root, rk, MARKET, [Act.call('set_config', { cfg }, 30)]);
  }
}
const stE = await client.view(MARKET, 'state', {}), sum = BigInt(stE.treasury) + BigInt(stE.pool) + stE.merchants.reduce((a, m) => a + BigInt(m.till), 0n) + BigInt((await client.view(MARKET, 'player', { account })).items.find(i => i.token === 'gold').amount); ok(sum === BigInt(stE.gold_supply), `all the gold is still there: ${sum} of ${stE.gold_supply}`);
console.log(fails ? `\n${fails} check(s) FAILED` : '\nAll checks passed.'); process.exit(fails ? 1 : 0);
