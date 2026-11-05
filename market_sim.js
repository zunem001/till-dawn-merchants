'use strict';
//  market_sim.js — THE GRAND MARKET WITH NO CHAIN UNDER IT: the same market as the contract (near/contract/src/lib.rs), tick for tick, for the week in a minute and for measuring the economy before it goes live.
//  A market's life, each tick: the world's prices wander and any world event comes or goes; on a new day the stalls pay their rent; the townsfolk buy from every open stall; and each merchant whose AI has not spoken lately follows its rulebook.
//  Gold is never made here and never lost: it moves between the treasury, the tills, the partners' pool and the players' purses. Goods come into the world from caravans and camps, and leave with caravans, the townsfolk and camps.
//  Every division is a floor on whole numbers, in the order the contract does it, so the two agree to the last digit when they are given the same random numbers (near/test/parity.js).

const MarketSim = (() => {
  const R = typeof MarketRules !== 'undefined' ? MarketRules : require('./market_rules.js');
  const BP = 10000n, big = x => (typeof x === 'bigint' ? x : BigInt(x)), bmin = (a, b) => (a < b ? a : b), bmax = (a, b) => (a > b ? a : b), ACC = 1000000000000n;
  /** how busy the town is at each hour of the market day, in percent (it averages 100): a slow night, a morning rush, the evening rush before dark */
  const DAY_PART = [35, 25, 20, 20, 30, 50, 80, 110, 130, 140, 135, 125, 115, 110, 110, 120, 140, 165, 180, 170, 140, 105, 70, 50];

  function create(seed, opts) {
    const o = opts || {}, cfg = Object.assign({}, R.CONFIG, o.config || {}), world = {};
    for (const t of Object.keys(R.GOODS)) world[t] = big(R.GOODS[t]);
    const merchants = R.MERCHANTS.map(d => {
      const goods = d.goods.map(token => { const target = R.startTarget(token), base = big(R.GOODS[token]); return { token, base, target, stock: target, spread_bp: d.greed, buy_heat: 0n, sell_heat: 0n, heat_ms: 0, day_base: base, day_target: target, start_target: target }; });
      return { id: d.id, name: d.name, till: big(d.till), start_till: big(d.till), open: true, goods, care: d.care, greed: d.greed, nerve: d.nerve, day_till: big(d.till), caravan_spent: 0n, founder_shares: 1000000n, partner_shares: 0n, acc: 0n, closed_at: 0, last_ai_tick: -100000, say: '', index: 0, loan: null };
    });
    merchants.forEach((m, i) => { m.index = i; });
    return { cfg, tick: 0, world, event: null, treasury: big(o.treasury || 14000000), pool: 0n, merchants, partners: new Map(), purses: new Map(), rnd: R.lcg(seed), log: [], onEvent: o.onEvent || null, stats: { busts: 0, rescues: 0, town_gold: 0n, caravan_in: 0n, caravan_out: 0n, trades: 0, rent: 0n } };
  }
  const nowMs = s => s.tick * s.cfg.tick_ms;
  const emit = (s, kind, data) => { const e = Object.assign({ kind, tick: s.tick }, data); s.log.push(e); if (s.onEvent) s.onEvent(e); };
  const goodOf = (m, token) => m.goods.find(g => g.token === token);
  const rollHeat = (s, g) => { const n = nowMs(s), dt = n - g.heat_ms; g.buy_heat = R.heatNow(g.buy_heat, dt, s.cfg.heat_half_ms); g.sell_heat = R.heatNow(g.sell_heat, dt, s.cfg.heat_half_ms); g.heat_ms = n; };
  /** the margin of a trade: the tax leaves for the treasury, and what falls on the partners' shares leaves for them */
  function settleMargin(s, m, gold, margin) {
    const tax = bmin(m.till, (gold * big(s.cfg.tax_bp)) / BP); m.till -= tax; s.treasury += tax;
    if (m.partner_shares > 0n && margin > 0n) { const cut = bmin(m.till, (((margin * big(s.cfg.partner_bp)) / BP) * m.partner_shares) / (m.founder_shares + m.partner_shares)); if (cut > 0n) { m.till -= cut; s.pool += cut; m.acc += (cut * ACC) / m.partner_shares; } }
  }
  /** a merchant sells q units to somebody who pays `from` (a function that takes the gold, and says if it could); returns the gold */
  function merchantSells(s, m, g, q, take) {
    rollHeat(s, g); q = big(q); if (q <= 0n || q > g.stock) return null;
    const curve = R.curveBuy(g.base, g.target, g.stock, q), gold = R.ceilDiv(curve * (BP + big(g.spread_bp) / 2n + g.buy_heat), BP);
    if (!take(gold)) return null;
    g.stock -= q; m.till += gold; g.buy_heat = bmin(big(s.cfg.heat_max_bp), g.buy_heat + R.heatAdd(q, g.target, s.cfg)); settleMargin(s, m, gold, gold - curve); s.stats.trades++; return gold;
  }
  /** a merchant buys q units; returns the gold it paid (null: it can't) */
  function merchantBuys(s, m, g, q) {
    rollHeat(s, g); q = big(q); if (q <= 0n) return null;
    const curve = R.curveSell(g.base, g.target, g.stock, q), off = big(g.spread_bp) / 2n + g.sell_heat; if (off >= BP) return null;
    const gold = (curve * (BP - off)) / BP; if (gold + (m.start_till * big(m.care)) / 400n > m.till) return null;          // (a merchant keeps some gold back: the more careful, the more)
    g.stock += q; m.till -= gold; g.sell_heat = bmin(big(s.cfg.heat_max_bp), g.sell_heat + R.heatAdd(q, g.target, s.cfg)); settleMargin(s, m, gold, curve - gold); s.stats.trades++; return gold;
  }
  const worthOf = m => m.goods.reduce((a, g) => a + g.stock * g.base, m.till);
  const stakeWorth = (s, m) => (m.open ? worthOf(m) : m.goods.reduce((a, g) => a + (g.stock * g.base * big(s.cfg.closed_goods_bp)) / BP, m.till));
  /** gold into a stall: the investor takes shares at what the stall is worth; a stall that holds enough opens */
  function invest(s, who, m, gold) {
    gold = big(gold); const total = m.founder_shares + m.partner_shares, shares = bmax(1n, (gold * total) / bmax(stakeWorth(s, m), 1n));
    m.till += gold; const key = who + '|' + m.id, p = s.partners.get(key) || { shares: 0n, debt: 0n, owed: 0n };
    p.owed += (p.shares * m.acc) / ACC - p.debt; p.shares += shares; p.debt = (p.shares * m.acc) / ACC; s.partners.set(key, p); m.partner_shares += shares;
    if (!m.open && m.till >= big(s.cfg.reopen_millis)) { m.open = true; s.stats.rescues++; emit(s, 'reopen', { merchant: m.id, by: who }); }
    return shares;
  }
  function closeStall(s, m) { m.open = false; m.closed_at = s.tick; s.stats.busts++; emit(s, 'broke', { merchant: m.id }); }
  /** a caravan: a merchant buys at the world's price and the tariff (paid to the treasury), or sells (paid by the treasury) */
  function caravanBuy(s, m, g, q) {
    q = big(q); if (q <= 0n) return 0n; const w = s.world[g.token], unit = (w * (BP + big(s.cfg.tariff_bp))) / BP, gold = unit * q; if (gold > m.till) return 0n;
    m.till -= gold; s.treasury += gold; g.stock += q; m.caravan_spent += gold; s.stats.caravan_out += gold; return gold;
  }
  function caravanSell(s, m, g, q) {
    q = bmin(big(q), g.stock); if (q <= 0n) return 0n; const w = s.world[g.token], unit = (w * (BP - big(s.cfg.tariff_bp))) / BP, gold = unit * q; if (gold > s.treasury) return 0n;
    s.treasury -= gold; m.till += gold; g.stock -= q; s.stats.caravan_in += gold; return gold;
  }
  /** the leash: a base and a target can only move so far from the morning's values in one day; the base stays within a third and three times the good's usual price */
  function leashBase(s, g, want) { const ref = big(R.GOODS[g.token]), span = (g.day_base * big(s.cfg.base_day_bp)) / BP; return bmin(bmin(g.day_base + span, ref * 3n), bmax(bmax(g.day_base - span, ref / 3n), want)); }
  function leashTarget(s, g, want) { const span = (g.day_target * big(s.cfg.target_day_bp)) / BP; return bmax(1n, bmin(bmin(g.day_target + span, g.start_target * 4n), bmax(bmax(g.day_target - span, g.start_target / 4n), want))); }

  /** THE RULEBOOK: what a merchant does in its hour when its AI has not spoken. Temper decides the rest: a careful merchant keeps gold back and sells early; a nervy one buys what looks cheap */
  function rulebook(s, m) {
    const cfg = s.cfg, care = big(m.care), nerve = big(m.nerve), reserve = (m.day_till * care) / 200n, budget = bmax(0n, (m.day_till * big(cfg.caravan_day_bp)) / BP - m.caravan_spent);
    const hoursLeft = BigInt(Math.max(1, 24 - Math.floor(((s.tick % cfg.day_ticks) * 24) / cfg.day_ticks)));
    let left = (budget * 2n) / hoursLeft < budget ? (budget * 2n) / hoursLeft : budget;                // (the day's budget is spread across the day, and what is scarcest is seen to first)
    const byNeed = m.goods.slice().sort((a, b) => { const x = a.stock * b.target, y = b.stock * a.target; return x < y ? -1 : x > y ? 1 : 0; });
    for (const g of byNeed) {
      const w = s.world[g.token], ref = big(R.GOODS[g.token]);
      g.base = leashBase(s, g, g.base + ((w - g.base) * 800n) / BP);                                    // the base follows the world's price, slowly
      g.spread_bp = Number(bmin(big(cfg.spread_max_bp), bmax(big(cfg.spread_min_bp), big(g.spread_bp) + (big(m.greed) - big(g.spread_bp)) / 4n)));
      const cheap = ((ref - w) * 100n) / ref, wantT = (g.start_target * (100n + ((m.nerve >= 80 ? -cheap : cheap) * nerve) / 25n)) / 100n;       // what looks cheap, a nervy merchant wants more of; a gambler chases what is rising instead
      g.target = leashTarget(s, g, g.target + (wantT - g.target) / 6n);
      if (g.stock < (g.target * 3n) / 4n) {
        const room = bmin(left, m.till > reserve ? m.till - reserve : 0n), unit = (w * (BP + big(cfg.tariff_bp))) / BP, q = bmin((g.target - g.stock) / 2n, room / bmax(unit, 1n));
        if (q > 0n) left -= caravanBuy(s, m, g, q);
      } else if (g.stock > (g.target * 5n) / 4n) {
        const unit = (w * (BP - big(cfg.tariff_bp))) / BP; if (R.unitPrice(g.base, g.target, g.stock) < unit) caravanSell(s, m, g, (g.stock - g.target) / 2n);
      }
    }
  }
  /** a stall closed for a day and no player has come to the rescue: the richest open merchant lends it enough to open, if it can spare the gold; after two days the City does. A loan comes back with a tenth on top, once the till can bear it */
  function rescues(s) {
    for (const m of s.merchants) {
      if (m.open) continue; const away = s.tick - m.closed_at;
      if (away >= s.cfg.day_ticks && away % 6 === 0) {
        let best = null; for (const o of s.merchants) if (o.open && o !== m && (!best || o.till > best.till)) best = o;
        const need = big(s.cfg.reopen_millis) + big(s.cfg.rent_millis); let from = null;
        if (best && best.till > need * 4n) { best.till -= need; from = best.id; }
        else if (away >= s.cfg.day_ticks * 2 && s.treasury > need * 4n) { s.treasury -= need; from = 'city'; }
        if (from) { m.till += need; m.loan = { from, amount: (m.loan ? m.loan.amount : 0n) + need }; m.open = true; s.stats.rescues++; emit(s, 'lend', { merchant: m.id, from, gold: Number(need) }); }
      }
    }
  }
  /** at dawn a loan is paid back, a tenth on top, once the till holds three times the debt */
  function repay(s, m) {
    if (!m.loan || m.till < m.loan.amount * 3n) return;
    const pay = (m.loan.amount * 11n) / 10n, from = m.loan.from; m.till -= pay; if (from === 'city') s.treasury += pay; else s.merchants.find(o => o.id === from).till += pay;
    emit(s, 'repaid', { merchant: m.id, from, gold: Number(pay) }); m.loan = null;
  }

  /** THE TOWNSFOLK BUY FROM WHOEVER IS CHEAPEST. The whole town's want for a good is shared out by price: a stall twice as dear gets a quarter of the custom, and if every stall is dear the town buys less. That is what makes a merchant's price matter */
  function townBuys(s, token, part, mood) {
    const cfg = s.cfg, usual = big(R.GOODS[token]), sellers = []; let room = 0n, sum = 0n, low = null;
    for (const m of s.merchants) { const g = goodOf(m, token); if (!g) continue; room += g.start_target; if (!m.open || g.stock <= 0n) continue; const a = bmax(1n, (R.unitPrice(g.base, g.target, g.stock) * (BP + big(g.spread_bp) / 2n)) / BP), x = (usual * 1000n) / a, w = x * x; sellers.push([m, g, w]); sum += w; if (low === null || a < low) low = a; }
    if (!sellers.length || sum === 0n) return;
    const boost = s.event && s.event.token === token && s.event.mult > 10000 ? 3n : 2n, elastic = bmax(40n, bmin(160n, (usual * 100n) / low)), want = (((((((room * 1000n * big(cfg.town_demand_bp) * part) / 100n / BP) * boost) / 2n) * mood) / 100n) * elastic) / 100n;          // (in thousandths of a unit: a dear good sells in small numbers, and the part of a unit the town did not take yet is carried over)
    for (const [m, g, w] of sellers) { g.carry = (g.carry || 0n) + (want * w) / sum; const q = bmin(g.carry / 1000n, g.stock); g.carry -= q * 1000n; if (g.carry > 8000n) g.carry = 8000n; if (q > 0n) merchantSells(s, m, g, q, need => { if (need > s.treasury) return false; s.treasury -= need; s.stats.town_gold += need; return true; }); }
  }
  /** food rots, and now and then a stall has a bad day */
  function wear(s) {
    const cfg = s.cfg, rnd = s.rnd;
    for (const m of s.merchants) {
      for (const g of m.goods) { const rot = big(R.ROT_BP[g.token] || 0); if (rot > 0n) { const gone = R.ceilDiv(g.stock * rot, BP); g.stock -= bmin(gone, g.stock); } }
      if (m.open && rnd() % 10000 < cfg.mishap_bp) { const g = m.goods[rnd() % m.goods.length], lost = (g.stock * big(cfg.mishap_loss_bp)) / BP; g.stock -= lost; s.stats.mishaps = (s.stats.mishaps || 0) + 1; emit(s, 'mishap', { merchant: m.id, token: g.token, lost: Number(lost) }); }
    }
  }

  /** ten minutes in the life of the market */
  function tick(s) {
    const cfg = s.cfg, rnd = s.rnd; s.tick++;
    // the world's prices
    for (const t of Object.keys(R.GOODS)) {
      const usual = big(R.GOODS[t]), ref = s.event && s.event.token === t ? (usual * big(s.event.mult)) / BP : usual, w = s.world[t], walk = big(cfg.walk_bp), r = big(rnd() % (cfg.walk_bp * 2 + 1)) - walk;
      s.world[t] = bmax(usual / 3n, bmin(usual * 3n, w + (w * r) / BP + ((ref - w) * big(cfg.revert_bp)) / BP));
    }
    // the world's events
    if (s.event && s.tick >= s.event.until) { emit(s, 'event_end', { text: s.event.text }); s.event = null; }
    if (!s.event && rnd() % 10000 < cfg.event_chance_bp) { const e = R.EVENTS[rnd() % R.EVENTS.length]; s.event = { token: e[1], mult: e[2], text: e[3], until: s.tick + cfg.event_min_ticks + (rnd() % (cfg.event_max_ticks - cfg.event_min_ticks + 1)) }; emit(s, 'event', { text: e[3], token: e[1], mult: e[2] }); }
    // a new day: the rent, and the morning's figures the leash counts from
    if (s.tick % cfg.day_ticks === 0) for (const m of s.merchants) {
      if (m.open) { const rent = big(cfg.rent_millis); if (m.till < rent) { closeStall(s, m); } else { m.till -= rent; s.treasury += rent; s.stats.rent += rent; const fat = m.till > m.start_till * 2n ? ((m.till - m.start_till * 2n) * big(cfg.levy_bp)) / BP : 0n; if (fat > 0n) { m.till -= fat; s.treasury += fat; s.stats.rent += fat; } } }
      repay(s, m);
      m.day_till = m.till; m.caravan_spent = 0n; for (const g of m.goods) { g.day_base = g.base; g.day_target = g.target; }
    }
    // the townsfolk
    const hour = Math.floor(((s.tick % cfg.day_ticks) * 24) / cfg.day_ticks), part = big(DAY_PART[hour]), mood = bmax(10n, bmin(150n, (s.treasury * 100n) / big(cfg.treasury_ref_millis)));          // (a City with an empty treasury has no money to spend: the town buys by what it holds, and that is what keeps the gold going round)
    for (const t of Object.keys(R.GOODS)) townBuys(s, t, part, mood);
    wear(s);
    // each merchant, once in its hour, follows its rulebook unless its AI has spoken lately (they take their turn across the hour)
    for (const m of s.merchants) if (m.open && (s.tick + m.index) % 6 === 0 && s.tick - m.last_ai_tick > 12) rulebook(s, m);
    rescues(s);
  }

  // ── what a player can do (the same trades the contract's intents make) ──
  const purse = (s, who) => s.purses.get(who) || 0n;
  /** a player sells q units to a merchant */
  function playerSell(s, who, id, token, q) { const m = s.merchants.find(x => x.id === id), g = m && goodOf(m, token); if (!g || !m.open) return null; const gold = merchantBuys(s, m, g, q); if (gold === null) return null; s.purses.set(who, purse(s, who) + gold); return gold; }
  /** a player buys q units from a merchant */
  function playerBuy(s, who, id, token, q) { const m = s.merchants.find(x => x.id === id), g = m && goodOf(m, token); if (!g || !m.open) return null; return merchantSells(s, m, g, q, need => { if (need > purse(s, who)) return false; s.purses.set(who, purse(s, who) - need); return true; }); }
  /** a handful of camps, as the real game brings: each hour one sells a surplus to the best bidder and buys what it lacks from the cheapest */
  function camps(s, n, rnd) {
    if (s.tick % 6 !== 0) return; const tokens = Object.keys(R.GOODS), now = nowMs(s);
    for (let i = 0; i < n; i++) {
      if (rnd() % 100 > 35) continue; const who = 'camp' + i, t = tokens[rnd() % tokens.length], q = BigInt(Math.max(1, Math.floor((8000 + rnd() % 22000) / R.GOODS[t])));
      let best = null, bestGold = -1n; for (const m of s.merchants) { if (!m.open) continue; const g = goodOf(m, t); if (!g) continue; const b = R.bid(g, q, now, s.cfg); if (b > bestGold && b <= m.till) { bestGold = b; best = m; } }
      if (best) playerSell(s, who, best.id, t, q);
      const need = tokens[rnd() % tokens.length], nq = BigInt(Math.max(1, Math.floor((8000 + rnd() % 22000) / R.GOODS[need]))); let cheap = null, cheapGold = null;
      for (const m of s.merchants) { if (!m.open) continue; const g = goodOf(m, need); if (!g) continue; const a = R.ask(g, nq, now, s.cfg); if (a !== null && (cheapGold === null || a < cheapGold)) { cheapGold = a; cheap = m; } }
      if (cheap) playerBuy(s, who, cheap.id, need, nq);
    }
  }
  const totalGold = s => s.treasury + s.pool + s.merchants.reduce((a, m) => a + m.till, 0n) + [...s.purses.values()].reduce((a, v) => a + v, 0n);
  return { create, tick, rulebook, invest, playerSell, playerBuy, camps, merchantSells, merchantBuys, caravanBuy, caravanSell, closeStall, worthOf, totalGold, goodOf, DAY_PART, nowMs };
})();
if (typeof module !== 'undefined' && module.exports) module.exports = MarketSim;
