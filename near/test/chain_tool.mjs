// near/test/chain_tool.mjs <break|dawn|restore>   on the LOCAL test chain only, as the market's owner: bad times on demand, so that the game's own answer to a broken stall can be tested. Run in Linux. It prints what happened as one line of JSON.
//   break     dawn comes every other tick, and one dawn's rent takes all but 20 gold from the poorest till. At the next dawn, at the usual rent, the poorest cannot pay: a break as it really happens, with a nearly empty till.
//   dawn      more quick dawns at the usual rent: the poor break, and after a while the street's richest or the City lends them enough to open.
//   restore   the clock goes back to ten minutes a tick and a market day to 144 ticks.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Act, keyFromSecret, nearClient } from '../../src/near.js';
const what = process.argv[2], root = 'test.near', MARKET = 'market.' + root, client = nearClient(['http://127.0.0.1:3030']);
const rk = await keyFromSecret(JSON.parse(fs.readFileSync(path.join(os.homedir(), 'sandbox', 'home', 'validator_key.json'), 'utf8')).secret_key);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const setCfg = cfg => client.tx(root, rk, MARKET, [Act.call('set_config', { cfg }, 30)]);
const crank = () => client.tx(root, rk, MARKET, [Act.call('crank', {}, 200)]).catch(e => ({ failed: String(e.message || e).slice(0, 80) }));
const state = () => client.view(MARKET, 'state', {});
const short = m => m.id.split('.')[0];
const closed = async () => (await state()).merchants.filter(m => !m.open).map(short);
const usual = await client.view(MARKET, 'get_config', {});
if (what === 'break') {
  const tills = (await state()).merchants.filter(m => m.open).map(m => BigInt(m.till)), low = tills.reduce((a, b) => (b < a ? b : a));
  await setCfg({ ...usual, tick_ms: 1, day_ticks: 2, rent_millis: String(low > 25000n ? low - 20000n : 5000n) }); await sleep(1200);
  for (let i = 0; i < 3; i++) { await crank(); await sleep(250); if ((await state()).tick % 2 === 0) break; }
  await setCfg({ ...usual, tick_ms: 1, day_ticks: 2 }); await sleep(800);
  for (let i = 0; i < 8 && !(await closed()).length; i++) { await crank(); await sleep(250); }
  const st = await state(); console.log(JSON.stringify({ closed: st.merchants.filter(m => !m.open).map(short), tills: Object.fromEntries(st.merchants.map(m => [short(m), Number(m.till) / 1000])) }));
} else if (what === 'dawn') {
  const broke = new Set(), lent = new Set(); let was = await closed();
  for (let i = 0; i < 16; i++) { await crank(); await sleep(150); const now = await closed(); for (const x of now) if (!was.includes(x)) broke.add(x); for (const x of was) if (!now.includes(x)) lent.add(x); was = now; if (lent.size && i >= 6) break; }
  console.log(JSON.stringify({ broke: [...broke], lent: [...lent], still: was }));
} else if (what === 'restore') {
  await setCfg({ ...usual, tick_ms: 600000, day_ticks: 144 }); console.log(JSON.stringify({ tick_ms: 600000, closed: await closed() }));
} else { console.log('near/test/chain_tool.mjs <break|dawn|restore>'); process.exit(1); }
