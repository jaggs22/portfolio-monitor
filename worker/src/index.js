/* Cloudflare Worker: serves the PWA (static assets) and a small read API.
 *
 * Data is produced by scheduled GitHub Actions and published to the `data` branch of the repo; this Worker only
 * relays and caches it (the free plan allows 10 ms CPU, so nothing heavy happens here). One route, /api/live,
 * proxies Yahoo's public chart feed for the freshest delayed quote and is edge-cached for 20 seconds so many
 * viewers cost one upstream call. */

const TICKER = /^[A-Z][A-Z0-9.\-]{0,9}$/;
const LIVE_SYMBOL = /^(\^?[A-Z][A-Z0-9.\-]{0,9}|[A-Z]{2,5}=F|[A-Z]{2,5}-[A-Z]{3}|DX-Y\.NYB)$/;
const YAHOO = 'https://query1.finance.yahoo.com/v8/finance/chart/';
const UA = 'Mozilla/5.0 (compatible; portfolio-monitor/1.0)';

// path template -> [file in data branch, edge TTL seconds]
const ROUTES = [
  [/^\/api\/health$/, () => 'health.json', 60],
  [/^\/api\/quotes$/, () => 'quotes.json', 60],
  [/^\/api\/news$/, () => 'news.json', 300],
  [/^\/api\/news\/([A-Z.\-]+)$/, (m) => `news/${m[1]}.json`, 300],
  [/^\/api\/history\/([A-Z.\-]+)$/, (m) => `history/${m[1]}.json`, 900],
  [/^\/api\/intraday\/([A-Z.\-]+)$/, (m) => `intraday/${m[1]}.json`, 60],
  [/^\/api\/fundamentals\/([A-Z.\-]+)$/, (m) => `fundamentals/${m[1]}.json`, 1800],
  [/^\/api\/evidence\/([A-Z.\-]+)$/, (m) => `evidence/${m[1]}.json`, 900],
  [/^\/api\/mgmt\/([A-Z.\-]+)$/, (m) => `mgmt/${m[1]}.json`, 1800],
  [/^\/api\/peers\/([A-Z.\-]+)$/, (m) => `peers/${m[1]}.json`, 1800],
  [/^\/api\/segments\/([A-Z.\-]+)$/, (m) => `segments/${m[1]}.json`, 3600],
];

const SEC_HEADERS = { 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer' };

function json(body, status = 200, ttl = 0, extra = {}) {
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': ttl ? `public, max-age=${ttl}` : 'no-store', ...SEC_HEADERS, ...extra },
  });
}

/* Private repositories work too: set a read-only fine-grained token as the GH_TOKEN secret. */
function auth(env) {
  return env.GH_TOKEN ? { headers: { authorization: `Bearer ${env.GH_TOKEN}` } } : {};
}

function rawUrl(env, file) {
  const repo = env.REPO, branch = env.DATA_BRANCH || 'data';
  return `https://raw.githubusercontent.com/${repo}/${branch}/${file}`;
}

async function cached(cache, key, ttl, make) {
  if (cache) {
    const hit = await cache.match(key);
    if (hit) return hit;
  }
  const res = await make();
  if (res.ok && cache) await cache.put(key, res.clone());
  return res;
}

async function fromData(env, file, ttl, f, cache, ctx, request) {
  const key = new Request(new URL(request.url).origin + '/__data/' + file);
  return cached(cache, key, ttl, async () => {
    const r = await f(rawUrl(env, file), Object.assign({ cf: { cacheTtl: ttl, cacheEverything: true } }, auth(env)));
    if (r.status === 404) return json({ error: 'not published yet', file }, 404, 30);
    if (!r.ok) return json({ error: 'upstream', status: r.status }, 502, 10);
    return json(await r.text(), 200, ttl);
  });
}

/* /api/baseline: the shape the app already reads ({generated_at, filings, quotes}), assembled from the filings
   and quotes files. If filings are not published yet it still returns quotes. */
async function baseline(env, f, cache, request) {
  const key = new Request(new URL(request.url).origin + '/__data/baseline');
  return cached(cache, key, 60, async () => {
    const [fr, qr] = await Promise.all([f(rawUrl(env, 'filings.json'), auth(env)), f(rawUrl(env, 'quotes.json'), auth(env))]);
    const filings = fr.ok ? await fr.json().catch(() => ({})) : {};
    const qs = qr.ok ? await qr.json().catch(() => ({})) : {};
    const quotes = {};
    for (const [t, q] of Object.entries(qs.quotes || {})) quotes[t] = { price: q.price, chg: q.pct, asof: q.asof };
    return json({ generated_at: filings.generated_at || qs.asof || null, filings: filings.filings || {}, quotes, quotes_asof: qs.asof || null }, 200, 60);
  });
}

function parseLive(sym, body) {
  const r = body && body.chart && body.chart.result && body.chart.result[0];
  const m = r && r.meta;
  if (!m || m.regularMarketPrice == null) return null;
  const prev = m.chartPreviousClose ?? m.previousClose ?? null;
  return {
    symbol: sym, price: m.regularMarketPrice, prev_close: prev,
    change: prev != null ? +(m.regularMarketPrice - prev).toFixed(4) : null,
    change_pct: prev ? +(((m.regularMarketPrice / prev) - 1) * 100).toFixed(3) : null,
    time: m.regularMarketTime || null, currency: m.currency || null, exchange: m.exchangeName || null,
    day_high: m.regularMarketDayHigh ?? null, day_low: m.regularMarketDayLow ?? null, volume: m.regularMarketVolume ?? null,
  };
}

async function live(url, f, cache, request) {
  const raw = (url.searchParams.get('symbols') || '').split(',').map((s) => s.trim().toUpperCase()).filter(Boolean);
  const syms = [...new Set(raw)].slice(0, 20);
  if (!syms.length || syms.some((s) => !LIVE_SYMBOL.test(s))) return json({ error: 'symbols required: up to 20, comma separated' }, 400);
  const key = new Request(url.origin + '/__live/' + syms.join(','));
  return cached(cache, key, 20, async () => {
    const out = {}, errors = [];
    await Promise.all(syms.map(async (s) => {
      try {
        const r = await f(`${YAHOO}${encodeURIComponent(s)}?range=1d&interval=1d`, { headers: { 'user-agent': UA, accept: 'application/json' }, cf: { cacheTtl: 15, cacheEverything: true } });
        if (!r.ok) throw new Error('status ' + r.status);
        const q = parseLive(s, await r.json());
        if (!q) throw new Error('no quote');
        out[s] = q;
      } catch (e) { errors.push(`${s}: ${e.message}`); }
    }));
    const ok = Object.keys(out).length > 0;
    return json({ asof: new Date().toISOString(), delayed: true, source: 'Yahoo Finance chart feed', quotes: out, errors }, ok ? 200 : 502, ok ? 20 : 0);
  });
}



/* ---------- chat: a ladder of free models, key(s) kept on the server ----------
   The browser sends the conversation plus a context block built from the research it already shows. The model
   answers from that context only. Replies may end with [[note: ...]] or [[dispute: ...]] tags, which the app turns
   into one-tap actions; nothing about the conversation is stored on the server.
   Every rung is a free tier with its own quota. A request walks down the ladder, strongest first. A rung that says
   it is rate-limited is skipped (a "cooldown") for a minute, or for an hour if it says its daily quota is spent, so
   later requests go straight to a rung that still has room; the ladder retries the top again once the cooldown ends.
   Add whichever keys you have as Worker secrets; rungs without a key are skipped. Workers AI needs no key. */
const CHAT_SYSTEM = `You are the analyst inside Moat Monitor, an AI-native equity research tool. You speak to an investor about the companies in the CONTEXT below.
Rules:
- Use only facts and numbers in the CONTEXT or stated by the user. If something is not there, say you do not have it. Never invent figures, dates or quotes.
- Plain English, short paragraphs, no jargon. At most about 180 words unless asked for more. Use **bold** sparingly and "- " bullets when listing.
- This is research discussion, not personal investment advice. Do not tell the user to buy or sell.
- When the user shares their own research or view, take it seriously: say what in the CONTEXT supports it, what argues against it, and what evidence would settle it.
- Then, if their view is worth keeping, end with one line: [[note: <their view in one sentence, in their voice>]]
- If their view implies a specific number for one of the model's assumptions that differs from the base case, also add one line: [[dispute: driver=<rev_cagr|margin_end|share_chg|exit_pe> value=<number in the same units as the CONTEXT> reason=<under 12 words>]]
- Only use those tags for the user's own views, never for your own suggestions, and never more than one of each.`;
const LADDER = [
  { id: 'gemini', key: 'GEMINI_API_KEY', kind: 'gemini', take: 2, cap: 700 },
  { id: 'nvidia', key: 'NVIDIA_API_KEY', kind: 'openai', base: 'https://integrate.api.nvidia.com/v1', prefer: [/deepseek-v4[.\d]*-pro/, /deepseek-v4/, /kimi-k2/, /gpt-oss-120b/, /llama-3\.3-70b-instruct/], take: 1, cap: 400 },
  { id: 'groq', key: 'GROQ_API_KEY', kind: 'openai', base: 'https://api.groq.com/openai/v1', models: ['openai/gpt-oss-120b'], tight: true, cap: 300 },
  { id: 'mistral', key: 'MISTRAL_API_KEY', kind: 'openai', base: 'https://api.mistral.ai/v1', models: ['mistral-medium-latest'], cap: 150 },
  { id: 'openrouter', key: 'OPENROUTER_API_KEY', kind: 'openai', base: 'https://openrouter.ai/api/v1', models: ['openrouter/free'], cap: 45 },
  { id: 'groq-small', key: 'GROQ_API_KEY', kind: 'openai', base: 'https://api.groq.com/openai/v1', models: ['qwen/qwen3.8-27b', 'openai/gpt-oss-20b'], tight: true, cap: 300 },
  { id: 'workers-ai', binding: 'AI', kind: 'workers-ai', models: ['@cf/meta/llama-3.3-70b-instruct-fp8-fast'], tight: true, cap: 20 }
];
/* Zero-cost guarantee. Every model has a daily ceiling set below its provider's free allowance, and all users share
   one overall ceiling. The counters live in one Durable Object (exact, shared by every user and server instance).
   A model is only called after its counter is taken; when every ceiling is reached the chat stops for everyone until
   00:00 UTC (8am Singapore). Workers AI's ceiling keeps it far inside Cloudflare's free 10,000 neurons a day even on
   a paid Workers plan. The other providers cannot bill without a card on file, or (Gemini) billing on the project. */
const DAILY_CAP = 1500;
const utcDay = () => new Date().toISOString().slice(0, 10);
const resetsAt = () => { const d = new Date(); d.setUTCHours(24, 0, 0, 0); return d.toISOString(); };
export class ChatLimits {
  constructor(state) { this.state = state; }
  async fetch(request) {
    const u = new URL(request.url), st = this.state.storage, day = utcDay();
    if ((await st.get('day')) !== day) { await st.deleteAll(); await st.put('day', day); }
    if (u.pathname === '/take') {
      const keys = u.searchParams.getAll('k'), caps = u.searchParams.getAll('cap').map(Number);
      const counts = await Promise.all(keys.map((k) => st.get('n:' + k)));
      if (counts.some((n, i) => (n || 0) >= caps[i])) return json({ ok: false });
      await Promise.all(keys.map((k, i) => st.put('n:' + k, (counts[i] || 0) + 1)));
      return json({ ok: true });
    }
    const all = await st.list({ prefix: 'n:' });
    return json(Object.fromEntries([...all].map(([k, v]) => [k.slice(2), v])));
  }
}
const memLimits = new Map();
export const _limitsTest = { reset: () => memLimits.clear() };
/* Take one unit from each counter (all-or-nothing). Without the Durable Object binding (tests) an in-memory twin is used. */
async function takeUnits(env, pairs) {
  if (env.LIMITS) {
    const stub = env.LIMITS.get(env.LIMITS.idFromName('global'));
    const q = pairs.map(([k, c]) => `k=${encodeURIComponent(k)}&cap=${c}`).join('&');
    return (await (await stub.fetch('https://limits/take?' + q)).json()).ok;
  }
  const day = utcDay();
  if (memLimits.get('day') !== day) { memLimits.clear(); memLimits.set('day', day); }
  if (pairs.some(([k, c]) => (memLimits.get(k) || 0) >= c)) return false;
  pairs.forEach(([k]) => memLimits.set(k, (memLimits.get(k) || 0) + 1));
  return true;
}
async function usage(env) {
  if (env.LIMITS) return (await env.LIMITS.get(env.LIMITS.idFromName('global')).fetch('https://limits/status')).json();
  const day = utcDay();
  return memLimits.get('day') === day ? Object.fromEntries([...memLimits].filter(([k]) => k !== 'day')) : {};
}
const dailyCap = (env) => Math.max(0, Number(env.CHAT_DAILY_CAP) || DAILY_CAP);
/* Messages left today for everyone: the overall ceiling, or the room left across configured models, whichever is lower. */
async function leftToday(env, rungs, used) {
  used = used || (await usage(env));
  let room = 0;
  for (const p of rungs) {
    const n = p.models ? p.models.length : p.take || 1;
    const prefix = p.id + ':';
    const spent = Object.entries(used).filter(([k]) => k.startsWith(prefix)).reduce((a, [, v]) => a + v, 0);
    room += Math.max(0, p.cap * n - spent);
  }
  return Math.max(0, Math.min(room, dailyCap(env) - (used.all || 0)));
}
export async function chatStatus(env) {
  const rungs = LADDER.filter((p) => (p.key ? env[p.key] : env[p.binding]));
  return json({ left: rungs.length ? await leftToday(env, rungs) : 0, resets_at: resetsAt(), on: rungs.length > 0 }, 200, 0);
}
const GEMINI = 'https://generativelanguage.googleapis.com/v1beta/';
const picks = {}; // provider id -> { at, list }
const cool = new Map(); // model -> until (ms); also mirrored in the edge cache so other isolates see it
const verOf = (n) => { const m = n.match(/gemini-(\d+(?:\.\d+)?)/); return m ? parseFloat(m[1]) : 0; };
export function rankModels(models) {
  const ok = (models || []).filter((m) => m && /^models\/gemini-/.test(m.name) && (m.supportedGenerationMethods || []).includes('generateContent')
    && /flash/.test(m.name) && !/(image|tts|audio|live|embedding|thinking-exp|native|computer)/.test(m.name));
  const score = (n) => verOf(n) * 10 - (/lite/.test(n) ? 3 : 0) - (/(preview|exp)/.test(n) ? 1 : 0) - (/-\d{3,}$/.test(n) ? 0.5 : 0);
  return ok.map((m) => m.name.replace(/^models\//, '')).sort((a, b) => score(b) - score(a));
}
export function preferModels(ids, prefer) {
  const out = [];
  for (const re of prefer) { const hit = ids.filter((x) => re.test(x) && !out.includes(x)).sort((a, b) => a.length - b.length)[0]; if (hit) out.push(hit); }
  return out;
}
async function modelsFor(p, env, f) {
  if (p.models) return p.models;
  const hit = picks[p.id];
  if (hit && Date.now() - hit.at < 6 * 3600e3) return hit.list;
  let list = [];
  if (p.kind === 'gemini') {
    if (env.GEMINI_MODEL) list = [env.GEMINI_MODEL];
    else {
      const r = await f(`${GEMINI}models?pageSize=200`, { headers: { 'x-goog-api-key': env.GEMINI_API_KEY } });
      if (!r.ok) throw new Error('model list ' + r.status);
      list = rankModels((await r.json()).models);
    }
  } else {
    const r = await f(`${p.base}/models`, { headers: { authorization: `Bearer ${env[p.key]}` } });
    if (!r.ok) throw new Error('model list ' + r.status);
    const j = await r.json();
    list = preferModels((j.data || []).map((m) => m.id).filter(Boolean), p.prefer || []);
  }
  list = list.slice(0, p.take || 3);
  picks[p.id] = { at: Date.now(), list };
  return list;
}
const coolKey = (m) => new Request('https://cooldown.moat-monitor.internal/' + encodeURIComponent(m));
async function cooling(m, cache) {
  const u = cool.get(m);
  if (u && u > Date.now()) return true;
  if (!cache) return false;
  try { const r = await cache.match(coolKey(m)); if (r) { const until = +(await r.text()); if (until > Date.now()) { cool.set(m, until); return true; } } } catch (e) { /* cache optional */ }
  return false;
}
async function coolDown(m, secs, cache) {
  const until = Date.now() + secs * 1000;
  cool.set(m, until);
  if (cache) { try { await cache.put(coolKey(m), new Response(String(until), { headers: { 'cache-control': `max-age=${Math.ceil(secs)}` } })); } catch (e) { /* cache optional */ } }
}
/* How long to rest a rung after a 429: an hour if it says a daily quota is spent, else its Retry-After, else a minute. */
export function restFor(status, headers, text) {
  if (status !== 429) return 0;
  if (/per.?day|daily|RPD|PerDay|quota exceeded for metric.*day/i.test(text || '')) return 3600;
  const ra = Number(headers && headers.get && headers.get('retry-after'));
  return isFinite(ra) && ra > 0 ? Math.min(ra, 3600) : 60;
}
async function ask(p, model, env, f, system, msgs) {
  if (p.kind === 'workers-ai') {
    const r = await env[p.binding].run(model, { messages: [{ role: 'system', content: system }].concat(msgs), max_tokens: 1000, temperature: 0.4 });
    const c = r && r.choices && r.choices[0];
    return { text: String((r && r.response) || (c && c.message && c.message.content) || '').trim() };
  }
  let r;
  if (p.kind === 'gemini') {
    r = await f(`${GEMINI}models/${encodeURIComponent(model)}:generateContent`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-goog-api-key': env.GEMINI_API_KEY },
      body: JSON.stringify({ systemInstruction: { parts: [{ text: system }] }, contents: msgs.map((m) => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] })), generationConfig: { temperature: 0.4, maxOutputTokens: 1200 } }) });
  } else {
    r = await f(`${p.base}/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${env[p.key]}` },
      body: JSON.stringify(Object.assign({ model, messages: [{ role: 'system', content: system }].concat(msgs), temperature: 0.4, max_tokens: 1200 }, p.id.startsWith('groq') && /gpt-oss/.test(model) ? { reasoning_effort: 'low' } : {})) });
  }
  const raw = await r.text();
  let j = {};
  try { j = JSON.parse(raw); } catch (e) { /* non-JSON error body */ }
  if (!r.ok) return { status: r.status, headers: r.headers, err: ((j.error && (j.error.message || j.error)) || raw).toString().slice(0, 300) };
  if (p.kind === 'gemini') {
    const c = (j.candidates || [])[0];
    return { text: c && c.content && Array.isArray(c.content.parts) ? c.content.parts.filter((x) => !x.thought).map((x) => x.text || '').join('').trim() : '' };
  }
  const c = (j.choices || [])[0];
  return { text: c && c.message && typeof c.message.content === 'string' ? c.message.content.trim() : '' };
}
export async function chat(request, env, f = fetch, cache = null) {
  const rungs = LADDER.filter((p) => (p.key ? env[p.key] : env[p.binding]));
  if (!rungs.length) return json({ error: 'Chat is not switched on yet: no model API key has been added.' }, 503);
  const origin = request.headers.get('origin');
  if (origin && new URL(origin).host !== new URL(request.url).host) return json({ error: 'forbidden' }, 403);
  const raw = await request.text();
  if (raw.length > 120000) return json({ error: 'too long' }, 413);
  let body;
  try { body = JSON.parse(raw); } catch (e) { return json({ error: 'bad json' }, 400); }
  const msgs = (Array.isArray(body.messages) ? body.messages : [])
    .filter((m) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string' && m.content.trim())
    .slice(-12).map((m) => ({ role: m.role, content: m.content.slice(0, 4000) }));
  while (msgs.length && msgs[0].role !== 'user') msgs.shift();
  if (!msgs.length || msgs[msgs.length - 1].role !== 'user') return json({ error: 'no question' }, 400);
  const context = String(body.context || '');
  let last = '', limited = false, capped = false;
  const deadKeys = new Set();
  for (const p of rungs) {
    if (p.key && deadKeys.has(p.key)) continue;
    let models;
    try { models = await modelsFor(p, env, f); } catch (e) { last = `${p.id}: ${e.message}`; continue; }
    for (const model of models) {
      if (await cooling(model, cache)) { limited = true; continue; }
      if (!(await takeUnits(env, [['all', dailyCap(env)], [`${p.id}:${model}`, p.cap]]))) { capped = true; continue; }
      try {
        // Groq allows about 8k tokens a minute, so it gets a shorter context and history.
        const sys = CHAT_SYSTEM + '\n\nCONTEXT\n' + context.slice(0, p.tight ? 14000 : 30000);
        const r = await ask(p, model, env, f, sys, p.tight ? msgs.slice(-6) : msgs);
        if (r.text) return json({ reply: r.text.replace(/<think>[\s\S]*?<\/think>/g, '').trim(), model, provider: p.id, left: await leftToday(env, rungs) }, 200, 0);
        const rest = restFor(r.status, r.headers, r.err);
        if (rest) { limited = true; await coolDown(model, rest, cache); last = `${model}: rate limited`; continue; }
        if (r.status === 401 || r.status === 403) { if (p.key) deadKeys.add(p.key); last = `${p.id}: key rejected`; break; }
        last = r.status ? `${model}: ${r.status} ${r.err}` : `${model}: empty reply`;
      } catch (e) {
        last = `${model}: ${String((e && e.message) || e)}`;
        if (/neuron|4006|daily/i.test(last)) { limited = true; await coolDown(model, 3600, cache); }
      }
    }
  }
  if (capped && !limited) return json({ error: "Today's free chat allowance is used up for everyone. It resets at 8am Singapore time.", left: 0, resets_at: resetsAt() }, 429);
  if (limited || capped) return json({ error: 'Every free model is busy or out of quota right now. Try again in a minute; daily allowances reset at 8am Singapore time.', left: await leftToday(env, rungs), resets_at: resetsAt() }, 429);
  return json({ error: 'The analyst is unavailable right now.', detail: last.slice(0, 200) }, 503);
}
export const _chatTest = { reset: () => { cool.clear(); Object.keys(picks).forEach((k) => delete picks[k]); } };

export async function handle(request, env, ctx, f = fetch, cache = (typeof caches !== 'undefined' ? caches.default : null)) {
  const url = new URL(request.url);
  if (!url.pathname.startsWith('/api/')) {
    if (!env.ASSETS) return new Response('not found', { status: 404 });
    return env.ASSETS.fetch(request);
  }
  if (url.pathname === '/api/chat/status') return await chatStatus(env);
  if (url.pathname === '/api/chat') {
    if (request.method !== 'POST') return json({ error: 'method not allowed' }, 405);
    try { return await chat(request, env, f, cache); } catch (e) { return json({ error: 'internal', detail: String(e && e.message || e) }, 500); }
  }
  if (request.method !== 'GET' && request.method !== 'HEAD') return json({ error: 'method not allowed' }, 405);
  if (!env.REPO) return json({ error: 'REPO is not configured' }, 500);
  try {
    if (url.pathname === '/api/baseline') return await baseline(env, f, cache, request);
    if (url.pathname === '/api/live') return await live(url, f, cache, request);
    for (const [re, file, ttl] of ROUTES) {
      const m = url.pathname.match(re);
      if (m) {
        if (m[1] && !TICKER.test(m[1])) return json({ error: 'bad ticker' }, 400);
        return await fromData(env, file(m), ttl, f, cache, ctx, request);
      }
    }
    return json({ error: 'unknown route' }, 404);
  } catch (e) {
    return json({ error: 'internal', detail: String(e && e.message || e) }, 500);
  }
}

export default { fetch: (request, env, ctx) => handle(request, env, ctx) };
