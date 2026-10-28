/* onboard.js: first run for each person on a device. Welcome, what is covered, pick a book in dollars, then a short
   guided tour with a spotlight. Nothing here changes research content; it only explains it and sets holdings. */
(function () {
  'use strict';
  const { h, fmt, btn, icon, store } = window.UI;

  window.makeOnboard = function (kit) {
    const { state, nameOf, go } = kit;
    const L = window.Lib;
    const STARTER_TOTAL = 100000;
    const starter = () => L.cleanHoldings(L.DEFAULT_HOLDINGS).map((x) => ({ ticker: x.ticker, weight: Math.round((x.weight / 100) * STARTER_TOTAL) }));
    const usd = (v) => '$' + Math.round(v).toLocaleString('en-US');
    const first = () => String(store.user() || '').trim().split(' ')[0];

    const TIERS = [
      { tier: 'core', label: 'Full research', depth: 3, gets: 'Rating, 12-month target, estimates vs consensus, peers, risks and a 5-page report.' },
      { tier: 'lighter', label: 'Lighter research', depth: 2, gets: 'Rating, target, scenarios, moat and tripwires. No written review yet.' },
      { tier: 'basic', label: 'The basics', depth: 1, gets: 'Price, statements, valuation against its own history, and news.' }
    ];
    const depthBar = (n) => h('span', { class: 'ob-depth', 'aria-label': `Depth ${n} of 3` }, [1, 2, 3].map((i) => h('i', { class: i <= n ? 'on' : '' })));
    const tierRows = (t) => state.data.universe.filter((u) => u.tier === t);

    /* ---------- full-screen steps ---------- */
    function frame(step, of, ...kids) {
      return h('div', { class: 'ob', role: 'dialog', 'aria-modal': 'true' },
        h('div', { class: 'ob-card' },
          h('div', { class: 'ob-top' }, UI.logo('ob-mark'), h('span', { class: 'ob-steps', 'aria-label': `Step ${step} of ${of}` }, Array.from({ length: of }, (_, i) => h('i', { class: i < step ? 'on' : '' })))),
          ...kids));
    }
    function mount(node) {
      document.querySelectorAll('.ob').forEach((n) => n.remove());
      document.body.append(node);
      document.body.classList.add('ob-open');
      const f = node.querySelector('input, button.primary');
      if (f) setTimeout(() => f.focus(), 60);
    }
    function unmount() { document.querySelectorAll('.ob').forEach((n) => n.remove()); document.body.classList.remove('ob-open'); }

    function welcome(done) {
      const view = frame(1, 2,
        h('h1', { class: 'ob-h' }, `Hey ${first()}.`),
        h('p', { class: 'ob-lead' }, 'Welcome to Moat Monitor, your AI-native equity research tool.'),
        h('div', { class: 'ob-eyebrow' }, `What is covered today · ${state.data.universe.length} stocks`),
        h('div', { class: 'ob-tiers' }, TIERS.map((x) => {
          const rows = tierRows(x.tier);
          return h('div', { class: 'ob-tier' },
            h('div', { class: 'ob-tier-h' }, depthBar(x.depth), h('b', null, x.label), h('span', { class: 'ob-n' }, String(rows.length))),
            h('div', { class: 'ob-names' }, rows.map((u) => u.name).join(' · ')),
            h('div', { class: 'ob-gets' }, x.gets));
        })),
        h('p', { class: 'ob-foot' }, 'More names move up a tier as research is added.'),
        h('div', { class: 'ob-actions' }, btn(['Pick my book', icon('chev')], () => book(done), 'primary')));
      mount(view);
    }

    function book(done) {
      const legacy = !store.get('holdings_usd', false);
      const cur = {};
      L.cleanHoldings(state.holdings).forEach((x) => { cur[x.ticker] = legacy ? Math.round(x.weight * 1000) : x.weight; });
      const amounts = store.get('onboarded', false) ? cur : {};
      const total = h('b', null, usd(0));
      const count = h('span', null, '');
      const go2 = btn(['Start with these', icon('chev')], () => finish(Object.entries(amounts).filter(([, v]) => v > 0).map(([ticker, weight]) => ({ ticker, weight }))), 'primary');
      const upd = () => {
        const xs = Object.values(amounts).filter((v) => v > 0);
        total.textContent = usd(xs.reduce((a, b) => a + b, 0));
        count.textContent = xs.length ? ` across ${xs.length} stock${xs.length === 1 ? '' : 's'}` : '';
        go2.disabled = !xs.length;
      };
      const row = (u) => {
        const inp = h('input', { type: 'text', inputmode: 'numeric', class: 'ob-amt', placeholder: '$0', 'aria-label': 'Dollars in ' + u.name });
        if (amounts[u.ticker]) inp.value = usd(amounts[u.ticker]);
        inp.addEventListener('input', () => {
          const v = Number(inp.value.replace(/[^0-9.]/g, ''));
          amounts[u.ticker] = isFinite(v) ? v : 0;
          upd();
        });
        inp.addEventListener('blur', () => { inp.value = amounts[u.ticker] > 0 ? usd(amounts[u.ticker]) : ''; });
        return h('label', { class: 'ob-row' }, h('span', { class: 'ob-tk' }, u.ticker), h('span', { class: 'ob-nm' }, u.name), inp);
      };
      const list = h('div', { class: 'ob-list' }, TIERS.map((x) => [
        h('div', { class: 'ob-group' }, depthBar(x.depth), x.label),
        tierRows(x.tier).map(row)]));
      const preset = starter();
      const view = frame(2, 2,
        h('h1', { class: 'ob-h sm' }, 'Pick your book'),
        h('p', { class: 'ob-lead' }, 'Enter what you hold in dollars. Leave the rest blank. You can change it any time.'),
        h('button', { type: 'button', class: 'ob-preset', onclick: () => finish(preset) },
          h('span', { class: 'ob-preset-t' }, h('b', null, 'Not sure yet? Use the starter book'),
            h('span', null, `${usd(STARTER_TOTAL)} across ${preset.length} names: ${preset.slice(0, 4).map((x) => x.ticker).join(', ')} and ${preset.length - 4} more.`)),
          icon('chev')),
        list,
        h('div', { class: 'ob-sum' }, h('span', null, 'Your book ', total, count), go2));
      mount(view);
      upd();
    }

    function finish(holdings) {
      state.holdings = L.cleanHoldings(holdings);
      store.set('holdings', state.holdings);
      store.set('holdings_usd', true);
      store.set('entries', {});
      store.set('onboarded', true);
      unmount();
      go('');
      kit.render();
      setTimeout(() => tour('home'), 350);
    }

    /* ---------- guided tour: dim the page, light one element, explain it ---------- */
    const phone = () => matchMedia('(max-width: 760px)').matches;
    const TOURS = {
      home: [
        { sel: '.home-search', title: 'Find any stock', text: 'Type a name or ticker. The bars show how deep the research goes: three for full research, one for the basics.' },
        { sel: '.fab', title: 'Your research counts', text: 'On every page. Ask the analyst anything, or tell it what you know. It tests your view against the research, saves it to your notes, and if you give a number, shows what it does to the target.' },
        { sel: '.qa-grid', title: 'Start here', text: 'Shortcuts to what you came for: the research, a full report, challenging a thesis, your book, what is coming up and the markets.' },
        { sel: () => (phone() ? '.tabbar' : '.side .nav'), title: 'Getting around', text: 'Coverage lists every stock by depth. Your book tracks what you hold. Your view keeps the assumptions you have challenged.' },
        { sel: () => (phone() ? '.topbar .icon-btn:last-child' : '.side .user'), title: 'Your workspace', text: 'Holdings, dark mode, this tour, and switching user live here.' },
        { sel: '.qa', title: 'Now open a company', text: 'Next, a quick look at a full research page.', next: 'Open Linde', action: () => { go('c/LIN'); setTimeout(() => tour('company'), 700); } }
      ],
      book: [
        { sel: '.hero h1', title: 'Your book', text: 'It counts from the prices when you set it, then day by day, weighted by your dollars. Prices are delayed.' },
        { sel: '.hero .btn', title: 'Change it any time', text: 'Add, remove or resize positions in dollars.' },
        { sel: '.cos', title: 'Full research', text: 'Rating, 12-month target and the call for each fully covered name.' },
        { sel: '.grid.g2', title: 'What is coming, what to watch', text: 'Earnings dates coming up, then the measures that would break a thesis, flagged when they get close.' }
      ],
      company: [
        { sel: '.stance-box', title: 'The call', text: 'Rating and 12-month target, with upside and total return against the cost of equity. Tap it to see how the target is built.' },
        { sel: '.call-text', title: 'The view in one paragraph', text: 'Numbers in the text are filled from live data, so the words never contradict the figures.' },
        { sel: '.yv', title: 'Add your view', text: 'What do you know that we do not? Your notes and disputes on this stock live here, and they show in your report.' },
        { sel: '.scorecard', title: 'Eight tests', text: 'Moat, growth, returns, balance sheet, cash quality, estimates, valuation and momentum. Green, amber or red against fixed thresholds. Each opens its evidence.' },
        { sel: '.args', title: 'Key arguments', text: 'The five points behind the call. Tap one for the detail.' },
        { sel: '.view-toggle', title: 'Quick view or full report', text: 'Switch to the detailed sell-side report: five pages you can save as a PDF.' },
        { sel: '.tiles', title: 'Go deeper', text: 'Each tile opens a window: the business, moat, financials, valuation against peers, the target and the risks. Dispute any assumption and the target moves.' }
      ]
    };
    let active = null;
    function tour(name) {
      if (active) active.end();
      const steps = TOURS[name];
      if (!steps) return;
      let i = 0;
      const spot = h('div', { class: 'tour-spot' });
      const box = h('div', { class: 'tour-box', role: 'dialog', 'aria-live': 'polite' });
      const veil = h('div', { class: 'tour', onclick: (e) => { if (e.target === veil) end(); } }, spot, box);
      document.body.append(veil);
      document.body.classList.add('tour-open');
      const keys = (e) => { if (e.key === 'Escape') end(); else if (e.key === 'ArrowRight') next(); else if (e.key === 'ArrowLeft') back(); };
      document.addEventListener('keydown', keys);
      const target = () => { const s = steps[i].sel; return document.querySelector(typeof s === 'function' ? s() : s); };
      function place() {
        const el = target();
        if (!el) return;
        const r = el.getBoundingClientRect(), pad = 8;
        Object.assign(spot.style, { top: r.top - pad + 'px', left: r.left - pad + 'px', width: r.width + pad * 2 + 'px', height: r.height + pad * 2 + 'px' });
        if (phone()) { box.style.cssText = ''; box.classList.add('sheet'); return; }
        box.classList.remove('sheet');
        const bw = 340, bh = box.offsetHeight, gap = 16;
        let top = r.bottom + gap;
        if (top + bh > innerHeight - 12) top = r.top - bh - gap;
        if (top < 12) top = Math.min(innerHeight - bh - 12, Math.max(12, r.top + 12));
        const left = Math.min(innerWidth - bw - 16, Math.max(16, r.left));
        Object.assign(box.style, { top: top + 'px', left: left + 'px', width: bw + 'px' });
      }
      function show() {
        const st = steps[i], el = target();
        if (!el) { if (i < steps.length - 1) { i++; show(); } else end(); return; }
        const r = el.getBoundingClientRect();
        const room = phone() ? innerHeight * 0.52 : innerHeight;
        if (r.top < 70 || r.bottom > room - 20) window.scrollTo({ top: Math.max(0, window.scrollY + r.top - (phone() ? 80 : innerHeight * 0.22)), behavior: 'auto' });
        const last = i === steps.length - 1;
        box.replaceChildren(
          h('div', { class: 'tour-count' }, `${i + 1} of ${steps.length}`),
          h('h3', null, st.title),
          h('p', null, st.text),
          h('div', { class: 'tour-act' },
            h('button', { type: 'button', class: 'tour-skip', onclick: end }, last && !st.action ? '' : 'Skip tour'),
            h('div', { class: 'grow' }),
            i ? btn('Back', back, 'small') : null,
            btn(st.next || (last ? 'Done' : 'Next'), next, 'small primary')));
        requestAnimationFrame(place);
      }
      function next() { const st = steps[i]; if (st.action) { end(); st.action(); return; } if (i < steps.length - 1) { i++; show(); } else end(); }
      function back() { if (i > 0) { i--; show(); } }
      function end() {
        veil.remove(); document.body.classList.remove('tour-open');
        document.removeEventListener('keydown', keys); removeEventListener('resize', place); removeEventListener('scroll', place, true);
        store.set('tour_' + name, true);
        active = null;
      }
      addEventListener('resize', place); addEventListener('scroll', place, true);
      active = { end };
      show();
    }

    /* First run: welcome and book, then the tour. Returns true if onboarding took over. */
    function maybeStart() {
      if (store.get('onboarded', false)) return false;
      welcome();
      return true;
    }
    return { maybeStart, welcome, book: () => book(), tour };
  };
})();
