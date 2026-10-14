import assert from 'node:assert/strict';
import { handle } from '../worker/src/index.js';

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
console.log('worker tests passed');
