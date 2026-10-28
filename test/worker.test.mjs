import assert from 'node:assert/strict';
import { handle, rankModels } from '../worker/src/index.js';

const env = { REPO: 'me/repo', DATA_BRANCH: 'data', ASSETS: { fetch: async () => new Response('<html>app</html>') } };
const store = new Map();
const cache = { match: async (k) => store.get(k.url), put: async (k, v) => { store.set(k.url, v); } };
const calls = [];
const files = {
  'quotes.json': { asof: 'T', quotes: { V: { price: 300, pct: 1.2, asof: 5 } } },
  'filings.json': { generated_at: 'G', filings: { LIN: { accession: 'a' } } },
  'history/V.json': { bars: [[1, 1, 1, 1, 1, 1]] },
};
const yahoo = (sym) => ({ chart: { result: [{ meta: { regularMarketPrice: 110, chartPreviousClose: 100, regularMarketTime: 9, currency: 'USD' } }] } });
const f = async (url) => {
  calls.push(String(url));
  const u = String(url);
  if (u.startsWith('https://raw.githubusercontent.com/me/repo/data/')) {
    const file = u.split('/data/')[1];
    return files[file] ? new Response(JSON.stringify(files[file])) : new Response('nf', { status: 404 });
  }
  if (u.includes('query1.finance.yahoo.com')) {
    if (u.includes('BAD')) return new Response('x', { status: 500 });
    return new Response(JSON.stringify(yahoo()));
  }
  return new Response('?', { status: 500 });
};
const get = (p) => handle(new Request('https://x.dev' + p), env, {}, f, cache);

let r = await get('/');
assert.equal(await r.text(), '<html>app</html>', 'non-api goes to assets');

r = await get('/api/quotes');
assert.equal(r.status, 200); assert.equal((await r.json()).quotes.V.price, 300);
const before = calls.length;
await get('/api/quotes');
assert.equal(calls.length, before, 'second call served from edge cache');

r = await get('/api/history/V'); assert.equal(r.status, 200);
r = await get('/api/history/NOPE'); assert.equal(r.status, 404);
r = await get('/api/history/..%2Fsecret'); assert.ok([400, 404].includes(r.status));
r = await get('/api/history/v'); assert.equal(r.status, 404, 'lowercase does not match a route');

r = await get('/api/baseline'); const b = await r.json();
assert.equal(b.generated_at, 'G'); assert.equal(b.quotes.V.price, 300); assert.ok(b.filings.LIN);

r = await get('/api/live?symbols=V,LIN,^TNX'); const l = await r.json();
assert.equal(r.status, 200); assert.equal(l.quotes.V.change_pct, 10); assert.equal(l.delayed, true);
r = await get('/api/live?symbols=V,BAD'); l.errors = (await r.json()).errors; assert.equal(l.errors.length, 1);
r = await get('/api/live?symbols=evil.com/x'); assert.equal(r.status, 400);
r = await get('/api/live'); assert.equal(r.status, 400);
r = await get('/api/live?symbols=' + Array.from({ length: 30 }, (_, i) => 'A' + i).join(',')); assert.equal(r.status, 200);

r = await handle(new Request('https://x.dev/api/quotes', { method: 'POST' }), env, {}, f, cache); assert.equal(r.status, 405);
r = await handle(new Request('https://x.dev/api/quotes'), {}, {}, f, cache); assert.equal(r.status, 500);
r = await get('/api/nothing'); assert.equal(r.status, 404);


// chat: Gemini first, Groq as backup
const mk = (name, gen = true) => ({ name: 'models/' + name, supportedGenerationMethods: gen ? ['generateContent'] : ['embedContent'] });
assert.deepEqual(rankModels([mk('gemini-2.5-flash'), mk('gemini-3.8-flash'), mk('gemini-3.5-flash-lite'), mk('gemini-3.8-flash-preview-09-2026'), mk('gemini-3.8-flash-image'), mk('gemini-2.5-pro'), mk('text-embedding-004', false)]).slice(0, 3),
  ['gemini-3.8-flash', 'gemini-3.8-flash-preview-09-2026', 'gemini-3.5-flash-lite']);
const chatReq = (body, origin) => new Request('https://x.dev/api/chat', { method: 'POST', headers: origin ? { origin } : {}, body: typeof body === 'string' ? body : JSON.stringify(body) });
const log = [];
const ff = (gem, grq) => async (u, o) => {
  u = String(u); log.push(u);
  if (u.includes('generativelanguage') && u.endsWith('models?pageSize=200')) return new Response(JSON.stringify({ models: [mk('gemini-3.8-flash'), mk('gemini-3.5-flash')] }));
  if (u.includes('generativelanguage')) return gem(u, JSON.parse(o.body));
  if (u.includes('groq')) return grq(u, JSON.parse(o.body));
  return f(u, o);
};
const ok = (x) => new Response(JSON.stringify(x));
const q = { messages: [{ role: 'assistant', content: 'hello' }, { role: 'user', content: 'my view' }], context: 'CTX' };
r = await handle(chatReq(q), env, {}, ff(), cache); assert.equal(r.status, 503);
const envG = Object.assign({}, env, { GEMINI_API_KEY: 'g', GROQ_API_KEY: 'q' });
r = await handle(chatReq(q), envG, {}, ff((u, b) => { assert.ok(b.systemInstruction.parts[0].text.includes('CTX')); assert.equal(b.contents.length, 1); assert.equal(b.contents[0].role, 'user'); return ok({ candidates: [{ content: { parts: [{ text: 'thinking', thought: true }, { text: 'Gemini answer [[note: x]]' }] } }] }); }), cache);
let cj = await r.json(); assert.equal(cj.reply, 'Gemini answer [[note: x]]'); assert.equal(cj.model, 'gemini-3.8-flash');
log.length = 0;
r = await handle(chatReq(q), envG, {}, ff(() => new Response('{}', { status: 429 }), (u, b) => { assert.equal(b.model, 'openai/gpt-oss-120b'); assert.equal(b.messages[0].role, 'system'); return ok({ choices: [{ message: { content: 'Groq answer' } }] }); }), cache);
cj = await r.json(); assert.equal(cj.reply, 'Groq answer'); assert.equal(cj.model, 'openai/gpt-oss-120b');
assert.equal(log.filter((u) => u.includes(':generateContent')).length, 2);
r = await handle(chatReq(q), envG, {}, ff(() => new Response('{}', { status: 429 }), () => new Response('{}', { status: 429 })), cache); assert.equal(r.status, 429);
r = await handle(chatReq(q), Object.assign({}, env, { GROQ_API_KEY: 'q' }), {}, ff(null, (u, b) => ok({ choices: [{ message: { content: '<think>x</think>Only Groq' } }] })), cache);
cj = await r.json(); assert.equal(cj.reply, 'Only Groq');
r = await handle(chatReq(q), envG, {}, ff(() => new Response('{"error":{"message":"bad key"}}', { status: 403 }), () => new Response('{}', { status: 401 })), cache); assert.equal(r.status, 503);
r = await handle(chatReq({ messages: [{ role: 'assistant', content: 'x' }] }), envG, {}, ff(), cache); assert.equal(r.status, 400);
r = await handle(chatReq('nope'), envG, {}, ff(), cache); assert.equal(r.status, 400);
r = await handle(chatReq(q, 'https://evil.com'), envG, {}, ff(), cache); assert.equal(r.status, 403);
r = await handle(new Request('https://x.dev/api/chat'), envG, {}, ff(), cache); assert.equal(r.status, 405);
console.log('worker tests passed');
