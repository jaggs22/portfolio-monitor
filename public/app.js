/* app.js: shell, routes and the screens that are not a company page (Home, Coverage, Markets, Your view).
   Routes live in the URL hash: #/ · #/coverage · #/markets · #/view · #/c/LIN · #/c/LIN/valuation (a window). */
(function () {
  'use strict';
  const { h, fmt, icon, pill, chg, eyebrow, seg, btn, empty, note, stat, disclose, spark, store, toast, win, applyTheme, isDark } = window.UI;
  const L = window.Lib, E = window.Engine, D = window.DataApi;
  const CFG = window.APP_CONFIG || {};
  const $ = (s) => document.querySelector(s);

  const safeUrl = (u) => { try { const x = new URL(u, location.href); return x.protocol === 'https:' || x.protocol === 'http:' ? x.href : null; } catch (e) { return null; } };

  /* ---------- state ---------- */
  const state = {
    data: null, error: null, quotes: null, news: null,
    holdings: L.cleanHoldings(store.get('holdings', null) || L.DEFAULT_HOLDINGS),
    disputes: store.get('disputes', []) || [], tilt: store.get('tilt', null), deepen: store.get('deepen', []) || [],
    feedback: store.get('feedback', {}) || {}, covQ: '', tvSymbol: 'LIN', demoFiling: false
  };
  const save = () => { store.set('disputes', state.disputes); store.set('tilt', state.tilt); store.set('deepen', state.deepen); store.set('holdings', state.holdings); };
  const usd = (v) => '$' + Math.round(v || 0).toLocaleString('en-US');
  const bookUsd = () => (store.get('holdings_usd', false) ? L.cleanHoldings(state.holdings).reduce((a, x) => a + x.weight, 0) : 0);
  const nameOf = (t) => (state.uniMap && state.uniMap[t] ? state.uniMap[t].name : t);
  const CORE = ['LIN', 'LLY', 'V'];

  /* ---------- data ---------- */
  const getJson = (u, ms) => Promise.race([fetch(u, { cache: 'no-cache' }).then((r) => (r.ok ? r.json() : null)), new Promise((res) => setTimeout(() => res(null), ms || 6000))]).catch(() => null);
  async function loadData() {
    try {
      const [universe, cards, market, lenses, idx, digest] = await Promise.all(['universe', 'cards', 'market', 'lenses', 'research/index', 'digest'].map((n) => getJson(`data/${n}.json`)));
      if (!universe || !market) throw new Error('Core data files did not load.');
      const research = {};
      await Promise.all((idx || []).map((t) => getJson(`data/research/${t}.json`).then((r) => { if (r) research[t] = r; })));
      const live = (await getJson('/api/baseline', 4000)) || (await getJson('data/baseline.json')) || { filings: {}, quotes: {} };
      state.data = { universe, cards: cards || {}, market, lenses: lenses || { lenses: [] }, research, live, digest: digest || {} };
      state.uniMap = Object.fromEntries(universe.map((u) => [u.ticker, u]));
      const known = new Set(universe.map((u) => u.ticker));
      state.holdings = state.holdings.filter((x) => known.has(x.ticker));
      if (!state.holdings.length) state.holdings = L.cleanHoldings(L.DEFAULT_HOLDINGS).filter((x) => known.has(x.ticker));
      state.error = null;
    } catch (e) { state.error = e.message || 'Unknown error'; }
    D.get('quotes', null, { fresh: true }).then((r) => {
      state.quotes = r.data;
      const tnx = r.data && (r.data.markets || []).find((m) => m.symbol === '^TNX');
      if (state.data && tnx && tnx.price > 0.5 && tnx.price < 15) state.data.market.rates = Object.assign({}, state.data.market.rates, { rf: Math.round(tnx.price * 100) / 100, rf_live: true });
      render();
    });
    D.get('news').then((r) => { state.news = (r.data && r.data.items) || []; if (route().page === 'home') render(); });
  }

  function priceOf(t) { return CO ? CO.priceOf(t) : null; }

  /* ---------- routing ---------- */
  function route() {
    const p = (location.hash || '#/').replace(/^#\/?/, '').split('/').filter(Boolean);
    if (p[0] === 'c' && p[1]) return p[2] === 'report' ? { page: 'company', t: p[1].toUpperCase(), win: null, mode: 'report' } : { page: 'company', t: p[1].toUpperCase(), win: p[2] || null, mode: 'quick' };
    if (['coverage', 'markets', 'view', 'book'].includes(p[0])) return { page: p[0] };
    return { page: 'home' };
  }
  const go = (path) => { location.hash = '#/' + path.replace(/^\//, ''); };
  let pushedWin = 0, lastRoute = null;
  window.addEventListener('hashchange', () => {
    const r = route();
    const same = lastRoute && lastRoute.page === r.page && lastRoute.t === r.t && lastRoute.mode === r.mode;
    lastRoute = r;
    if (r.page === 'company' && r.win) {
      const top = win.top();
      if (!top || top.key !== r.win) { win.close(true); CO.openWin(r.t, r.win, { fromRoute: true }); }
      render(true);
      return;
    }
    if (win.depth()) { pushedWin = 0; win.close(true); }
    render(same);
    if (!same) window.scrollTo(0, 0);
  });

  /* ---------- shell ---------- */
  const NAV = [['home', '', 'Home', 'home'], ['coverage', 'coverage', 'Coverage', 'grid'], ['book', 'book', 'Your book', 'book'], ['markets', 'markets', 'Markets', 'markets'], ['view', 'view', 'Your view', 'view']];
  function sidebar(r) {
    return h('aside', { class: 'side' },
      h('a', { class: 'brand', href: '#/', style: { textDecoration: 'none' } }, UI.logo('brand-mark'), h('span', { class: 'brand-text' }, h('span', { class: 'brand-name' }, CFG.appName || 'Moat Monitor'), h('span', { class: 'brand-sub' }, 'AI Native Equity Research'))),
      h('nav', { class: 'nav', 'aria-label': 'Main' }, NAV.map(([id, path, label, ic]) => h('a', { href: '#/' + path, 'aria-current': r.page === id ? 'page' : null }, icon(ic), label))),
      h('div', { class: 'side-foot' }, usageBar(),
        h('button', { type: 'button', class: 'user', onclick: (e) => userMenu(e.currentTarget) }, h('span', { class: 'avatar' }, initial()), h('span', { class: 'user-t' }, h('b', null, workspaceName()), h('small', null, 'Holdings, theme, help'))),
        h('div', { class: 'marker' }, 'Prototype · live data, delayed')));
  }
  /* Shared AI usage today, all users: one bar in the sidebar (and in the menu on phones). */
  let llmQ = null;
  function usageBar() {
    const q = llmQ;
    if (!q) return h('div', { class: 'llm-use', hidden: true });
    const on = q.on !== false && q.cap > 0;
    const pct = on ? Math.min(1, (q.used || 0) / q.cap) : 0;
    const kind = !on ? '' : pct >= 1 ? 'bad' : pct >= 0.8 ? 'warn' : '';
    const at = q.resets_at ? new Date(q.resets_at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : '';
    return h('div', { class: 'llm-use ' + kind, title: 'Free AI analyst messages used today by all users. Resets daily; there is no paid overflow.' },
      h('div', { class: 'llm-top' }, h('span', null, 'AI analyst · today'), h('b', null, on ? Math.round(pct * 100) + '%' : 'Off')),
      h('div', { class: 'llm-bar', role: 'progressbar', 'aria-label': 'AI usage today, all users', 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': String(Math.round(pct * 100)) }, h('i', { style: { width: Math.round(pct * 100) + '%' } })),
      h('small', null, !on ? 'Chat is not switched on' : pct >= 1 ? `Used up for everyone · back at ${at}` : `${(q.left || 0).toLocaleString('en-US')} of ${q.cap.toLocaleString('en-US')} left · all users · resets ${at}`));
  }
  function paintUsage() { document.querySelectorAll('.llm-use').forEach((n) => n.replaceWith(usageBar())); }
  const userName = () => store.user() || '';
  const initial = () => (userName().trim()[0] || '?').toUpperCase();
  const workspaceName = () => (userName() ? `${userName()}'s workspace` : 'Your workspace');
  /* Sign-in: a username only, no password. It names the workspace and keeps each person's data separate on this device. */
  function gate() {
    const inp = h('input', { type: 'text', class: 'gate-in', placeholder: 'Enter your name', autocomplete: 'given-name', autocapitalize: 'words', maxlength: '40', 'aria-label': 'Your name' });
    const go2 = () => { if (store.signIn(inp.value)) location.reload(); else inp.focus(); };
    inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') go2(); });
    const view = h('div', { class: 'gate' }, h('div', { class: 'gate-card' },
      UI.logo('gate-mark'),
      h('h1', null, CFG.appName || 'Moat Monitor'),
      h('p', { class: 'gate-sub' }, 'AI Native Equity Research'),
      h('label', { class: 'gate-q' }, 'What should we call you?'),
      inp,
      btn('Continue', go2, 'primary'),
      h('p', { class: 'gate-note' }, 'No password. Your name labels your workspace and keeps your book separate from anyone else on this device.')));
    $('#app').replaceChildren(view);
    setTimeout(() => inp.focus(), 50);
  }
  function tabbar(r) {
    return h('nav', { class: 'tabbar', 'aria-label': 'Main' }, NAV.map(([id, path, label, ic]) => h('a', { href: '#/' + path, 'aria-current': r.page === id || (id === 'coverage' && r.page === 'company') ? 'page' : null }, icon(ic), label)));
  }
  function liveChip() {
    const lv = D.live;
    const on = lv.ok && lv.asof;
    const asof = on ? Date.parse(lv.asof) : state.quotes && state.quotes.asof ? Date.parse(state.quotes.asof) : null;
    return h('span', { class: 'live' + (on ? ' on' : '') }, h('i'), on ? 'Live · ' + fmt.ago(asof) : asof ? 'Updated ' + fmt.ago(asof) : 'Snapshot');
  }
  function topbar(r) {
    const crumbs = [h('a', { href: '#/' }, 'Home')];
    if (r.page === 'company') crumbs.push(icon('chev'), h('a', { href: '#/coverage', class: 'crumb-mid' }, 'Coverage'), h('span', { class: 'crumb-mid' }, icon('chev')), h('b', null, nameOf(r.t)));
    else if (r.page !== 'home') crumbs.push(icon('chev'), h('b', null, NAV.find((n) => n[0] === r.page)[2]));
    return h('header', { class: 'topbar' }, h('div', { class: 'crumbs' }, crumbs), h('div', { class: 'grow' }), liveChip(),
      h('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Switch theme', onclick: () => { applyTheme(isDark() ? 'light' : 'dark'); render(); } }, icon(isDark() ? 'sun' : 'moon')),
      h('button', { type: 'button', class: 'icon-btn', 'aria-label': 'More', onclick: (e) => userMenu(e.currentTarget) }, icon('dots')));
  }
  function userMenu(anchor) {
    document.querySelectorAll('.pop').forEach((p) => p.remove());
    const r = anchor.getBoundingClientRect();
    const close = () => { pop.remove(); document.removeEventListener('pointerdown', outside, true); };
    const outside = (e) => { if (!pop.contains(e.target)) close(); };
    const item = (ic, label, fn) => h('button', { type: 'button', onclick: () => { close(); fn(); } }, icon(ic), label);
    const pop = h('div', { class: 'pop', role: 'menu' },
      h('div', { class: 'pop-head' }, h('span', { class: 'avatar' }, initial()), h('b', null, workspaceName())),
      h('div', { class: 'pop-usage' }, usageBar()),
      item('grid', 'Edit holdings', holdingsWin),
      item('chev', 'Take the tour', () => { go(''); setTimeout(() => OB.tour('home'), 300); }),
      item(isDark() ? 'sun' : 'moon', isDark() ? 'Light mode' : 'Dark mode', () => { applyTheme(isDark() ? 'light' : 'dark'); render(); }),
      item('view', 'Your view and disputes', () => go('view')),
      h('hr'),
      item('news', 'How this works', helpWin),
      item('ext', 'Send feedback', sendFeedback),
      h('hr'),
      item('view', 'Switch user', () => { store.signOut(); location.reload(); }));

    document.body.append(pop);
    const top = r.bottom + 6 + pop.offsetHeight > innerHeight ? r.top - pop.offsetHeight - 6 : r.bottom + 6;
    pop.style.top = Math.max(8, top) + 'px';
    pop.style.left = Math.min(innerWidth - pop.offsetWidth - 8, Math.max(8, r.right - pop.offsetWidth)) + 'px';
    setTimeout(() => document.addEventListener('pointerdown', outside, true));
  }

  /* ---------- home: a launcher, not a dashboard ---------- */
  function greeting() { const hr = new Date().getHours(); return hr < 12 ? 'Good morning' : hr < 18 ? 'Good afternoon' : 'Good evening'; }
  function stockSearch() {
    const list = h('div', { class: 'hs-list', role: 'listbox' });
    const inp = h('input', { type: 'search', class: 'hs-in', placeholder: 'Find a stock by name or ticker', 'aria-label': 'Find a stock', autocomplete: 'off' });
    const depth = { core: 3, lighter: 2, basic: 1 };
    const draw = () => {
      const q = inp.value.trim().toLowerCase();
      const rows = state.data.universe.filter((u) => !q || u.ticker.toLowerCase().startsWith(q) || u.name.toLowerCase().includes(q)).slice(0, q ? 6 : 0);
      list.replaceChildren(...rows.map((u) => h('button', { type: 'button', class: 'hs-row', role: 'option', onclick: () => go('c/' + u.ticker) },
        h('span', { class: 'ob-depth', 'aria-hidden': 'true' }, [1, 2, 3].map((i) => h('i', { class: i <= depth[u.tier] ? 'on' : '' }))),
        h('b', null, u.ticker), h('span', null, u.name), icon('chev'))));
      list.hidden = !rows.length;
    };
    inp.addEventListener('input', draw);
    inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') { const b = list.querySelector('.hs-row'); if (b) b.click(); } });
    list.hidden = true;
    return h('div', { class: 'home-search' }, h('div', { class: 'hs-box' }, icon('search'), inp), list);
  }
  function pickCompany(title, sub, path) {
    win.open({ title, sub, build: () => stackOf(() => h('div', null, h('div', { class: 'card list' }, CORE.map((t) => {
      const c = CO.callOf(t, false);
      return h('button', { type: 'button', class: 'li', onclick: () => { win.close(true); go(`c/${t}${path}`); } },
        h('div', { class: 'li-main' }, h('div', { class: 'li-title' }, nameOf(t)), h('div', { class: 'li-sub' }, (CO.review(t) || {}).title || t)),
        c ? pill(c.rating, CO.ratingKind(c.rating)) : null, icon('chev'));
    })))) });
  }
  function comingUpWin() {
    win.open({ title: 'Coming up', sub: 'The next three weeks across the companies we cover.', build: () => stackOf(() => {
      const iso = new Date().toISOString().slice(0, 10), end = new Date(Date.now() + 21 * 864e5).toISOString().slice(0, 10);
      const ev = [];
      Object.values(state.data.research).forEach((r) => (r.catalysts || []).forEach((c) => { if (c.date >= iso && c.date <= end) ev.push(Object.assign({ t: r.ticker }, c)); }));
      ev.sort((a, b) => a.date.localeCompare(b.date));
      return h('div', null, ev.length ? h('div', { class: 'card list' }, ev.map((e) => h('button', { type: 'button', class: 'li', onclick: () => { win.close(true); go('c/' + e.t); } }, dateChip(e.date), h('div', { class: 'li-main' }, h('div', { class: 'li-title' }, e.label.replace(/ \(.*\)/, '')), h('div', { class: 'li-sub' }, nameOf(e.t) + (e.confirmed ? '' : ' · date not confirmed'))), icon('chev')))) : empty('Nothing scheduled in the next three weeks.'));
    }) });
  }
  function home() {
    const n = state.data.universe.length, deep = state.data.universe.filter((u) => u.tier === 'core').length;
    const bookN = L.cleanHoldings(state.holdings).length;
    const A = [
      ['chat', 'Add your own research', 'Share a view on any stock; the analyst tests it and saves it', () => CHAT.open(null, { view: true }), 'hot'],
      ['business', 'Read the research', `${CORE.map(nameOf).join(', ')} in full`, () => go('coverage')],
      ['report', 'Open a sell-side report', 'Five pages, ready to save as PDF', () => pickCompany('Open a report', 'Choose a company.', '/report')],
      ['branch', 'Challenge a thesis', 'Dispute an assumption and watch the target move', () => pickCompany('Challenge a thesis', 'Choose a company, then tap any assumption.', '/thesis')],
      ['book', 'View your book', bookUsd() ? `${usd(bookUsd())} across ${bookN} stock${bookN === 1 ? '' : 's'}` : `${bookN} stocks`, () => go('book')],
      ['calendar', 'What is coming up', 'Earnings and events in the next three weeks', comingUpWin],
      ['markets', 'Check the markets', 'Indices, rates and live charts', () => go('markets')],
      ['view', 'Your view', 'Every note and dispute you have made', () => go('view')]
    ];
    return [
      h('section', { class: 'home-hero' },
        eyebrow(new Date().toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' })),
        h('h1', null, `${greeting()}, ${String(userName()).split(' ')[0]}.`),
        h('p', { class: 'sub' }, 'Where would you like to start?'),
        stockSearch()),
      h('section', { class: 'qa-grid', 'aria-label': 'Quick actions' }, A.map(([ic, t, d, fn, hot]) => h('button', { type: 'button', class: 'qa' + (hot ? ' hot' : ''), onclick: fn },
        h('span', { class: 'qa-ic' }, icon(ic)), h('span', { class: 'qa-t' }, h('b', null, t), h('span', null, d)), icon('chev', 'qa-go')))),
      h('p', { class: 'home-foot' }, `${n} stocks covered · ${deep} in full research · `, h('a', { href: '#', onclick: (e) => { e.preventDefault(); OB.tour('home'); } }, 'Take the tour'))
    ];
  }

  /* ---------- your book ---------- */
  /* The book's move. A position only counts from the moment it was added: its entry price and time are stamped
     then. Until the market trades after that moment there is no move to show. In the first session after entry
     the move runs from the entry price; from the next session on it is the ordinary move from the prior close. */
  const ET = 'America/New_York';
  const etParts = (ms) => Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: ET, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', weekday: 'short', hour12: false }).formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  /* Wall-clock time in New York -> epoch ms (handles daylight saving by measuring the offset at that date). */
  function etToMs(y, mo, d, hh, mm) {
    const guess = Date.UTC(y, mo - 1, d, hh, mm);
    const p = etParts(guess);
    const asUtc = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour % 24, +p.minute);
    return guess - (asUtc - guess);
  }
  /* Close (4pm New York) of the last weekday session before the session that a quote at time ms belongs to. */
  function prevCloseMs(ms) {
    const p = etParts(ms);
    let d = new Date(Date.UTC(+p.year, +p.month - 1, +p.day));
    const mins = (+p.hour % 24) * 60 + +p.minute;
    if (mins >= 16 * 60 + 15) return etToMs(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate(), 16, 0);
    do { d = new Date(d.getTime() - 864e5); } while (d.getUTCDay() === 0 || d.getUTCDay() === 6);
    return etToMs(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate(), 16, 0);
  }
  /* Next 9:30am New York weekday open after now (exchange holidays are not modelled). */
  function nextOpenMs(now) {
    const p = etParts(now);
    let d = new Date(Date.UTC(+p.year, +p.month - 1, +p.day));
    const mins = (+p.hour % 24) * 60 + +p.minute;
    const wk = (x) => x.getUTCDay() !== 0 && x.getUTCDay() !== 6;
    if (!(wk(d) && mins < 9 * 60 + 30)) do { d = new Date(d.getTime() + 864e5); } while (!wk(d));
    return etToMs(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate(), 9, 30);
  }
  function stampEntries() {
    const ent = store.get('entries', {}) || {};
    let changed = false;
    L.cleanHoldings(state.holdings).forEach((x) => {
      if (ent[x.ticker]) return;
      const p = priceOf(x.ticker);
      if (p && p.price && p.src !== 'snapshot') { ent[x.ticker] = { price: p.price, at: Date.now() }; changed = true; }
    });
    Object.keys(ent).forEach((t) => { if (!state.holdings.some((x) => x.ticker === t)) { delete ent[t]; changed = true; } });
    if (changed) store.set('entries', ent);
    return ent;
  }
  function portfolioMove() {
    const ent = stampEntries();
    const prices = {};
    let fresh = 0, waiting = 0;
    L.cleanHoldings(state.holdings).forEach((x) => {
      const p = priceOf(x.ticker), e = ent[x.ticker];
      if (!p || p.pct == null) return;
      const asof = p.asof || Date.now();
      if (e && asof <= e.at) { waiting++; return; }
      if (e && e.at > prevCloseMs(asof)) { prices[x.ticker] = { close: p.price, prev: e.price }; fresh++; return; }
      prices[x.ticker] = { close: p.price, prev: p.price / (1 + p.pct) };
    });
    const out = L.portfolioMove(state.holdings, prices);
    out.waiting = waiting; out.fresh = fresh;
    if (!Object.keys(prices).length) out.move = null;
    return out;
  }
  function book() {
    const pm = portfolioMove();
    const today = new Date();
    const out = [];
    out.push(h('section', { class: 'hero' },
      h('div', null, eyebrow('Your book · ' + today.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' })),
        h('h1', { style: { marginTop: '8px' } }, pm.move == null ? 'Your book is set' : [pm.fresh ? 'Since you set it, your book is ' : 'Your book is ', h('span', { class: fmt.dir(pm.move) }, (pm.move >= 0 ? 'up ' : 'down ') + fmt.pct(Math.abs(pm.move), 2)), pm.fresh ? '' : ' today']),
        bookUsd() ? h('p', { class: 'book-usd' }, h('b', null, usd(bookUsd())), ' book', pm.move != null ? [' · ', h('span', { class: fmt.dir(pm.move) }, (pm.move >= 0 ? '+' : '−') + usd(Math.abs(pm.move * bookUsd()))), pm.fresh ? ' since you set it' : ' today'] : null) : null,
        pm.move == null ? h('p', { class: 'sub' }, `Tracking starts from your entry prices when the US market next trades, ${new Date(nextOpenMs(Date.now())).toLocaleString('en-GB', { weekday: 'short', hour: 'numeric', minute: '2-digit' })} your time.`) : null,
        pm.move == null ? null : h('p', { class: 'sub' }, [pm.best ? `${nameOf(pm.best.ticker)} leads at ${fmt.spct(pm.best.change, 1)}` : null, pm.worst && pm.worst !== pm.best ? `${nameOf(pm.worst.ticker)} lags at ${fmt.spct(pm.worst.change, 1)}` : null].filter(Boolean).join('. ') + (pm.best ? '.' : ''))),
      btn('Edit holdings', holdingsWin, 'small')));

    // core research cards
    out.push(h('section', null, h('div', { class: 'sec-head' }, h('h2', null, 'Full research'), h('a', { href: '#/coverage' }, 'All coverage')),
      h('div', { class: 'cos' }, CORE.map((t) => coCard(t)))));

    // this week
    const events = [];
    Object.values(state.data.research).forEach((r) => (r.catalysts || []).forEach((c) => events.push(Object.assign({ t: r.ticker }, c))));
    const iso = today.toISOString().slice(0, 10);
    const horizon = new Date(today.getTime() + 21 * 864e5).toISOString().slice(0, 10);
    const soon = events.filter((e) => e.date >= iso && e.date <= horizon).sort((a, b) => a.date.localeCompare(b.date));
    const watch = [];
    CORE.concat(['MU', 'PG']).forEach((t) => { const r = CO.researchOf(t); if (!r) return; r.tripwires.forEach((tw) => { const s = CO.tripStatus(tw); if (s !== 'holding') watch.push({ t, tw, s }); }); });
    out.push(h('section', { class: 'grid g2' },
      h('div', null, h('div', { class: 'sec-head' }, h('h2', null, 'Coming up')),
        soon.length ? h('div', { class: 'card list' }, soon.map((e) => h('button', { type: 'button', class: 'li', onclick: () => go('c/' + e.t) }, dateChip(e.date), h('div', { class: 'li-main' }, h('div', { class: 'li-title' }, e.label.replace(/ \(.*\)/, '')), h('div', { class: 'li-sub' }, nameOf(e.t) + ' · ' + (e.confirmed ? fmt.dayShort(e.date) : 'date not confirmed'))), icon('chev')))) : empty('Nothing scheduled in the next three weeks.')),
      h('div', null, h('div', { class: 'sec-head' }, h('h2', null, 'On watch')),
        watch.length ? h('div', { class: 'card list' }, watch.slice(0, 6).map((x) => h('button', { type: 'button', class: 'li', onclick: () => go(`c/${x.t}/risks`) }, h('span', { class: 'dot ' + CO.statusKind(x.s) }), h('div', { class: 'li-main' }, h('div', { class: 'li-title' }, x.tw.text), h('div', { class: 'li-sub' }, `${nameOf(x.t)} · last ${x.tw.current == null ? 'n/a' : x.tw.current} ${x.tw.unit || ''}`)), pill(x.s, CO.statusKind(x.s))))) : empty('Every tripwire is holding.'))));

    // markets strip
    const mk = (state.quotes && state.quotes.markets) || [];
    if (mk.length) out.push(h('section', null, h('div', { class: 'sec-head' }, h('h2', null, 'Markets'), h('a', { href: '#/markets' }, 'Open markets')),
      h('div', { class: 'mkt-strip' }, mk.slice(0, 6).map((m) => h('div', { class: 'mkt' }, h('div', { class: 'mkt-l' }, m.label), h('div', { class: 'mkt-v' }, m.symbol === '^TNX' ? m.price.toFixed(2) + '%' : m.price.toLocaleString('en-US', { maximumFractionDigits: 2 })), chg(m.pct != null ? m.pct / 100 : null))))));

    // headlines
    const news = (state.news || []).slice(0, 5);
    out.push(h('section', null, h('div', { class: 'sec-head' }, h('h2', null, 'Headlines')),
      news.length ? h('div', { class: 'card list' }, news.map((n) => {
        const u = safeUrl(n.url);
        return h(u ? 'a' : 'div', { class: 'li', href: u, target: u ? '_blank' : null, rel: 'noopener' }, h('div', { class: 'li-main' }, h('div', { class: 'li-title' }, n.title), h('div', { class: 'li-sub' }, [(n.tickers || []).join(', '), n.source, n.t ? fmt.ago(n.t * 1000) : null].filter(Boolean).join(' · '))), icon('ext'));
      })) : empty(state.news ? 'No headlines published yet.' : 'Loading headlines…')));

    // rest of coverage
    out.push(h('section', null, h('div', { class: 'sec-head' }, h('h2', null, 'Rest of coverage'), h('span', { class: 'small muted' }, 'Tap a name for its page')),
      h('div', { class: 'mini-tiles' }, state.data.universe.filter((u) => !CORE.includes(u.ticker)).map((u) => {
        const p = priceOf(u.ticker);
        return h('button', { type: 'button', class: 'mini', onclick: () => go('c/' + u.ticker) }, h('b', null, u.ticker), h('span', { class: 'muted' }, u.name), p ? chg(p.pct) : h('span', { class: 'muted' }, '–'));
      }))));
    return out;
  }
  const dateChip = (d) => { const x = new Date(d + 'T00:00:00Z'); return h('div', { class: 'date-chip' }, h('b', null, String(x.getUTCDate())), h('small', null, x.toLocaleDateString('en-GB', { month: 'short', timeZone: 'UTC' }))); };
  const sparkCache = {};
  function coCard(t) {
    const p = priceOf(t), ev = CO.evalFor(t, true), rv = CO.review(t);
    if (!sparkCache[t]) { sparkCache[t] = 'loading'; D.get('history', t).then((r) => { sparkCache[t] = r.data ? CO.sliceBars(r.data.bars, '3M').map((b) => b[4]) : []; render(); }); }
    const sp = Array.isArray(sparkCache[t]) ? sparkCache[t] : [];
    const r3 = sp.length > 1 ? sp[sp.length - 1] / sp[0] - 1 : null;
    const r = CO.researchOf(t);
    const next = r && (r.catalysts || []).filter((c) => c.date >= new Date().toISOString().slice(0, 10)).sort((a, b) => a.date.localeCompare(b.date))[0];
    return h('a', { class: 'card co-card tile', href: '#/c/' + t, style: { textDecoration: 'none' } },
      h('div', { class: 'co-id' }, h('span', { class: 'co-name' }, nameOf(t)), h('span', { class: 'co-tk' }, t)),
      h('div', { class: 'co-px' }, h('b', null, p ? fmt.px(p.price) : '–'), p ? chg(p.pct) : null),
      spark(sp, { cls: r3 == null ? '' : r3 >= 0 ? 'up' : 'down' }),
      rv ? h('p', { class: 'co-line' }, rv.title || rv.headline) : null,
      h('div', { class: 'tile-foot' }, (() => { const c = CO.callOf(t, false); return c ? pill(`${c.rating} · ${fmt.px(c.pt)}`, CO.ratingKind(c.rating)) : null; })(), next ? pill('Results ' + fmt.dayShort(next.date), 'info') : null, r3 != null ? h('span', null, '3M ' + fmt.spct(r3, 1)) : null));
  }

  /* ---------- coverage ---------- */
  function coverage() {
    const listBox = h('div');
    const draw = () => {
      const q = state.covQ.trim().toLowerCase();
      const groups = [['core', 'Full research'], ['lighter', 'Lighter research'], ['basic', 'Basic view']];
      listBox.replaceChildren(...groups.map(([tier, label]) => {
        const rows = state.data.universe.filter((u) => u.tier === tier && (!q || u.ticker.toLowerCase().includes(q) || u.name.toLowerCase().includes(q) || (u.sector || '').toLowerCase().includes(q)));
        if (!rows.length) return null;
        return h('section', null, h('div', { class: 'sec-head' }, h('h2', null, label), h('span', { class: 'small muted' }, rows.length + ' names')),
          h('div', { class: 'card list' }, rows.map((u) => {
            const p = priceOf(u.ticker), cl = CO.callOf(u.ticker, false);
            return h('button', { type: 'button', class: 'li', onclick: () => go('c/' + u.ticker) },
              h('span', { class: 'tickers', style: { width: '52px' } }, u.ticker),
              h('div', { class: 'li-main' }, h('div', { class: 'li-title' }, u.name), h('div', { class: 'li-sub' }, u.sector)),
              cl ? pill(cl.rating, CO.ratingKind(cl.rating)) : (state.deepen.includes(u.ticker) ? pill('Deepen requested', 'info') : null),
              h('div', { class: 'li-end' }, h('div', { style: { color: 'var(--ink)' } }, p ? fmt.px(p.price) : '–'), p ? chg(p.pct) : null), icon('chev'));
          })));
      }).filter(Boolean));
      if (!listBox.children.length) listBox.append(empty('No names match.'));
    };
    const search = h('input', { type: 'search', placeholder: 'Search name, ticker or sector', 'aria-label': 'Search coverage', style: { width: '100%', maxWidth: '360px' } });
    search.value = state.covQ;
    search.addEventListener('input', () => { state.covQ = search.value; draw(); });
    draw();
    return [h('section', { class: 'hero' }, h('div', null, eyebrow('15 names, one per sector or more'), h('h1', { style: { marginTop: '8px' } }, 'Coverage')), search), listBox];
  }

  /* ---------- markets ---------- */
  const TV = 'https://s3.tradingview.com/external-embedding/';
  const EXCH = { MSFT: 'NASDAQ', GOOGL: 'NASDAQ', COST: 'NASDAQ', AMZN: 'NASDAQ', LIN: 'NASDAQ', MU: 'NASDAQ' };
  const tvSym = (t) => `${EXCH[t] || 'NYSE'}:${t}`;
  function tvWidget(name, config, height) {
    const box = h('div', { class: 'tradingview-widget-container tv-box', style: { height: height + 'px' } }, h('div', { class: 'tradingview-widget-container__widget', style: { height: '100%' } }));
    const s = document.createElement('script');
    s.async = true; s.src = `${TV}embed-widget-${name}.js`;
    s.text = JSON.stringify(Object.assign({ colorTheme: isDark() ? 'dark' : 'light', isTransparent: true, locale: 'en' }, config));
    requestAnimationFrame(() => box.append(s));
    return box;
  }
  function openTv(t) {
    win.open({ title: nameOf(t) + ' · live chart', eyebrow: 'TradingView', wide: true, build: () => stackOf(() => h('div', null,
      tvWidget('advanced-chart', { symbol: tvSym(t), interval: 'D', timezone: 'America/New_York', theme: isDark() ? 'dark' : 'light', style: '1', withdateranges: true, hide_side_toolbar: true, allow_symbol_change: true, autosize: true, studies: ['STD;SMA'] }, 480),
      tvWidget('technical-analysis', { symbol: tvSym(t), interval: '1D', width: '100%', height: 380, showIntervalTabs: true }, 400),
      note('TradingView’s free widgets, delayed up to 15 minutes for most US exchanges.'))) });
  }
  function markets() {
    const mk = (state.quotes && state.quotes.markets) || [];
    const out = [h('section', { class: 'hero' }, h('div', null, eyebrow('Indices, rates and the covered names'), h('h1', { style: { marginTop: '8px' } }, 'Markets')))];
    if (mk.length) out.push(h('section', null, h('div', { class: 'mkt-strip' }, mk.map((m) => h('div', { class: 'mkt' }, h('div', { class: 'mkt-l' }, m.label), h('div', { class: 'mkt-v' }, m.symbol === '^TNX' ? m.price.toFixed(2) + '%' : m.price.toLocaleString('en-US', { maximumFractionDigits: 2 })), chg(m.pct != null ? m.pct / 100 : null))))));
    out.push(h('section', null, h('div', { class: 'sec-head' }, h('h2', null, 'Covered names'), h('span', { class: 'small muted' }, 'Tap for the live chart')),
      h('div', { class: 'mini-tiles' }, state.data.universe.map((u) => { const p = priceOf(u.ticker); return h('button', { type: 'button', class: 'mini', onclick: () => openTv(u.ticker) }, h('b', null, u.ticker), h('span', { style: { color: 'var(--ink)' } }, p ? fmt.px(p.price) : '–'), p ? chg(p.pct) : null); }))));
    out.push(h('section', null, h('div', { class: 'sec-head' }, h('h2', null, 'S&P 500 today')),
      tvWidget('stock-heatmap', { dataSource: 'SPX500', grouping: 'sector', blockSize: 'market_cap_basic', blockColor: 'change', hasTopBar: false, isDataSetEnabled: false, isZoomEnabled: true, hasSymbolTooltip: true, width: '100%', height: 460 }, 470),
      note('Block size is market value, colour is today’s move. TradingView widget, delayed.')));
    return out;
  }

  /* ---------- your view ---------- */
  function yourView() {
    const prof = E.profile(state.disputes, state.data.research);
    const out = [h('section', { class: 'hero' }, h('div', null, eyebrow('Kept on this device'), h('h1', { style: { marginTop: '8px' } }, 'Your view')),
      h('div', { class: 'row-actions' }, btn('Export backup', exportBackup, 'small'), btn('Restore', restoreWin, 'small ghost')))];
    out.push(h('section', { class: 'grid g2' },
      h('div', { class: 'card pad block' }, eyebrow('Your philosophy so far'),
        prof.n ? [h('p', { class: 'read' }, `Across ${prof.n} dispute${prof.n === 1 ? '' : 's'} you lean ${prof.bias}.`), h('div', { class: 'list' }, prof.lines.map((l) => h('div', { class: 'li', style: { padding: '8px 0' } }, h('span', { class: 'dot' }), h('div', { class: 'li-main small' }, l))))] : h('p', { class: 'muted' }, 'No disputes yet. Open a company, then Scenarios, and dispute an assumption.')),
      weightsCard()));
    const allNotes = CHAT.notesAll();
    out.push(h('section', null, h('div', { class: 'sec-head' }, h('h2', null, 'Your research notes'), h('button', { type: 'button', class: 'linkish', onclick: () => CHAT.open(null, { view: true }) }, 'Add a view')),
      Object.keys(allNotes).length ? h('div', { class: 'card list' }, Object.entries(allNotes).flatMap(([t, ns]) => ns.map((n) => h('div', { class: 'li' }, h('span', { class: 'tickers', style: { width: '44px' } }, t), h('div', { class: 'li-main' }, h('div', { class: 'li-title', style: { fontWeight: 400 } }, n.text), h('div', { class: 'li-sub' }, new Date(n.at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }))), h('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Delete note', onclick: () => CHAT.delNote(t, n.id) }, icon('close')))))) : empty('No notes yet. Use Ask or add your view on any page.')));
    out.push(h('section', null, h('div', { class: 'sec-head' }, h('h2', null, 'Your disputes')),
      state.disputes.length ? h('div', { class: 'card list' }, state.disputes.map((d) => h('button', { type: 'button', class: 'li', onclick: () => go(`c/${d.ticker}/thesis`) },
        h('span', { class: 'tickers', style: { width: '44px' } }, d.ticker), h('div', { class: 'li-main' }, h('div', { class: 'li-title' }, E.DRIVER_META[d.driver].label), h('div', { class: 'li-sub' }, `Engine ${d.from}, yours ${d.to}${d.note ? '. ' + d.note : ''}`)), icon('chev')))) : empty('None yet.')));
    out.push(h('section', { class: 'grid g2' },
      h('div', { class: 'card pad block' }, eyebrow('Names to deepen'), state.deepen.length ? h('div', { class: 'chips' }, state.deepen.map((t) => pill(nameOf(t), 'info'))) : h('p', { class: 'muted' }, 'None requested.')),
      h('div', { class: 'card pad block' }, eyebrow('Live baseline'),
        h('p', { class: 'small' }, 'When a company files a 10-Q or 10-K, the backend rebuilds its starting EPS, revenue and share count, then refreshes segments and peers. Your disputes stay.'),
        h('div', { class: 'row-actions' }, btn(state.demoFiling ? 'Clear demo filing' : 'Replay a filing (demo)', () => {
          const lv = state.data.live; lv.filings = lv.filings || {};
          if (state.demoFiling) { delete lv.filings.LIN; state.demoFiling = false; toast('Demo cleared.'); }
          else { lv.filings.LIN = { form: '10-Q', period: '2026-09-30', label: 'Q3 2026 (DEMO)', filed: '2026-10-29', accession: 'demo-fixture', eps: 18.2, revenue: 37.4, shares: 0.462 }; state.demoFiling = true; toast('Replayed an illustrative Linde filing.'); }
          render();
        }, 'small')), note('The replay is an illustrative fixture, not a real filing.'))));
    return out;
  }
  function weightsCard() {
    const t0 = state.tilt || { growth: 50, risk: 50 };
    const wg = h('input', { type: 'range', min: '10', max: '90', step: '5', 'aria-label': 'Weight on growth' }), wr = h('input', { type: 'range', min: '10', max: '90', step: '5', 'aria-label': 'Weight on downside' });
    wg.value = t0.growth; wr.value = t0.risk;
    const lab = h('p', { class: 'note' });
    const upd = () => { lab.textContent = `Growth ${wg.value} · downside ${wr.value}. At 50 and 50 the engine’s own odds apply.`; };
    wg.addEventListener('input', upd); wr.addEventListener('input', upd); upd();
    return h('div', { class: 'card pad block' }, eyebrow('Scenario weights'), h('label', { class: 'fld' }, 'Weight on the upside case', wg), h('label', { class: 'fld' }, 'Weight on the downside case', wr), lab,
      h('div', { class: 'row-actions' }, btn('Save', () => { state.tilt = { growth: +wg.value, risk: +wr.value }; save(); toast('Weights saved.'); render(); }, 'primary small'), btn('Reset', () => { state.tilt = null; save(); render(); }, 'ghost small')));
  }

  /* ---------- holdings, backup, help, feedback ---------- */
  const stackOf = (fn) => { const n = fn(); n.classList.add('stack'); return n; };
  function holdingsWin() {
    win.open({ title: 'Holdings', sub: 'In dollars. Your daily move is weighted by them. Kept on this device.', build: () => stackOf(() => {
      const hs = L.cleanHoldings(state.holdings).sort((a, b) => b.weight - a.weight);
      const setAmt = (t, v) => { state.holdings = state.holdings.map((y) => (y.ticker === t ? { ticker: y.ticker, weight: v } : y)); store.set('holdings_usd', true); save(); render(); };
      const rows = hs.map((x) => {
        const inp = h('input', { type: 'text', inputmode: 'numeric', class: 'amt', 'aria-label': 'Dollars in ' + x.ticker });
        inp.value = usd(x.weight);
        inp.addEventListener('change', () => { const w = Number(inp.value.replace(/[^0-9.]/g, '')); if (!isFinite(w) || w < 0) { inp.value = usd(x.weight); return; } setAmt(x.ticker, w); inp.value = usd(w); tot.textContent = usd(bookUsd()); });
        return h('div', { class: 'li' }, h('span', { class: 'tickers', style: { width: '52px' } }, x.ticker), h('div', { class: 'li-main' }, nameOf(x.ticker)), inp, h('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Remove ' + x.ticker, onclick: () => { state.holdings = state.holdings.filter((y) => y.ticker !== x.ticker); save(); win.refresh(); render(); } }, icon('close')));
      });
      const held = new Set(hs.map((x) => x.ticker));
      const sel = h('select', { 'aria-label': 'Add a stock' }, h('option', { value: '' }, 'Add a stock'), state.data.universe.filter((u) => !held.has(u.ticker)).map((u) => h('option', { value: u.ticker }, `${u.ticker} · ${u.name}`)));
      sel.addEventListener('change', () => { if (!sel.value) return; state.holdings = state.holdings.concat([{ ticker: sel.value, weight: 10000 }]); store.set('holdings_usd', true); save(); win.refresh(); render(); });
      const tot = h('b', null, usd(bookUsd()));
      return h('div', null, h('div', { class: 'row-actions', style: { justifyContent: 'space-between' } }, h('span', { class: 'muted' }, 'Total ', tot), btn('Start over', () => { win.close(); OB.book(); }, 'small ghost')),
        h('div', { class: 'card list' }, rows.length ? rows : h('div', { class: 'li' }, 'No holdings.')), sel);
    }) });
  }
  async function exportBackup() {
    const text = JSON.stringify({ version: 2, exported_at: new Date().toISOString(), holdings: state.holdings, feedback: state.feedback, disputes: state.disputes, tilt: state.tilt, deepen: state.deepen, peers: Object.fromEntries(CORE.map((t) => [t, store.get('peers:' + t, null)])) }, null, 2);
    try {
      const a = h('a', { href: URL.createObjectURL(new Blob([text], { type: 'application/json' })), download: 'portfolio-monitor-backup.json' });
      document.body.append(a); a.click(); a.remove(); toast('Backup saved to downloads.');
    } catch (e) { toast('Could not export.'); }
  }
  function restoreWin() {
    win.open({ title: 'Restore from backup', build: () => stackOf(() => {
      const ta = h('textarea', { placeholder: 'Paste the backup text', 'aria-label': 'Backup text', style: { minHeight: '180px' } });
      return h('div', null, ta, h('div', { class: 'row-actions' }, btn('Restore', () => {
        const res = L.parseBackup(ta.value, state.data.universe.map((u) => u.ticker));
        if (!res.ok) { toast(res.error); return; }
        state.holdings = res.holdings; state.feedback = Object.assign({}, state.feedback, res.feedback);
        if (res.disputes) { state.disputes = res.disputes; state.tilt = res.tilt || null; state.deepen = res.deepen || []; }
        try { const raw = JSON.parse(ta.value); if (raw.peers) Object.entries(raw.peers).forEach(([t, v]) => { if (v) store.set('peers:' + t, v); }); } catch (e) { /* peers are optional */ }
        save(); win.close(); render(); toast('Restored.');
      }, 'primary')));
    }) });
  }
  function helpWin() {
    win.open({ title: 'How this works', build: () => stackOf(() => h('div', null,
      h('p', { class: 'read' }, 'A research tool, not advice. It explains each business before it values it, then lets you argue with the numbers.'),
      ...[['Read top to bottom', 'Each company page follows an analyst’s order: how it makes money, the moat, financials, balance sheet, management, valuation, scenarios, risks. Tap any tile to open it.'],
        ['Where the numbers come from', 'Statements and segments come straight from SEC filings and refresh when a 10-Q or 10-K lands. Peers, consensus and prices come from Yahoo Finance daily. Written analysis is dated and refreshed after each earnings print.'],
        ['Dispute anything', 'In Scenarios, every assumption has a Dispute button. The engine argues back, shows what your number does to the return, and remembers your view on this device.'],
        ['Peers are yours to set', 'In Valuation, switch peers on and off. The median and the premium update instantly.'],
        ['Install it', 'On iPhone: Share, then Add to Home Screen. On Android: menu, then Install app.']].map(([t, d]) => disclose(t, d)),
      note('Your holdings, disputes and peer choices stay in this browser. Export a backup from Your view.'))) });
  }
  function sendFeedback() {
    const text = L.feedbackToText(state.feedback, { app: CFG.appName });
    if (CFG.feedbackEmail) { location.href = `mailto:${CFG.feedbackEmail}?subject=${encodeURIComponent((CFG.appName || 'Moat Monitor') + ' feedback')}&body=${encodeURIComponent(text.slice(0, 1800))}`; return; }
    (navigator.clipboard ? navigator.clipboard.writeText(text) : Promise.reject()).then(() => toast('Feedback copied. Paste it into a message.'), () => toast('Could not copy.'));
  }
  function requestDeepen(t) {
    if (!state.deepen.includes(t)) state.deepen.push(t);
    save();
    if (CFG.feedbackEmail) location.href = `mailto:${CFG.feedbackEmail}?subject=${encodeURIComponent('Deepen ' + t)}&body=${encodeURIComponent('Please add full research for ' + nameOf(t) + ' (' + t + ').')}`;
    toast('Requested. It shows on Your view.');
    render();
  }

  /* ---------- render ---------- */
  let shellBuilt = false;
  function render(keepScroll) {
    const r = route();
    const app = $('#app');
    if (!state.data) {
      app.replaceChildren(h('div', { class: 'page' }, state.error ? [h('h1', null, 'Could not load'), h('p', { class: 'muted' }, state.error), btn('Try again', () => init(), 'primary')] : h('p', { class: 'muted' }, 'Loading…')));
      return;
    }
    const y = window.scrollY;
    let content;
    if (r.page === 'company' && state.uniMap[r.t]) content = CO.page(r.t, r.mode);
    else if (r.page === 'company') content = [h('h1', null, 'Not covered'), h('p', { class: 'muted' }, r.t + ' is not in the coverage list.')];
    else if (r.page === 'coverage') content = coverage();
    else if (r.page === 'markets') content = markets();
    else if (r.page === 'view') content = yourView();
    else if (r.page === 'book') content = book();
    else content = home();
    document.title = (r.page === 'company' ? nameOf(r.t) + ' · ' : '') + (CFG.appName || 'Moat Monitor');
    app.replaceChildren(h('div', { class: 'shell' }, sidebar(r),
      h('div', { class: 'main' }, topbar(r), h('main', { class: 'page', id: 'view', tabindex: '-1' }, content),
        h('footer', { class: 'foot' }, 'Research and monitoring tool, not investment advice. Prices delayed. Filings from SEC EDGAR; market data from Yahoo Finance.'))),
      tabbar(r), r.mode === 'report' ? null : CHAT.fab(r.page === 'company' && state.uniMap[r.t] ? r.t : null));
    if (keepScroll !== false && shellBuilt) window.scrollTo(0, y);
    if (r.page === 'book' && store.get('tour_home', false) && !store.get('tour_book', false) && !document.querySelector('.tour, .ob')) setTimeout(() => { if (route().page === 'book' && !document.querySelector('.tour')) OB.tour('book'); }, 600);
    shellBuilt = true;
  }

  const CO = window.makeCompany({
    state, go, nameOf, safeUrl, save, openTv, requestDeepen,
    render: () => render(),
    viewPrompt: (t) => CHAT.viewPrompt(t),
    currentTicker: () => { const r = route(); return r.page === 'company' ? r.t : null; },
    setMode: (t, m) => go(m === 'report' ? `c/${t}/report` : `c/${t}`),
    report: (t) => REPORT.build(t),
    openedWin: (t, id) => { pushedWin++; history.pushState(null, '', `#/c/${t}/${id}`); },
    closedWin: (t) => { const r = route(); if (r.page === 'company' && r.win) { if (pushedWin > 0) { pushedWin--; history.back(); } else history.replaceState(null, '', '#/c/' + t); } }
  });

  const REPORT = window.makeReport(CO, { state, nameOf, notesOf: (t) => CHAT.notesOf(t) });
  const OB = window.makeOnboard({ state, nameOf, go, render: () => render() });
  const CHAT = window.makeChat({ state, nameOf, CO, go, save, render: () => render(), onQuota: (q) => { llmQ = q; paintUsage(); } });

  async function init() {
    if (!store.user()) { gate(); return; }
    lastRoute = route();
    render();
    await loadData();
    render();
    if (state.data && OB.maybeStart()) return subscribe();
    const r = route();
    if (r.page === 'company' && r.win && state.data) CO.openWin(r.t, r.win, { fromRoute: true });
    if (state.data && r.page === 'company' && CORE.includes(r.t) && r.mode === 'quick' && !r.win && !store.get('tour_company', false) && store.get('tour_home', false)) setTimeout(() => OB.tour('company'), 800);
    subscribe();
  }
  let quotaTimer = null;
  function subscribe() {
    if (!quotaTimer) { CHAT.refreshQuota(); quotaTimer = setInterval(() => { if (document.visibilityState === 'visible') CHAT.refreshQuota(); }, 60000); }
    D.subscribe(state.data ? state.data.universe.map((u) => u.ticker) : CORE, () => { if (!win.depth() && !document.querySelector('.ob, .tour') && !document.querySelector('input:focus, select:focus, textarea:focus')) render(); });
  }
  if ('serviceWorker' in navigator && location.protocol !== 'file:') window.addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(() => {}));
  init();
  window.__monitor = { state, CO, render, go, OB };
})();
