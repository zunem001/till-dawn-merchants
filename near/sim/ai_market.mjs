// node near/sim/ai_market.mjs [days] [hoursPerThought]     THE MARKET RUN BY THE REAL AI, MEASURED, on the local chain (near/scripts/sandbox.sh, in Linux or WSL) with the key in .dev.vars. Every game hour each merchant due to think asks NEAR AI and its own key brings the answer, exactly as the live market does; the clock runs fast (`set_config`, the owner's key).
//   See: for each game day the tills, who broke, the caravans and deals, the stock against what each aims for, and what the thinking cost. A rulebook market is measured by near/sim/week.js; this is the same market with the AI's own judgement in it.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Act, derivedKey, keyFromSecret, nearClient } from '../../src/near.js';
import { factsFor } from '../../src/bazaar.js';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url), R = require('../../market_rules.js');
const days = +process.argv[2] || 3, EVERY = +process.argv[3] || 1, root = 'test.near', MARKET = 'market.' + root, client = nearClient(['http://127.0.0.1:3030']), SEED = 'sandbox-test-secret', MODEL = process.env.NEAR_MODEL || 'Qwen/Qwen3.8-27B';
const keyLine = fs.readFileSync(path.resolve(import.meta.dirname, '../../.dev.vars'), 'utf8').split(/\r?\n/).find(l => l.startsWith('NEARAI_KEY=')), KEY = keyLine ? keyLine.slice(11) : ''; if (!KEY) { console.log('No NEARAI_KEY in .dev.vars'); process.exit(1); }
const rk = await keyFromSecret(JSON.parse(fs.readFileSync(path.join(os.homedir(), 'sandbox', 'home', 'validator_key.json'), 'utf8')).secret_key);
const short = id => id.split('.')[0], sleep = ms => new Promise(r => setTimeout(r, ms)), state = () => client.view(MARKET, 'state', {});
const usual = await client.view(MARKET, 'get_config', {}); await client.tx(root, rk, MARKET, [Act.call('set_config', { cfg: { ...usual, tick_ms: 1 } }, 30)]); await sleep(1000);
let tok = [0, 0], asked = 0, bad = 0, cuts = 0, deals = 0, caravanCalls = 0, broke = {}; const said = {};
async function think(st, m) {
  const def = R.MERCHANTS.find(d => d.id === short(m.id)), body = JSON.stringify({ model: MODEL, messages: [{ role: 'system', content: R.merchantPrompt(def) }, { role: 'user', content: factsFor(st, m) }], temperature: 0.7, max_tokens: 400, chat_template_kwargs: { enable_thinking: false } });
  let j = null; for (let n = 0; n < 3 && !j; n++) { try { const r = await fetch('https://cloud-api.near.ai/v1/chat/completions', { method: 'POST', headers: { authorization: 'Bearer ' + KEY, 'content-type': 'application/json' }, body }); if (r.ok) j = await r.json(); else { console.log('  AI answered', r.status); await sleep(2000); } } catch (e) { await sleep(2000); } } if (!j) { bad++; return; }
  asked++; tok[0] += (j.usage && j.usage.prompt_tokens) || 0; tok[1] += (j.usage && j.usage.completion_tokens) || 0; const c = j.choices[0].message.content || '', a = c.indexOf('{'), b = c.lastIndexOf('}'); if (a < 0 || b < a) { bad++; return; } let d; try { d = JSON.parse(c.slice(a, b + 1)); } catch (e) { bad++; return; }
  const out = await client.tx(m.id, await derivedKey(SEED, 'merchant:' + def.id), MARKET, [Act.call('decide', { decision: c.slice(a, b + 1), model: MODEL }, 60)]).catch(e => ({ ok: false, failure: e.message })); if (!out.ok) { bad++; return; }
  const ev = (out.events || []); cuts += ev.filter(e => e.event === 'decision').reduce((x, e) => x + ((e.data[0].pulled || []).length), 0); deals += ev.filter(e => e.event === 'deal').length; if ((d.caravan || []).length) caravanCalls++; said[def.id] = d.say;
}
console.log(`The market on ${MODEL}, ${days} game days, each merchant thinking every ${EVERY} hour(s)`);
const t0 = Date.now(); let st = await state(); const startTotal = st.merchants.reduce((a, m) => a + Number(m.till), 0);
for (let hour = 1; hour <= days * 24; hour++) {
  for (let t = 0; t < 6; t++) { await client.tx(root, rk, MARKET, [Act.call('crank', {}, 200)]).catch(() => {}); await sleep(120); }
  st = await state(); if (hour % EVERY === 0) await Promise.all(st.merchants.filter(m => m.open).map(m => think(st, m)));
  st = await state(); for (const m of st.merchants) if (!m.open) broke[short(m.id)] = (broke[short(m.id)] || 0) + (m.closed_at >= st.tick - 6 ? 1 : 0);
  if (hour % 24 === 0) {
    const cost = tok[0] * 0.04e-6 + tok[1] * 1.35e-6; console.log(`\nDay ${hour / 24}, tick ${st.tick}, ${((Date.now() - t0) / 60000).toFixed(1)} min. Asked ${asked}, unusable ${bad}, cut by the leash ${cuts}, deals ${deals}, with caravans ${caravanCalls}, thinking cost $${cost.toFixed(4)}. Treasury ${(Number(st.treasury) / 1000).toFixed(0)}.`);
    for (const m of st.merchants) console.log(`  ${short(m.id).padEnd(5)} ${m.open ? '     ' : 'SHUT '} till ${(Number(m.till) / 1000).toFixed(0).padStart(5)}  ${m.goods.map(g => `${g.token} ${g.stock}/${g.target} sold ${g.sold_yesterday} @${(Number(R.unitPrice(g.base, g.target, g.stock)) / R.GOODS[g.token]).toFixed(2)}x m${(g.spread_bp / 100).toFixed(0)}%`).join('  ')}`);
    console.log('  broke so far:', JSON.stringify(broke), ' words:', Object.entries(said).slice(0, 3).map(([k, v]) => `${k}: "${v}"`).join(' '));
  }
}
const end = st.merchants.reduce((a, m) => a + Number(m.till), 0); console.log(`\nAll tills: ${(startTotal / 1000).toFixed(0)} at the start, ${(end / 1000).toFixed(0)} at the end. Stalls broke: ${Object.values(broke).reduce((a, b) => a + b, 0)}.`);
await client.tx(root, rk, MARKET, [Act.call('set_config', { cfg: usual }, 30)]);
