'use strict';
// node near/test/parity.js      The contract and the JavaScript market, tick for tick, digit for digit. The contract's test `parity` writes down every number of a fortnight (near/test/vectors/parity.json);
// this runs market_sim.js from the same seed and compares them all. If this passes, what the game shows before a trade and what the week in a minute does are what the chain does.
const fs = require('fs'), path = require('path'), R = require('../../market_rules.js'), S = require('../../market_sim.js'), rows = JSON.parse(fs.readFileSync(path.join(__dirname, 'vectors', 'parity.json'), 'utf8'));
const s = S.create(7), keys = Object.keys(R.GOODS); let compared = 0;
const eq = (a, b, what, tick) => { compared++; if (String(a) !== String(b)) { console.log(`  FAIL tick ${tick}: ${what}: the contract has ${a}, the JavaScript market has ${b}`); process.exit(1); } };
for (const r of rows) {
  S.tick(s); eq(r.t, s.tick, 'the tick', r.t); eq(r.tr, s.treasury, 'the treasury', r.t);
  keys.forEach((k, i) => eq(r.w[i], s.world[k], 'the world price of ' + k, r.t));
  r.m.forEach((m, i) => { const j = s.merchants[i]; eq(m[0], j.till, j.id + ' till', r.t); eq(m[1], j.open, j.id + ' open', r.t); m[2].forEach((g, x) => { const h = j.goods[x]; ['base', 'target', 'stock', 'spread_bp', 'buy_heat', 'sell_heat'].forEach((f, n) => eq(g[n], h[f], `${j.id} ${h.token} ${f}`, r.t)); eq(g[6], h.carry || 0n, `${j.id} ${h.token} carry`, r.t); }); });
}
// hard times: the same script as the contract's test parity_hard_times. Stalls really break, a player trades and rescues, loans are given and paid back
const hardRows = JSON.parse(fs.readFileSync(path.join(__dirname, 'vectors', 'parity_hard.json'), 'utf8')), h = S.create(7), who = 'rescuer.near'; let broke = 0, opened = 0;
h.treasury -= 400000n; h.purses.set(who, 400000n);
const drain = (i, to) => { const m = h.merchants[i], x = m.till > BigInt(to) ? m.till - BigInt(to) : 0n; m.till -= x; h.treasury += x; };
const rescue = (i, gold) => { h.purses.set(who, h.purses.get(who) - BigInt(gold)); S.invest(h, who, h.merchants[i], gold); };
for (const r of hardRows) {
  const was = h.merchants.map(m => m.open); S.tick(h);
  if (h.tick === 143) { drain(1, 30000); drain(5, 20000); drain(4, 25000); }
  if (h.tick === 80) { S.playerSell(h, who, 'odin', 'wood', 300); S.playerBuy(h, who, 'odin', 'metal', 10); }
  if (h.tick === 150) rescue(5, 60000);
  if (h.tick === 300) { S.playerSell(h, who, 'odin', 'wood', 300); rescue(1, 50000); }
  if (h.tick === 719) { drain(2, 10000); drain(6, 15000); }
  h.merchants.forEach((m, i) => { if (was[i] && !m.open) broke++; if (!was[i] && m.open) opened++; });
  eq(r.t, h.tick, 'hard times: the tick', r.t); eq(r.tr, h.treasury, 'hard times: the treasury', r.t); eq(r.pool, h.pool, 'hard times: the pool', r.t); eq(r.gold, h.purses.get(who), "hard times: the player's gold", r.t);
  keys.forEach((k, i) => eq(r.w[i], h.world[k], 'hard times: the world price of ' + k, r.t));
  r.m.forEach((m, i) => { const j = h.merchants[i]; eq(m[0], j.till, j.id + ' till', r.t); eq(m[1], j.open, j.id + ' open', r.t); eq(m[3], j.partner_shares, j.id + ' partner shares', r.t); eq(m[4], j.acc, j.id + ' partner account', r.t); eq(m[5], j.loan ? j.loan.amount : 0n, j.id + ' loan', r.t); eq(m[6], j.closed_at, j.id + ' closed at', r.t); m[2].forEach((g, x) => { const q = j.goods[x]; ['base', 'target', 'stock', 'spread_bp', 'buy_heat', 'sell_heat'].forEach((f, n) => eq(g[n], q[f], `${j.id} ${q.token} ${f}`, r.t)); eq(g[6], q.carry || 0n, `${j.id} ${q.token} carry`, r.t); }); });
}
// the sums a card shows, against the sums of the contract's unit tests
const near = (a, b) => { compared++; if (a !== b) { console.log('  FAIL', a, b); process.exit(1); } };
near(R.curveSell(100, 2400, 2400, 200), BigInt(Math.floor(4 * 100 * 2400 * 2400 * 200 / ((2400 + 2400) * (2400 + 200 + 2400)))));
console.log(`  ok   the contract and the JavaScript market agree on all ${compared.toLocaleString('en')} numbers of a quiet fortnight (${rows.length} ticks; ${s.stats.busts} stalls broke, ${s.log.filter(e => e.kind === 'event').length} world events) and of twelve hard days (${hardRows.length} ticks; ${broke} stalls broke, ${opened} opened again, a player traded and rescued, gold ${S.totalGold(h) === S.totalGold(s) ? 'the same as the quiet market' : 'DIFFERENT'})`);
