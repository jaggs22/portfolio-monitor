import assert from 'node:assert/strict';
import { handle, rankModels, preferModels, restFor, _chatTest, _limitsTest, ChatLimits } from '../worker/src/index.js';

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


// chat: a ladder of free models with cooldowns
const mk = (name, gen = true) => ({ name: 'models/' + name, supportedGenerationMethods: gen ? ['generateContent'] : ['embedContent'] });
assert.deepEqual(rankModels([mk('gemini-2.5-flash'), mk('gemini-3.8-flash'), mk('gemini-3.5-flash-lite'), mk('gemini-3.8-flash-preview-09-2026'), mk('gemini-3.8-flash-image'), mk('gemini-2.5-pro'), mk('text-embedding-004', false)]).slice(0, 3),
  ['gemini-3.8-flash', 'gemini-3.8-flash-preview-09-2026', 'gemini-3.5-flash-lite']);
assert.deepEqual(preferModels(['meta/llama-3.3-70b-instruct', 'deepseek-ai/deepseek-v4-pro', 'deepseek-ai/deepseek-v4-pro-0813-fp8', 'openai/gpt-oss-120b'], [/deepseek-v4[.\d]*-pro/, /gpt-oss-120b/]), ['deepseek-ai/deepseek-v4-pro', 'openai/gpt-oss-120b']);
assert.deepEqual(preferModels(['meta/llama-3.3-70b-instruct', 'openai/gpt-oss-120b'], [/deepseek-v4[.\d]*-pro/, /deepseek-v4/]), []);
assert.equal(restFor(200), 0);
assert.equal(restFor(429, new Headers({ 'retry-after': '20' }), 'slow down'), 20);
assert.equal(restFor(429, new Headers(), 'Quota exceeded for metric: generate_content_free_tier_requests, limit: 1500 per day'), 3600);
assert.equal(restFor(429, new Headers(), 'Rate limit reached for model on requests per minute'), 60);
const cstore = new Map();
const ccache = { match: async (k) => { const v = cstore.get(k.url); return v ? v.clone() : undefined; }, put: async (k, v) => { cstore.set(k.url, v); } };
const chatReq = (body, origin) => new Request('https://x.dev/api/chat', { method: 'POST', headers: origin ? { origin } : {}, body: typeof body === 'string' ? body : JSON.stringify(body) });
const ok = (x) => new Response(JSON.stringify(x));
const hits = [];
const ff = (h) => async (u, o) => {
  u = String(u);
  if (u.endsWith('models?pageSize=200')) return ok({ models: [mk('gemini-3.8-flash'), mk('gemini-3.5-flash')] });
  if (u === 'https://integrate.api.nvidia.com/v1/models') return ok({ data: [{ id: 'deepseek-ai/deepseek-v4-pro' }, { id: 'meta/llama-3.3-70b-instruct' }] });
  const b = o && o.body ? JSON.parse(o.body) : {};
  const model = b.model || (u.match(/models\/([^:]+):(?:streamGenerateContent|generateContent)/) || [])[1];
  hits.push(model);
  return h(model, b, u);
};
const sse = (events) => new Response(events.map((e) => 'data: ' + (typeof e === 'string' ? e : JSON.stringify(e)) + '\n\n').join(''), { headers: { 'content-type': 'text/event-stream' } });
const geminiOk = (t) => sse([{ candidates: [{ content: { parts: [{ text: 'hidden', thought: true }, { text: t.slice(0, 3) }] } }] }, { candidates: [{ content: { parts: [{ text: t.slice(3) }] } }] }]);
const oaiOk = (t) => sse([{ choices: [{ delta: { content: t.slice(0, 2) } }] }, { choices: [{ delta: { content: t.slice(2) } }] }, '[DONE]']);
const rj = async (r) => {
  if (!(r.headers.get('content-type') || '').includes('ndjson')) return r.json();
  const lines = (await r.text()).trim().split('\n').map((x) => JSON.parse(x));
  return Object.assign({ reply: lines.filter((x) => x.t).map((x) => x.t).join('').replace(/<think>[\s\S]*?<\/think>/g, '') }, lines.find((x) => x.done));
};
const q = { messages: [{ role: 'assistant', content: 'hello' }, { role: 'user', content: 'my view' }], context: 'CTX' };
const call = (e, h) => handle(chatReq(q), e, {}, ff(h), ccache);
const all = Object.assign({}, env, { GEMINI_API_KEY: 'g', NVIDIA_API_KEY: 'n', GROQ_API_KEY: 'q', MISTRAL_API_KEY: 'ignored', OPENROUTER_API_KEY: 'ignored' });
_chatTest.reset();
r = await handle(chatReq(q), env, {}, ff(), ccache); assert.equal(r.status, 503);
// top rung answers; system prompt carries the context; leading assistant turn dropped
r = await call(all, (m, b, u) => { assert.ok(u.endsWith(':streamGenerateContent?alt=sse')); assert.deepEqual(b.generationConfig.thinkingConfig, { thinkingLevel: 'low' }); assert.ok(b.systemInstruction.parts[0].text.includes('CTX')); assert.equal(b.contents.length, 1); return geminiOk('Gemini answer'); });
let cj = await rj(r); assert.equal(cj.reply, 'Gemini answer'); assert.equal(cj.provider, 'gemini'); assert.equal(cj.model, 'gemini-3.8-flash');
// Gemini daily quota spent: both Gemini models rest, NVIDIA answers; next request skips Gemini without calling it
hits.length = 0;
r = await call(all, (m) => (/gemini/.test(m) ? new Response('{"error":{"message":"Quota exceeded ... per day"}}', { status: 429 }) : oaiOk('NVIDIA answer')));
cj = await rj(r); assert.equal(cj.provider, 'nvidia'); assert.equal(cj.model, 'deepseek-ai/deepseek-v4-pro'); assert.deepEqual(hits, ['gemini-3.8-flash', 'gemini-3.5-flash', 'deepseek-ai/deepseek-v4-pro']);
hits.length = 0;
r = await call(all, () => oaiOk('NVIDIA again')); cj = await rj(r); assert.equal(cj.provider, 'nvidia'); assert.deepEqual(hits, ['deepseek-ai/deepseek-v4-pro']);
// cooldown is shared through the edge cache: a fresh isolate (cleared memory) still skips Gemini
_chatTest.reset(); hits.length = 0;
r = await call(all, () => oaiOk('still NVIDIA')); cj = await rj(r); assert.equal(cj.provider, 'nvidia'); assert.ok(!hits.some((x) => /gemini/.test(x)));
// Gemini and NVIDIA limited: Groq answers; only the three providers are ever called
_chatTest.reset(); cstore.clear(); hits.length = 0;
r = await call(all, (m) => (/gpt-oss-120b/.test(m) ? oaiOk('Groq answer') : new Response('{}', { status: 429 }))); cj = await rj(r); assert.equal(cj.provider, 'groq');
assert.deepEqual(hits, ['gemini-3.8-flash', 'gemini-3.5-flash', 'deepseek-ai/deepseek-v4-pro', 'openai/gpt-oss-120b']);
// every rung limited -> 429, and nothing outside the three providers is tried
_chatTest.reset(); cstore.clear(); hits.length = 0;
r = await call(all, () => new Response('{}', { status: 429 })); assert.equal(r.status, 429);
assert.ok(hits.every((m) => /gemini|deepseek|gpt-oss|qwen/.test(m)));
// a rejected key skips every rung that uses it (groq and groq-small)
_chatTest.reset(); cstore.clear(); hits.length = 0;
r = await call(Object.assign({}, env, { GROQ_API_KEY: 'bad', NVIDIA_API_KEY: 'n' }), (m) => (/deepseek/.test(m) ? new Response('{}', { status: 500 }) : new Response('{}', { status: 401 })));
assert.equal(r.status, 503); assert.deepEqual(hits, ['deepseek-ai/deepseek-v4-pro', 'openai/gpt-oss-120b']);
// groq gets trimmed context and low reasoning effort; <think> stripped
_chatTest.reset(); cstore.clear();
r = await handle(chatReq({ messages: q.messages, context: 'x'.repeat(40000) }), Object.assign({}, env, { GROQ_API_KEY: 'q' }), {}, ff((m, b) => { assert.ok(b.messages[0].content.length < 16000); assert.equal(b.reasoning_effort, 'low'); assert.equal(b.stream, true); return oaiOk('<think>a</think>Groq'); }), ccache);
cj = await rj(r); assert.equal(cj.reply, 'Groq');
r = await handle(chatReq({ messages: [{ role: 'assistant', content: 'x' }] }), all, {}, ff(), ccache); assert.equal(r.status, 400);
r = await handle(chatReq('nope'), all, {}, ff(), ccache); assert.equal(r.status, 400);
r = await handle(chatReq(q, 'https://evil.com'), all, {}, ff(), ccache); assert.equal(r.status, 403);
r = await handle(new Request('https://x.dev/api/chat'), all, {}, ff(), ccache); assert.equal(r.status, 405);

// zero-cost ceilings
_chatTest.reset(); _limitsTest.reset(); cstore.clear();
const capEnv = Object.assign({}, env, { GROQ_API_KEY: 'q', CHAT_DAILY_CAP: '3' });
for (let i = 0; i < 3; i++) { r = await call(capEnv, () => oaiOk('ok ' + i)); cj = await rj(r); assert.equal(r.status, 200); assert.equal(cj.left, 2 - i); assert.equal(cj.cap, 3); assert.equal(cj.used, i + 1); assert.equal(cj.reply, 'ok ' + i); }
hits.length = 0;
r = await call(capEnv, () => oaiOk('should not be called')); cj = await rj(r);
assert.equal(r.status, 429); assert.equal(cj.left, 0); assert.match(cj.error, /used up for everyone/); assert.equal(hits.length, 0);
r = await handle(new Request('https://x.dev/api/chat/status'), capEnv, {}, ff(), ccache); cj = await rj(r); assert.equal(cj.left, 0); assert.ok(cj.resets_at.endsWith('T00:00:00.000Z')); assert.equal(cj.on, true);
r = await handle(new Request('https://x.dev/api/chat/status'), env, {}, ff(), ccache); cj = await rj(r); assert.equal(cj.on, false); assert.equal(cj.left, 0);
// per-model ceiling: NVIDIA stops at 400 a day even with room overall
_limitsTest.reset(); _chatTest.reset();
const nvOnly = Object.assign({}, env, { NVIDIA_API_KEY: 'n', CHAT_DAILY_CAP: '5000' });
for (let i = 0; i < 400; i++) { r = await call(nvOnly, () => oaiOk('xx')); assert.equal(r.status, 200); await r.text(); }
r = await call(nvOnly, () => oaiOk('x')); assert.equal(r.status, 429);
// the Durable Object counter: all-or-nothing, resets on a new day
const mem = new Map();
const storage = { get: async (k) => mem.get(k), put: async (k, v) => { mem.set(k, v); }, deleteAll: async () => mem.clear(), list: async ({ prefix }) => new Map([...mem].filter(([k]) => k.startsWith(prefix))) };
const lim = new ChatLimits({ storage });
const take = async (q) => (await (await lim.fetch(new Request('https://limits/take?' + q))).json()).ok;
assert.equal(await take('k=all&cap=2&k=m1&cap=1'), true);
assert.equal(await take('k=all&cap=2&k=m1&cap=1'), false);
assert.equal(await take('k=all&cap=2&k=m2&cap=5'), true);
assert.equal(await take('k=all&cap=2&k=m3&cap=5'), false);
assert.deepEqual(await (await lim.fetch(new Request('https://limits/status'))).json(), { all: 2, m1: 1, m2: 1 });
mem.set('day', '1999-01-01');
assert.equal(await take('k=all&cap=2&k=m1&cap=1'), true);

// a model that rejects the thinking setting is asked again without it
_chatTest.reset(); _limitsTest.reset(); cstore.clear();
let tries = 0;
r = await call(Object.assign({}, env, { GEMINI_API_KEY: 'g' }), (m, b) => { tries++; return b.generationConfig.thinkingConfig ? new Response('{"error":{"message":"thinking_level is not supported"}}', { status: 400 }) : geminiOk('plain'); });
cj = await rj(r); assert.equal(cj.reply, 'plain'); assert.equal(tries, 2);
r = await handle(new Request('https://x.dev/api/chat/status'), Object.assign({}, env, { GEMINI_API_KEY: 'g', GROQ_API_KEY: 'q' }), {}, ff(), ccache); cj = await r.json();
assert.equal(cj.cap, 1500); assert.equal(cj.used, 1); assert.equal(cj.left, 1499);
console.log('worker tests passed');
