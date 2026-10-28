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


/* ---------- chat: Workers AI, no API key, free daily allowance ----------
   The browser sends the conversation plus a context block built from the research it already shows. The model
   answers from that context only. Replies may end with [[note: ...]] or [[dispute: ...]] tags, which the app turns
   into one-tap actions; nothing is saved on the server. */
const CHAT_FALLBACKS = ['@cf/openai/gpt-oss-120b', '@cf/meta/llama-3.3-70b-instruct-fp8-fast'];
const CHAT_SYSTEM = `You are the analyst inside Moat Monitor, an AI-native equity research tool. You speak to an investor about the companies in the CONTEXT below.
Rules:
- Use only facts and numbers in the CONTEXT or stated by the user. If something is not there, say you do not have it. Never invent figures, dates or quotes.
- Plain English, short paragraphs, no jargon. At most about 180 words unless asked for more. Use **bold** sparingly and "- " bullets when listing.
- This is research discussion, not personal investment advice. Do not tell the user to buy or sell.
- When the user shares their own research or view, take it seriously: say what in the CONTEXT supports it, what argues against it, and what evidence would settle it.
- Then, if their view is worth keeping, end with one line: [[note: <their view in one sentence, in their voice>]]
- If their view implies a specific number for one of the model's assumptions that differs from the base case, also add one line: [[dispute: driver=<rev_cagr|margin_end|share_chg|exit_pe> value=<number in the same units as the CONTEXT> reason=<under 12 words>]]
- Only use those tags for the user's own views, never for your own suggestions, and never more than one of each.`;
function chatText(r) {
  if (!r) return '';
  if (typeof r === 'string') return r;
  if (typeof r.response === 'string') return r.response;
  const c = r.choices && r.choices[0];
  if (c && c.message && typeof c.message.content === 'string') return c.message.content;
  if (typeof r.output_text === 'string') return r.output_text;
  if (Array.isArray(r.output)) return r.output.flatMap((o) => (o && Array.isArray(o.content) ? o.content : [])).map((x) => x && (x.text || '')).join('');
  return '';
}
export async function chat(request, env) {
  if (!env.AI) return json({ error: 'Chat is not switched on for this deployment.' }, 503);
  const origin = request.headers.get('origin');
  if (origin && new URL(origin).host !== new URL(request.url).host) return json({ error: 'forbidden' }, 403);
  const raw = await request.text();
  if (raw.length > 120000) return json({ error: 'too long' }, 413);
  let body;
  try { body = JSON.parse(raw); } catch (e) { return json({ error: 'bad json' }, 400); }
  const msgs = (Array.isArray(body.messages) ? body.messages : [])
    .filter((m) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string' && m.content.trim())
    .slice(-12).map((m) => ({ role: m.role, content: m.content.slice(0, 4000) }));
  if (!msgs.length || msgs[msgs.length - 1].role !== 'user') return json({ error: 'no question' }, 400);
  const context = String(body.context || '').slice(0, 24000);
  const messages = [{ role: 'system', content: CHAT_SYSTEM + '\n\nCONTEXT\n' + context }].concat(msgs);
  const models = [env.CHAT_MODEL].concat(CHAT_FALLBACKS).filter(Boolean);
  let last = '';
  for (const model of models) {
    try {
      const r = await env.AI.run(model, { messages, max_tokens: 900, temperature: 0.4 });
      const text = chatText(r).replace(/<think>[\s\S]*?<\/think>/g, '').trim();
      if (text) return json({ reply: text, model }, 200, 0);
      last = 'empty reply from ' + model;
    } catch (e) {
      last = String((e && e.message) || e);
      if (/neuron|quota|limit exceeded|4006|daily/i.test(last)) return json({ error: 'The free daily chat allowance is used up. It resets at 8am Singapore time.' }, 429);
    }
  }
  return json({ error: 'The analyst is unavailable right now.', detail: last.slice(0, 200) }, 503);
}

export async function handle(request, env, ctx, f = fetch, cache = (typeof caches !== 'undefined' ? caches.default : null)) {
  const url = new URL(request.url);
  if (!url.pathname.startsWith('/api/')) {
    if (!env.ASSETS) return new Response('not found', { status: 404 });
    return env.ASSETS.fetch(request);
  }
  if (url.pathname === '/api/chat') {
    if (request.method !== 'POST') return json({ error: 'method not allowed' }, 405);
    try { return await chat(request, env); } catch (e) { return json({ error: 'internal', detail: String(e && e.message || e) }, 500); }
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
