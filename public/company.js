/* company.js: the company page. A short hero, then ten tiles in the order an analyst reads a business:
   how it makes money, the moat, financials, balance sheet, management, valuation, scenarios, risks, price, news.
   Each tile shows one number and one line; clicking it opens a window with the detail. */
(function () {
  'use strict';
  const { h, fmt, icon, pill, chg, eyebrow, seg, btn, empty, note, stat, disclose, spark, shareBar, store, toast, win } = window.UI;
  const F = window.Fin, E = window.Engine, D = window.DataApi, C = window.Charts, L = window.Lib;
  const css = (n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
  const num = fmt.num;

  window.makeCompany = function (kit) {
    const { state, go, nameOf } = kit;
    const cache = {};
    const ui = {}; // per ticker view state
    const cs = (t) => (cache[t] = cache[t] || {});
    const us = (t) => (ui[t] = ui[t] || { range: '1Y', sma50: true, sma200: false, stmt: 'income', freq: 'annual', line: null, rfreq: 'annual', basis: 'ntm', period: 'quarterly', axis: null, valTab: null, finTab: 'statements' });
    const dat = (t, k) => (cs(t)[k] && cs(t)[k].data) || null;
    const loaded = (t, k) => cs(t)[k] !== undefined;
    const KINDS = ['fundamentals', 'history', 'mgmt', 'evidence', 'news', 'peers', 'segments', 'intraday'];
    let pending = false;
    const rerender = () => {
      if (pending) return;
      pending = true;
      requestAnimationFrame(() => { pending = false; if (kit.currentTicker() ) kit.render(); if (win.depth()) win.refresh(); });
    };
    function load(t) {
      const c = cs(t);
      if (c._loading) return;
      c._loading = true;
      KINDS.forEach((k) => D.get(k, t).then((r) => { c[k] = r; rerender(); }));
    }

    /* ---------- data helpers ---------- */
    const research = (t) => (state.data.research || {})[t] || null;
    const review = (t) => (research(t) || {}).review || null;
    const tierOf = (t) => (state.uniMap[t] || {}).tier;
    function priceOf(t) {
      const lq = D.live.quotes[t];
      if (lq && lq.price) return { price: lq.price, pct: lq.change_pct != null ? lq.change_pct / 100 : null, asof: lq.time ? lq.time * 1000 : null, src: 'live' };
      const q = state.quotes && state.quotes.quotes && state.quotes.quotes[t];
      if (q && q.price) return { price: q.price, pct: q.pct != null ? q.pct / 100 : null, asof: q.asof ? q.asof * 1000 : null, src: 'pipeline', hi52: q.hi52, lo52: q.lo52, state: q.state };
      const m = state.data.market.stocks[t];
      if (m) return { price: m.price, pct: m.chg != null ? m.chg / 100 : null, asof: Date.parse(state.data.market.as_of), src: 'snapshot' };
      return null;
    }
    const rates = () => state.data.market.rates;
    function mkOf(t) {
      const m = state.data.market.stocks[t];
      if (!m) return null;
      const p = priceOf(t);
      return Object.assign({}, m, p ? { price: p.price } : {});
    }
    function withEvidence(r, t) {
      const ev = dat(t, 'evidence');
      if (!ev || !ev.tripwires || !ev.tripwires.length) return r;
      const by = {};
      ev.tripwires.forEach((x) => { by[x.id] = x; });
      return Object.assign({}, r, { tripwires: r.tripwires.map((tw) => {
        const a = by[tw.id];
        if (!a) return tw;
        const o = Object.assign({}, tw, { auto: a });
        if (a.comparable && a.status) o.status = a.status === 'ok' ? 'holding' : a.status;
        return o;
      }) });
    }
    function researchOf(t) {
      const r0 = research(t);
      if (!r0) return null;
      const f = state.data.live && state.data.live.filings && state.data.live.filings[t];
      if (f && (f.period || '') > (r0.base_period_end || r0.as_of || '')) return withEvidence(E.rebaseFromFiling(r0, f), t);
      return withEvidence(r0, t);
    }
    const tilt = () => state.tilt || { growth: 50, risk: 50 };
    const overrides = (t) => E.overridesFrom(state.disputes, t);
    function evalFor(t, mine) {
      const r = researchOf(t), m = mkOf(t);
      if (!r || !m) return null;
      return E.evaluate(r, m, rates(), mine ? { overrides: overrides(t), tilt: tilt() } : {});
    }
    const hasMine = (t) => !!(overrides(t) || state.tilt);
    function tripStatus(tw) {
      if (tw.status) return tw.status;
      if (tw.threshold == null || tw.current == null) return 'watch';
      const d = Math.max(Math.abs(tw.threshold), 1e-9);
      const m = tw.op === '<' ? (tw.current - tw.threshold) / d : (tw.threshold - tw.current) / d;
      return m <= 0 ? 'tripped' : m < 0.15 ? 'watch' : 'holding';
    }
    const statusKind = (s) => (s === 'holding' ? 'ok' : s === 'watch' ? 'warn' : s === 'tripped' ? 'bad' : '');
    const stanceKind = (s) => (s === 'Overweight' || s === 'Lean positive' ? 'ok' : s === 'Neutral' ? '' : 'warn');
    const lastNum = (xs) => { for (let i = (xs || []).length - 1; i >= 0; i--) if (num(xs[i]) !== null) return xs[i]; return null; };

    /* ---------- peer selection (kept on this device) ---------- */
    function peerSet(t, doc) {
      const saved = store.get('peers:' + t, null);
      if (saved) return new Set(saved);
      return new Set((doc && doc.rows ? doc.rows.filter((r) => r.role === 'default').map((r) => r.ticker) : []));
    }
    function togglePeer(t, tk, doc) {
      const s = peerSet(t, doc);
      if (s.has(tk)) s.delete(tk); else s.add(tk);
      store.set('peers:' + t, Array.from(s));
    }
    function median(xs) {
      const a = xs.filter((x) => num(x) !== null && x > 0).sort((p, q) => p - q);
      if (!a.length) return null;
      const n = a.length;
      return n % 2 ? a[(n - 1) / 2] : (a[n / 2 - 1] + a[n / 2]) / 2;
    }
    function peerStats(t) {
      const doc = dat(t, 'peers');
      if (!doc || !doc.rows) return null;
      const inc = peerSet(t, doc);
      const me = doc.rows.find((r) => r.role === 'subject');
      const peers = doc.rows.filter((r) => r.role !== 'subject' && inc.has(r.ticker));
      const med = (blk, k) => median(peers.map((r) => (blk ? r[blk][k] : r[k])));
      return { doc, me, peers, inc, med };
    }

    /* ---------- segment view selection ---------- */
    function mixView(t, period, kind) {
      const seg = dat(t, 'segments');
      if (!seg) return null;
      const views = seg[period] || [];
      return views.find((v) => v.kind === kind) || null;
    }
    function mappedRows(t, view) {
      const rv = review(t);
      if (!view) return [];
      if (!rv || !rv.mix || view.kind !== rv.mix.axis) return view.rows.filter((r) => r.revenue > 0).map((r) => ({ row: r, label: r.name }));
      const by = {};
      view.rows.forEach((r) => { by[r.name] = r; });
      return rv.mix.rows.filter((m) => by[m.match]).map((m) => ({ row: by[m.match], label: m.label, role: m.role, driver: m.driver,
        children: (m.children || []).filter((c) => by[c]).map((c) => ({ row: by[c], label: c.replace('Other Cardiometabolic Health', 'Other cardiometabolic') })) }));
    }
    function periods(t, kind) {
      const out = [];
      [['quarterly', 'Quarter'], ['ytd', 'Year to date'], ['annual', 'Full year']].forEach(([p, label]) => {
        const v = mixView(t, p, kind);
        if (v && mappedRows(t, v).length >= 2) out.push([p, label]);
      });
      return out;
    }
    const periodLabel = (v) => {
      if (!v) return '';
      const e = v.period.end, s = v.period.start;
      const days = (Date.parse(e) - Date.parse(s)) / 864e5;
      const d = new Date(e + 'T00:00:00Z');
      const mon = d.toLocaleDateString('en-GB', { month: 'short', year: 'numeric', timeZone: 'UTC' });
      return days < 100 ? `Quarter to ${mon}` : days < 300 ? `${Math.round(days / 30.4)} months to ${mon}` : `Year to ${mon}`;
    };

    /* ================= the call: target, estimates, framework ================= */
    const SECTOR_BENCH = { Materials: 'XLB', 'Health care': 'XLV', Financials: 'XLF', Technology: 'XLK', 'Consumer staples': 'XLP', 'Consumer discretionary': 'XLY', 'Communication services': 'XLC', Energy: 'XLE', Utilities: 'XLU', 'Real estate': 'XLRE', Industrials: 'XLI' };
    const BENCH_NAME = { SPY: 'S&P 500', XLB: 'S&P 500 Materials', XLV: 'S&P 500 Health Care', XLF: 'S&P 500 Financials', XLK: 'S&P 500 Technology', XLP: 'S&P 500 Staples', XLY: 'S&P 500 Discretionary', XLC: 'S&P 500 Communication', XLE: 'S&P 500 Energy', XLU: 'S&P 500 Utilities', XLRE: 'S&P 500 Real Estate', XLI: 'S&P 500 Industrials' };
    const benchOf = (t) => SECTOR_BENCH[(state.uniMap[t] || {}).sector] || 'SPY';
    function callOf(t, mine) {
      const r = researchOf(t), m = mkOf(t);
      if (!r || !m) return null;
      return E.target(r, m, rates(), mine ? { overrides: overrides(t) } : {});
    }
    const ratingKind = (x) => (x === 'Overweight' ? 'ok' : x === 'Underweight' ? 'bad' : '');
    function consensusOf(t) {
      const d = dat(t, 'peers');
      const me = d && d.rows ? d.rows.find((x) => x.role === 'subject') : null;
      return (me && me.consensus) || null;
    }
    /* Our base-case path beside consensus for the current and next two fiscal years. */
    function estimates(t) {
      const r = researchOf(t), c = consensusOf(t);
      if (!r) return null;
      const p = E.path(r, 'base');
      const fy0 = c && c.fy0_end ? +c.fy0_end.slice(0, 4) : +(r.base_period_end || r.as_of).slice(0, 4);
      const rows = p.slice(0, 3).map((x, i) => {
        const cEps = c ? (i === 0 ? c.eps0 : i === 1 ? c.eps1 : null) : null;
        const cRev = c ? (i === 0 ? c.rev0_m : i === 1 ? c.rev1_m : null) : null;
        return { label: `FY${String(fy0 + i).slice(2)}E`, year: fy0 + i, rev: x.rev * 1000, eps: x.eps, margin: x.margin, dps: x.dps,
          cEps, cRev, gapEps: cEps ? x.eps / cEps - 1 : null, gapRev: cRev ? (x.rev * 1000) / cRev - 1 : null };
      });
      return { rows, fy0, consensus: c };
    }
    function relPerf(t) {
      const a = dat(t, 'history'), bk = benchOf(t);
      const b = dat(bk, 'history');
      if (!loaded(bk, 'history')) { cs(bk).history = { data: null }; D.get('history', bk).then((r) => { cs(bk).history = r; rerender(); }); }
      if (!a || !a.bars) return null;
      const last = a.bars[a.bars.length - 1][0];
      const at = (bars, ts) => { let v = null; for (const x of bars) { if (x[0] <= ts) v = x[4]; else break; } return v; };
      const ret = (bars, days, ytd) => {
        if (!bars || !bars.length) return null;
        const end = at(bars, last);
        const startTs = ytd ? Date.UTC(new Date(last * 1000).getUTCFullYear(), 0, 1) / 1000 - 86400 : last - days * 86400;
        const st = at(bars, startTs);
        return end && st ? end / st - 1 : null;
      };
      const win = [['1M', 31], ['3M', 92], ['12M', 366], ['YTD', 0, true]];
      return { bench: bk, benchName: BENCH_NAME[bk], rows: win.map(([k, d, y]) => { const x = ret(a.bars, d, y), y2 = b && b.bars ? ret(b.bars, d, y) : null; return { k, abs: x, rel: x != null && y2 != null ? (1 + x) / (1 + y2) - 1 : null }; }), benchBars: b && b.bars };
    }
    /* Fill {tokens} in review text with live figures, so prose never contradicts the numbers beside it. */
    function fill(t, text) {
      if (!text) return '';
      const c = callOf(t, false), e = estimates(t), ps = peerStats(t);
      const g = e && e.rows[1] && e.rows[1].gapEps;
      const k = ps && ps.me && ps.me.ntm.ev_ebitda != null ? 'ev_ebitda' : 'pe';
      const mine = ps && ps.me ? ps.me.ntm[k] : null, med = ps ? ps.med('ntm', k) : null;
      const prem = mine && med ? mine / med - 1 : null;
      const map = {
        rating: c ? c.rating : 'not rated', pt: c ? fmt.px(c.pt) : '–', upside: c ? fmt.spct(c.upside, 1) : '–', ret: c ? fmt.spct(c.totalReturn, 1) : '–', hurdle: c ? fmt.pct(c.hurdle) : '–',
        vs_cons: g == null ? 'compared with consensus' : Math.abs(g) < 0.01 ? 'in line with' : `${fmt.pct(Math.abs(g))} ${g < 0 ? 'below' : 'above'}`,
        peer_line: prem == null ? '' : `The shares trade at ${fmt.mult(mine)} next-12-month ${k === 'pe' ? 'P/E' : 'EV/EBITDA'}, a ${fmt.pct(Math.abs(prem), 0)} ${prem >= 0 ? 'premium' : 'discount'} to the peer median of ${fmt.mult(med)}.`
      };
      return text.replace(/\{(\w+)\}/g, (_, k2) => (map[k2] !== undefined ? map[k2] : ''));
    }
    /* The framework: eight tests, each a traffic light with the number behind it. Thresholds are fixed and shown. */
    function framework(t) {
      const out = [], rv = review(t), r = research(t), card = state.data.cards && state.data.cards[t];
      const ps = peerStats(t), s = finSnapshot(t), m = dat(t, 'mgmt'), e = estimates(t), rp = relPerf(t);
      const L = (key, label, light, value, why, win) => out.push({ key, label, light, value, why, win });
      const moat = rv ? rv.moat.rating : r && r.moat ? r.moat.rating : null;
      if (moat != null) L('moat', 'Moat', moat >= 4 ? 'g' : moat === 3 ? 'a' : 'r', `${moat} / 5`, rv ? rv.moat.sources.slice(0, 2).join(', ') : r.moat.summary, 'moat');
      else if (card) L('moat', 'Moat', card.verdict === 'Strong' ? 'g' : card.verdict === 'Weak' ? 'r' : 'a', card.verdict, 'Five-forces score', 'moat');
      if (ps && ps.me && ps.me.ntm.rev_growth != null) {
        const d = ps.me.ntm.rev_growth - ps.med('ntm', 'rev_growth');
        L('growth', 'Growth', d >= 0.02 ? 'g' : d <= -0.02 ? 'r' : 'a', fmt.spct(ps.me.ntm.rev_growth, 1), `Consensus next 12 months vs peers ${fmt.spct(ps.med('ntm', 'rev_growth'), 1)}`, 'business');
      } else if (s && s.growth != null) L('growth', 'Growth', s.growth >= 0.08 ? 'g' : s.growth < 0.03 ? 'r' : 'a', fmt.spct(s.growth, 1), 'Revenue, last 12 months', 'financials');
      const roic = ps && ps.me && ps.me.roic != null ? ps.me.roic : s && s.roic;
      if (roic != null) L('returns', 'Returns', roic >= 0.15 ? 'g' : roic < 0.08 ? 'r' : 'a', fmt.pct(roic), ps && ps.me ? `ROIC vs peer median ${fmt.pct(ps.med(null, 'roic'))}` : 'ROIC on reported capital', 'financials');
      if (s && s.ndE != null) L('balance', 'Balance sheet', s.ndE < 1.5 ? 'g' : s.ndE <= 3 ? 'a' : 'r', s.ndE < 0 ? 'Net cash' : fmt.mult(s.ndE), 'Net debt to EBITDA', 'balance');
      const eq = m && (m.components || []).find((c) => c.key === 'earnings_quality');
      const cc = eq && eq.note ? +((eq.note.match(/([\d.]+)x net income/) || [])[1]) : null;
      if (cc) L('quality', 'Cash quality', cc >= 1 ? 'g' : cc < 0.8 ? 'r' : 'a', cc.toFixed(2) + 'x', `Operating cash flow to net income, 5 years${rv ? '; ' + rv.flags.filter((x) => x.severity === 'watch').length + ' flags to judge' : ''}`, 'management');
      if (e && e.rows[1] && e.rows[1].gapEps != null) { const g = e.rows[1].gapEps; L('estimates', 'Estimates', g >= 0.03 ? 'g' : g <= -0.03 ? 'r' : 'a', fmt.spct(g, 1), `Our ${e.rows[1].label} EPS vs consensus`, 'valuation:estimates'); }
      if (ps && ps.me) {
        const k = ps.me.ntm.ev_ebitda != null ? 'ev_ebitda' : 'pe', mine = ps.me.ntm[k], med = ps.med('ntm', k);
        if (mine && med) { const pr = mine / med - 1; L('valuation', 'Valuation', pr <= 0 ? 'g' : pr > 0.25 ? 'r' : 'a', fmt.spct(pr, 0), `Premium to peers, NTM ${k === 'pe' ? 'P/E' : 'EV/EBITDA'}`, 'valuation:peers'); }
      } else {
        const f = dat(t, 'fundamentals'), pz = priceOf(t), hist = dat(t, 'history');
        if (f && pz && hist) { const v = F.valuation(f, pz.price, f.profile), pc = F.percentile(F.valuationHistory(f, hist.bars), 'pe', v.pe); if (pc) L('valuation', 'Valuation', pc.pct < 0.3 ? 'g' : pc.pct > 0.7 ? 'r' : 'a', `${Math.round(pc.pct * 100)}th pct`, 'P/E against its own history', 'valuation:history'); }
      }
      if (rp && rp.rows[2].rel != null) { const x = rp.rows[2].rel; L('momentum', 'Momentum', x >= 0.05 ? 'g' : x <= -0.05 ? 'r' : 'a', fmt.spct(x, 0), `12 months vs ${rp.benchName}`, 'price'); }
      return out;
    }
    function lights(light) { return h('span', { class: 'tl', 'aria-label': light === 'g' ? 'positive' : light === 'r' ? 'negative' : 'neutral' }, ['r', 'a', 'g'].map((x) => h('i', { class: x === light ? 'on ' + x : '' }))); }
    function scorecard(t) {
      const fw = framework(t);
      if (!fw.length) return null;
      return h('section', { class: 'scorecard', 'aria-label': 'Moat Monitor framework' }, fw.map((x) =>
        h('button', { type: 'button', class: 'sc', onclick: () => { const [w, tab] = x.win.split(':'); if (tab) us(t).valTab = tab; openWin(t, w); }, title: x.why },
          h('div', { class: 'sc-top' }, h('span', { class: 'eyebrow' }, x.label), lights(x.light)), h('div', { class: 'sc-v' }, x.value), h('div', { class: 'sc-w' }, x.why))));
    }

    /* ================= tiles ================= */
    function tile(id, ic, label, body, foot, opts) {
      const locked = opts && opts.locked;
      return h(locked ? 'div' : 'button', { type: locked ? null : 'button', class: 'tile' + (locked ? ' locked' : ''), onclick: locked ? null : () => openWin(kit.currentTicker(), id), 'aria-label': locked ? null : label + ': open' },
        h('div', { class: 'tile-top' }, icon(ic), eyebrow(label), locked ? null : icon('chev', 'tile-go')),
        body, foot ? h('div', { class: 'tile-foot' }, [].concat(foot).filter((x) => x !== '·' && x !== null && x !== undefined && x !== false).map((x, i) => [i ? h('span', { class: 'sep', 'aria-hidden': 'true' }, '·') : null, typeof x === 'string' ? h('span', null, x) : x])) : null);
    }
    const big = (v, small) => h('div', { class: 'tile-big' }, v, small ? h('small', null, small) : null);
    const line = (text) => h('div', { class: 'tile-line' }, text);
    const loadingTile = (t, k) => (loaded(t, k) ? null : line(h('span', { class: 'muted' }, 'Loading…')));

    function tBusiness(t) {
      const rv = review(t), f = dat(t, 'fundamentals');
      const kind = rv && rv.mix ? rv.mix.axis : 'segment';
      const v = mixView(t, 'quarterly', kind) || mixView(t, 'annual', kind);
      const rows = mappedRows(t, v).filter((x) => x.row.revenue > 0);
      if (rv && rows.length) {
        const parts = rows.map((x) => ({ label: x.label, v: x.row.revenue }));
        const tot = parts.reduce((a, p) => a + p.v, 0);
        return tile('business', 'business', 'How it makes money',
          [line(rv.model), shareBar(parts),
            h('div', { class: 'legend' }, parts.slice(0, 3).map((p, i) => h('span', null, h('i', { class: 'sb' + i }), `${p.label} ${Math.round(p.v / tot * 100)}%`)))],
          [`${rows.length} ${kind === 'segment' ? 'segments' : 'revenue lines'}`, '·', periodLabel(v)]);
      }
      const summary = f && f.profile && f.profile.summary;
      return tile('business', 'business', 'How it makes money',
        [line(summary ? summary.split('. ').slice(0, 2).join('. ') + '.' : 'Business description loads with the statements.')],
        [tierOf(t) === 'core' ? 'Segment data loading' : 'Not deepened yet']);
    }

    function tMoat(t) {
      const rv = review(t), r = research(t), card = state.data.cards && state.data.cards[t];
      const rating = rv ? rv.moat.rating : r && r.moat ? r.moat.rating : null;
      if (rating == null && !card) return tile('moat', 'shield', 'Moat', [line('No industry-structure card for this name yet.')], null, { locked: true });
      return tile('moat', 'shield', 'Moat',
        [big(rating != null ? `${rating} / 5` : card.verdict),
          rating != null ? h('div', { class: 'meter' }, [1, 2, 3, 4, 5].map((n) => h('i', { class: n <= rating ? 'on' : '' }))) : null,
          line(rv ? rv.moat.sources.slice(0, 2).join(' · ') : (r && r.moat ? r.moat.summary : card.summary || ''))],
        [card ? `Five forces: ${card.verdict}` : 'Five forces not scored']);
    }

    function finSnapshot(t) {
      const f = dat(t, 'fundamentals');
      if (!f) return null;
      const q = F.derive(f, 'quarterly');
      const rev = f.quarterly && f.quarterly.rows.revenue || [];
      const r4 = F.rolling4(rev);
      const n = r4.length;
      const ttm = r4[n - 1], prior = r4[n - 5];
      return { f, q, ttm, growth: num(ttm) && num(prior) && prior > 0 ? ttm / prior - 1 : null, spark: r4.slice(-12),
        opm: f.ttm && num(f.ttm.op_income) && f.ttm.revenue ? f.ttm.op_income / f.ttm.revenue : lastNum(q.op_margin), fcf: f.ttm && f.ttm.fcf, ndE: lastNum(q.net_debt_ebitda), cover: lastNum(q.interest_cover), debt: lastNum(f.quarterly.rows.total_debt), cash: lastNum(f.quarterly.rows.cash), roic: lastNum(q.roic) };
    }

    function tFinancials(t) {
      const s = finSnapshot(t);
      if (!s) return tile('financials', 'bars', 'Financials', [loadingTile(t, 'fundamentals') || line('Statements not published yet.')]);
      return tile('financials', 'bars', 'Financials',
        [big(fmt.usdM(s.ttm), 'revenue, last 12 months'), h('div', { class: 'row-actions' }, chg(s.growth, 1), h('span', { class: 'small muted' }, 'year on year')),
          spark(s.spark, { cls: s.growth >= 0 ? '' : 'down' })],
        [`Operating margin ${fmt.pct(s.opm)}`, '·', `ROIC ${fmt.pct(s.roic)}`]);
    }

    function tBalance(t) {
      const s = finSnapshot(t), rv = review(t);
      if (!s) return tile('balance', 'scale', 'Balance sheet', [loadingTile(t, 'fundamentals') || line('Statements not published yet.')]);
      const nd = s.ndE;
      const kind = nd == null ? '' : nd < 1.5 ? 'ok' : nd < 3 ? 'warn' : 'bad';
      return tile('balance', 'scale', 'Balance sheet',
        [big(nd == null ? '–' : (nd < 0 ? 'Net cash' : fmt.mult(nd)), nd != null && nd >= 0 ? 'net debt / EBITDA' : null),
          line(rv ? rv.balance.read : `Interest cover ${fmt.mult(s.cover)}.`)],
        [pill(nd == null ? 'n/a' : nd < 1.5 ? 'Low leverage' : nd < 3 ? 'Moderate' : 'High leverage', kind), `Interest cover ${fmt.mult(s.cover, 0)}`]);
    }

    function tManagement(t) {
      const m = dat(t, 'mgmt'), rv = review(t);
      if (!m) return tile('management', 'people', 'Management & governance', [loadingTile(t, 'mgmt') || line('Management record not published yet.')]);
      const sp = m.surprises || {};
      const eq = (m.components || []).find((c) => c.key === 'earnings_quality');
      const cc = eq && eq.note ? (eq.note.match(/([\d.]+)x net income/) || [])[1] : null;
      const flags = rv ? rv.flags.filter((x) => x.severity === 'watch').length : 0;
      return tile('management', 'people', 'Management & governance',
        [big(sp.n ? `${sp.beats} of ${sp.n}` : '–', 'quarters beat consensus'),
          line(cc ? `Operating cash flow ${cc}x net income over five years.` : 'Earnings quality evidence inside.')],
        [flags ? pill(`${flags} to judge`, 'warn') : null, 'Evidence, not a score']);
    }

    function tValuation(t) {
      const ps = peerStats(t);
      if (ps && ps.me) {
        const k = 'ev_ebitda';
        const useEv = ps.me.ntm[k] != null;
        const key = useEv ? k : 'pe';
        const mine = ps.me.ntm[key], med = ps.med('ntm', key);
        const prem = mine && med ? mine / med - 1 : null;
        return tile('valuation', 'tag', 'Valuation vs peers',
          [big(fmt.mult(mine), useEv ? 'NTM EV/EBITDA' : 'NTM P/E'),
            line(`Peer median ${fmt.mult(med)} across ${ps.peers.length} peers.`)],
          [prem != null ? pill((prem >= 0 ? 'Premium ' : 'Discount ') + fmt.pct(Math.abs(prem), 0), prem > 0.15 ? 'warn' : prem < -0.1 ? 'ok' : '') : null,
            `NTM P/E ${fmt.mult(ps.me.ntm.pe)} vs ${fmt.mult(ps.med('ntm', 'pe'))}`]);
      }
      const f = dat(t, 'fundamentals'), p = priceOf(t), hist = dat(t, 'history');
      if (!f || !p) return tile('valuation', 'tag', 'Valuation', [loadingTile(t, 'fundamentals') || line('Needs statements and a price.')]);
      const v = F.valuation(f, p.price, f.profile);
      const vh = hist ? F.valuationHistory(f, hist.bars) : [];
      const pc = F.percentile(vh, 'pe', v.pe);
      return tile('valuation', 'tag', 'Valuation',
        [big(fmt.mult(v.pe), 'P/E, trailing'), line(pc ? `Cheaper than ${Math.round((1 - pc.pct) * 100)}% of its own quarter-ends since ${vh[0].end.slice(0, 4)}.` : `EV/EBITDA ${fmt.mult(v.ev_ebitda)}.`)],
        [`EV/EBITDA ${fmt.mult(v.ev_ebitda)}`, '·', `FCF yield ${fmt.pct(v.fcf_yield)}`]);
    }

    function rangeViz(ev) {
      const sc = ev.scenarios;
      const lo = Math.min(sc.bear.irr, -0.05), hi = Math.max(sc.bull.irr, ev.hurdle + 0.05);
      const X = (x) => ((x - lo) / (hi - lo) * 100).toFixed(1) + '%';
      return h('div', { class: 'range', role: 'img', 'aria-label': `Annual return: downside ${fmt.spct(sc.bear.irr)}, base ${fmt.spct(sc.base.irr)}, upside ${fmt.spct(sc.bull.irr)}; hurdle ${fmt.pct(ev.hurdle)}` },
        h('div', { class: 'track' }),
        h('div', { class: 'seg-r', style: { left: X(sc.bear.irr), width: `calc(${X(sc.bull.irr)} - ${X(sc.bear.irr)})` } }),
        h('div', { class: 'zero', style: { left: X(0) }, title: '0%' }),
        h('div', { class: 'mk base', style: { left: X(sc.base.irr) }, title: 'Base case' }),
        h('div', { class: 'zero', style: { left: X(ev.hurdle), background: 'var(--info)' }, title: 'Hurdle' }));
    }

    function tThesis(t) {
      const c = callOf(t, false), mine = hasMine(t) ? callOf(t, true) : null;
      if (!c) return tile('thesis', 'branch', '12-month target', [line('No research file yet, so no target. The engine states no view rather than guess one.')], [pill('Not deepened', '')], { locked: true });
      const p = priceOf(t), lo = Math.min(c.bear.value, p.price) * 0.97, hi = Math.max(c.bull.value, p.price) * 1.03;
      const X = (v) => ((v - lo) / (hi - lo) * 100).toFixed(1) + '%';
      return tile('thesis', 'branch', '12-month target',
        [h('div', { class: 'row-actions' }, h('div', { class: 'tile-big' }, fmt.px(c.pt)), pill(c.rating, ratingKind(c.rating))),
          line(`${fmt.spct(c.upside, 1)} upside, ${fmt.spct(c.totalReturn, 1)} with dividends, against a ${fmt.pct(c.hurdle)} cost of equity.`),
          h('div', { class: 'range', role: 'img', 'aria-label': `Downside ${fmt.px(c.bear.value)}, target ${fmt.px(c.pt)}, upside ${fmt.px(c.bull.value)}, price ${fmt.px(p.price)}` },
            h('div', { class: 'track' }), h('div', { class: 'seg-r', style: { left: X(c.bear.value), width: `calc(${X(c.bull.value)} - ${X(c.bear.value)})` } }),
            h('div', { class: 'mk base', style: { left: X(c.pt) }, title: 'Target' }), h('div', { class: 'zero', style: { left: X(p.price), background: 'var(--info)', width: '2px' }, title: 'Price' }))],
        [`Downside ${fmt.px(c.bear.value)}`, `Upside ${fmt.px(c.bull.value)}`, mine && mine.rating !== c.rating ? pill('Yours: ' + mine.rating, '') : null]);
    }

    function tRisks(t) {
      const r = researchOf(t), rv = review(t);
      if (!r) return tile('risks', 'alert', 'What could break', [line('Risks are written with the research file.')], null, { locked: true });
      const sts = (r.tripwires || []).map(tripStatus);
      const count = (s) => sts.filter((x) => x === s).length;
      const n = rv ? rv.risks.length : (r.risks || []).length;
      return tile('risks', 'alert', 'What could break',
        [big(String(n), n === 1 ? 'way the thesis fails' : 'ways the thesis fails'), line(rv ? rv.risks[0].cause + '.' : (r.risks || [])[0] || '')],
        [h('span', { class: 'inline-dot' }, h('span', { class: 'dot ok' }), `${count('holding')} holding`), count('watch') ? h('span', { class: 'inline-dot' }, h('span', { class: 'dot warn' }), `${count('watch')} on watch`) : null, count('tripped') ? h('span', { class: 'inline-dot' }, h('span', { class: 'dot bad' }), `${count('tripped')} tripped`) : null]);
    }

    function tPrice(t) {
      const hist = dat(t, 'history');
      const st = hist && hist.stats;
      if (!hist) return tile('price', 'line', 'Price', [loadingTile(t, 'history') || line('Price history not published yet.')]);
      const bars = sliceBars(hist.bars, '1Y');
      const r1 = bars.length > 1 ? bars[bars.length - 1][4] / bars[0][4] - 1 : null;
      return tile('price', 'line', 'Price',
        [big(fmt.spct(r1, 1), 'over one year'), spark(bars.map((b) => b[4]), { cls: r1 >= 0 ? 'up' : 'down' })],
        [st && num(st.pos52) ? `${Math.round(st.pos52 * 100)}% of 52-week range` : null, st && st.technical && st.technical.label ? 'Technicals: ' + st.technical.label.toLowerCase() : null]);
    }

    function tNews(t) {
      const d = dat(t, 'news');
      const items = (d && d.items) || [];
      if (!items.length) return tile('news', 'news', 'News', [loadingTile(t, 'news') || line('No headlines published yet.')], null, { locked: !loaded(t, 'news') || !items.length });
      const el = tile('news', 'news', `News · ${items.length} headlines`, h('div', { class: 'news-strip' }, items.slice(0, 3).map((n) => h('div', null, h('div', { class: 'tile-line', style: { color: 'var(--ink)', fontWeight: 500 } }, n.title), h('div', { class: 'small muted' }, [n.source, n.t ? fmt.ago(n.t * 1000) : null].filter(Boolean).join(' · '))))));
      el.classList.add('wide');
      return el;
    }

    /* ================= page ================= */
    function page(t, mode) {
      load(t);
      const isReport = mode === 'report';
      const u = state.uniMap[t] || {}, p = priceOf(t), r = researchOf(t), rv = review(t);
      const base = r ? evalFor(t, false) : null;
      const depth = r ? (r.depth === 'deep' ? 'Full research' : 'Lighter research') : 'Basic view';
      const next = r && (r.catalysts || []).filter((c) => c.date >= new Date().toISOString().slice(0, 10)).sort((a, b) => a.date.localeCompare(b.date))[0];
      const c = r ? callOf(t, false) : null, cm = r && hasMine(t) ? callOf(t, true) : null;
      const hero = h('section', { class: 'co-hero' },
        h('div', null,
          eyebrow([t, u.sector, depth].filter(Boolean).join(' · ')),
          h('h1', null, nameOf(t)),
          p ? h('div', { class: 'co-quote' }, h('span', { class: 'px' }, fmt.px(p.price)), chg(p.pct),
            h('small', null, p.src === 'live' ? 'Delayed quote · ' + fmt.ago(p.asof) : p.src === 'pipeline' ? 'Last update ' + fmt.ago(p.asof) : 'Snapshot')) : null),
        c ? h('button', { type: 'button', class: 'card stance-box', style: { textAlign: 'left', cursor: 'pointer' }, onclick: () => openWin(t, 'thesis') },
          eyebrow('Moat Monitor call'),
          h('div', { class: 'stance' }, h('b', null, c.rating), pill('Target ' + fmt.px(c.pt), ratingKind(c.rating) || 'info')),
          h('div', { class: 'small muted' }, `${fmt.spct(c.upside, 1)} upside · ${fmt.spct(c.totalReturn, 1)} total return · cost of equity ${fmt.pct(c.hurdle)}`),
          cm ? h('div', { class: 'small' }, h('b', null, 'Your view: '), `${cm.rating}, ${fmt.px(cm.pt)}`) : null,
          h('span', { class: 'btn small', style: { alignSelf: 'flex-start' } }, 'How we get there')) : null,
        rv ? h('div', { class: 'call-text' }, h('h2', { class: 'call-title' }, rv.title), h('p', { class: 'headline' }, fill(t, rv.lead))) : r ? h('p', { class: 'headline' }, r.header.one_liner) : null,
        scorecard(t),
        rv ? h('div', { class: 'args' }, eyebrow('Key arguments'), rv.arguments.map((a) => disclose([h('b', { class: 'arg-l' }, a.label), h('span', { class: 'arg-t' }, fill(t, a.text).split('. ')[0].replace(/\.$/, '') + '.')], fill(t, a.text)))) : null,
        h('div', { class: 'co-meta' },
          next ? pill(`${next.label.replace(/ \(.*\)/, '')} · ${fmt.dayShort(next.date)}${next.confirmed ? '' : ' (unconfirmed)'}`, 'info') : null,
          rv ? pill('Review as of ' + fmt.date(rv.as_of), '') : null,
          rv ? h('span', { class: 'small muted', style: { alignSelf: 'center' } }, rv.basis) : null));
      const toggle = h('div', { class: 'view-toggle' },
        seg([['quick', 'Quick view'], ['report', 'Detailed sell-side analysis']], isReport ? 'report' : 'quick', (m) => kit.setMode(t, m), 'View'),
        isReport ? btn([icon('ext'), 'Download PDF'], () => window.print(), 'primary small') : h('span', { class: 'small muted' }, 'Tap any tile to open it'));
      if (isReport) return [hero, toggle, kit.report(t)];
      const tiles = h('section', { class: 'tiles' },
        tBusiness(t), tMoat(t), tFinancials(t), tBalance(t), tManagement(t), tValuation(t), tThesis(t), tRisks(t), tPrice(t), tNews(t));
      return [hero, toggle, tiles, !r ? deepenCard(t) : null];
    }

    function deepenCard(t) {
      const asked = (state.deepen || []).includes(t);
      return h('section', { class: 'card pad', style: { display: 'flex', gap: '16px', alignItems: 'center', flexWrap: 'wrap' } },
        h('div', { style: { flex: 1, minWidth: '240px' } }, h('h3', null, 'Deepen this name'),
          h('p', { class: 'small muted', style: { marginTop: '4px' } }, 'Adds segments, peers, scenarios and risks built from the latest filings, like Linde, Lilly and Visa.')),
        btn(asked ? 'Requested' : 'Request deep research', () => kit.requestDeepen(t), asked ? '' : 'primary', { disabled: asked }));
    }

    /* ================= windows ================= */
    const WINS = {
      business: { title: 'How it makes money', build: wBusiness, wide: true },
      moat: { title: 'Moat and industry', build: wMoat },
      financials: { title: 'Financials', build: wFinancials, wide: true },
      balance: { title: 'Balance sheet', build: wBalance },
      management: { title: 'Management, governance and earnings quality', build: wManagement, wide: true },
      valuation: { title: 'Valuation', build: wValuation, wide: true },
      thesis: { title: 'Target, scenarios and thesis', build: wThesis, wide: true },
      risks: { title: 'What could break the thesis', build: wRisks },
      price: { title: 'Price', build: wPrice, wide: true },
      news: { title: 'News', build: wNews }
    };
    function openWin(t, id, opts) {
      const w = WINS[id];
      if (!w) return;
      load(t);
      win.open({ title: w.title, eyebrow: nameOf(t), wide: w.wide, build: () => { const n = w.build(t); n.classList && n.classList.add('stack'); return n; }, key: id, onClose: () => kit.closedWin(t) });
      if (!(opts && opts.fromRoute)) kit.openedWin(t, id);
    }

    const block = (title, ...kids) => h('section', { class: 'block' }, title ? h('h3', null, title) : null, ...kids);
    const srcLine = (sources) => (sources && sources.length ? note(['Sources: ', sources.map((s, i) => [i ? '; ' : '', kit.safeUrl(s.url) ? h('a', { href: s.url, target: '_blank', rel: 'noopener' }, s.title) : s.title])]) : null);

    /* ----- business ----- */
    function wBusiness(t) {
      const rv = review(t), S = us(t), f = dat(t, 'fundamentals');
      const seg0 = dat(t, 'segments');
      const out = [];
      if (rv) out.push(h('p', { class: 'read' }, rv.model));
      if (rv && rv.how_it_earns) out.push(h('div', { class: 'grid g4' }, rv.how_it_earns.map((x) => h('div', { class: 'card pad', style: { padding: '14px' } }, h('div', { class: 'eyebrow' }, x.k), h('p', { class: 'small', style: { marginTop: '6px', color: 'var(--ink2)' } }, x.v)))));
      if (!seg0) {
        out.push(loaded(t, 'segments') ? (f && f.profile && f.profile.summary ? block('About', h('p', null, f.profile.summary)) : empty('No segment data for this name yet.')) : empty('Loading segment data…'));
        return h('div', null, out);
      }
      const kinds = [];
      const primary = rv && rv.mix ? rv.mix.axis : (seg0.quarterly.find((v) => v.kind === 'segment') ? 'segment' : 'product');
      kinds.push([primary, primary === 'segment' ? 'Segments' : 'Revenue lines']);
      if ((seg0.quarterly.concat(seg0.annual)).some((v) => v.kind === 'geography')) kinds.push(['geography', 'Regions']);
      const kind = S.axis && kinds.some((k) => k[0] === S.axis) ? S.axis : primary;
      const pers = periods(t, kind);
      const period = pers.some((p) => p[0] === S.period) ? S.period : (pers[0] || ['annual'])[0];
      const v = mixView(t, period, kind);
      const rows = kind === primary ? mappedRows(t, v) : geoRows(v);
      const hasProfit = rows.some((x) => x.row.profit != null);
      const total = rows.reduce((a, x) => a + Math.max(0, x.row.revenue), 0);
      const controls = h('div', { class: 'controls' },
        kinds.length > 1 ? seg(kinds, kind, (k) => { S.axis = k; win.refresh(); }, 'Breakdown') : h('span'),
        pers.length > 1 ? seg(pers, period, (p) => { S.period = p; win.refresh(); }, 'Period') : h('span', { class: 'small muted' }, periodLabel(v)));
      const head = h('div', { class: 'mixhead', style: { display: 'grid', gridTemplateColumns: hasProfit ? 'minmax(0,1.6fr) repeat(4, minmax(64px, .6fr))' : 'minmax(0,1.6fr) repeat(2, minmax(64px, .6fr))', gap: '10px', padding: '0 14px 6px', fontSize: '10.5px', letterSpacing: '.06em', textTransform: 'uppercase', color: 'var(--faint)', fontWeight: 600 } },
        h('span', null, ''), h('span', { style: { textAlign: 'right' } }, 'Revenue'), h('span', { style: { textAlign: 'right' } }, 'Growth'),
        hasProfit ? h('span', { style: { textAlign: 'right' } }, 'Margin') : null, hasProfit ? h('span', { style: { textAlign: 'right' } }, 'EBITDA') : null);
      const grid = hasProfit ? 'minmax(0,1.6fr) repeat(4, minmax(64px, .6fr))' : 'minmax(0,1.6fr) repeat(2, minmax(64px, .6fr))';
      const mkRow = (x, child) => {
        const r = x.row, share = r.revenue > 0 && total ? r.revenue / total : null;
        const marginTxt = r.margin != null ? fmt.pct(r.margin) : '–';
        const mDelta = r.margin != null && r.margin_prior != null ? r.margin - r.margin_prior : null;
        const summary = h('div', { style: { display: 'grid', gridTemplateColumns: grid, gap: '10px', alignItems: 'center', width: '100%' } },
          h('div', { style: { minWidth: 0 } },
            h('div', { style: { display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' } }, h('span', { style: { color: 'var(--ink)', fontWeight: child ? 400 : 500 } }, x.label), x.role ? pill(x.role, '') : null),
            share != null ? h('div', { class: 'mixrow', style: { marginTop: '6px' } }, h('div', { class: 'bar' }, h('i', { style: { width: (share * 100).toFixed(1) + '%' } }))) : null),
          h('span', { style: { textAlign: 'right', color: 'var(--ink)' } }, fmt.usdM(r.revenue), share != null ? h('div', { class: 'small muted' }, fmt.pct(share, 0)) : null),
          h('span', { style: { textAlign: 'right' } }, r.growth != null ? chg(r.growth, 0) : '–'),
          hasProfit ? h('span', { style: { textAlign: 'right' } }, marginTxt, mDelta != null ? h('div', { class: 'small ' + (mDelta >= 0 ? 'up' : 'down') }, fmt.pts(mDelta, 1)) : null) : null,
          hasProfit ? h('span', { style: { textAlign: 'right' } }, r.ebitda != null ? fmt.usdM(r.ebitda) : '–', r.ebitda != null && r.revenue > 0 ? h('div', { class: 'small muted' }, fmt.pct(r.ebitda / r.revenue, 0)) : null) : null);
        const detail = [x.driver ? h('p', null, x.driver) : null,
          r.profit != null ? h('p', { class: 'small muted', style: { marginTop: '6px' } }, `Segment profit ${fmt.usdM(r.profit)} vs ${fmt.usdM(r.profit_prior)} a year earlier.`) : null,
          r.revenue_prior != null ? h('p', { class: 'small muted' }, `Revenue a year earlier ${fmt.usdM(r.revenue_prior)}.`) : null,
          (x.children || []).length ? h('div', { style: { marginTop: '10px', display: 'flex', flexDirection: 'column', gap: '6px' } }, x.children.map((c) => mkRow(c, true))) : null];
        return child ? h('div', { style: { padding: '8px 0 0' } }, summary) : disclose(summary, detail);
      };
      out.push(block(null, controls, h('div', null, head, h('div', { style: { display: 'flex', flexDirection: 'column', gap: '8px' } }, rows.map((x) => mkRow(x))))));
      if (rv && rv.mix && rv.mix.callout && kind === primary) {
        const c = (v && v.rows.find((r) => r.name === rv.mix.callout.match)) || null;
        if (c) out.push(h('div', { class: 'callout' }, h('b', null, `${rv.mix.callout.label}: ${fmt.usdM(c.revenue)}`), c.growth != null ? ` (${fmt.spct(c.growth, 0)})` : '', '. ', rv.mix.callout.text));
      }
      if (rv && kind === primary) out.push(note(rv.mix.note));
      if (kind === 'geography') out.push(note('Regions as the company tags them in its filing. Where a parent region is shown, the rows below it sum to it.'));
      if (rv) {
        out.push(block('What the numbers say', ...rv.what_numbers_say.map((x) => disclose(x.t, x.d))));
        out.push(h('div', { class: 'callout' }, h('b', null, 'Position. '), rv.position));
      }
      const fl = seg0.filings || {};
      out.push(note(['From the company’s XBRL filings: ', [fl.quarterly, fl.annual].filter(Boolean).map((x, i) => [i ? ' and ' : '', h('a', { href: x.url, target: '_blank', rel: 'noopener' }, `${x.form} for ${fmt.date(x.period)}`)]), '. Refreshed automatically when a new 10-Q or 10-K lands.']));
      return h('div', null, out);
    }
    function geoRows(v) {
      if (!v) return [];
      const rows = v.rows.filter((r) => r.revenue > 0);
      const outside = rows.find((r) => /^Outside US$/.test(r.name));
      if (outside) {
        const others = rows.filter((r) => r !== outside && r.name !== 'US');
        const sumTop = others.filter((r) => ['Europe', 'Rest Of World', 'Other International'].includes(r.name)).reduce((a, r) => a + r.revenue, 0);
        const kids = others.filter((r) => ['Europe', 'Rest Of World'].includes(r.name) || Math.abs(sumTop - outside.revenue) > outside.revenue * 0.03);
        return rows.filter((r) => r.name === 'US').map((r) => ({ row: r, label: 'United States' }))
          .concat([{ row: outside, label: 'Outside the US', children: kids.map((r) => ({ row: r, label: r.name.replace('Rest Of World', 'Rest of world').replace(/^CN$/, 'China').replace(/^JP$/, 'Japan') })) }]);
      }
      const NAME = { US: 'United States', CN: 'China', DE: 'Germany', GB: 'United Kingdom', MX: 'Mexico', BR: 'Brazil', AU: 'Australia', JP: 'Japan' };
      return rows.map((r) => ({ row: r, label: NAME[r.name] || r.name }));
    }

    /* ----- moat ----- */
    function wMoat(t) {
      const rv = review(t), r = research(t), card = state.data.cards && state.data.cards[t];
      const out = [];
      const rating = rv ? rv.moat.rating : r && r.moat ? r.moat.rating : null;
      if (rating != null) out.push(h('div', { style: { display: 'flex', alignItems: 'center', gap: '14px' } }, h('div', { class: 'tile-big' }, `${rating} / 5`), h('div', { class: 'meter' }, [1, 2, 3, 4, 5].map((n) => h('i', { class: n <= rating ? 'on' : '' })))));
      if (rv) {
        out.push(block('Where it comes from', h('div', { class: 'chips' }, rv.moat.sources.map((s) => pill(s, '')))));
        out.push(h('div', { class: 'callout' }, h('b', null, 'The threat. '), rv.moat.threat));
        out.push(h('div', { class: 'callout' }, h('b', null, 'Position. '), rv.position));
      } else if (r && r.moat) out.push(h('p', { class: 'read' }, r.moat.summary));
      if (card && card.forces) {
        out.push(block(`Five forces · ${card.verdict}`, note('5 means the force is weak against the company, which protects pricing. H is filing data, M is filing text, L is a management claim.'),
          ...L.FORCES.filter((f) => card.forces[f]).map((f) => {
            const fo = card.forces[f];
            return disclose([h('span', { style: { flex: 1 } }, L.FORCE_LABEL[f]), h('div', { class: 'meter' }, [1, 2, 3, 4, 5].map((n) => h('i', { class: n <= fo.score ? 'on' : '' }))), h('span', { class: 'small muted', style: { width: '64px', textAlign: 'right' } }, fo.trend)],
              h('ul', { style: { margin: 0, paddingLeft: '18px', display: 'flex', flexDirection: 'column', gap: '6px' } }, (fo.evidence || []).map((e) => h('li', null, pill(e.tier, ''), ' ', e.text, ' ', h('span', { class: 'muted small' }, e.source ? `(${e.source.title}${e.source.date ? ', ' + e.source.date : ''})` : '')))));
          })));
      }
      return h('div', null, out);
    }

    /* ----- financials ----- */
    const STMT = {
      income: { label: 'Income', rows: [['revenue', 'Revenue', 'b'], ['cogs', 'Cost of revenue'], ['gross_profit', 'Gross profit', 'b'], ['rnd', 'R&D'], ['sga', 'SG&A'], ['op_income', 'Operating income', 'b'], ['interest_expense', 'Interest expense'], ['pretax', 'Pre-tax income'], ['tax', 'Tax'], ['net_income', 'Net income', 'b'], ['ebitda', 'EBITDA', 'b'], ['eps_diluted', 'Diluted EPS', 'eps'], ['shares_diluted', 'Diluted shares (M)', 'sh']],
        derived: [['rev_growth', 'Revenue growth', 'g'], ['gross_margin', 'Gross margin', 'p'], ['op_margin', 'Operating margin', 'p'], ['net_margin', 'Net margin', 'p'], ['eps_growth', 'EPS growth', 'g']] },
      balance: { label: 'Balance sheet', rows: [['cash', 'Cash'], ['receivables', 'Receivables'], ['inventory', 'Inventory'], ['current_assets', 'Current assets', 'b'], ['ppe', 'PP&E'], ['goodwill', 'Goodwill'], ['intangibles', 'Intangibles'], ['total_assets', 'Total assets', 'b'], ['payables', 'Payables'], ['current_liabilities', 'Current liabilities', 'b'], ['total_debt', 'Total debt', 'b'], ['total_liabilities', 'Total liabilities', 'b'], ['equity', 'Equity', 'b'], ['net_debt', 'Net debt', 'b']],
        derived: [['debt_to_equity', 'Debt to equity', 'x'], ['current_ratio', 'Current ratio', 'x']] },
      cashflow: { label: 'Cash flow', rows: [['cfo', 'Operating cash flow', 'b'], ['capex', 'Capex'], ['fcf', 'Free cash flow', 'b'], ['da', 'D&A'], ['sbc', 'Stock comp'], ['dividends', 'Dividends'], ['buybacks', 'Buybacks']],
        derived: [['fcf_margin', 'FCF margin', 'p'], ['cash_conversion', 'CFO / net income', 'x']] }
    };
    function cell(v, kind) {
      if (!num(v)) return '–';
      if (kind === 'p') return fmt.pct(v);
      if (kind === 'g') return fmt.spct(v);
      if (kind === 'x') return v.toFixed(2) + 'x';
      if (kind === 'eps') return v.toFixed(2);
      if (kind === 'sh') return v.toFixed(0);
      const s = Math.abs(v) >= 100 ? Math.round(Math.abs(v)).toLocaleString('en-US') : Math.abs(v).toFixed(1);
      return v < 0 ? '(' + s + ')' : s;
    }
    function wFinancials(t) {
      const S = us(t), f = dat(t, 'fundamentals');
      if (!f) return empty(loaded(t, 'fundamentals') ? 'Statements are not published for this name yet.' : 'Loading statements…');
      const tabs = seg([['statements', 'Statements'], ['ratios', 'Ratios'], ['returns', 'Returns']], S.finTab, (x) => { S.finTab = x; win.refresh(); }, 'Financials view');
      let body;
      if (S.finTab === 'ratios') body = finRatios(t, f);
      else if (S.finTab === 'returns') body = finReturns(t, f);
      else body = finStatements(t, f);
      return h('div', null, tabs, body,
        note(`Company-reported GAAP figures from SEC filings${(f.sources || []).length > 1 ? ', gaps filled from Yahoo Finance' : ''}. USD millions except per share. As of ${(f.asof || '').slice(0, 10)}.`));
    }
    function finStatements(t, f) {
      const S = us(t), spec = STMT[S.stmt], blk = f[S.freq];
      if (!blk || !blk.period_ends.length) return empty('No periods published.');
      const keep = S.freq === 'annual' ? 7 : 8, n = blk.period_ends.length, from = Math.max(0, n - keep);
      const ends = blk.period_ends.slice(from);
      const D2 = F.derive(f, S.freq);
      const lab = (e) => (S.freq === 'annual' ? "FY'" + e.slice(2, 4) : e.slice(2, 7).replace('-', '/'));
      const lineKey = S.line || spec.rows[0][0];
      const all = spec.rows.concat(spec.derived);
      const meta = all.find((r) => r[0] === lineKey) || spec.rows[0];
      const isD = spec.derived.some((r) => r[0] === lineKey);
      const vals = (isD ? D2[lineKey] : blk.rows[lineKey] || []).slice(from);
      const host = h('div', { class: 'chart-host' });
      if (vals.some(num)) requestAnimationFrame(() => C.barChart(host, { labels: ends.map(lab), height: 180, label: meta[1], bars: [{ name: meta[1], color: css('--sb1'), negColor: css('--bad'), values: vals }], fmt: (v) => cell(v, meta[2]) }));
      const mk = (r, d) => {
        const vs = (d ? D2[r[0]] : blk.rows[r[0]] || []).slice(from);
        if (!vs.some(num)) return null;
        return h('tr', { class: (r[2] === 'b' ? 'b ' : '') + (d ? 'it ' : '') + (lineKey === r[0] ? 'sel' : '') },
          h('th', { scope: 'row' }, h('button', { type: 'button', class: 'rowbtn', onclick: () => { S.line = r[0]; win.refresh(); } }, r[1])),
          vs.map((v) => h('td', { class: num(v) && v < 0 && !d ? 'neg' : '' }, cell(v, r[2]))));
      };
      const wrap = h('div', { class: 'tbl-wrap' }, h('table', { class: 'tbl' },
        h('thead', null, h('tr', null, h('th', null, 'USD M'), ends.map((e) => h('th', null, lab(e))))),
        h('tbody', null, spec.rows.map((r) => mk(r, false)), spec.derived.map((r) => mk(r, true)))));
      requestAnimationFrame(() => { wrap.scrollLeft = wrap.scrollWidth; });
      return h('div', { class: 'block' },
        h('div', { class: 'controls' },
          seg(Object.keys(STMT).map((k) => [k, STMT[k].label]), S.stmt, (k) => { S.stmt = k; S.line = null; win.refresh(); }, 'Statement'),
          seg([['annual', 'Annual'], ['quarterly', 'Quarterly']], S.freq, (k) => { S.freq = k; win.refresh(); }, 'Period')),
        h('div', null, h('p', { class: 'small muted', style: { marginBottom: '6px' } }, meta[1] + ' · tap a row to chart it'), host),
        wrap);
    }
    const RATIOS = [
      ['Margins', [['gross_margin', 'Gross margin', 'p'], ['op_margin', 'Operating margin', 'p'], ['ebitda_margin', 'EBITDA margin', 'p'], ['net_margin', 'Net margin', 'p'], ['fcf_margin', 'FCF margin', 'p']]],
      ['Growth', [['rev_growth', 'Revenue', 'g'], ['op_growth', 'Operating income', 'g'], ['eps_growth', 'EPS', 'g'], ['fcf_growth', 'Free cash flow', 'g']]],
      ['Cash and efficiency', [['cash_conversion', 'CFO / net income', 'x'], ['capex_pct', 'Capex / revenue', 'p'], ['asset_turnover', 'Asset turnover', 'x'], ['dso', 'Days sales outstanding', 'd'], ['sbc_pct', 'Stock comp / revenue', 'p']]],
      ['Liquidity', [['current_ratio', 'Current ratio', 'x'], ['quick_ratio', 'Quick ratio', 'x']]]
    ];
    function ratioTable(D2, groups, freq, keep) {
      const n = D2.ends.length, from = Math.max(0, n - keep);
      const lab = (e) => (freq === 'annual' ? "FY'" + e.slice(2, 4) : e.slice(2, 7).replace('-', '/'));
      const f2 = (v, k) => (!num(v) ? '–' : k === 'p' ? fmt.pct(v) : k === 'g' ? fmt.spct(v) : k === 'd' ? v.toFixed(0) : v.toFixed(2) + 'x');
      const rows = [];
      groups.forEach(([title, items]) => {
        const body = items.map(([k, name, kind]) => {
          const vs = (D2[k] || []).slice(from);
          if (!vs.some(num)) return null;
          return h('tr', null, h('th', { scope: 'row' }, name), vs.map((v) => h('td', null, f2(v, kind))), h('td', null, spark(vs, { w: 64, h: 18 })));
        }).filter(Boolean);
        if (body.length) rows.push(h('tr', { class: 'b' }, h('th', { colspan: String(keep + 2), style: { color: 'var(--faint)', fontSize: '10.5px', letterSpacing: '.06em', textTransform: 'uppercase', background: 'var(--sunk)' } }, title)), ...body);
      });
      const wrap = h('div', { class: 'tbl-wrap' }, h('table', { class: 'tbl' }, h('thead', null, h('tr', null, h('th', null, ''), D2.ends.slice(from).map((e) => h('th', null, lab(e))), h('th', null, 'Trend'))), h('tbody', null, rows)));
      requestAnimationFrame(() => { wrap.scrollLeft = wrap.scrollWidth; });
      return wrap;
    }
    function finRatios(t, f) {
      const S = us(t), D2 = F.derive(f, S.rfreq);
      return h('div', { class: 'block' }, seg([['annual', 'Annual'], ['quarterly', 'Quarterly']], S.rfreq, (k) => { S.rfreq = k; win.refresh(); }, 'Period'),
        ratioTable(D2, RATIOS, S.rfreq, S.rfreq === 'annual' ? 6 : 8), note('Quarterly ratios use trailing four-quarter flows over average balances.'));
    }
    function finReturns(t, f) {
      const S = us(t), D2 = F.derive(f, S.rfreq), n = D2.ends.length;
      const dp = D2.dupont[n - 1] || {};
      const rv = review(t);
      const adj = rv && rv.flags.find((x) => /return on capital/i.test(x.flag));
      const ps = peerStats(t);
      return h('div', { class: 'block' },
        h('div', { class: 'stats boxed' },
          stat('ROIC', fmt.pct(lastNum(D2.roic)), 'after tax, reported capital'),
          stat('Return on equity', fmt.pct(lastNum(D2.roe))),
          stat('Return on assets', fmt.pct(lastNum(D2.roa))),
          ps && ps.me && ps.me.roic != null ? stat('Peer median ROIC', fmt.pct(ps.med(null, 'roic')), ps.peers.length + ' peers') : null),
        adj ? h('div', { class: 'callout warn' }, h('b', null, adj.flag + '. '), adj.evidence) : null,
        seg([['annual', 'Annual'], ['quarterly', 'Quarterly']], S.rfreq, (k) => { S.rfreq = k; win.refresh(); }, 'Period'),
        ratioTable(D2, [['Returns', [['roic', 'Return on invested capital', 'p'], ['roe', 'Return on equity', 'p'], ['roa', 'Return on assets', 'p']]]], S.rfreq, S.rfreq === 'annual' ? 6 : 8),
        num(dp.roe) ? block('Where return on equity comes from',
          h('div', { class: 'stats boxed' }, stat('Net margin', fmt.pct(dp.net_margin)), stat('× Asset turnover', fmt.mult(dp.asset_turnover, 2)), stat('× Equity multiplier', fmt.mult(dp.equity_multiplier, 2)), stat('= Return on equity', fmt.pct(dp.roe))),
          note('High equity returns built on margin are sturdier than ones built on leverage.')) : null);
    }

    /* ----- balance sheet ----- */
    function wBalance(t) {
      const s = finSnapshot(t), rv = review(t);
      if (!s) return empty(loaded(t, 'fundamentals') ? 'Statements are not published for this name yet.' : 'Loading…');
      const q = s.q, n = q.ends.length;
      const host = h('div', { class: 'chart-host' });
      const pts = q.ends.map((e, i) => [Date.parse(e) / 1000, q.net_debt_ebitda[i]]).filter((p) => num(p[1]) !== null);
      if (pts.length > 2) requestAnimationFrame(() => C.lineChart(host, { series: [{ name: 'Net debt / EBITDA', color: css('--c1'), points: pts, width: 1.8 }], height: 170, xTicks: [pts[0][0], pts[Math.floor(pts.length / 2)][0], pts[pts.length - 1][0]], xFmt: (x) => new Date(x * 1000).toISOString().slice(0, 7), tipFmt: (x) => new Date(x * 1000).toISOString().slice(0, 10), yFmt: (v) => v.toFixed(1) + 'x', label: 'Net debt to EBITDA by quarter' }));
      return h('div', null,
        rv ? h('p', { class: 'read' }, rv.balance.read) : null,
        h('div', { class: 'stats boxed' },
          stat('Net debt', fmt.usdM(lastNum(s.f.quarterly.rows.net_debt))),
          stat('Net debt / EBITDA', s.ndE != null && s.ndE < 0 ? 'Net cash' : fmt.mult(s.ndE)),
          stat('Interest cover', fmt.mult(s.cover, 0), 'EBIT / interest'),
          stat('Total debt', fmt.usdM(s.debt)),
          stat('Cash', fmt.usdM(s.cash)),
          stat('Debt to equity', fmt.mult(lastNum(q.debt_to_equity), 2))),
        pts.length > 2 ? block('Leverage over time', host) : null,
        rv ? block('What to know', h('div', { class: 'list card' }, rv.balance.facts.map((x) => h('div', { class: 'li' }, h('span', { class: 'dot' }), h('div', { class: 'li-main' }, x))))) : null,
        block('How to read it', h('div', { class: 'list card' },
          h('div', { class: 'li' }, h('div', { class: 'li-main' }, h('div', { class: 'li-title' }, 'Below 1.5x'), h('div', { class: 'li-sub' }, 'Room to invest and return cash through a downturn.'))),
          h('div', { class: 'li' }, h('div', { class: 'li-main' }, h('div', { class: 'li-title' }, '1.5x to 3x'), h('div', { class: 'li-sub' }, 'Typical for investment-grade industrials; watch the trend more than the level.'))),
          h('div', { class: 'li' }, h('div', { class: 'li-main' }, h('div', { class: 'li-title' }, 'Above 3x'), h('div', { class: 'li-sub' }, 'Rating agencies start to press; buybacks usually slow.')))),
          note('Thresholds follow common rating-agency practice for industrial issuers. Leases and off-balance-sheet commitments are covered under Management, governance and earnings quality.')));
    }

    /* ----- management ----- */
    function wManagement(t) {
      const m = dat(t, 'mgmt'), rv = review(t), f = dat(t, 'fundamentals');
      if (!m) return empty(loaded(t, 'mgmt') ? 'The management record is not published for this name yet.' : 'Loading…');
      const comp = (k) => (m.components || []).find((c) => c.key === k) || {};
      const ev = (label, framework, value, lineText, question) => h('div', { class: 'ev' },
        h('div', { class: 'ev-top' }, eyebrow(label), framework ? pill(framework, '') : null),
        h('div', { class: 'ev-v' }, value), lineText ? h('div', { class: 'ev-l' }, lineText) : null, question ? h('div', { class: 'ev-q' }, 'Your judgment: ', question) : null);
      const sp = m.surprises || {};
      const host = h('div', { class: 'chart-host' });
      if (sp.rows && sp.rows.length) requestAnimationFrame(() => C.barChart(host, { labels: sp.rows.map((r) => r.date.slice(2, 7).replace('-', '/')), height: 150, label: 'EPS estimate vs reported', bars: [{ name: 'Estimate', color: css('--c3'), values: sp.rows.map((r) => r.estimate) }, { name: 'Reported', color: css('--c1'), values: sp.rows.map((r) => r.actual) }], fmt: (v) => v.toFixed(2) }));
      const cap = m.capital || {}, eq = comp('earnings_quality'), gov = comp('governance');
      const govScore = gov.note ? (gov.note.match(/([\d.]+) of 10/) || [])[1] : null;
      const cards = h('div', { class: 'grid g2' },
        ev('Delivery', 'Consensus surprise', sp.n ? `${sp.beats} of ${sp.n} beats` : '–', sp.n ? `Average surprise ${fmt.spct(sp.avg_surprise_pct / 100, 1)}; worst ${fmt.spct(sp.worst_pct / 100, 1)}.` : null, 'Managements help set consensus. Is the streak skill or sandbagging?'),
        ev('Earnings quality', 'Accruals, cash conversion', eq.score != null ? (eq.note.match(/([\d.]+)x net income/) || [])[1] + 'x cash to profit' : '–', eq.note ? eq.note.replace(/^Operating cash flow was [\d.]+x net income over 5 years\. /, '') : null, 'Do adjusted earnings and cash tell the same story?'),
        ev('Capital allocation', 'Buybacks, payout, M&A', cap.share_change_pct_pa != null ? fmt.spct(cap.share_change_pct_pa / 100, 1) + ' shares a year' : '–',
          [cap.payout_of_fcf_pct != null ? `Dividends and buybacks took ${cap.payout_of_fcf_pct}% of free cash flow.` : null, cap.goodwill_pct_assets != null ? ` Goodwill is ${cap.goodwill_pct_assets}% of assets.` : null].filter(Boolean).join(''), 'Is cash going where returns are highest?'),
        ev('Governance', 'ISS QualityScore', govScore ? `${govScore} / 10 risk` : '–', 'Average of audit, board, pay and shareholder-rights risk. 1 is lowest risk.', 'Does pay reward per-share value or size?'));
      const out = [cards, sp.rows && sp.rows.length ? block('EPS against consensus', host) : null];
      if (m.insiders) out.push(h('div', { class: 'callout' }, h('b', null, 'Insiders, 12 months. '), `${m.insiders.buy_count} open-market buys (${fmt.usdM(m.insiders.bought_value / 1e6)}) and ${m.insiders.sell_count} sales (${fmt.usdM(m.insiders.sold_value / 1e6)}). Selling is routine; buying is the rarer signal.`));
      if (rv) {
        out.push(block('Accounting and earnings-quality flags', ...rv.flags.map((x) => disclose([pill(x.severity === 'watch' ? 'Judge' : 'Note', x.severity === 'watch' ? 'warn' : ''), h('span', null, x.flag)], x.evidence))));
        out.push(block('Questions for your judgment', h('div', { class: 'list card' }, rv.questions.map((q, i) => h('div', { class: 'li' }, h('span', { class: 'tickers', style: { width: '18px' } }, String(i + 1)), h('div', { class: 'li-main' }, q))))));
      }
      const g = m.guidance;
      out.push(block('Guidance record', g && g.n ? h('div', { class: 'stats boxed' }, stat('Verified guides', String(g.n)), stat('Met or beat', fmt.pct(g.hit_rate, 0)), stat('Missed', String(g.misses))) : note('Not retrieved yet. Built from earnings-release text, checked word for word; it fills as releases are parsed.')));
      const c = m.composite || {};
      out.push(note(`Summary score ${c.score != null ? Math.round(c.score) : '–'} / 100 on ${Math.round((c.coverage || 0) * 100)}% of the model. A convenience for sorting, not a verdict: read the evidence above.`));
      return h('div', null, out);
    }

    /* ----- valuation ----- */
    function wValuation(t) {
      const S = us(t), doc = dat(t, 'peers');
      const tabs = [];
      if (researchOf(t)) tabs.push(['estimates', 'Target and estimates']);
      if (doc) tabs.push(['peers', 'Peers']);
      tabs.push(['multiples', 'Multiples'], ['history', 'vs own history'], ['targets', 'Analyst targets']);
      const cur = tabs.some((x) => x[0] === S.valTab) ? S.valTab : tabs[0][0];
      let body;
      if (cur === 'estimates') body = valEstimates(t);
      else if (cur === 'peers') body = valPeers(t);
      else if (cur === 'history') body = valHistory(t);
      else if (cur === 'targets') body = valTargets(t);
      else body = valMultiples(t);
      return h('div', null, seg(tabs, cur, (x) => { S.valTab = x; win.refresh(); }, 'Valuation view'), body);
    }
    function estTable(t) {
      const e = estimates(t);
      if (!e) return null;
      const c = e.consensus, td = (x, cls) => h('td', { class: cls || null }, x);
      const gap = (x) => (x == null ? '–' : h('span', { class: Math.abs(x) < 0.01 ? '' : x > 0 ? 'up' : 'down' }, fmt.spct(x, 1)));
      const row = (label, f) => h('tr', null, h('th', null, label), e.rows.map((r) => td(f(r))));
      return h('div', { class: 'tbl-wrap' }, h('table', { class: 'tbl' },
        h('thead', null, h('tr', null, h('th', null, 'Fiscal year'), e.rows.map((r) => h('th', null, r.label)))),
        h('tbody', null,
          row('Revenue, ours', (r) => fmt.usdM(r.rev)), row('Revenue, consensus', (r) => (r.cRev ? fmt.usdM(r.cRev) : '–')), row('Gap', (r) => gap(r.gapRev)),
          row('EPS, ours', (r) => '$' + r.eps.toFixed(2)), row('EPS, consensus', (r) => (r.cEps ? '$' + r.cEps.toFixed(2) : '–')), row('Gap', (r) => gap(r.gapEps)),
          row('Net margin, ours', (r) => fmt.pct(r.margin)), row('Dividend, ours', (r) => '$' + r.dps.toFixed(2)))));
    }
    function valEstimates(t) {
      const c = callOf(t, false), e = estimates(t), r = researchOf(t);
      if (!c) return empty('No research file, so no target.');
      const out = [];
      out.push(h('div', { class: 'stats boxed' },
        stat('Rating', h('span', { class: ratingKind(c.rating) === 'ok' ? 'up' : ratingKind(c.rating) === 'bad' ? 'down' : '' }, c.rating), '±5 pts vs cost of equity'),
        stat('12-month target', fmt.px(c.pt), fmt.spct(c.upside, 1) + ' upside'),
        stat('Total return', fmt.spct(c.totalReturn, 1), 'incl. ' + fmt.pct(c.divYield, 1) + ' dividend'),
        stat('Cost of equity', fmt.pct(c.hurdle), `${rates().rf}% + beta × ${rates().erp}%`)));
      out.push(block('How the target is built', h('div', { class: 'card derive' },
        h('div', { class: 'dv' }, h('span', null, `${e.rows[1].label} EPS, our base case`), h('b', null, '$' + c.eps1.toFixed(2))),
        h('div', { class: 'dv' }, h('span', null, `Target P/E: today ${c.pe0.toFixed(1)}x, moved a third of the way to the ${r.horizon}-year exit multiple`), h('b', null, '× ' + c.targetPE.toFixed(1) + 'x')),
        h('div', { class: 'dv total' }, h('span', null, '12-month price target'), h('b', null, fmt.px(c.pt))),
        h('div', { class: 'dv' }, h('span', null, `Downside case (${c.bear.pe.toFixed(1)}x × $${c.bear.eps1.toFixed(2)})`), h('b', null, fmt.px(c.bear.value))),
        h('div', { class: 'dv' }, h('span', null, `Upside case (${c.bull.pe.toFixed(1)}x × $${c.bull.eps1.toFixed(2)})`), h('b', null, fmt.px(c.bull.value))))));
      out.push(block('Our estimates vs consensus', estTable(t)));
      const cons = e.consensus;
      out.push(note(cons ? 'Consensus is the Yahoo Finance analyst mean. Our estimates are the base case of the scenario model; dispute any assumption in Target and thesis and they move.' : 'Consensus not loaded yet.'));
      return h('div', null, out);
    }
    function valPeers(t) {
      const S = us(t), ps = peerStats(t);
      if (!ps) return empty('Loading peers…');
      const { doc, me, inc } = ps;
      const b = S.basis;
      const cols = [['mcap_usd_b', 'Mkt cap', (v) => fmt.usdB(v)], [b + '.ev_ebitda', 'EV/EBITDA', fmt.mult], [b + '.pe', 'P/E', fmt.mult], [b + '.ev_ocf', 'EV/OCF', fmt.mult], [b + '.ev_fcf', 'EV/FCF', fmt.mult], ['ebitda_margin', 'EBITDA mgn', (v) => fmt.pct(v, 0)], [b === 'ntm' ? 'ntm.rev_growth' : 'rev_growth_fy', b === 'ntm' ? 'NTM growth' : 'FY growth', (v) => fmt.spct(v, 0)], ['roic', 'ROIC', (v) => fmt.pct(v, 0)], ['net_debt_ebitda', 'ND/EBITDA', (v) => (num(v) === null ? '–' : v.toFixed(1) + 'x')]];
      const get = (r, k) => k.split('.').reduce((o, x) => (o ? o[x] : null), r);
      const order = [me].concat(doc.rows.filter((r) => r.role !== 'subject' && inc.has(r.ticker)), doc.rows.filter((r) => r.role !== 'subject' && !inc.has(r.ticker)));
      const meds = cols.map(([k]) => median(doc.rows.filter((r) => r.role !== 'subject' && inc.has(r.ticker)).map((r) => get(r, k))));
      const rowEl = (r) => {
        const isMe = r.role === 'subject', on = isMe || inc.has(r.ticker);
        return h('tr', { class: isMe ? 'me' : on ? '' : 'off' },
          h('th', { scope: 'row' }, isMe ? h('span', null, r.name) : h('label', { class: 'chk' }, h('input', { type: 'checkbox', class: 'toggle', checked: on ? true : null, 'aria-label': `Include ${r.name} in the peer median`, onchange: () => { togglePeer(t, r.ticker, doc); win.refresh(); kit.render(); } }), h('span', null, r.name, r.stale ? ' *' : '', r.role === 'optional' ? h('span', { class: 'muted small' }, ' · optional') : null))),
          cols.map(([k, , f]) => h('td', null, f(get(r, k)))));
      };
      const premRow = h('tr', { class: 'med' }, h('th', { scope: 'row' }, 'Premium to median'), cols.map(([k], i) => {
        if (i === 0 || i >= 5) return h('td', null, '');
        const mv = get(me, k), md = meds[i];
        return h('td', { class: mv && md ? (mv / md - 1 > 0 ? '' : '') : '' }, mv && md ? fmt.spct(mv / md - 1, 0) : '–');
      }));
      const table = h('div', { class: 'tbl-wrap' }, h('table', { class: 'tbl' },
        h('thead', null, h('tr', null, h('th', null, 'Company'), cols.map(([, l]) => h('th', null, l)))),
        h('tbody', null, order.map(rowEl), h('tr', { class: 'med' }, h('th', { scope: 'row' }, `Peer median (${ps.peers.length})`), cols.map(([k, , f], i) => h('td', null, i === 0 ? '' : f(meds[i])))), premRow)));
      const rv = review(t);
      // computed comparison chips
      const cmp = (label, mine, med, f, higherBetter) => (num(mine) !== null && num(med) !== null ? h('div', { class: 'stat' }, h('div', { class: 'stat-l' }, label), h('div', { class: 'stat-v' }, f(mine)), h('div', { class: 'stat-s ' + ((mine > med) === higherBetter ? 'up' : 'down') }, `peers ${f(med)}`)) : null);
      const facts = h('div', { class: 'stats boxed' },
        cmp('NTM revenue growth', me.ntm.rev_growth, ps.med('ntm', 'rev_growth'), (v) => fmt.spct(v, 1), true),
        cmp('EBITDA margin', me.ebitda_margin, ps.med(null, 'ebitda_margin'), (v) => fmt.pct(v, 0), true),
        cmp('ROIC', me.roic, ps.med(null, 'roic'), (v) => fmt.pct(v, 1), true),
        cmp('Net debt / EBITDA', me.net_debt_ebitda, ps.med(null, 'net_debt_ebitda'), (v) => v.toFixed(1) + 'x', false));
      const notes = doc.rows.filter((r) => (r.notes || []).length).map((r) => h('li', null, h('b', null, r.name + ': '), r.notes.join(' ')));
      return h('div', { class: 'block' },
        h('div', { class: 'controls' }, seg([['ntm', 'Next 12 months'], ['ltm', 'Last 12 months']], b, (x) => { S.basis = x; win.refresh(); }, 'Basis'), h('span', { class: 'small muted' }, 'Toggle peers to change the median. Saved on this device.')),
        table,
        block('Is the premium earned?', facts,
          rv ? h('div', { class: 'grid g2' }, h('div', { class: 'callout' }, h('b', null, 'For the premium. '), rv.peer_read.why_premium), h('div', { class: 'callout' }, h('b', null, 'Against it. '), rv.peer_read.why_not)) : null),
        rv && rv.peer_read.peers_note ? note(rv.peer_read.peers_note) : null,
        disclose('Method and data notes', [h('p', { style: { whiteSpace: 'pre-line' } }, doc.method), notes.length ? h('ul', { style: { paddingLeft: '18px', marginTop: '8px' } }, notes) : null, h('p', { class: 'small muted', style: { marginTop: '8px' } }, `${doc.why} Source: ${doc.source}, ${fmt.date(doc.asof)}.`)]));
    }
    function valMultiples(t) {
      const f = dat(t, 'fundamentals'), p = priceOf(t);
      if (!f || !p) return empty('Needs statements and a price.');
      const v = F.valuation(f, p.price, f.profile);
      return h('div', { class: 'block' }, h('div', { class: 'stats boxed' },
        stat('Market cap', fmt.usdM(v.mcap)), stat('Enterprise value', fmt.usdM(v.ev)), stat('P/E', fmt.mult(v.pe), 'trailing, GAAP'), stat('EV / EBITDA', fmt.mult(v.ev_ebitda)), stat('EV / sales', fmt.mult(v.ev_sales)),
        stat('Price / FCF', fmt.mult(v.p_fcf)), stat('Price / book', fmt.mult(v.pb)), stat('FCF yield', fmt.pct(v.fcf_yield)), stat('Earnings yield', fmt.pct(v.earnings_yield)), stat('Dividend yield', fmt.pct(v.div_yield))),
        note('Live price over trailing-twelve-month GAAP figures from filings. The peer tab uses adjusted EBITDA and consensus, so the two can differ.'));
    }
    function valHistory(t) {
      const f = dat(t, 'fundamentals'), p = priceOf(t), hist = dat(t, 'history');
      if (!f || !p || !hist) return empty('Needs statements and price history.');
      const v = F.valuation(f, p.price, f.profile), vh = F.valuationHistory(f, hist.bars);
      if (vh.length < 6) return empty('Needs at least six quarters of history.');
      const rows = [['pe', 'P/E', v.pe], ['ev_ebitda', 'EV / EBITDA', v.ev_ebitda], ['ps', 'Price / sales', v.ps], ['p_fcf', 'Price / FCF', v.p_fcf]].map(([k, n, cur]) => {
        const pc = F.percentile(vh, k, cur);
        return h('tr', null, h('th', null, n), h('td', null, fmt.mult(cur)), h('td', null, pc ? fmt.mult(pc.median) : '–'), h('td', null, pc ? `${fmt.mult(pc.low)} – ${fmt.mult(pc.high)}` : '–'), h('td', null, pc ? (pc.pct > 0.7 ? pill('Expensive', 'warn') : pc.pct < 0.3 ? pill('Cheap', 'ok') : pill('Middle', '')) : '–'));
      });
      const host = h('div', { class: 'chart-host' });
      const pts = vh.filter((x) => num(x.pe) && x.pe < 200).map((x) => [Date.parse(x.end) / 1000, x.pe]);
      if (pts.length > 3) requestAnimationFrame(() => C.lineChart(host, { series: [{ name: 'P/E', color: css('--c1'), points: pts, width: 1.8 }], height: 180, xTicks: [pts[0][0], pts[Math.floor(pts.length / 2)][0], pts[pts.length - 1][0]], xFmt: (x) => String(new Date(x * 1000).getUTCFullYear()), tipFmt: (x) => new Date(x * 1000).toISOString().slice(0, 10), yFmt: (x) => x.toFixed(0) + 'x', label: 'P/E at each quarter end', refLine: (F.percentile(vh, 'pe', v.pe) || {}).median }));
      return h('div', { class: 'block' }, h('div', { class: 'tbl-wrap' }, h('table', { class: 'tbl' }, h('thead', null, h('tr', null, ['', 'Now', 'Median', 'Range', 'Where it sits'].map((x) => h('th', null, x)))), h('tbody', null, rows))),
        pts.length > 3 ? host : null, note(`Quarter-ends since ${vh[0].end.slice(0, 4)}, GAAP trailing figures. Cheap means cheaper than usual on that measure; it says nothing about why.`));
    }
    function valTargets(t) {
      const f = dat(t, 'fundamentals'), p = priceOf(t);
      const pr = (f && f.profile) || {};
      if (!num(pr.target_mean) || !p) return empty('Consensus targets not retrieved.');
      const lo = pr.target_low, hi = pr.target_high, cur = p.price;
      const X = (x) => (Math.max(0, Math.min(1, (x - lo) / (hi - lo))) * 100).toFixed(1) + '%';
      return h('div', { class: 'block' },
        h('div', { class: 'stats boxed' }, stat('Mean target', fmt.px(pr.target_mean), fmt.spct(pr.target_mean / cur - 1, 1) + ' vs price'), stat('Median', fmt.px(pr.target_median)), stat('Range', `${fmt.px(lo)} – ${fmt.px(hi)}`), stat('Analysts', String(pr.analyst_count || '–'), pr.recommendation ? String(pr.recommendation).replace('_', ' ') : null)),
        h('div', { class: 'range', role: 'img', 'aria-label': 'Price within the target range' }, h('div', { class: 'track' }), h('div', { class: 'seg-r', style: { left: '0', width: '100%' } }), h('div', { class: 'mk', style: { left: X(cur) }, title: 'Price' }), h('div', { class: 'zero', style: { left: X(pr.target_mean), background: 'var(--info)' }, title: 'Mean target' })),
        note('Third-party opinions from Yahoo Finance. They trail the price and are context, not the engine’s view.'));
    }

    /* ----- thesis ----- */
    function wThesis(t) {
      const r = researchOf(t), m = mkOf(t), rv = review(t);
      if (!r || !m) return empty('No research file for this name yet.');
      const base = evalFor(t, false), mine = evalFor(t, true), yours = hasMine(t);
      const shown = yours ? mine : base;
      const out = [];
      const c = callOf(t, false), cm = yours ? callOf(t, true) : null;
      if (c) {
        out.push(block('12-month call', h('div', { class: 'scen' }, [['bear', 'Downside'], ['base', 'Target'], ['bull', 'Upside']].map(([k, lab]) => {
          const v = k === 'base' ? c.pt : c[k].value, pe = k === 'base' ? c.targetPE : c[k].pe, ep = k === 'base' ? c.eps1 : c[k].eps1;
          return h('div', { class: 'card ' + k }, h('div', { class: 'ev-top' }, eyebrow(lab), k === 'base' ? pill(c.rating, ratingKind(c.rating)) : null),
            h('div', { class: 's-ret' }, fmt.px(v)), h('div', { class: 's-px' }, `${fmt.spct(v / m.price - 1, 1)} · ${pe.toFixed(1)}x × $${ep.toFixed(2)}`));
        })), cm ? note(`With your disputes: ${cm.rating}, target ${fmt.px(cm.pt)} (${fmt.spct(cm.upside, 1)}).`) : null));
        if (rv && rv.thesis_long) out.push(block('Investment thesis', ...rv.thesis_long.map((x) => h('p', { class: 'read' }, fill(t, x)))));
        out.push(h('h3', { class: 'sub-h' }, `${r.horizon}-year scenarios`));
      }
      out.push(h('div', { class: 'stats boxed' },
        stat('Engine stance', base.stance, base.conviction + ' conviction'),
        yours ? stat('Your view', mine.stance, 'after your disputes') : null,
        stat('Expected return', fmt.pct(shown.expectedIrr), 'a year, probability-weighted'),
        stat('Hurdle', fmt.pct(shown.hurdle), `${rates().rf}% + beta × ${rates().erp}%`),
        stat('Price implies', E.impliedGrowth(r, m, rates(), { overrides: overrides(t) }).toFixed(1) + '%', 'revenue growth a year')));
      if (!(rv && rv.thesis_long)) out.push(h('p', { class: 'read' }, r.header.thesis));
      const sc = shown.scenarios, pr = shown.probs;
      const story = (k) => (rv && rv.scenarios[k === 'bear' ? 'downside' : k === 'bull' ? 'upside' : 'base']) || null;
      out.push(h('div', { class: 'scen' }, ['bear', 'base', 'bull'].map((k) => {
        const s = story(k);
        return h('div', { class: 'card ' + k },
          h('div', { class: 'ev-top' }, eyebrow(k === 'bear' ? 'Downside' : k === 'bull' ? 'Upside' : 'Base'), pill(fmt.pct(pr[k], 0) + ' odds', '')),
          h('div', { class: 's-ret' }, fmt.spct(sc[k].irr), h('small', { class: 'muted', style: { fontSize: '12px', fontFamily: 'var(--sans)' } }, ' a year')),
          h('div', { class: 's-px' }, `${fmt.px(sc[k].exitPrice)} in ${r.horizon} years · ${sc[k].pe.toFixed(0)}x exit`),
          s ? h('div', { class: 's-story' }, s.story) : null,
          s ? h('div', { class: 'small muted' }, h('b', null, 'Needs: '), s.needs) : null);
      })));
      const ov = overrides(t) || {};
      out.push(block('Assumptions · tap one to dispute it', h('div', { class: 'card' }, E.DRIVERS.map((k) => {
        const d = r.drivers[k], meta = E.DRIVER_META[k], basis = rv && rv.forecast_basis ? rv.forecast_basis[k] : (d.kind === 'sourced' ? 'Sourced from filings' : 'Engine judgment');
        const kindTag = /^Driver-based/.test(basis) ? 'Driver-based' : /^Changed/.test(basis) ? 'Changed assumption' : /^Trend|^Below trend/.test(basis) ? 'Trend' : /^Judgment/.test(basis) ? 'Judgment' : d.kind === 'sourced' ? 'Sourced' : 'Judgment';
        return h('div', { class: 'drv' },
          h('div', null, h('div', { class: 'drv-n' }, meta.label), h('div', { class: 'small muted' }, `Downside ${d.bear} · Base ${d.base} · Upside ${d.bull} ${meta.unit}`)),
          h('div', { class: 'drv-v' }, ov[k] !== undefined ? [h('s', null, String(d.base)), String(ov[k])] : String(d.base), h('span', { class: 'small muted', style: { fontFamily: 'var(--sans)', marginLeft: '3px' } }, meta.unit)),
          btn(ov[k] !== undefined ? 'Edit' : 'Dispute', () => openDispute(t, k), 'small'),
          h('div', { class: 'drv-b' }, pill(kindTag, kindTag === 'Driver-based' || kindTag === 'Sourced' ? 'info' : ''), ' ', basis.replace(/^[^:]+:\s*/, '')));
      }))));
      if (yours) out.push(diffPanel(t));
      const sens = E.sensitivity(r, m, rates(), { overrides: overrides(t) });
      const mx = Math.max(...sens.map((s) => Math.max(Math.abs(s.up), Math.abs(s.down))), 1e-4);
      out.push(block('What moves the base-case return', ...sens.map((s) => h('div', { class: 'tor' },
        h('div', null, `${s.label} ±${s.flex}${s.unit.startsWith('%') ? ' pts' : s.unit === 'x' ? 'x' : ''}`),
        h('div', { class: 'tor-bar' }, h('i', { class: 'neg', style: { width: Math.min(50, Math.abs(Math.min(s.up, s.down)) / mx * 50) + '%' } }), h('i', { class: 'pos', style: { width: Math.min(50, Math.abs(Math.max(s.up, s.down)) / mx * 50) + '%' } })),
        h('div', { class: 'tor-v' }, `${fmt.pts(Math.min(s.up, s.down))} / ${fmt.pts(Math.max(s.up, s.down))}`)))));
      const vv = r.variant;
      out.push(block('Where the engine differs from the market', h('div', { class: 'grid g2' }, h('div', { class: 'callout' }, h('b', null, 'Market assumes. '), vv.street), h('div', { class: 'callout' }, h('b', null, 'Engine view. '), vv.ours)),
        disclose('Where this could be wrong', vv.could_be_wrong), disclose('What would change the view', vv.would_change_mind)));
      out.push(lensesBlock(t, r, shown, m));
      out.push(h('div', { class: 'row-actions' }, btn([icon('ext'), 'Challenge it with Claude'], () => askClaude(t), ''), btn('Reset to engine baseline', () => { state.disputes = state.disputes.filter((x) => x.ticker !== t); kit.save(); win.refresh(); kit.render(); }, 'ghost', { disabled: !overrides(t) })));
      out.push(srcLine((rv ? rv.sources : []).concat(r.sources || [])));
      return h('div', null, out);
    }
    function diffPanel(t) {
      const r = researchOf(t), m = mkOf(t);
      const df = E.diff(r, m, rates(), state.disputes, { tilt: state.tilt });
      const a = df.baseline, b = df.yours;
      return block('Engine baseline vs your view',
        h('div', { class: 'tbl-wrap' }, h('table', { class: 'tbl' }, h('thead', null, h('tr', null, h('th', null, ''), h('th', null, 'Engine'), h('th', null, 'Yours'))),
          h('tbody', null, [['Stance', a.stance, b.stance], ['Expected return', fmt.pct(a.expectedIrr), fmt.pct(b.expectedIrr)], ['Edge over hurdle', fmt.pts(a.edge), fmt.pts(b.edge)], ['Base-case price', fmt.px(a.scenarios.base.exitPrice), fmt.px(b.scenarios.base.exitPrice)]].map((x) => h('tr', null, h('th', null, x[0]), h('td', null, x[1]), h('td', null, x[2])))))),
        note(df.context));
    }
    function lensesBlock(t, r, ev, m) {
      const lenses = state.data.lenses;
      if (!lenses || !lenses.lenses || !lenses.lenses.length) return null;
      return disclose('Investor lenses (parked for now)', [note(lenses.note), ...lenses.lenses.map((l) => {
        const rd = E.lensRead(l, r, ev, m, rates());
        return h('div', { style: { marginTop: '10px' } }, h('div', { style: { display: 'flex', gap: '8px', alignItems: 'center' } }, h('b', null, l.name), h('span', { class: 'small muted' }, `${rd.passes} of ${rd.of} checks pass`)), h('p', { class: 'small' }, rd.own || l.tagline));
      })]);
    }
    function openDispute(t, k) {
      win.open({ title: 'Dispute: ' + E.DRIVER_META[k].label, eyebrow: nameOf(t), build: () => { const n = disputeBody(t, k); n.classList.add('stack'); return n; } });
    }
    function disputeBody(t, driver) {
      const r = researchOf(t), m = mkOf(t), d = r.drivers[driver], meta = E.DRIVER_META[driver];
      const existing = state.disputes.find((x) => x.ticker === t && x.driver === driver);
      const input = h('input', { type: 'number', step: String(meta.step), inputmode: 'decimal', 'aria-label': 'Your value' });
      input.value = existing ? existing.to : d.base;
      const reasons = [['forecast', 'I forecast differently'], ['data', 'The data is wrong'], ['multiple', 'The market will pay a different multiple'], ['risk', 'A risk is missing'], ['other', 'Other']];
      const reason = h('select', { 'aria-label': 'Reason' }, reasons.map(([v, l]) => h('option', { value: v }, l)));
      if (existing) reason.value = existing.reason;
      const why = h('textarea', { placeholder: 'Your reasoning, in a sentence', 'aria-label': 'Your reasoning', maxlength: '400' });
      if (existing) why.value = existing.note || '';
      const result = h('div', { 'aria-live': 'polite', class: 'block' });
      return h('div', null,
        h('div', { class: 'stats boxed' }, stat('Engine', `${d.base} ${meta.unit}`, `downside ${d.bear}, upside ${d.bull}`), stat('Basis', d.kind === 'sourced' ? 'Sourced' : 'Judgment', d.source)),
        h('p', { class: 'small' }, d.why),
        h('div', { class: 'grid g2' }, h('label', { class: 'fld' }, `Your value (${meta.unit})`, input), h('label', { class: 'fld' }, 'Why', reason)),
        why,
        h('div', { class: 'row-actions' },
          btn(existing ? 'Test and update' : 'Test my number', () => {
            const to = Number(input.value);
            if (!isFinite(to)) { toast('Enter a number.'); return; }
            if (to === d.base) { toast('That is the engine’s number.'); return; }
            const disp = { id: t + '-' + driver, ticker: t, driver, to, from: d.base, reason: reason.value, note: why.value.trim(), ts: Date.now() };
            const c = E.challenge(r, m, rates(), disp, state.disputes);
            result.replaceChildren(
              h('div', { class: 'callout' }, h('b', null, '1. The case for the engine. '), c.steelman),
              h('div', { class: 'callout' }, h('b', null, '2. What your number does. '), c.quantified, ' ', `Expected return ${fmt.pct(c.before.expectedIrr)} → ${fmt.pct(c.after.expectedIrr)}; stance ${c.before.stance === c.after.stance ? 'stays ' + c.after.stance : c.before.stance + ' → ' + c.after.stance}.`),
              c.tripwires.length ? h('div', { class: 'callout' }, h('b', null, '3. What would prove you right. '), c.tripwires.map((x) => x.text).join('; ') + '.') : null,
              h('div', { class: 'row-actions' },
                btn('Keep my view', () => {
                  state.disputes = state.disputes.filter((x) => !(x.ticker === t && x.driver === driver)).concat([disp]);
                  kit.save(); win.close(); toast('Saved. Your view is recomputed.'); kit.render();
                }, 'primary'),
                btn('Reconsider', () => result.replaceChildren(note('Nothing saved.')), 'ghost')));
          }, 'primary'),
          existing ? btn('Withdraw', () => { state.disputes = state.disputes.filter((x) => x !== existing); kit.save(); win.close(); kit.render(); }, 'ghost') : null),
        result);
    }
    function askClaude(t) {
      const r = researchOf(t), rv = review(t), ev = evalFor(t, true);
      const lines = [`Challenge this investment thesis on ${nameOf(t)} (${t}). Be specific and sceptical; cite what would prove it wrong.`, '',
        `Engine stance: ${ev.stance}, expected ${fmt.pct(ev.expectedIrr)} a year vs hurdle ${fmt.pct(ev.hurdle)}.`, `Thesis: ${r.header.thesis}`];
      if (rv) {
        lines.push('', 'What the numbers say:', ...rv.what_numbers_say.map((x) => `- ${x.t}: ${x.d}`), '', 'Risks:', ...rv.risks.map((x) => `- ${x.cause}: ${x.how}`));
      }
      lines.push('', 'Assumptions:', ...E.DRIVERS.map((k) => `- ${E.DRIVER_META[k].label}: base ${r.drivers[k].base} (${r.drivers[k].bear} to ${r.drivers[k].bull}). ${r.drivers[k].why}`));
      const text = lines.join('\n');
      (navigator.clipboard ? navigator.clipboard.writeText(text) : Promise.reject()).then(() => toast('Prompt copied. Paste it into Claude.'), () => toast('Could not copy.'));
      window.open('https://claude.ai/new?q=' + encodeURIComponent(lines.slice(0, 4).join(' ')), '_blank', 'noopener');
    }

    /* ----- risks ----- */
    function wRisks(t) {
      const r = researchOf(t), rv = review(t);
      if (!r) return empty('No research file yet.');
      const by = {};
      (r.tripwires || []).forEach((x) => { by[x.id] = x; });
      const sevKind = (s) => (s === 'high' ? 'bad' : s === 'medium' ? 'warn' : '');
      const out = [];
      if (rv) {
        out.push(note('Each risk is a cause, not an outcome. The indicator is how you would see it coming; a linked tripwire is checked against the last reported number.'));
        out.push(...rv.risks.map((x) => {
          const tw = x.trip ? by[x.trip] : null, st = tw ? tripStatus(tw) : null;
          return h('div', { class: 'risk' },
            h('span', { class: 'dot sev ' + sevKind(x.sev), title: x.sev + ' severity' }),
            h('div', { class: 'risk-c' }, x.cause),
            h('div', { class: 'risk-h' }, x.how),
            h('div', { class: 'risk-w' }, pill('Watch: ' + x.watch, ''), tw ? pill(`${tw.text} · ${st}`, statusKind(st)) : null,
              tw && tw.current != null ? h('span', { class: 'small muted' }, `last ${tw.current} ${tw.unit || ''}`) : null));
        }));
      } else {
        out.push(h('div', { class: 'list card' }, (r.risks || []).map((x) => h('div', { class: 'li' }, h('span', { class: 'dot warn' }), h('div', { class: 'li-main' }, x)))));
      }
      out.push(block('Tripwires', h('div', { class: 'list card' }, (r.tripwires || []).map((tw) => {
        const st = tripStatus(tw);
        return h('div', { class: 'li' }, h('div', { class: 'li-main' }, h('div', { class: 'li-title' }, tw.text), h('div', { class: 'li-sub' }, `Last: ${tw.current == null ? 'n/a' : tw.current} ${tw.unit || ''} · ${tw.src}`, tw.auto ? ` · filings show ${tw.auto.auto_value} (${tw.auto.basis})` : '')), pill(st, statusKind(st)));
      }))));
      out.push(block('Coming up', h('div', { class: 'list card' }, (r.catalysts || []).map((c) => h('div', { class: 'li' }, dateChip(c.date), h('div', { class: 'li-main' }, h('div', { class: 'li-title' }, c.label), h('div', { class: 'li-sub' }, c.note || '')), c.confirmed ? null : pill('Unconfirmed', ''))))));
      return h('div', null, out);
    }
    const dateChip = (d) => { const x = new Date(d + 'T00:00:00Z'); return h('div', { class: 'date-chip' }, h('b', null, String(x.getUTCDate())), h('small', null, x.toLocaleDateString('en-GB', { month: 'short', timeZone: 'UTC' }))); };

    /* ----- price ----- */
    const RANGES = [['1D', null], ['1M', 31], ['3M', 92], ['YTD', 'ytd'], ['1Y', 366], ['5Y', 1830], ['Max', 99999]];
    function sliceBars(bars, range) {
      if (!bars || !bars.length) return [];
      const spec = (RANGES.find((r) => r[0] === range) || RANGES[4])[1];
      const last = bars[bars.length - 1][0];
      if (spec === 'ytd') { const y = new Date(last * 1000).getUTCFullYear(); return bars.filter((b) => b[0] >= Date.UTC(y, 0, 1) / 1000); }
      return bars.filter((b) => b[0] >= last - spec * 86400);
    }
    function sma(bars, n) { const out = []; let s = 0; for (let i = 0; i < bars.length; i++) { s += bars[i][4]; if (i >= n) s -= bars[i - n][4]; if (i >= n - 1) out.push([bars[i][0], s / n]); } return out; }
    function relBlock(t) {
      const rp = relPerf(t);
      if (!rp) return null;
      const td = (x) => h('td', null, x == null ? '–' : h('span', { class: fmt.dir(x) }, fmt.spct(x, 1)));
      return block('Performance vs ' + rp.benchName, h('div', { class: 'tbl-wrap' }, h('table', { class: 'tbl' },
        h('thead', null, h('tr', null, h('th', null, ''), rp.rows.map((x) => h('th', null, x.k)))),
        h('tbody', null, h('tr', null, h('th', null, 'Absolute'), rp.rows.map((x) => td(x.abs))), h('tr', null, h('th', null, 'Relative to ' + rp.bench), rp.rows.map((x) => td(x.rel)))))));
    }
    function wPrice(t) {
      const S = us(t), hist = dat(t, 'history'), intra = dat(t, 'intraday');
      const host = h('div', { class: 'chart-host' });
      let pts = [], vol = [], ref = null, xFmt, tipFmt, up = true;
      const series = [];
      if (S.range === '1D') {
        const b = (intra && intra.bars) || [];
        pts = b.map((x) => [x[0], x[4]]); vol = b.map((x) => [x[0], x[5] || 0]); ref = intra && intra.prev_close;
        up = b.length ? b[b.length - 1][4] >= (ref || b[0][1]) : true;
        const hm = (x) => new Date(x * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', timeZone: 'America/New_York' });
        xFmt = hm; tipFmt = hm;
      } else if (hist) {
        const b = sliceBars(hist.bars, S.range);
        pts = b.map((x) => [x[0], x[4]]); vol = b.map((x) => [x[0], x[5] || 0]);
        up = b.length > 1 ? b[b.length - 1][4] >= b[0][4] : true;
        const keep = new Set(b.map((x) => x[0]));
        if (S.sma50) series.push({ name: 'SMA 50', color: css('--c2'), points: sma(hist.bars, 50).filter((p) => keep.has(p[0])), width: 1.1 });
        if (S.sma200) series.push({ name: 'SMA 200', color: css('--c3'), points: sma(hist.bars, 200).filter((p) => keep.has(p[0])), width: 1.1 });
        const long = S.range === '5Y' || S.range === 'Max';
        xFmt = (x) => { const d = new Date(x * 1000); return long ? String(d.getUTCFullYear()) : d.toLocaleDateString('en-GB', { month: 'short', day: S.range === '1M' ? 'numeric' : undefined, timeZone: 'UTC' }); };
        tipFmt = (x) => new Date(x * 1000).toISOString().slice(0, 10);
      }
      if (pts.length > 1) {
        series.unshift({ name: 'Price', color: up ? css('--ok') : css('--bad'), points: pts, area: true, width: 1.7 });
        const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => pts[0][0] + (pts[pts.length - 1][0] - pts[0][0]) * f);
        requestAnimationFrame(() => C.lineChart(host, { series, volume: vol, height: 300, xTicks: ticks, xFmt, tipFmt, refLine: ref, label: `${t} price ${S.range}`, yFmt: (v) => (v >= 1000 ? Math.round(v).toLocaleString('en-US') : v.toFixed(2)) }));
      }
      const st = hist && hist.stats;
      const tr = st && st.technical;
      return h('div', null,
        h('div', { class: 'controls' }, seg(RANGES.map((r) => [r[0], r[0]]), S.range, (x) => { S.range = x; win.refresh(); }, 'Range'),
          h('div', { class: 'row-actions' }, h('label', { class: 'chk small' }, h('input', { type: 'checkbox', class: 'toggle', checked: S.sma50 ? true : null, onchange: () => { S.sma50 = !S.sma50; win.refresh(); } }), '50-day'), h('label', { class: 'chk small' }, h('input', { type: 'checkbox', class: 'toggle', checked: S.sma200 ? true : null, onchange: () => { S.sma200 = !S.sma200; win.refresh(); } }), '200-day'))),
        pts.length > 1 ? host : empty(S.range === '1D' ? 'Intraday bars appear while the US market is open.' : 'Loading price history…'),
        st ? h('div', { class: 'stats boxed' },
          ...[['1 month', st.ret_1m], ['3 months', st.ret_3m], ['Year to date', st.ret_ytd], ['1 year', st.ret_1y], ['3 years', st.ret_3y]].filter((x) => num(x[1]) !== null).map(([k, v]) => stat(k, h('span', { class: fmt.dir(v) }, fmt.spct(v, 1)))),
          stat('RSI (14)', num(st.rsi14) ? st.rsi14.toFixed(0) : '–'), stat('Volatility', num(st.vol60) ? fmt.pct(st.vol60, 0) : '–', '60-day, annualised'), stat('Worst drawdown', num(st.max_dd_1y) ? fmt.pct(st.max_dd_1y, 0) : '–', 'past year')) : null,
        relBlock(t),
        tr && tr.label ? block('Technical read: ' + tr.label, h('div', { class: 'list card' }, (tr.reasons || []).map((x) => h('div', { class: 'li' }, h('span', { class: 'dot' }), h('div', { class: 'li-main small' }, x))))) : null,
        h('div', { class: 'row-actions' }, btn([icon('ext'), 'Open live TradingView chart'], () => kit.openTv(t), '')),
        note('Delayed prices from Yahoo Finance’s public feed, Stooq as backup. For monitoring, not trading.'));
    }

    /* ----- news ----- */
    function wNews(t) {
      const d = dat(t, 'news'), items = (d && d.items) || [];
      if (!items.length) return empty('No headlines yet.');
      return h('div', null, h('div', { class: 'list card' }, items.slice(0, 15).map((n) => {
        const u = kit.safeUrl(n.url);
        return h(u ? 'a' : 'div', { class: 'li', href: u || null, target: u ? '_blank' : null, rel: u ? 'noopener' : null },
          h('div', { class: 'li-main' }, h('div', { class: 'li-title' }, n.title), h('div', { class: 'li-sub' }, [n.source, n.t ? fmt.ago(n.t * 1000) : null].filter(Boolean).join(' · '))), u ? icon('ext') : null);
      })), note('Collected automatically; links go to the publisher. Not curated or rated.'));
    }

    return { page, openWin, load, priceOf, evalFor, researchOf, review, tripStatus, statusKind, stanceKind, peerStats, sliceBars, dat, WINS, finSnapshot, mixView, mappedRows, periodLabel, callOf, estimates, estTable, consensusOf, relPerf, fill, framework, ratingKind, benchOf, rates };
  };
})();
