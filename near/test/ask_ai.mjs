// node near/test/ask_ai.mjs      Asking NEAR AI when its machines misbehave, with no network at all: a stuck machine, a failing one, a proof that never comes. A visitor must get an answer in moments, or the rulebook's.
const { askNearAI } = await import('../../src/bazaar.js');

let fails = 0; const ok = (c, m) => { console.log((c ? '  ok   ' : '  FAIL ') + m); if (!c) fails++; };
const ANSWER = JSON.stringify({ id: 'chat-1', model: 'm', choices: [{ message: { content: '{"give":5,"say":"Five off."}' } }] }), PROOF = JSON.stringify({ signature: '0xabc', text: 'a:b', signing_address: '0x1' });
const hang = init => new Promise((_, rej) => { init.signal.addEventListener('abort', () => { const e = new Error('aborted'); e.name = 'AbortError'; rej(e); }); });
const res = (body, status = 200) => ({ ok: status < 400, status, text: async () => body });
/** chat: what each call to the AI does, in order; sig: what each call for the proof does */
function net(chat, sig) { const log = { chat: 0, sig: 0 }; globalThis.fetch = async (url, init) => { if (/chat\/completions/.test(url)) { const f = chat[Math.min(log.chat, chat.length - 1)]; log.chat++; return f(init); } const f = sig[Math.min(log.sig, sig.length - 1)]; log.sig++; return f(init); }; return log; }
const good = async () => res(ANSWER), bad = async () => res('{"error":"busy"}', 503), proofGood = async () => res(PROOF), env = { NEARAI_KEY: 'test', NEARAI_BASE: 'http://ai.test' }, O = { limitMs: 600, hedgeMs: 120, proofMs: 200 }, quiet = console.log;
const timed = async o => { console.log = () => {}; const t = Date.now(), a = await askNearAI(env, 'sys', 'user', o || O); console.log = quiet; return { a, ms: Date.now() - t }; };
{ const log = net([good], [proofGood]), { a, ms } = await timed(); ok(a && a.decision.give === 5 && a.proof && log.chat === 1 && log.sig === 1 && ms < 100, `the plain case: one question, one answer, the proof (${ms} ms)`); }
{ const log = net([hang, good], [proofGood]), { a, ms } = await timed(); ok(a && a.decision.give === 5 && log.chat === 2 && ms >= 120 && ms < 400, `a stuck machine: the same question goes again, and the answer comes in moments (${ms} ms)`); ok(a && a.request === JSON.stringify(JSON.parse(a.request)), 'the request kept for the seal is the one that was sent'); }
{ const log = net([bad, good], [proofGood]), { a, ms } = await timed(); ok(a && log.chat === 2 && ms < 100, `a failing machine: asked again at once (${ms} ms)`); }
{ const log = net([hang], [proofGood]), { a, ms } = await timed(); ok(a === null && log.chat === 2 && ms >= 590 && ms < 900, `nobody answers: the caller goes on without an answer at its limit (${ms} ms)`); }
{ const log = net([bad], [proofGood]), { a, ms } = await timed(); ok(a === null && log.chat === 2 && ms < 100, `everybody refuses: said at once (${ms} ms)`); }
{ const log = net([good], [hang]), { a, ms } = await timed(); ok(a && a.decision.give === 5 && !a.proof && ms < 400, `a proof that never comes does not hold the answer back (${ms} ms, ${log.sig} tries)`); }
{ const log = net([good], [async () => res('{}', 404), async () => res('{}', 404), proofGood]), { a } = await timed({ limitMs: 600, hedgeMs: 120, proofMs: 4000 }); ok(a && a.proof && log.sig === 3, 'a proof not ready yet is asked for again'); }
{ const log = net([async () => res('no json here')], [proofGood]), { a } = await timed(); ok(a === null && log.chat === 1, 'an answer that cannot be read counts as none'); }
console.log(fails ? `\n${fails} check(s) FAILED` : '\nAll checks passed.'); process.exit(fails ? 1 : 0);
