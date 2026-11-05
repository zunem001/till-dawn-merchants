'use strict';
// The market's opening: everything the contract's `new` takes, from market_rules.js, so the file that says what the numbers are is what goes on the chain.
//   node near/scripts/init_args.js [root account]      prints the JSON
const path = require('path'), crypto = require('crypto'), R = require(path.join(__dirname, '..', '..', 'market_rules.js'));
function initArgs(root, opts) {
  const o = opts || {}, C = R.CONFIG, u = x => String(x);
  return {
    owner: o.owner || root, warden: o.warden || 'warden.' + root, seed: o.seed === undefined ? 7 : o.seed, treasury: u(14000000),
    cfg: { tick_ms: C.tick_ms, day_ticks: C.day_ticks, town_demand_bp: C.town_demand_bp, walk_bp: C.walk_bp, revert_bp: C.revert_bp, tariff_bp: C.tariff_bp, tax_bp: C.tax_bp, partner_bp: C.partner_bp, rent_millis: u(C.rent_millis), levy_bp: C.levy_bp, treasury_ref_millis: u(C.treasury_ref_millis), heat_max_bp: C.heat_max_bp, heat_half_ms: C.heat_half_ms, spread_min_bp: C.spread_min_bp, spread_max_bp: C.spread_max_bp, caravan_day_bp: C.caravan_day_bp, base_day_bp: C.base_day_bp, target_day_bp: C.target_day_bp, event_chance_bp: C.event_chance_bp, event_min_ticks: C.event_min_ticks, event_max_ticks: C.event_max_ticks, reopen_millis: u(C.reopen_millis), mishap_bp: C.mishap_bp, mishap_loss_bp: C.mishap_loss_bp, credit_day: u(C.credit_day), starter_gold_millis: u(C.starter_gold_millis), closed_goods_bp: C.closed_goods_bp, think_fee_millis: u(C.think_fee_millis) },
    goods: Object.keys(R.GOODS).map(t => ({ token: t, usual: u(R.GOODS[t]), rot_bp: R.ROT_BP[t] || 0 })),
    events: R.EVENTS.map(e => ({ token: e[1], mult: e[2] })),
    merchants: R.MERCHANTS.map(m => ({ id: m.id + '.' + root, name: m.name, goods: m.goods, till: u(m.till), care: m.care, greed: m.greed, nerve: m.nerve, prompt_hash: o.prompts && o.prompts[m.id] ? crypto.createHash('sha256').update(o.prompts[m.id]).digest('hex') : null })),
  };
}
if (require.main === module) console.log(JSON.stringify(initArgs(process.argv[2] || 'tilldawn.testnet'), null, 1));
module.exports = { initArgs };
