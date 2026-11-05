// near/worker/index.js   The market's server on its own, without the game around it, so the repository can be run from scratch (near/scripts/local_demo.sh). In the game the same two functions are mounted in the game's Worker.
import { handleBazaar, bazaarCron } from '../../src/bazaar.js';
const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json' } });
const readJson = async (req, max) => { const t = await req.text(); if (t.length > max) throw new Error('too big'); return JSON.parse(t || '{}'); };
export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (url.pathname.startsWith('/api/bazaar/')) return handleBazaar(req, env, url, { json, readJson, authUser: async () => null });
    return json({ ok: true, about: 'The Grand Market of Till Dawn. The game itself is at https://tilldawngame.com/?market. The API is under /api/bazaar/.' });
  },
  async scheduled(_ev, env) { await bazaarCron(env); },
};
