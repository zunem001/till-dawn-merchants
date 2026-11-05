'use strict';
// node near/sim/week.js [seed] [days]        one run of the Grand Market, printed day by day: no chain, no network, the same rules as the contract
// node near/sim/week.js --measure [runs] [days]    many runs: is the economy healthy? (the figures the market's numbers were tuned to)
const path = require('path'), R = require(path.join(__dirname, '..', '..', 'market_rules.js')), S = require(path.join(__dirname, '..', '..', 'market_sim.js'));
const gold = x => (Number(x) / 1000).toFixed(0).padStart(6), args = process.argv.slice(2);
function run(seed, days, ncamps, quiet) {
  const s = S.create(seed), rnd = R.lcg(seed ^ 0x5bd1e995), start = S.totalGold(s), hist = {};
  for (const t of Object.keys(R.GOODS)) hist[t] = [];
  const lo = {}, hi = {};
  if (!quiet) console.log('day | treasury |' + s.merchants.map(m => m.id.padStart(7)).join('') + ' |' + Object.keys(R.GOODS).map(t => t.slice(0, 5).padStart(7)).join('') + ' | news');
  for (let t = 0; t < days * s.cfg.day_ticks; t++) {
    const before = s.log.length; S.tick(s); S.camps(s, ncamps, rnd);
    for (const m of s.merchants) for (const g of m.goods) { const p = Number(R.unitPrice(g.base, g.target, g.stock)), k = g.token; if (lo[k] === undefined || p < lo[k]) lo[k] = p; if (hi[k] === undefined || p > hi[k]) hi[k] = p; }
    if (!quiet && s.tick % s.cfg.day_ticks === 0) {
      const avg = Object.keys(R.GOODS).map(k => { let a = 0, n = 0; for (const m of s.merchants) { const g = S.goodOf(m, k); if (g) { a += Number(R.unitPrice(g.base, g.target, g.stock)); n++; } } return (a / n / R.GOODS[k]).toFixed(2).padStart(7); }).join('');
      const news = s.log.filter(e => e.tick > s.tick - s.cfg.day_ticks && (e.kind === 'event' || e.kind === 'broke' || e.kind === 'reopen' || e.kind === 'mishap' || e.kind === 'lend')).map(e => e.kind === 'event' ? e.token + (e.mult > 10000 ? '+' : '-') : e.kind + ':' + e.merchant).join(' ');
      console.log(String(s.tick / s.cfg.day_ticks).padStart(3) + ' | ' + gold(s.treasury) + '   |' + s.merchants.map(m => (m.open ? gold(m.till) : ' SHUT ').padStart(7)).join('') + ' |' + avg + ' | ' + news);
    }
  }
  if (S.totalGold(s) !== start) throw new Error('GOLD WAS MADE OR LOST: ' + start + ' became ' + S.totalGold(s));
  return { s, lo, hi };
}
if (args[0] === '--measure') {
  const runs = +args[1] || 100, days = +args[2] || 7, ncamps = args[3] !== undefined ? +args[3] : 8; let busts = 0, rescues = 0, shutAtEnd = 0, events = 0, tres = 0, tills = 0, zero = 0, never = 0, rich = 0, poor = 0, trades = 0; const spread = {}; const broke = {};
  for (let i = 0; i < runs; i++) {
    const { s, lo, hi } = run(1000 + i * 7, days, ncamps, true); busts += s.stats.busts; rescues += s.stats.rescues; shutAtEnd += s.merchants.filter(m => !m.open).length; events += s.log.filter(e => e.kind === 'event').length; tres += Number(s.treasury) / 1000; trades += s.stats.trades;
    if (s.stats.busts === 0) never++; const tl = s.merchants.map(m => Number(m.till) / 1000); tills += tl.reduce((a, b) => a + b, 0); rich += Math.max(...tl); poor += Math.min(...tl);
    for (const m of s.merchants) if (s.log.some(e => e.kind === 'broke' && e.merchant === m.id)) broke[m.id] = (broke[m.id] || 0) + 1;
    for (const k of Object.keys(R.GOODS)) { spread[k] = spread[k] || [0, 0]; spread[k][0] += lo[k] / R.GOODS[k]; spread[k][1] += hi[k] / R.GOODS[k]; }
  }
  console.log(`${runs} runs of ${days} days with ${ncamps} camps: stalls broke ${(busts / runs).toFixed(2)} a run (none in ${(100 * never / runs).toFixed(0)}% of runs), rescued ${(rescues / runs).toFixed(2)}, still shut at the end ${(shutAtEnd / runs).toFixed(2)}, world events ${(events / runs).toFixed(1)}, trades ${(trades / runs).toFixed(0)}`);
  console.log(`treasury at the end ${(tres / runs).toFixed(0)} gold; all tills ${(tills / runs).toFixed(0)}; richest ${(rich / runs).toFixed(0)}, poorest ${(poor / runs).toFixed(0)}; broke most: ${Object.entries(broke).sort((a, b) => b[1] - a[1]).map(([k, v]) => k + ' ' + (v / runs).toFixed(2)).join(', ')}`);
  console.log('prices as a share of usual, lowest and highest seen: ' + Object.keys(R.GOODS).map(k => `${k} ${(spread[k][0] / runs).toFixed(2)}-${(spread[k][1] / runs).toFixed(2)}`).join(', '));
} else { const { s } = run(+args[0] || 7, +args[1] || 7, 8, false); console.log('trades ' + s.stats.trades + ', town spent ' + gold(s.stats.town_gold) + ', caravans sold ' + gold(s.stats.caravan_out) + ' bought ' + gold(s.stats.caravan_in) + ', rent ' + gold(s.stats.rent) + ', gold kept whole: ' + (S.totalGold(s) === 14000000n + 3450000n + 0n ? 'yes' : S.totalGold(s))); }
