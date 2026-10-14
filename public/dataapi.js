/* Data access for the live backend with a static-seed fallback, plus a small live-quote poller.
   Order for every request: the same-origin /api route (Cloudflare Worker), then the file shipped with the app, else null.
   Responses are cached in memory for a short time so tab switches do not refetch. */
(function () {
  'use strict';
  const mem = new Map();
  const TTL = { quotes: 60e3, history: 10 * 60e3, intraday: 60e3, fundamentals: 30 * 60e3, evidence: 10 * 60e3, mgmt: 30 * 60e3, news: 5 * 60e3 };

  function timed(url, ms) {
    const ctl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const t = setTimeout(() => ctl && ctl.abort(), ms);
    return fetch(url, { cache: 'no-cache', signal: ctl ? ctl.signal : undefined })
      .then((r) => { clearTimeout(t); return r; }, (e) => { clearTimeout(t); throw e; });
  }

  async function tryJson(url, ms) {
    try {
      const r = await timed(url, ms || 6000);
      if (!r.ok) return null;
      return await r.json();
    } catch (e) { return null; }
  }

  /* kind: quotes | news (no ticker) or history | intraday | fundamentals | evidence | mgmt | news (with ticker).
     Resolves to { data, source: 'live' | 'seed' | null }. */
  async function get(kind, ticker, opts) {
    const key = kind + ':' + (ticker || '');
    const now = Date.now(), hit = mem.get(key);
    if (hit && now - hit.at < (TTL[kind] || 60e3) && !(opts && opts.fresh)) return hit.v;
    const path = ticker ? `${kind}/${ticker}` : kind;
    let data = await tryJson(`/api/${path}`, 6000), source = 'live';
    if (!data || data.error) {
      data = await tryJson(`data/${path}.json`, 4000);
      source = data ? 'seed' : null;
    }
    const v = { data: data || null, source };
    if (data) mem.set(key, { at: now, v });
    return v;
  }

  /* Live quotes: /api/live?symbols=A,B,C. Subscribers receive the latest map; polling pauses when the page is hidden. */
  const live = { quotes: {}, asof: null, subs: new Set(), symbols: new Set(), timer: null, failing: 0, ok: false };

  async function pollOnce() {
    const syms = Array.from(live.symbols).slice(0, 20);
    if (!syms.length) return;
    const d = await tryJson('/api/live?symbols=' + encodeURIComponent(syms.join(',')), 7000);
    if (d && d.quotes && Object.keys(d.quotes).length) {
      Object.assign(live.quotes, d.quotes);
      live.asof = d.asof; live.failing = 0; live.ok = true;
      live.subs.forEach((cb) => { try { cb(live); } catch (e) { /* subscriber errors must not stop polling */ } });
    } else {
      live.failing++;
      if (live.failing >= 3) live.ok = false;
    }
  }

  function schedule() {
    clearTimeout(live.timer);
    const wait = live.failing >= 3 ? 120e3 : 30e3;
    live.timer = setTimeout(async () => {
      if (document.visibilityState === 'visible' && live.subs.size) await pollOnce();
      schedule();
    }, wait);
  }

  function subscribe(symbols, cb) {
    symbols.forEach((s) => live.symbols.add(s));
    live.subs.add(cb);
    if (!live.timer) { pollOnce(); schedule(); } else if (Object.keys(live.quotes).length) cb(live);
    return () => live.subs.delete(cb);
  }
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && live.subs.size) pollOnce(); });

  window.DataApi = { get, live, subscribe, pollOnce, clear: () => mem.clear() };
})();
