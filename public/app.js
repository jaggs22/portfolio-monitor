(function () {
  'use strict';

  const L = window.Lib;
  const CFG = window.APP_CONFIG || {};
  const $ = (sel, root) => (root || document).querySelector(sel);

  /* ---------- small helpers ---------- */

  function h(tag, attrs) {
    const el = document.createElement(tag);
    if (attrs) {
      for (const [k, v] of Object.entries(attrs)) {
        if (v === null || v === undefined || v === false) continue;
        if (k === 'class') el.className = v;
        else if (k === 'html') el.innerHTML = v; // only ever called with static strings from this file
        else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
        else el.setAttribute(k, v === true ? '' : v);
      }
    }
    const kids = Array.prototype.slice.call(arguments, 2);
    for (const kid of kids.flat(Infinity)) {
      if (kid === null || kid === undefined || kid === false) continue;
      el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
    }
    return el;
  }

  function safeUrl(u) {
    try {
      const url = new URL(u, location.href);
      return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : null;
    } catch (e) { return null; }
  }

  const store = {
    get(key, fallback) {
      try { const v = localStorage.getItem(key); return v === null ? fallback : JSON.parse(v); } catch (e) { return fallback; }
    },
    set(key, value) {
      try { localStorage.setItem(key, JSON.stringify(value)); return true; } catch (e) { return false; }
    }
  };

  const fmtPct = (x) => (Math.abs(x) < 0.00005 ? '0.00%' : (x > 0 ? '+' : '-') + Math.abs(x * 100).toFixed(2) + '%');
  const fmtBps = (x) => { const b = Math.round(x * 10000); return (b >= 0 ? '+' : '-') + Math.abs(b) + ' bps'; };
  const dirClass = (x) => (x > 0 ? 'up' : x < 0 ? 'down' : '');
  const verdictClass = (v) => String(v || '').toLowerCase().split(' ')[0].replace('insufficient', 'insufficient');
  const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;

  const ICONS = {
    today: '<circle cx="12" cy="12" r="4"/><path d="M12 3v2M12 19v2M3 12h2M19 12h2M5.6 5.6L7 7M17 17l1.4 1.4M5.6 18.4L7 17M17 7l1.4-1.4"/>',
    markets: '<path d="M3 15l4-5 4 3 5-8 5 6"/><path d="M3 20h18"/>',
    holdings: '<path d="M4 7h16M4 12h16M4 17h10"/>',
    universe: '<rect x="4" y="4" width="6.5" height="6.5" rx="1.2"/><rect x="13.5" y="4" width="6.5" height="6.5" rx="1.2"/><rect x="4" y="13.5" width="6.5" height="6.5" rx="1.2"/><rect x="13.5" y="13.5" width="6.5" height="6.5" rx="1.2"/>',
    calendar: '<rect x="4" y="6" width="16" height="14" rx="2"/><path d="M4 10h16M9 3v4M15 3v4"/>',
    view: '<path d="M4 19V9M10 19V5M16 19v-8M22 19V3"/>',
    help: '<circle cx="12" cy="12" r="9"/><path d="M9.5 9.5a2.5 2.5 0 1 1 3.5 2.3c-.7.4-1 1-1 1.7M12 17h.01"/>'
  };
  const icon = (id) => h('span', { 'aria-hidden': 'true', html: `<svg viewBox="0 0 24 24" focusable="false">${ICONS[id]}</svg>` });

  /* The force strip: five bars, one per force, height equals the score. */
  function strip(card) {
    const w = 5 * 6 + 4 * 3, ht = 24;
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('class', 'strip');
    svg.setAttribute('width', String(w));
    svg.setAttribute('height', String(ht));
    svg.setAttribute('viewBox', `0 0 ${w} ${ht}`);
    const scores = L.FORCES.map((f) => (card && card.forces && card.forces[f] ? card.forces[f].score : null));
    svg.setAttribute('role', 'img');
    svg.setAttribute('aria-label', 'Force scores: ' + L.FORCES.map((f, i) => `${L.FORCE_LABEL[f]} ${scores[i] === null ? 'none' : scores[i]}`).join(', '));
    scores.forEach((s, i) => {
      const bar = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
      const barH = s === null ? 3 : Math.round((s / 5) * ht);
      bar.setAttribute('x', String(i * 9));
      bar.setAttribute('y', String(ht - barH));
      bar.setAttribute('width', '6');
      bar.setAttribute('height', String(barH));
      bar.setAttribute('rx', '1.5');
      if (s === null) bar.setAttribute('class', 'empty');
      svg.append(bar);
    });
    return svg;
  }

  async function copyText(text) {
    try { await navigator.clipboard.writeText(text); return true; } catch (e) { /* fall through */ }
    const ta = h('textarea', { 'aria-hidden': 'true', style: 'position:fixed;opacity:0;top:0;left:0' });
    ta.value = text;
    document.body.append(ta);
    ta.select();
    let ok = false;
    try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
    ta.remove();
    return ok;
  }

  let toastTimer;
  function toast(msg) {
    const t = $('#toast');
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove('show'), 3400);
  }

  /* ---------- state ---------- */

  const state = {
    tab: 'today',
    data: null,
    error: null,
    refreshFailed: false,
    loadedAt: 0,
    holdings: L.cleanHoldings(store.get('holdings', null) || L.DEFAULT_HOLDINGS),
    feedback: store.get('feedback', {}) || {},
    editing: false,
    restoreOpen: false,
    restoreError: '',
    wrongOpen: null,
    uni: { q: '', sector: 'All', verdict: 'All' },
    ask: { q: 0, includeHoldings: false },
    sortBy: 'chg',
    onbStep: 0,
    storageOk: true,
    sheets: []
  };
  state.storageOk = store.set('probe', 1);

  function persist() {
    const a = store.set('holdings', state.holdings);
    const b = store.set('feedback', state.feedback);
    state.storageOk = a && b;
  }

  /* ---------- data ---------- */

  async function loadData() {
    try {
      const names = ['digest', 'universe', 'cards'];
      const [digest, universe, cards] = await Promise.all(names.map((n) =>
        fetch(`data/${n}.json`, { cache: 'no-cache' }).then((r) => {
          if (!r.ok) throw new Error(`${n}.json returned ${r.status}`);
          return r.json();
        })
      ));
      const getJson = (u, ms) => Promise.race([fetch(u, { cache: 'no-cache' }).then((r) => (r.ok ? r.json() : null)), new Promise((res) => setTimeout(() => res(null), ms || 6000))]).catch(() => null);
      const [market, lenses, resIndex] = await Promise.all([getJson('data/market.json'), getJson('data/lenses.json'), getJson('data/research/index.json')]);
      const research = {};
      await Promise.all((resIndex || []).map((t) => getJson(`data/research/${t}.json`).then((r) => { if (r) research[t] = r; })));
      // Live baseline: the backend function first, the static file as fallback.
      const live = (await getJson('/api/baseline', 4000)) || (await getJson('data/baseline.json')) || { filings: {}, quotes: {} };
      await overlayQuotes(digest);
      state.data = { digest, universe, cards, market: market || { rates: { rf: 5, erp: 4.5 }, stocks: {} }, lenses: lenses || { lenses: [], note: '' }, research, live };
      if (digest.live && digest.live.tnx && state.data.market.rates) state.data.market.rates = Object.assign({}, state.data.market.rates, { rf: Math.round(digest.live.tnx * 100) / 100, rf_live: true });
      state.uniMap = {};
      for (const u of universe) state.uniMap[u.ticker] = u;
      // The universe was cut to 15 names: drop saved holdings that are no longer covered.
      const known = new Set(universe.map((u) => u.ticker));
      const kept = state.holdings.filter((x) => known.has(x.ticker));
      if (kept.length !== state.holdings.length) {
        state.holdings = kept.length ? kept : L.cleanHoldings(L.DEFAULT_HOLDINGS);
        persist();
      }
      state.error = null;
      state.refreshFailed = false;
      state.loadedAt = Date.now();
    } catch (e) {
      if (state.data) state.refreshFailed = true;
      else state.error = e.message || 'Unknown error';
    }
  }

  /* Pipeline quotes (every ten minutes in market hours) replace the static snapshot prices and index levels.
     The curated headlines and macro notes in the digest stay as dated. */
  const INDEX_FMT = { '^TNX': (v) => v.toFixed(3) + '%', '^VIX': (v) => v.toFixed(2) };
  async function overlayQuotes(digest) {
    try {
      const r = await DataApi.get('quotes', null, { fresh: true });
      const q = r.data && r.data.quotes;
      if (!q || !Object.keys(q).length) return;
      digest.prices = digest.prices || {};
      for (const [t, v] of Object.entries(q)) if (v && v.price) digest.prices[t] = { close: v.price, prev: v.prev_close != null ? v.prev_close : (digest.prices[t] || {}).prev };
      const mk = (r.data.markets || []).filter((m) => m && m.price != null);
      if (mk.length) digest.markets = mk.map((m) => ({ label: m.label, value: (INDEX_FMT[m.symbol] || ((v) => v.toLocaleString('en-US', { maximumFractionDigits: 2 })))(m.price), change: m.pct != null ? m.pct / 100 : null }));
      const tnx = (r.data.markets || []).find((m) => m && m.symbol === '^TNX');
      digest.live = { asof: r.data.asof, source: r.source, tnx: tnx && tnx.price > 0.5 && tnx.price < 15 ? tnx.price : null };
      digest.snapshot = false;
    } catch (e) { /* keep the snapshot */ }
  }

  const nameOf = (t) => (state.uniMap && state.uniMap[t] ? state.uniMap[t].name : t);
  const cardOf = (t) => (state.data && state.data.cards ? state.data.cards[t] : null);
  const knownTickers = () => (state.data ? state.data.universe.filter((u) => !u.sample).map((u) => u.ticker) : []);

  /* ---------- sheets ---------- */

  let lastFocus = null;

  function pushSheet(title, build) { state.sheets.push({ title, build }); renderSheet(true); }
  function popSheet() { state.sheets.pop(); renderSheet(true); }
  function closeAllSheets() { state.sheets = []; renderSheet(true); }

  function renderSheet(moveFocus) {
    const root = $('#sheet-root');
    const top = state.sheets[state.sheets.length - 1];
    if (!top) {
      root.hidden = true;
      root.replaceChildren();
      document.body.classList.remove('sheet-open');
      if (lastFocus && document.contains(lastFocus)) lastFocus.focus();
      lastFocus = null;
      return;
    }
    if (root.hidden) lastFocus = document.activeElement;
    const keyBefore = document.activeElement && document.activeElement.dataset ? document.activeElement.dataset.key : null;
    const scrollBefore = $('.sheet-body') ? $('.sheet-body').scrollTop : 0;
    const back = state.sheets.length > 1;
    const sheet = h('div', { class: 'sheet', role: 'dialog', 'aria-modal': 'true', 'aria-label': top.title },
      h('div', { class: 'sheet-bar' },
        h('button', { class: 'text-btn', type: 'button', 'data-key': 'sheet-close', onclick: popSheet }, back ? 'Back' : 'Close'),
        h('div', { class: 'sheet-title' }, top.title),
        h('div', { class: 'sheet-spacer', 'aria-hidden': 'true' })),
      h('div', { class: 'sheet-body' }, top.build()));
    root.replaceChildren(h('div', { class: 'backdrop', onclick: closeAllSheets }), sheet);
    root.hidden = false;
    document.body.classList.add('sheet-open');
    if (moveFocus) {
      $('.text-btn', sheet).focus();
    } else {
      const body = $('.sheet-body', sheet);
      if (body) body.scrollTop = scrollBefore;
      const again = keyBefore ? sheet.querySelector(`[data-key="${keyBefore}"]`) : null;
      if (again) again.focus({ preventScroll: true });
    }
  }
  const refreshSheet = () => renderSheet(false);

  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && state.sheets.length) popSheet(); });

  /* ---------- shared pieces ---------- */

  function sourceLine(src) {
    if (!src) return null;
    const url = safeUrl(src.url);
    return h('p', { class: 'small muted' }, 'Source: ',
      url ? h('a', { href: url, target: '_blank', rel: 'noopener' }, src.title || url) : (src.title || 'Unnamed source'),
      src.date ? ', ' + L.formatDateLabel(src.date) : '');
  }

  function touches(item) {
    const bits = [];
    if (item.tickers && item.tickers.length) bits.push(item.tickers.join(', '));
    if (item.tags && item.tags.force && L.FORCE_LABEL[item.tags.force]) bits.push(L.FORCE_LABEL[item.tags.force].toLowerCase());
    if (item.tags && item.tags.falsifier) bits.push('falsifier ' + item.tags.falsifier);
    return bits.length ? 'Touches: ' + bits.join(', ') : 'Market-wide';
  }

  function itemRow(item, key) {
    return h('li', { class: 'row' },
      h('button', { class: 'row-btn', type: 'button', 'data-key': key, onclick: () => pushSheet('Item', () => itemSheet(item)) },
        h('span', { class: 'row-main' },
          h('span', { class: 'row-title' }, item.headline),
          h('br'),
          h('span', { class: 'row-sub' }, touches(item))),
        h('span', { class: 'chev', 'aria-hidden': 'true' }, '›')));
  }

  function saveFeedback(id, value, note) {
    state.feedback = L.recordFeedback(state.feedback, id, value, note, new Date().toISOString());
    persist();
    refreshSheet();
    if (!state.storageOk) toast('This browser is not saving changes. Export a backup from Holdings.');
  }

  function feedbackBlock(item) {
    const cur = state.feedback[item.id];
    const mk = (value, label) => h('button', {
      class: 'seg', type: 'button', 'data-key': 'fb-' + value,
      'aria-pressed': String(!!cur && cur.value === value),
      onclick: () => {
        if (value === 'wrong') state.wrongOpen = item.id; else state.wrongOpen = null;
        saveFeedback(item.id, value, value === 'wrong' && cur ? cur.note : '');
      }
    }, label);
    const wrap = h('div', null,
      h('div', { class: 'seg-group', role: 'group', 'aria-label': 'Rate this item' }, mk('useful', 'Useful'), mk('noise', 'Noise'), mk('wrong', 'Wrong')));
    if ((cur && cur.value === 'wrong') || state.wrongOpen === item.id) {
      const ta = h('textarea', { id: 'wrong-note', maxlength: '500', 'aria-label': 'What looks wrong?' });
      ta.value = cur ? cur.note || '' : '';
      wrap.append(
        h('label', { for: 'wrong-note' }, 'What looks wrong?'),
        ta,
        h('p', null, h('button', { class: 'btn small', type: 'button', 'data-key': 'fb-save', onclick: () => { saveFeedback(item.id, 'wrong', ta.value); toast('Saved'); } }, 'Save note')));
    }
    return wrap;
  }

  function itemSheet(item) {
    const cardButtons = (item.tickers || []).filter((t) => cardOf(t)).map((t) =>
      h('button', { class: 'btn small', type: 'button', onclick: () => STK.open(t, 'thesis') }, `Open ${t} card`));
    return h('div', null,
      h('h2', { class: 'card-title' }, item.headline),
      h('p', { class: 'muted' }, touches(item)),
      h('p', null, item.why),
      sourceLine(item.source),
      cardButtons.length ? h('p', { class: 'inline' }, cardButtons) : null,
      h('h3', null, 'Was this useful?'),
      feedbackBlock(item));
  }

  /* ---------- Today ---------- */

  const newsFor = (t) => ((state.data.digest.items || []).filter((i) => (i.tickers || []).includes(t))
    .sort((a, b) => (b.materiality || 0) - (a.materiality || 0) || String(b.source && b.source.date).localeCompare(String(a.source && a.source.date))));
  const moveOf = (t) => { const p = state.data.digest.prices && state.data.digest.prices[t]; return p ? L.pctChange(p.close, p.prev) : null; };
  const fmtPx = (x) => (typeof x === 'number' ? x.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : 'n/a');

  function marketsStrip() {
    const m = state.data.digest.markets || [];
    if (!m.length) return null;
    return h('div', { class: 'markets', role: 'group', 'aria-label': 'Market levels' }, m.map((x) =>
      h('div', { class: 'mkt' },
        h('span', { class: 'mkt-l' }, x.label),
        h('span', { class: 'mkt-v' }, x.value),
        h('span', { class: 'mkt-c ' + (x.change === null || x.change === undefined ? '' : dirClass(x.change)) }, x.change === null || x.change === undefined ? 'level only' : fmtPct(x.change)))));
  }

  function openName(t) {
    if (cardOf(t)) STK.open(t, 'thesis');
    else toast(`${t}: thesis pending. Cards are added name by name.`);
  }

  function heatmap() {
    const { universe } = state.data;
    const held = new Set(L.cleanHoldings(state.holdings).map((x) => x.ticker));
    const bySector = {};
    universe.forEach((u) => { (bySector[u.sector] = bySector[u.sector] || []).push(u); });
    const wrap = h('div', { class: 'heat', role: 'group', 'aria-label': 'One-day move by company, grouped by sector' });
    Object.keys(bySector).forEach((sec) => {
      const tiles = bySector[sec].map((u) => {
        const mv = moveOf(u.ticker);
        const a = mv === null ? 0 : Math.min(1, Math.abs(mv) / 0.03);
        return h('button', { type: 'button', class: 'tile ' + (mv === null ? '' : mv >= 0 ? 'pos' : 'neg') + (held.has(u.ticker) ? ' held' : ''),
          style: `--a:${(0.18 + a * 0.62).toFixed(2)}`, 'aria-label': `${u.name} ${mv === null ? 'no price' : fmtPct(mv)}${held.has(u.ticker) ? ', in your book' : ''}`,
          onclick: () => openName(u.ticker) },
          h('span', { class: 't-sym' }, u.ticker), h('span', { class: 't-chg' }, mv === null ? 'n/a' : fmtPct(mv)));
      });
      wrap.append(h('div', { class: 'heat-group' }, h('div', { class: 'heat-label' }, sec), h('div', { class: 'heat-tiles' }, tiles)));
    });
    return wrap;
  }

  function quoteTable(tickers, opts) {
    const cols = (opts && opts.sort) || state.sortBy || 'chg';
    const rows = tickers.map((t) => ({ t, p: state.data.digest.prices && state.data.digest.prices[t], mv: moveOf(t) }));
    rows.sort((a, b) => cols === 'sym' ? a.t.localeCompare(b.t) : (a.mv === null) - (b.mv === null) || (b.mv - a.mv));
    const sortBtn = (id, label) => h('button', { type: 'button', class: 'th-btn', 'aria-pressed': String(state.sortBy === id), onclick: () => { state.sortBy = id; render(); } }, label);
    const head = h('div', { class: 'qt-head' }, sortBtn('sym', 'Name'), h('span', { class: 'r' }, 'Last'), sortBtn('chg', '1D'), h('span', { class: 'c' }, 'Thesis'));
    const body = rows.map(({ t, p, mv }) => {
      const c = cardOf(t);
      return h('button', { type: 'button', class: 'qt-row', 'data-key': 'q-' + t, onclick: () => openName(t) },
        h('span', { class: 'qt-name' }, h('span', { class: 'tickers' }, t), h('span', { class: 'qt-co' }, nameOf(t))),
        h('span', { class: 'r num' }, p ? fmtPx(p.close) : 'n/a'),
        h('span', { class: 'num chg ' + (mv === null ? '' : dirClass(mv)) }, mv === null ? 'n/a' : fmtPct(mv)),
        h('span', { class: 'c qt-th' }, c ? [strip(c), h('span', { class: 'pill ' + verdictClass(c.verdict) }, c.verdict)] : h('span', { class: 'pill pending' }, 'Pending')));
    });
    return h('div', { class: 'qt' }, head, body);
  }

  function todayView() {
    const { digest } = state.data;
    const pm = L.portfolioMove(state.holdings, digest.prices || {});
    const { attention, oneLiners } = L.splitDigest(digest.items || [], state.holdings, CFG.maxAttention || 3);
    const out = [];
    const strip0 = marketsStrip();
    if (strip0) out.push(strip0);

    const status = h('section', { class: 'wide' }, h('h2', null, 'Portfolio'));
    if (pm.move === null) {
      status.append(h('p', { class: 'muted' }, 'This update has no prices for your holdings.'));
    } else {
      status.append(h('p', { class: 'lede' }, 'Your book ', h('span', { class: 'num ' + dirClass(pm.move) }, fmtPct(pm.move)), ' at the last close.'));
      const bits = [];
      if (pm.best) bits.push(`Biggest lift: ${pm.best.ticker} ${fmtPct(pm.best.change)}, ${fmtBps(pm.best.contribution)} of the book`);
      if (pm.worst && pm.worst !== pm.best) bits.push(`Biggest drag: ${pm.worst.ticker} ${fmtPct(pm.worst.change)}, ${fmtBps(pm.worst.contribution)} of the book`);
      if (bits.length) status.append(h('p', { class: 'muted' }, bits.join('. ') + '.'));
      if (pm.coverage < 1) status.append(h('p', { class: 'small muted' }, `Prices cover ${Math.round(pm.coverage * 100)}% of your book by weight.`));
    }
    const note = digest.snapshot ? null : L.marketNote(digest);
    if (note) status.append(h('p', { class: 'small' }, note));
    out.push(status);

    out.push(h('section', { class: 'wide' }, h('h2', null, 'Market map'), h('p', { class: 'small muted' }, 'One-day move for the 15-name universe. An outlined tile is in your book. Tap a tile for its thesis.'), heatmap()));

    const held = L.cleanHoldings(state.holdings).map((x) => x.ticker);
    out.push(h('section', { class: 'wide' }, h('h2', null, 'Your holdings'), quoteTable(held)));

    out.push(RUI.macroAndWatch(L.cleanHoldings(state.holdings)));
    out.push(headlinesSection());

    const att = h('section', null, h('h2', null, 'Needs attention'));
    if (!attention.length) att.append(h('p', { class: 'empty' }, 'Nothing in this snapshot needs your attention.'));
    else att.append(h('ul', { class: 'rows' }, attention.map((it, i) => itemRow(it, 'att-' + i))));
    out.push(att);

    const hold = h('section', null, h('h2', null, 'Other holdings'));
    if (!oneLiners.length) hold.append(h('p', { class: 'empty' }, 'No other news on your holdings in this snapshot.'));
    else {
      hold.append(h('ul', { class: 'rows' }, oneLiners.map((o, i) =>
        h('li', { class: 'row' },
          h('button', { class: 'row-btn', type: 'button', 'data-key': 'one-' + i, onclick: () => pushSheet('Item', () => itemSheet(o.item)) },
            h('span', { class: 'row-main' },
              h('span', { class: 'row-title' }, h('span', { class: 'tickers' }, o.ticker), ' ', o.item.headline)),
            h('span', { class: 'chev', 'aria-hidden': 'true' }, '›'))))));
    }
    out.push(hold);

    const macro = h('section', null, h('h2', null, 'Macro'));
    if (!(digest.macro || []).length) macro.append(h('p', { class: 'empty' }, 'No macro items in this update.'));
    else macro.append(h('ul', { class: 'rows' }, digest.macro.slice(0, 5).map((it, i) => itemRow(it, 'macro-' + i))));
    out.push(macro);

    const week = L.upcoming(digest.calendar, digest.generated_at, 7);
    const next = h('section', null, h('h2', null, 'Next 7 days'));
    if (!week.length) next.append(h('p', { class: 'empty' }, 'No calendar in this snapshot. A live event calendar is a planned upgrade.'));
    else next.append(h('ul', { class: 'rows' }, week.map((e) => calendarRow(e))));
    out.push(next);
    return out;
  }

  /* Auto headlines from the news job: Yahoo Finance via yfinance, newest first, holdings first. */
  function headlinesSection() {
    const box = h('section', { class: 'wide', id: 'headlines' }, h('h2', null, 'Latest headlines'));
    const fill = (items) => {
      const held = new Set(L.cleanHoldings(state.holdings).map((x) => x.ticker));
      const mine = items.filter((n) => (n.tickers || []).some((t) => held.has(t)));
      const rest = items.filter((n) => !mine.includes(n));
      const list = mine.concat(rest).slice(0, 8);
      if (!list.length) { box.append(h('p', { class: 'empty' }, 'No headlines published yet. The news job fills this each day.')); return; }
      box.append(h('ul', { class: 'rows' }, list.map((n) => {
        const u = safeUrl(n.url);
        const ago = n.t ? Math.max(0, Math.round((Date.now() / 1000 - n.t) / 3600)) : null;
        return h('li', { class: 'row row-static news' }, h('span', { class: 'row-main' },
          u ? h('a', { class: 'row-title', href: u, target: '_blank', rel: 'noopener' }, n.title) : h('span', { class: 'row-title' }, n.title), h('br'),
          h('span', { class: 'row-sub' }, [(n.tickers || []).join(', '), n.source, ago === null ? null : ago < 1 ? 'under an hour ago' : ago < 48 ? ago + ' h ago' : Math.round(ago / 24) + ' days ago'].filter(Boolean).join(' · '))));
      })), h('p', { class: 'small muted' }, 'Headlines are collected automatically and link to the publisher. They are not curated or rated.'));
    };
    if (state.newsCache) fill(state.newsCache);
    else DataApi.get('news').then((r) => { state.newsCache = (r.data && r.data.items) || []; if (document.contains(box)) { box.querySelectorAll('p.empty,ul,p.small').forEach((n) => n.remove()); fill(state.newsCache); } });
    return box;
  }

  function calendarRow(e) {
    const held = new Set(state.holdings.map((x) => x.ticker));
    const mine = (e.tickers || []).some((t) => held.has(t));
    return h('li', { class: 'row row-static' },
      h('span', { class: 'muted', style: 'min-width:84px' }, L.formatDateLabel(e.date)),
      h('span', { class: 'row-main' }, e.label,
        (e.tickers || []).length ? h('span', { class: 'row-sub' }, ' ' + e.tickers.join(', ')) : null),
      mine ? h('span', { class: 'pill holding' }, 'In your book') : null);
  }

  /* ---------- Holdings ---------- */

  function holdingsView() {
    const { digest } = state.data;
    const hs = L.cleanHoldings(state.holdings).sort((a, b) => b.weight - a.weight);
    const total = L.totalWeight(hs);
    const pm = L.portfolioMove(hs, digest.prices || {});
    const byTicker = {};
    for (const c of pm.contributions) byTicker[c.ticker] = c;
    const out = [];

    const head = h('section', null,
      h('div', { class: 'inline', style: 'justify-content:space-between' },
        h('h2', { style: 'margin:0' }, 'Holdings'),
        h('button', { class: 'text-btn', type: 'button', onclick: () => { state.editing = !state.editing; render(); } }, state.editing ? 'Done' : 'Edit')));
    if (!state.storageOk) head.append(h('p', { class: 'banner warn', style: 'margin-top:8px' }, 'This browser is not saving changes. Export a backup before you close the app.'));
    if (!hs.length) head.append(h('p', { class: 'empty' }, 'No holdings yet. Tap Edit to add some.'));
    else {
      head.append(h('ul', { class: 'rows' }, hs.map((x) => {
        const items = (digest.items || []).filter((i) => (i.tickers || []).includes(x.ticker));
        const chg = byTicker[x.ticker];
        const pctOfBook = total ? ((x.weight / total) * 100).toFixed(1) : '0.0';
        const sub = `${pctOfBook}% of book` + (items.length ? `, ${plural(items.length, 'update')}` : '');
        if (state.editing) {
          const input = h('input', { type: 'number', class: 'weight-input', inputmode: 'decimal', min: '0', step: '0.5', 'aria-label': `Weight for ${x.ticker}` });
          input.value = String(x.weight);
          input.addEventListener('change', () => {
            const w = Number(input.value);
            if (!isFinite(w) || w < 0) { input.value = String(x.weight); toast('Enter a weight of zero or more.'); return; }
            state.holdings = state.holdings.map((y) => (y.ticker === x.ticker ? { ticker: y.ticker, weight: w } : y));
            persist(); render();
          });
          return h('li', { class: 'row row-static' },
            h('span', { class: 'row-main' }, h('span', { class: 'row-title' }, h('span', { class: 'tickers' }, x.ticker), ' ', nameOf(x.ticker))),
            input,
            h('button', { class: 'btn small', type: 'button', onclick: () => { state.holdings = state.holdings.filter((y) => y.ticker !== x.ticker); persist(); render(); } }, 'Remove'));
        }
        const inner = [
          h('span', { class: 'row-main' },
            h('span', { class: 'row-title' }, h('span', { class: 'tickers' }, x.ticker), ' ', nameOf(x.ticker)),
            h('br'),
            h('span', { class: 'row-sub' }, sub)),
          h('span', { class: 'row-end ' + (chg ? dirClass(chg.change) : 'muted') }, chg ? fmtPct(chg.change) : 'No price')
        ];
        inner.push(h('span', { class: 'chev', 'aria-hidden': 'true' }, '›'));
        return h('li', { class: 'row' }, h('button', { class: 'row-btn', type: 'button', onclick: () => STK.open(x.ticker) }, inner));
      })));
      if (total !== 100) head.append(h('p', { class: 'small muted' }, `Weights add up to ${Number(total.toFixed(2))}. They are treated as relative, so they do not need to reach 100.`));
    }

    if (state.editing) {
      const held = new Set(hs.map((x) => x.ticker));
      const sel = h('select', { 'aria-label': 'Stock to add' }, h('option', { value: '' }, 'Choose a stock'),
        state.data.universe.filter((u) => !u.sample && !held.has(u.ticker)).map((u) => h('option', { value: u.ticker }, `${u.ticker}, ${u.name}`)));
      const w = h('input', { type: 'number', class: 'weight-input', inputmode: 'decimal', min: '0', step: '0.5', 'aria-label': 'Weight to add' });
      w.value = '5';
      head.append(h('h3', null, 'Add a holding'),
        h('div', { class: 'inline' }, sel, w,
          h('button', { class: 'btn', type: 'button', onclick: () => {
            const wt = Number(w.value);
            if (!sel.value) { toast('Choose a stock first.'); return; }
            if (!isFinite(wt) || wt <= 0) { toast('Enter a weight above zero.'); return; }
            state.holdings = state.holdings.concat([{ ticker: sel.value, weight: wt }]);
            persist(); render();
          } }, 'Add')));
    }
    out.push(head);
    out.push(RUI.positionRead(hs));

    const backup = h('section', null,
      h('h2', null, 'Backup'),
      h('p', { class: 'muted' }, 'Your holdings and ratings live only on this device. Export a backup so you can restore them if the app is reinstalled.'),
      h('p', { class: 'inline' },
        h('button', { class: 'btn', type: 'button', onclick: exportBackup }, 'Export backup'),
        h('button', { class: 'btn', type: 'button', onclick: () => { state.restoreOpen = !state.restoreOpen; state.restoreError = ''; render(); } }, 'Restore from backup')));
    if (state.restoreOpen) {
      const ta = h('textarea', { id: 'restore-text', 'aria-label': 'Paste backup text here', placeholder: 'Paste backup text here' });
      backup.append(ta,
        state.restoreError ? h('p', { class: 'down', role: 'alert' }, state.restoreError) : null,
        h('p', null, h('button', { class: 'btn primary', type: 'button', onclick: () => {
          const res = L.parseBackup(ta.value, knownTickers());
          if (!res.ok) { state.restoreError = res.error; render(); return; }
          state.holdings = res.holdings;
          state.feedback = Object.assign({}, state.feedback, res.feedback);
          if (res.disputes) { state.disputes = res.disputes; state.tilt = res.tilt || null; state.deepen = res.deepen || []; store.set('disputes', state.disputes); store.set('tilt', state.tilt); store.set('deepen', state.deepen); }
          persist();
          state.restoreOpen = false; state.restoreError = '';
          render(); toast('Backup restored.');
        } }, 'Restore')));
    }
    out.push(backup);
    return out;
  }

  async function exportBackup() {
    const text = JSON.stringify({ version: 1, exported_at: new Date().toISOString(), holdings: state.holdings, feedback: state.feedback, disputes: state.disputes, tilt: state.tilt, deepen: state.deepen }, null, 2);
    if (navigator.share) {
      try { await navigator.share({ title: `${CFG.appName} backup`, text }); return; } catch (e) { if (e && e.name === 'AbortError') return; }
    }
    try {
      const blob = new Blob([text], { type: 'application/json' });
      const a = h('a', { href: URL.createObjectURL(blob), download: 'portfolio-monitor-backup.json' });
      document.body.append(a); a.click(); a.remove();
      toast('Backup saved to your downloads.');
    } catch (e) {
      const ok = await copyText(text);
      toast(ok ? 'Backup copied. Paste it somewhere safe.' : 'Could not export the backup.');
    }
  }

  /* ---------- Universe ---------- */

  function cardVerdict(t) { const c = cardOf(t); return c ? c.verdict : null; }

  function universeView() {
    const { universe, cards } = state.data;
    const published = Object.keys(cards).filter((t) => !cards[t].sample).length;
    const total = universe.filter((u) => !u.sample).length;
    const sectors = ['All'].concat(Array.from(new Set(universe.map((u) => u.sector))));
    const verdicts = ['All', 'Strong', 'Moderate', 'Weak', 'Contested', 'Thesis pending'];

    const listBox = h('div', { 'aria-live': 'polite' });
    const drawList = () => {
      const q = state.uni.q.trim().toLowerCase();
      const rows = universe.filter((u) => {
        if (state.uni.sector !== 'All' && u.sector !== state.uni.sector) return false;
        const v = cardVerdict(u.ticker);
        if (state.uni.verdict === 'Thesis pending' && v) return false;
        if (!['All', 'Thesis pending'].includes(state.uni.verdict) && v !== state.uni.verdict) return false;
        if (q && !(u.ticker.toLowerCase().includes(q) || u.name.toLowerCase().includes(q))) return false;
        return true;
      });
      if (!rows.length) { listBox.replaceChildren(h('p', { class: 'empty' }, 'No companies match. Clear a filter to see more.')); return; }
      listBox.replaceChildren(h('ul', { class: 'rows' }, rows.map((u) => {
        const c = cardOf(u.ticker);
        const mv = moveOf(u.ticker);
        const px = state.data.digest.prices && state.data.digest.prices[u.ticker];
        const quote = h('span', { class: 'uq' }, h('span', { class: 'num' }, px ? fmtPx(px.close) : 'n/a'), h('span', { class: 'num chg ' + (mv === null ? '' : dirClass(mv)) }, mv === null ? 'n/a' : fmtPct(mv)));
        const ev = RUI.evalFor(u.ticker, true);
        const end = [quote, c ? strip(c) : null, c ? h('span', { class: 'pill ' + verdictClass(c.verdict) }, c.verdict) : null, ev ? RUI.stancePill(ev.stance) : RUI.depthPill(u.ticker)];
        const main = h('span', { class: 'row-main' },
          h('span', { class: 'row-title' }, h('span', { class: 'tickers' }, u.ticker), ' ', u.name),
          h('br'), h('span', { class: 'row-sub' }, u.sector + ' · ' + (RUI.valuationLine(u.ticker) || '')));
        return h('li', { class: 'row' }, h('button', { class: 'row-btn', type: 'button', onclick: () => STK.open(u.ticker) },
          main, h('span', { class: 'row-end inline', style: 'gap:10px;justify-content:flex-end' }, end), h('span', { class: 'chev', 'aria-hidden': 'true' }, '›')));
      })));
    };

    const search = h('input', { type: 'search', id: 'uni-q', 'aria-label': 'Search by name or ticker', placeholder: 'Search by name or ticker', autocomplete: 'off' });
    search.value = state.uni.q;
    search.addEventListener('input', () => { state.uni.q = search.value; drawList(); });
    const sectorSel = h('select', { 'aria-label': 'Sector' }, sectors.map((s) => h('option', { value: s }, s === 'All' ? 'All sectors' : s)));
    sectorSel.value = state.uni.sector;
    sectorSel.addEventListener('change', () => { state.uni.sector = sectorSel.value; drawList(); });
    const verdictSel = h('select', { 'aria-label': 'Verdict' }, verdicts.map((s) => h('option', { value: s }, s === 'All' ? 'All verdicts' : s)));
    verdictSel.value = state.uni.verdict;
    verdictSel.addEventListener('change', () => { state.uni.verdict = verdictSel.value; drawList(); });

    const resultBox = h('div', { 'aria-live': 'polite' });
    const queries = [
      { label: 'Weakest force in my book', empty: 'No published cards match your holdings yet.',
        run: () => L.weakestForces(cards, state.holdings).slice(0, 8).map((x) => `${x.ticker}: ${L.FORCE_LABEL[x.force]}, ${x.score} of 5`) },
      { label: 'Falsifiers close to tripping', empty: 'No falsifiers are on watch for your holdings.',
        run: () => L.falsifiersAtRisk(cards, state.holdings).map((x) => `${x.ticker}: ${x.text} (${x.status}). Threshold: ${x.threshold}`) }
    ];
    const chips = queries.map((qy) => h('button', { class: 'chip', type: 'button', 'aria-pressed': 'false', onclick: (ev) => {
      chips.forEach((c) => c.setAttribute('aria-pressed', 'false'));
      ev.currentTarget.setAttribute('aria-pressed', 'true');
      const lines = qy.run();
      resultBox.replaceChildren(h('div', { class: 'result' }, lines.length ? lines.map((l) => h('p', null, l)) : h('p', { class: 'muted' }, qy.empty)));
    } }, qy.label));

    drawList();
    return [
      h('section', null,
        h('h2', null, 'Universe'),
        h('p', { class: 'muted' }, `${published} of ${total} thesis cards published.`),
        h('div', { class: 'seg-group', role: 'group', 'aria-label': 'Quick questions' }, chips),
        resultBox),
      h('section', null,
        h('div', { class: 'filters' }, search, sectorSel, verdictSel),
        listBox)
    ];
  }

  /* ---------- Thesis card ---------- */

  function porterSheet(ticker) {
    const card = cardOf(ticker);
    if (!card) return h('div', null, h('h2', { class: 'card-title' }, nameOf(ticker)), h('p', { class: 'muted' }, 'The thesis card for this company is not published yet. Cards are added name by name.'));
    const check = L.validateCard(card);
    const trendNote = (t) => (t === 'strengthening' ? { text: 'Force is strengthening', cls: 'worse' } : t === 'weakening' ? { text: 'Force is weakening', cls: 'better' } : { text: 'Force is stable', cls: '' });
    const out = h('div', null);

    out.append(h('div', { class: 'card-head' },
      h('h2', { class: 'card-title' }, card.name || nameOf(ticker)),
      h('div', { class: 'card-meta' },
        h('span', { class: 'pill ' + verdictClass(card.verdict) }, card.verdict),
        strip(card),
        h('span', { class: 'muted' }, `Trend: ${card.trend}`),
        h('span', { class: 'muted' }, `Confidence: ${card.confidence}`)),
      h('p', { class: 'small muted' }, `As of ${L.formatDateLabel(card.as_of)}. Card ${card.id}, version ${card.version}.`)));
    if (card.sample) out.append(h('p', { class: 'banner sample' }, h('strong', null, 'Sample card. '), 'It shows the layout and does not describe a real company.'));
    if (card.summary) out.append(h('p', null, card.summary));
    if (!check.ok) {
      out.append(h('div', { class: 'problems', role: 'alert' }, h('strong', null, 'This card failed automatic checks.'),
        h('ul', { class: 'list' }, check.problems.map((p) => h('li', null, p)))));
    }

    out.append(h('h3', null, 'Five forces'),
      h('p', { class: 'small muted' }, 'A score of 5 means the force is weak for this company, which protects pricing power. Evidence tiers: H is filing or computed data, M is filing text, L is a management claim.'));
    for (const f of L.FORCES) {
      const force = card.forces[f];
      if (!force) continue;
      const tn = trendNote(force.trend);
      out.append(h('div', { class: 'force' },
        h('div', { class: 'force-head' },
          h('span', { class: 'force-name' }, L.FORCE_LABEL[f]),
          h('span', { class: 'score' }, `${force.score} of 5`)),
        h('div', { class: 'meter', 'aria-hidden': 'true' }, [1, 2, 3, 4, 5].map((n) => h('i', { class: n <= force.score ? 'on' : '' }))),
        h('div', { class: 'trend ' + tn.cls },
          tn.text + (force.firm_adjust ? `. Adjusted ${force.firm_adjust > 0 ? '+' : ''}${force.firm_adjust} versus peers.` : '.')),
        h('ul', { class: 'evidence' }, (force.evidence || []).map((e) => {
          const url = e.source && safeUrl(e.source.url);
          return h('li', null, h('span', { class: 'tier', title: 'Confidence tier' }, e.tier), e.text, ' ',
            h('span', { class: 'small muted' }, `(${e.basis}; `,
              url ? h('a', { href: url, target: '_blank', rel: 'noopener' }, e.source.title) : (e.source ? e.source.title : 'no source'),
              e.source && e.source.date ? ', ' + e.source.date : '', ')'));
        }))));
    }

    const rec = card.reconciliation;
    if (rec) {
      out.append(h('h3', null, 'Story versus numbers'));
      if (rec.status === 'conflict' && rec.story && rec.numbers) {
        out.append(h('div', { class: 'split' },
          h('div', null, h('h3', null, 'The story'), h('p', null, rec.story)),
          h('div', null, h('h3', null, 'The numbers'), h('p', null, rec.numbers))));
      } else {
        out.append(h('p', null, rec.status === 'pass' ? 'The numbers support the story.' : rec.status === 'conflict' ? 'The numbers conflict with the story.' : 'Not enough data to reconcile the story with the numbers.'));
      }
      if ((rec.tests || []).length) out.append(h('ul', { class: 'list' }, rec.tests.map((t) => h('li', null, h('strong', null, t.name + ': '), t.result))));
    }

    const factList = (title, facts) => (facts && facts.length
      ? [h('h3', null, title), h('ul', { class: 'list' }, facts.map((x) => h('li', null, x.text, ' ', x.source ? h('span', { class: 'small muted' }, `(${x.source.title}, ${x.source.date})`) : null)))]
      : []);
    out.append(...factList('Strongest supporting facts', card.supporting), ...factList('Strongest counter-facts', card.counter));

    out.append(h('h3', null, 'Falsifiers'),
      h('ul', { class: 'rows' }, (card.falsifiers || []).map((f) =>
        h('li', { class: 'row row-static' },
          h('span', { class: 'row-main' }, h('span', { class: 'row-title' }, f.text), h('br'), h('span', { class: 'row-sub' }, 'Threshold: ' + f.threshold)),
          h('span', { class: 'pill ' + f.status }, f.status)))));

    out.append(h('p', { style: 'margin-top:20px' },
      h('button', { class: 'btn primary', type: 'button', onclick: () => pushSheet('Ask Claude', () => askSheet(ticker)) }, 'Ask Claude about this card')));
    return out;
  }

  function cardSheet(ticker) { return RUI.cardWithToggle(ticker, porterSheet); }

  /* ---------- Ask Claude ---------- */

  const ASK_LABELS = ['Challenge the score', 'What would break it', 'Compare with a peer', 'Plain language'];

  const CLAUDE_NEW = 'https://claude.ai/new';

  /* The hand-off, in one place so the button, the preview and the tests agree.
     1. Build a full, self-contained prompt (card, evidence, falsifiers, news; holdings only if opted in).
     2. Copy the full prompt to the clipboard (always works, needs no network).
     3. Open claude.ai/new with a short version prefilled via ?q=. If the prefill is ignored by the
        device, the clipboard still holds everything and the user pastes it. */
  function askPrompts(ticker) {
    const card = cardOf(ticker);
    return L.buildAskPrompt({
      card, question: L.ASK_QUESTIONS[state.ask.q], holdings: state.holdings, includeHoldings: state.ask.includeHoldings,
      news: newsFor(ticker), snapshotLabel: state.data.digest.snapshot_label
    });
  }
  const askUrl = (compact) => CLAUDE_NEW + '?q=' + encodeURIComponent(compact);

  function askSheet(ticker) {
    const card = cardOf(ticker);
    const nNews = newsFor(ticker).slice(0, 4).length;
    const preview = h('pre', { class: 'prompt', 'aria-live': 'polite' });
    const qBtns = L.ASK_QUESTIONS.map((q, i) => h('button', { class: 'chip', type: 'button', 'aria-pressed': 'false',
      onclick: () => { state.ask.q = i; update(); } }, ASK_LABELS[i]));
    const sizeNote = h('p', { class: 'small muted' });
    const link = h('a', { class: 'btn primary', href: CLAUDE_NEW, target: '_blank', rel: 'noopener', 'data-key': 'ask-open' }, 'Ask Claude');
    const update = () => {
      const p = askPrompts(ticker);
      preview.textContent = p.full;
      link.setAttribute('href', askUrl(p.compact));
      sizeNote.textContent = `Full prompt: ${p.full.length.toLocaleString('en-US')} characters, with ${plural(nNews, 'news item')}.`;
      qBtns.forEach((b, i) => b.setAttribute('aria-pressed', String(i === state.ask.q)));
    };
    const box = h('input', { type: 'checkbox', id: 'inc-holdings' });
    box.checked = state.ask.includeHoldings;
    box.addEventListener('change', () => { state.ask.includeHoldings = box.checked; update(); });
    // Copy first, then let the link open. The click handler must not block the navigation.
    link.addEventListener('click', () => {
      copyText(askPrompts(ticker).full).then((ok) => toast(ok
        ? 'Full prompt copied. If Claude opens empty, paste it.'
        : 'Could not copy. Select the text on this page and copy it by hand.'));
    });
    update();

    return h('div', null,
      h('h2', { class: 'card-title' }, 'Ask Claude'),
      h('p', { class: 'muted' }, `Ask Claude to test the ${card.name || ticker} thesis. Everything it needs is inside the prompt, with sources and dates. Nothing needs to be connected.`),
      h('h3', null, 'Question'),
      h('div', { class: 'seg-group', role: 'group', 'aria-label': 'Question' }, qBtns),
      h('label', { class: 'check', for: 'inc-holdings' }, box, 'Include my holding weights. They stay on this device unless you tick this.'),
      h('p', { class: 'inline' }, link,
        h('button', { class: 'btn', type: 'button', 'data-key': 'ask-copy', onclick: async () => {
          const ok = await copyText(askPrompts(ticker).full);
          toast(ok ? 'Full prompt copied. Paste it into a chat with Claude.' : 'Could not copy. Select the text below and copy it by hand.');
        } }, 'Copy full prompt')),
      h('p', { class: 'small muted' }, 'Ask Claude copies the full prompt and opens a new chat with a short version already typed. Send it, then paste the full prompt as your next message if Claude asks for the evidence. If the new chat opens empty on your device, just paste.'),
      h('h3', null, 'Full prompt'),
      sizeNote,
      preview);
  }

  /* ---------- Calendar ---------- */

  function calendarView() {
    const cal = (state.data.digest.calendar || []).slice().sort((a, b) => a.date.localeCompare(b.date) || String(a.label).localeCompare(String(b.label)));
    const out = [h('section', null, h('h2', null, 'Calendar'))];
    if (!cal.length) { out[0].append(h('p', { class: 'empty' }, 'No scheduled events in this update.')); return out; }
    const groups = {};
    for (const e of cal) (groups[e.date] = groups[e.date] || []).push(e);
    for (const date of Object.keys(groups)) {
      out[0].append(h('h3', null, L.formatDateLabel(date)), h('ul', { class: 'rows' }, groups[date].map((e) => calendarRow(Object.assign({}, e, { date: e.date })))));
    }
    return out;
  }

  /* ---------- Help ---------- */

  const WALKTHROUGH = [
    ['What this is', 'A daily read on your portfolio and on the structure of each business you own. It is a research and monitoring tool. It does not give investment advice.'],
    ['What you are looking at', 'This version is a static snapshot: closing prices from 28 September 2026 and news from 21 to 29 September 2026. It is clearly dated on every screen. Live prices and a daily refresh are the next upgrade.'],
    ['How to read an item', 'Each item says which holding it touches and which of the five forces it bears on. Tap it to see the source. Rate it Useful, Noise or Wrong. Your ratings decide what the next version shows.'],
    ['The thesis cards', 'Each card scores five forces from 1 to 5. A 5 means the force is weak for that company, so pricing power is safer. Every score needs cited evidence. Falsifiers are the signals that would prove the thesis wrong.'],
    ['Ask Claude', 'Every thesis card has an Ask Claude button. It copies the full card, its sources and the related news, then opens a new chat in Claude with a short version typed in. Nothing needs to be connected. Your holdings stay on this device unless you tick the box.']
  ];

  function walkthroughSheet() {
    const [title, text] = WALKTHROUGH[state.onbStep];
    const last = state.onbStep === WALKTHROUGH.length - 1;
    return h('div', null,
      h('p', { class: 'small muted' }, `Step ${state.onbStep + 1} of ${WALKTHROUGH.length}`),
      h('h2', { class: 'card-title' }, title),
      h('p', { class: 'lede', style: 'font-size:19px;font-weight:500;font-family:var(--sans)' }, text),
      h('p', { class: 'inline', style: 'margin-top:20px' },
        state.onbStep > 0 ? h('button', { class: 'btn', type: 'button', 'data-key': 'onb-back', onclick: () => { state.onbStep--; refreshSheet(); } }, 'Back') : null,
        h('button', { class: 'btn primary', type: 'button', 'data-key': 'onb-next', onclick: () => {
          if (last) { closeAllSheets(); return; }
          state.onbStep++; refreshSheet();
        } }, last ? 'Start' : 'Next')));
  }

  function startWalkthrough() { state.onbStep = 0; pushSheet('Welcome', walkthroughSheet); }

  async function sendFeedback() {
    const text = L.feedbackToText(state.feedback, { app: CFG.appName });
    if (CFG.feedbackEmail && text.length <= 1800) {
      location.href = `mailto:${CFG.feedbackEmail}?subject=${encodeURIComponent(CFG.appName + ' feedback')}&body=${encodeURIComponent(text)}`;
      return;
    }
    if (navigator.share) {
      try { await navigator.share({ title: `${CFG.appName} feedback`, text }); return; } catch (e) { if (e && e.name === 'AbortError') return; }
    }
    const ok = await copyText(text);
    toast(ok ? 'Feedback copied. Paste it into a message.' : 'Could not copy the feedback.');
  }

  function helpView() {
    const rated = Object.keys(state.feedback).length;
    const conn = h('section', null,
      h('h2', null, 'Ask Claude'),
      h('p', null, 'On a thesis card, tap Ask Claude. The app copies a self-contained prompt (the card, its evidence and sources, and the related news) and opens claude.ai with a short version prefilled. If the new chat opens empty on your device, paste the prompt.'),
      h('p', { class: 'muted' }, 'You need a Claude account. Nothing has to be connected or installed.'));
    return [
      h('section', null,
        h('h2', null, 'Install on any device'),
        h('ul', { class: 'list' },
          h('li', null, h('strong', null, 'iPhone or iPad: '), 'open the page in Safari, tap Share, choose Add to Home Screen, then open it from the Home Screen.'),
          h('li', null, h('strong', null, 'Android: '), 'open the page in Chrome, tap the menu, choose Install app or Add to Home screen.'),
          h('li', null, h('strong', null, 'Windows, Mac or Linux: '), 'open the page in Chrome or Edge and click the install icon in the address bar.')),
        h('p', { class: 'muted' }, 'This version is a dated snapshot and does not send alerts.'),
        h('p', null, h('button', { class: 'btn', type: 'button', onclick: startWalkthrough }, 'Replay the walkthrough'))),
      h('section', null,
        h('h2', null, 'Reading the digest'),
        h('ul', { class: 'list' },
          h('li', null, 'Needs attention shows at most three items, ranked by how much they matter to your holdings.'),
          h('li', null, 'Silence under a holding means no news was found in the snapshot, not that nothing happened.'),
          h('li', null, 'Every fact links to its source. If a figure looks wrong, tap Wrong and say what.'),
          h('li', null, 'A Contested verdict means the story and the numbers disagree. The card shows both.'))),
      conn,
      h('section', null,
        h('h2', null, 'Send feedback'),
        h('p', null, 'After a week, answer three questions in your message: was it accurate, was it relevant to your book, and was it worth two minutes of your morning?'),
        h('p', { class: 'muted' }, `You have rated ${plural(rated, 'item')}.`),
        h('p', null, h('button', { class: 'btn primary', type: 'button', onclick: sendFeedback }, 'Send feedback'))),
      h('section', null,
        h('h2', null, 'About your data'),
        h('p', null, 'Your holdings and ratings stay on this device. The app only downloads its own data files. It is a research and monitoring tool and does not give investment advice.'))
    ];
  }

  /* ---------- shell ---------- */

  const TABS = [['today', 'Today'], ['holdings', 'Holdings'], ['universe', 'Universe'], ['markets', 'Markets'], ['view', 'Your view'], ['calendar', 'Calendar'], ['help', 'Help']];

  function renderTabs() {
    $('#tabs').replaceChildren(h('div', { class: 'tabs-inner' }, TABS.map(([id, label]) =>
      h('button', { type: 'button', 'aria-current': state.tab === id ? 'page' : null, onclick: () => {
        state.tab = id; state.editing = false; window.scrollTo(0, 0); render(); $('#view').focus({ preventScroll: true });
      } }, icon(id), h('span', null, label)))));
  }

  function renderBanners() {
    const banners = [];
    const d = state.data && state.data.digest;
    if (d && d.live) banners.push(h('div', { class: 'banner info', role: 'status' }, h('strong', null, 'Prices and index levels are live. '),
      'Refreshed ' + (d.live.asof ? d.live.asof.replace('T', ' ').slice(0, 16) + ' UTC' : 'recently') + (d.live.source === 'seed' ? ' (saved copy)' : '') + '. Needs-attention items and macro notes are a curated snapshot from ' + L.formatDateLabel((d.generated_at || '').slice(0, 10)) + ' and change only when the digest is rebuilt.'));
    if (d && d.snapshot) banners.push(h('div', { class: 'banner info', role: 'status' }, h('strong', null, 'Static snapshot, not live. '), d.snapshot_label || 'Data is dated.'));
    if (d && d.sample) banners.push(h('div', { class: 'banner sample', role: 'status' }, h('strong', null, 'Sample data. '), 'The numbers and headlines in this build are test values, not market data.'));
    if (d) {
      const s = L.staleness(d.live && d.live.asof ? d.live.asof : d.generated_at, Date.now(), d.live ? 36 : CFG.staleHours);
      if (s.stale && !d.snapshot) banners.push(h('div', { class: 'banner warn', role: 'status' },
        h('strong', null, 'This update is out of date. '),
        s.known ? `It is ${Math.floor(s.hours)} hours old. ` : 'Its time is unknown. ',
        'Do not treat these prices as current.'));
    }
    if (state.refreshFailed) banners.push(h('div', { class: 'banner warn', role: 'status' }, 'Could not refresh. You are seeing the last update saved on this device.',
      h('button', { class: 'btn small', type: 'button', onclick: refresh }, 'Try again')));
    $('#banners').replaceChildren(...banners);
  }

  function render() {
    $('#app-name').textContent = CFG.appName || 'Portfolio Monitor';
    document.title = CFG.appName || 'Portfolio Monitor';
    renderTabs();
    const view = $('#view');
    if (!state.data) {
      $('#updated').textContent = '';
      $('#banners').replaceChildren();
      view.replaceChildren(state.error
        ? h('section', null, h('h2', null, 'Could not load the update'),
            h('p', { class: 'muted' }, 'Check your connection and try again.'),
            h('p', { class: 'small muted' }, state.error),
            h('p', null, h('button', { class: 'btn primary', type: 'button', onclick: refresh }, 'Try again')))
        : h('section', null, h('p', { class: 'muted' }, 'Loading today’s update.')));
      return;
    }
    const gen = Date.parse(state.data.digest.generated_at);
    const lv = state.data.digest.live;
    $('#updated').textContent = lv && lv.asof ? 'Prices updated ' + L.formatSgt(Date.parse(lv.asof)) : state.data.digest.snapshot ? 'Snapshot, close of ' + L.formatDateLabel(state.data.digest.prices_session || state.data.digest.generated_at.slice(0, 10)) : (isNaN(gen) ? 'Update time unknown' : 'Updated ' + L.formatSgt(gen));
    renderBanners();
    const views = { today: todayView, holdings: holdingsView, universe: universeView, calendar: calendarView, help: helpView, markets: () => MK.build(), view: () => RUI.yourView() };
    view.className = 'view-' + state.tab;
    view.replaceChildren(...views[state.tab]());
  }

  async function refresh() {
    await loadData();
    render();
    if (state.sheets.length) refreshSheet();
  }

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && Date.now() - state.loadedAt > 15 * 60 * 1000) refresh();
  });
  window.addEventListener('online', () => { if (state.refreshFailed || state.error) refresh(); });

  async function init() {
    render();
    await loadData();
    render();
    if (state.data) RUI.loadEvidence();
    if (state.data && !store.get('onboarded', false)) {
      store.set('onboarded', true);
      startWalkthrough();
    }
  }

  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    window.addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(() => {}));
  }

  const RUI = window.makeResearchUI({
    h, state, store, pushSheet, popSheet, refreshSheet, render, toast, safeUrl, nameOf, porterSheet, cardSheet, openStock: (t, tab) => STK.open(t, tab),
    askAbout: (t) => { if (cardOf(t)) pushSheet('Ask Claude', () => askSheet(t)); else toast('Ask Claude needs a thesis card for this name.'); }
  });

  const MK = window.makeMarketsUI({ h, state, nameOf, openStock: (t) => STK.open(t) });
  const STK = window.makeStockUI({ h, state, pushSheet, refreshSheet, safeUrl, nameOf, thesis: (t) => cardSheet(t) });

  /* Live prices: the poller updates the in-memory prices and redraws the price-bearing tabs when that is safe. */
  DataApi.subscribe(Object.keys((state.data && state.data.market && state.data.market.stocks) || {}).length ? Object.keys(state.data.market.stocks) : ['V', 'LIN', 'LLY', 'MU', 'PG', 'MSFT', 'JPM', 'GOOGL', 'WM', 'COST', 'KO', 'AMZN', 'XOM', 'NEE', 'AMT'], (live) => {
    if (!state.data) return;
    const px = state.data.digest.prices = state.data.digest.prices || {};
    for (const [t, q] of Object.entries(live.quotes)) if (q && q.price) px[t] = { close: q.price, prev: q.prev_close != null ? q.prev_close : (px[t] || {}).prev };
    state.data.digest.live = Object.assign({}, state.data.digest.live, { asof: live.asof, source: 'live' });
    state.data.digest.snapshot = false;
    if ((state.tab === 'today' || state.tab === 'holdings') && !state.sheets.length && !state.editing) render();
  });

  init();

  // Small hook for the browser test.
  window.__monitor = { state, RUI, STK, render, pushSheet, cardSheet, itemSheet, askSheet, refresh };
})();
