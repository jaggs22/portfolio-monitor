/* The stock page: price, financial statements, ratios, valuation, management record, thesis and news in one place.
   Built by app.js with a small kit. Data arrives through DataApi (live backend, then static seed). */
(function () {
  'use strict';
  const F = window.Fin, C = window.Charts, D = window.DataApi;

  window.makeStockUI = function (kit) {
    const { h, state, pushSheet, refreshSheet, safeUrl, nameOf } = kit;
    const TABS = [['overview', 'Overview'], ['chart', 'Chart'], ['financials', 'Financials'], ['ratios', 'Ratios'], ['valuation', 'Valuation'], ['management', 'Management'], ['thesis', 'Thesis'], ['news', 'News']];
    const cache = {}; // ticker -> { history, intraday, fundamentals, evidence, mgmt, news, loading }
    const view = {};  // ticker -> { tab, range, sma, stmt, freq, line }
    let quotes = null;

    const vs = (t) => (view[t] = view[t] || { tab: 'overview', range: '1Y', sma50: true, sma200: false, stmt: 'income', freq: 'annual', line: null, ratioFreq: 'annual' });
    const cs = (t) => (cache[t] = cache[t] || {});

    /* ---------- data ---------- */
    let pending = false;
    const rerender = () => { if (pending) return; pending = true; requestAnimationFrame(() => { pending = false; refreshSheet(); }); };

    function load(t) {
      const c = cs(t);
      if (c.loading) return;
      c.loading = true;
      const kinds = ['history', 'fundamentals', 'evidence', 'mgmt', 'news'];
      kinds.forEach((k) => D.get(k, t).then((r) => { c[k] = r; rerender(); }));
      D.get('intraday', t).then((r) => { c.intraday = r; rerender(); });
      if (!quotes) D.get('quotes').then((r) => { quotes = r; rerender(); });
      D.subscribe([t], () => { const old = document.querySelector('.sk-head[data-t="' + t + '"]'); if (old) old.replaceWith(header(t)); });
    }

    function priceOf(t) {
      const lq = D.live.quotes[t];
      if (lq && lq.price) return { price: lq.price, pct: lq.change_pct != null ? lq.change_pct / 100 : null, prev: lq.prev_close, asof: lq.time ? lq.time * 1000 : null, src: 'live', hi: lq.day_high, lo: lq.day_low, vol: lq.volume };
      const q = quotes && quotes.data && quotes.data.quotes && quotes.data.quotes[t];
      if (q && q.price) return { price: q.price, pct: q.pct != null ? q.pct / 100 : null, prev: q.prev_close, asof: q.asof ? q.asof * 1000 : null, src: 'pipeline', hi: q.day_high, lo: q.day_low, vol: q.volume, state: q.state, hi52: q.hi52, lo52: q.lo52 };
      const m = state.data.market.stocks[t];
      if (m) return { price: m.price, pct: m.chg != null ? m.chg / 100 : null, prev: null, asof: Date.parse(state.data.market.as_of), src: 'snapshot' };
      return null;
    }

    /* ---------- small bits ---------- */
    const num = F.num;
    const pctSpan = (x, d) => h('span', { class: 'num chg ' + (num(x) === null ? '' : x > 0 ? 'up' : x < 0 ? 'down' : '') }, F.spct(x, d == null ? 2 : d));
    const px = (x) => (num(x) === null ? '–' : x >= 1000 ? x.toLocaleString('en-US', { maximumFractionDigits: 2 }) : x.toFixed(2));
    const when = (ms) => {
      if (!ms) return '';
      const mins = Math.round((Date.now() - ms) / 60000);
      if (mins < 2) return 'just now';
      if (mins < 90) return mins + ' min ago';
      if (mins < 2880) return Math.round(mins / 60) + ' h ago';
      return new Date(ms).toISOString().slice(0, 10);
    };
    const note = (text) => h('p', { class: 'small muted' }, text);
    const empty = (text) => h('p', { class: 'empty' }, text);
    const sourceBadge = (r) => (r && r.source ? h('span', { class: 'src-badge ' + r.source, title: r.source === 'live' ? 'From the live backend' : 'From the file shipped with the app; the backend did not answer' }, r.source === 'live' ? 'Live backend' : 'Saved copy') : null);
    const dataOf = (t, k) => (cs(t)[k] && cs(t)[k].data) || null;
    const loadingOrEmpty = (t, k, msg) => (cs(t)[k] === undefined ? h('p', { class: 'muted' }, 'Loading…') : empty(msg));
    const fundOf = (t) => dataOf(t, 'fundamentals');
    const NOT_PUBLISHED = 'Not published yet. The data pipeline fills this on its next run (see the deploy guide).';

    function kv(rows) {
      return h('dl', { class: 'kv' }, rows.filter(Boolean).map(([k, v, sub]) => h('div', null, h('dt', null, k), h('dd', null, v, sub ? h('span', { class: 'sub' }, sub) : null))));
    }

    /* ---------- header ---------- */
    function header(t) {
      const u = state.uniMap[t] || {}, p = priceOf(t), h52 = (dataOf(t, 'history') || {}).stats;
      const stateLabel = p && p.src === 'live' ? 'Delayed quote' : p && p.src === 'pipeline' ? 'Updated by pipeline' : 'Snapshot price';
      return h('div', { class: 'sk-head', 'data-t': t },
        h('div', { class: 'sk-id' },
          h('h2', { class: 'card-title' }, h('span', { class: 'tickers' }, t), ' ', nameOf(t)),
          h('p', { class: 'small muted' }, [u.sector, u.tier === 'core' ? 'Core name' : u.tier === 'lighter' ? 'Lighter coverage' : 'Basic view'].filter(Boolean).join(' · '))),
        p ? h('div', { class: 'sk-px' },
          h('span', { class: 'sk-price num' }, '$' + px(p.price)),
          pctSpan(p.pct),
          h('span', { class: 'small muted' }, `${stateLabel}${p.asof ? ', ' + when(p.asof) : ''}`)) : null,
        h52 ? null : null);
    }

    function tabsBar(t) {
      const S = vs(t);
      return h('div', { class: 'stabs', role: 'tablist', 'aria-label': 'Stock sections' }, TABS.map(([id, label]) =>
        h('button', { type: 'button', role: 'tab', class: 'stab', 'aria-selected': String(S.tab === id), 'data-key': 'stab-' + id, onclick: () => { S.tab = id; refreshSheet(); } }, label)));
    }

    /* ---------- chart helpers ---------- */
    const RANGES = [['1D', null], ['1M', 31], ['3M', 92], ['6M', 183], ['YTD', 'ytd'], ['1Y', 366], ['5Y', 1830], ['Max', 99999]];
    const dayStr = (t) => new Date(t * 1000).toISOString().slice(0, 10);

    function sliceBars(bars, range) {
      if (!bars || !bars.length) return [];
      const spec = RANGES.find((r) => r[0] === range)[1];
      const last = bars[bars.length - 1][0];
      if (spec === 'ytd') { const y = new Date(last * 1000).getUTCFullYear(); const start = Date.UTC(y, 0, 1) / 1000; return bars.filter((b) => b[0] >= start); }
      return bars.filter((b) => b[0] >= last - spec * 86400);
    }
    function sma(bars, n) { const out = []; let s = 0; for (let i = 0; i < bars.length; i++) { s += bars[i][4]; if (i >= n) s -= bars[i - n][4]; if (i >= n - 1) out.push([bars[i][0], s / n]); } return out; }
    const xTicksFor = (pts, fmtKey) => {
      if (!pts.length) return [];
      const a = pts[0][0], b = pts[pts.length - 1][0], n = 5;
      return Array.from({ length: n }, (_, i) => a + ((b - a) * i) / (n - 1));
    };

    function priceChart(t, S, tall) {
      const host = h('div', { class: 'chart-host' });
      const hist = dataOf(t, 'history'), intra = dataOf(t, 'intraday');
      let series, volume, ticks, xFmt, tipFmt, refLine = null;
      if (S.range === '1D') {
        const bars = (intra && intra.bars) || [];
        if (!bars.length) return h('div', null, loadingOrEmpty(t, 'intraday', 'No intraday bars yet. They appear while the market is open, from the quotes job.'));
        const up = bars[bars.length - 1][4] >= (intra.prev_close || bars[0][1]);
        series = [{ name: 'Price', color: up ? '#26C281' : '#F0584D', points: bars.map((b) => [b[0], b[4]]), area: true }];
        volume = bars.map((b) => [b[0], b[5] || 0]);
        refLine = intra.prev_close || null;
        const hm = (x) => new Date(x * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', timeZone: 'America/New_York' });
        ticks = xTicksFor(series[0].points); xFmt = hm; tipFmt = hm;
      } else {
        const bars = sliceBars(hist && hist.bars, S.range);
        if (!bars.length) return h('div', null, loadingOrEmpty(t, 'history', NOT_PUBLISHED));
        const up = bars[bars.length - 1][4] >= bars[0][4];
        series = [{ name: 'Close', color: up ? '#26C281' : '#F0584D', points: bars.map((b) => [b[0], b[4]]), area: true, width: 1.7 }];
        const all = hist.bars;
        const keep = new Set(bars.map((b) => b[0]));
        if (S.sma50) series.push({ name: 'SMA 50', color: '#4DA3FF', points: sma(all, 50).filter((p) => keep.has(p[0])), width: 1.2 });
        if (S.sma200) series.push({ name: 'SMA 200', color: '#F5A524', points: sma(all, 200).filter((p) => keep.has(p[0])), width: 1.2 });
        volume = bars.map((b) => [b[0], b[5] || 0]);
        const long = S.range === '5Y' || S.range === 'Max';
        const f = (x) => { const d = new Date(x * 1000); return long ? String(d.getUTCFullYear()) : d.toLocaleDateString('en-US', { month: 'short', day: S.range === '1M' ? 'numeric' : undefined, timeZone: 'UTC' }); };
        ticks = xTicksFor(series[0].points); xFmt = f; tipFmt = (x) => dayStr(x);
      }
      requestAnimationFrame(() => C.lineChart(host, { series, volume, height: tall ? 320 : 240, xTicks: ticks, xFmt, tipFmt, refLine, label: `${t} price, ${S.range}`, yFmt: (v) => (v >= 1000 ? Math.round(v).toLocaleString('en-US') : v.toFixed(2)) }));
      return host;
    }

    function rangeBar(t, S, withSma) {
      return h('div', { class: 'range-bar' },
        h('div', { class: 'seg-group', role: 'group', 'aria-label': 'Range' }, RANGES.map(([r]) =>
          h('button', { type: 'button', class: 'seg', 'aria-pressed': String(S.range === r), 'data-key': 'rng-' + r, onclick: () => { S.range = r; refreshSheet(); } }, r))),
        withSma ? h('div', { class: 'seg-group', role: 'group', 'aria-label': 'Overlays' },
          h('button', { type: 'button', class: 'seg', 'aria-pressed': String(S.sma50), 'data-key': 'sma50', onclick: () => { S.sma50 = !S.sma50; refreshSheet(); } }, 'SMA 50'),
          h('button', { type: 'button', class: 'seg', 'aria-pressed': String(S.sma200), 'data-key': 'sma200', onclick: () => { S.sma200 = !S.sma200; refreshSheet(); } }, 'SMA 200')) : null);
    }

    /* ---------- overview ---------- */
    function rangeBar52(lo, hi, cur) {
      if (!(hi > lo) || !num(cur)) return null;
      const pos = Math.max(0, Math.min(1, (cur - lo) / (hi - lo)));
      return h('div', { class: 'r52' }, h('span', { class: 'num' }, '$' + px(lo)), h('div', { class: 'r52-bar' }, h('i', { style: `left:${(pos * 100).toFixed(1)}%` })), h('span', { class: 'num' }, '$' + px(hi)));
    }

    function targetsBlock(t, p) {
      const prof = (fundOf(t) || {}).profile || {};
      if (!num(prof.target_mean) || !p) return null;
      const lo = prof.target_low, hi = prof.target_high, mean = prof.target_mean, cur = p.price;
      const up = mean / cur - 1;
      return h('section', { class: 'rsec' }, h('h3', null, 'Analyst targets'),
        kv([['Mean target', '$' + px(mean), `${F.spct(up, 1)} vs price`], ['Median', num(prof.target_median) ? '$' + px(prof.target_median) : '–'],
          ['Low to high', num(lo) && num(hi) ? `$${px(lo)} to $${px(hi)}` : '–'], ['Analysts', prof.analyst_count != null ? String(prof.analyst_count) : '–', prof.recommendation ? String(prof.recommendation).replace('_', ' ') : null]]),
        rangeBar52(lo, hi, cur),
        note('Consensus targets are third-party opinions from Yahoo Finance and trail the price. They are context, not the engine’s view.'));
    }

    function technicalBlock(t) {
      const st = (dataOf(t, 'history') || {}).stats;
      if (!st) return null;
      const tr = st.technical || {};
      const rows = [['1 month', st.ret_1m], ['3 months', st.ret_3m], ['6 months', st.ret_6m], ['Year to date', st.ret_ytd], ['1 year', st.ret_1y], ['3 years', st.ret_3y]].filter((r) => num(r[1]) !== null);
      return h('section', { class: 'rsec' }, h('h3', null, 'Price action'),
        h('div', { class: 'ret-grid' }, rows.map(([k, v]) => h('div', null, h('span', { class: 'small muted' }, k), pctSpan(v, 1)))),
        kv([['RSI (14)', num(st.rsi14) ? st.rsi14.toFixed(0) : '–'], ['50-day average', num(st.sma50) ? '$' + px(st.sma50) : '–'], ['200-day average', num(st.sma200) ? '$' + px(st.sma200) : '–'],
          ['Annualised volatility (60d)', num(st.vol60) ? F.pct(st.vol60, 0) : '–'], ['Worst drawdown, 1y', num(st.max_dd_1y) ? F.pct(st.max_dd_1y, 0) : '–'], ['52-week position', num(st.pos52) ? F.pct(st.pos52, 0) + ' of range' : '–']]),
        tr.label ? h('div', null, h('span', { class: 'pill ' + (tr.score >= 0.75 ? 'strong' : tr.score <= -0.75 ? 'weak' : 'moderate') }, 'Technical read: ' + tr.label),
          h('ul', { class: 'list tight' }, (tr.reasons || []).map((r) => h('li', null, r)))) : null);
    }

    function overview(t) {
      const S = vs(t), p = priceOf(t), f = fundOf(t);
      const val = f && p ? F.valuation(f, p.price, f.profile) : null;
      const st = (dataOf(t, 'history') || {}).stats;
      const prof = (f && f.profile) || {};
      const lo = (st && st.lo52) || (p && p.lo52) || (state.data.market.stocks[t] || {}).lo, hi = (st && st.hi52) || (p && p.hi52) || (state.data.market.stocks[t] || {}).hi;
      const m = state.data.market.stocks[t] || {};
      return h('div', null,
        rangeBar(t, S, false), priceChart(t, S, false),
        h('section', { class: 'rsec' }, h('h3', null, 'Key statistics'),
          kv([['Market cap', val && val.mcap ? F.money(val.mcap) : (m.mcap ? '$' + m.mcap + 'B' : '–')], ['Enterprise value', val ? F.money(val.ev) : '–'],
            ['P/E (TTM)', val ? F.mult(val.pe) : '–', val && val.eps_ttm ? `EPS $${val.eps_ttm.toFixed(2)}` : null], ['EV / EBITDA', val ? F.mult(val.ev_ebitda) : '–'],
            ['Price / sales', val ? F.mult(val.ps) : '–'], ['Price / FCF', val ? F.mult(val.p_fcf) : '–'],
            ['FCF yield', val ? F.pct(val.fcf_yield) : '–'], ['Dividend yield', val ? F.pct(val.div_yield) : (m.div && p ? F.pct(m.div / p.price) : '–')],
            ['Beta', num(prof.beta) ? prof.beta.toFixed(2) : (m.beta ? m.beta.toFixed(2) : '–')], ['Employees', prof.employees ? Number(prof.employees).toLocaleString('en-US') : '–']]),
          note(f ? 'Multiples use the live price over trailing-twelve-month figures rebuilt from the company’s filings.' : 'Statement-based multiples appear when the pipeline has published this company’s filings.'),
          lo && hi && p ? h('div', null, h('p', { class: 'small muted' }, '52-week range'), rangeBar52(lo, hi, p.price)) : null),
        technicalBlock(t), targetsBlock(t, p),
        prof.summary ? h('section', { class: 'rsec' }, h('h3', null, 'About'), h('p', { class: 'about' }, prof.summary), prof.website && safeUrl(prof.website) ? h('p', { class: 'small' }, h('a', { href: safeUrl(prof.website), target: '_blank', rel: 'noopener' }, prof.website)) : null) : null,
        h('p', { class: 'small muted' }, 'Prices are delayed and come from Yahoo Finance’s public feed. They are for monitoring, not for trading.'));
    }

    /* ---------- chart tab ---------- */
    function chartTab(t) {
      const S = vs(t), hist = dataOf(t, 'history');
      const bars = S.range === '1D' ? [] : sliceBars(hist && hist.bars, S.range);
      let stats = null;
      if (bars.length > 1) {
        const hi = Math.max.apply(null, bars.map((b) => b[2] != null ? b[2] : b[4])), lo = Math.min.apply(null, bars.map((b) => b[3] != null ? b[3] : b[4]));
        stats = kv([['Return', pctSpan(bars[bars.length - 1][4] / bars[0][4] - 1, 1)], ['High', '$' + px(hi)], ['Low', '$' + px(lo)], ['From high', F.spct(bars[bars.length - 1][4] / hi - 1, 1)], ['Average volume', Math.round(bars.reduce((a, b) => a + (b[5] || 0), 0) / bars.length).toLocaleString('en-US')]]);
      }
      return h('div', null, rangeBar(t, S, true), priceChart(t, S, true), stats, sourceBadge(cs(t).history),
        note('Daily bars from Yahoo Finance, with Stooq as the backup source. The 1D view uses 5-minute bars and refreshes every ten minutes in market hours; the price in the header refreshes about every 30 seconds.'));
    }

    /* ---------- financials ---------- */
    const STMT = {
      income: { label: 'Income statement', rows: [
        ['revenue', 'Revenue'], ['cogs', 'Cost of revenue'], ['gross_profit', 'Gross profit', 'b'], ['rnd', 'Research and development'], ['sga', 'Selling, general and admin'],
        ['op_income', 'Operating income', 'b'], ['interest_expense', 'Interest expense'], ['pretax', 'Pre-tax income'], ['tax', 'Income tax'], ['net_income', 'Net income', 'b'],
        ['ebitda', 'EBITDA', 'b'], ['eps_diluted', 'Diluted EPS', 'eps'], ['shares_diluted', 'Diluted shares (M)', 'sh']],
        derived: [['rev_growth', 'Revenue growth', 'g'], ['gross_margin', 'Gross margin', 'p'], ['op_margin', 'Operating margin', 'p'], ['net_margin', 'Net margin', 'p'], ['ebitda_margin', 'EBITDA margin', 'p'], ['eps_growth', 'EPS growth', 'g']] },
      balance: { label: 'Balance sheet', rows: [
        ['cash', 'Cash and equivalents'], ['st_investments', 'Short-term investments'], ['receivables', 'Receivables'], ['inventory', 'Inventory'], ['current_assets', 'Total current assets', 'b'],
        ['ppe', 'Property, plant and equipment'], ['goodwill', 'Goodwill'], ['intangibles', 'Intangibles'], ['total_assets', 'Total assets', 'b'], ['payables', 'Payables'], ['current_liabilities', 'Total current liabilities', 'b'],
        ['st_debt', 'Short-term debt'], ['lt_debt', 'Long-term debt'], ['total_debt', 'Total debt', 'b'], ['total_liabilities', 'Total liabilities', 'b'], ['equity', 'Shareholders’ equity', 'b'], ['net_debt', 'Net debt', 'b']],
        derived: [['debt_to_equity', 'Debt to equity', 'x'], ['current_ratio', 'Current ratio', 'x']] },
      cashflow: { label: 'Cash flow', rows: [
        ['cfo', 'Operating cash flow', 'b'], ['capex', 'Capital expenditure'], ['fcf', 'Free cash flow', 'b'], ['cfi', 'Investing cash flow'], ['cff', 'Financing cash flow'],
        ['da', 'Depreciation and amortisation'], ['sbc', 'Stock-based compensation'], ['dividends', 'Dividends paid'], ['buybacks', 'Share repurchases']],
        derived: [['fcf_margin', 'FCF margin', 'p'], ['fcf_growth', 'FCF growth', 'g'], ['cash_conversion', 'Cash conversion (CFO / net income)', 'x']] }
    };

    function cell(v, kind) {
      if (!num(v)) return '–';
      if (kind === 'p') return F.pct(v);
      if (kind === 'g') return F.spct(v);
      if (kind === 'x') return v.toFixed(2) + 'x';
      if (kind === 'eps') return v.toFixed(2);
      if (kind === 'sh') return v.toFixed(1);
      const s = Math.abs(v) >= 100 ? Math.round(Math.abs(v)).toLocaleString('en-US') : Math.abs(v).toFixed(1);
      return v < 0 ? '(' + s + ')' : s;
    }

    function financials(t) {
      const S = vs(t), f = fundOf(t);
      if (!f) return h('div', null, loadingOrEmpty(t, 'fundamentals', 'Financial statements are not published for ' + t + ' yet. The daily job rebuilds them from SEC filings, with Yahoo Finance as backup.'));
      const spec = STMT[S.stmt], block = f[S.freq];
      if (!block || !block.period_ends.length) return empty('No ' + S.freq + ' periods in the published statements.');
      const keep = S.freq === 'annual' ? 8 : 10, n = block.period_ends.length, from = Math.max(0, n - keep);
      const ends = block.period_ends.slice(from);
      const D2 = F.derive(f, S.freq);
      const label = (e) => (S.freq === 'annual' ? "FY'" + e.slice(2, 4) : e.slice(2, 7).replace('-', '/'));
      const mkRow = (key, name, kind, isDerived) => {
        const vals = (isDerived ? D2[key] : block.rows[key] || []).slice(from);
        if (!vals.some(num)) return null;
        const flags = (block.derived || {})[key];
        return h('tr', { class: (kind === 'b' ? 'bold ' : '') + (S.line === key ? 'sel' : '') + (isDerived ? ' ital' : '') },
          h('th', { scope: 'row' }, h('button', { type: 'button', class: 'linkish', 'data-key': 'line-' + key, onclick: () => { S.line = key; S.lineDerived = !!isDerived; refreshSheet(); } }, name)),
          vals.map((v, i) => h('td', { class: num(v) && v < 0 && !isDerived ? 'neg' : '' }, cell(v, isDerived ? kind : kind), flags && flags[from + i] ? h('sup', { title: 'Derived: full year minus the first three quarters' }, '†') : null)));
      };
      const rows = spec.rows.map(([k, n_, kd]) => mkRow(k, n_, kd, false)).concat(spec.derived.map(([k, n_, kd]) => mkRow(k, n_, kd, true))).filter(Boolean);
      // chart for the selected line
      let chart = null;
      const lineKey = S.line || spec.rows[0][0];
      const isD = S.line && S.lineDerived;
      const all = (isD ? D2[lineKey] : block.rows[lineKey] || []).slice(from);
      if (all.some(num)) {
        const nm = ([].concat(spec.rows, spec.derived).find((r) => r[0] === lineKey) || [])[1] || lineKey;
        const host = h('div', { class: 'chart-host' });
        const kind = ([].concat(spec.rows, spec.derived).find((r) => r[0] === lineKey) || [])[2];
        const pctLike = isD && (kind === 'p' || kind === 'g');
        const marginOverlay = !isD && (lineKey === 'revenue' || lineKey === 'net_income' || lineKey === 'op_income' || lineKey === 'gross_profit') ? (lineKey === 'revenue' ? D2.rev_growth : lineKey === 'net_income' ? D2.net_margin : lineKey === 'op_income' ? D2.op_margin : D2.gross_margin).slice(from) : null;
        requestAnimationFrame(() => C.barChart(host, {
          labels: ends.map(label), height: 200, label: nm,
          bars: [{ name: nm, color: '#4DA3FF', negColor: '#F0584D', values: all }],
          line: marginOverlay ? { name: lineKey === 'revenue' ? 'Growth' : 'Margin', color: '#F5A524', values: marginOverlay, fmt: (v) => F.pct(v, 0) } : null,
          fmt: pctLike ? (v) => F.pct(v, 1) : (v) => cell(v, kind)
        }));
        chart = h('div', null, h('p', { class: 'small muted' }, `${nm}${marginOverlay ? (lineKey === 'revenue' ? ' with year-on-year growth' : ' with margin') : ''}. Tap any row name to chart it.`), host);
      }
      const anyDerived = Object.keys(block.derived || {}).length;
      return h('div', null,
        h('div', { class: 'range-bar' },
          h('div', { class: 'seg-group', role: 'group', 'aria-label': 'Statement' }, Object.keys(STMT).map((k) =>
            h('button', { type: 'button', class: 'seg', 'aria-pressed': String(S.stmt === k), 'data-key': 'st-' + k, onclick: () => { S.stmt = k; S.line = null; refreshSheet(); } }, STMT[k].label))),
          h('div', { class: 'seg-group', role: 'group', 'aria-label': 'Period' },
            ['annual', 'quarterly'].map((k) => h('button', { type: 'button', class: 'seg', 'aria-pressed': String(S.freq === k), 'data-key': 'fq-' + k, onclick: () => { S.freq = k; S.line = null; refreshSheet(); } }, k === 'annual' ? 'Annual' : 'Quarterly')))),
        chart,
        h('div', { class: 'tbl-wrap fin' }, h('table', { class: 'tbl' },
          h('thead', null, h('tr', null, h('th', { scope: 'col' }, 'USD millions'), ends.map((e) => h('th', { scope: 'col' }, label(e))))),
          h('tbody', null, rows))),
        note(`Source: ${(f.sources || []).join('; ') || 'not stated'}. As of ${(f.asof || '').slice(0, 10)}. USD millions except per-share data.` + (anyDerived ? ' † marks a derived value (fourth quarter = full year minus nine months).' : '') + ' Company-reported GAAP figures; adjusted figures in the thesis cards will differ.'),
        sourceBadge(cs(t).fundamentals));
    }

    /* ---------- ratios ---------- */
    const GROUPS = [
      ['Margins', [['gross_margin', 'Gross margin', 'p'], ['op_margin', 'Operating margin', 'p'], ['ebitda_margin', 'EBITDA margin', 'p'], ['net_margin', 'Net margin', 'p'], ['fcf_margin', 'FCF margin', 'p']]],
      ['Growth, year on year', [['rev_growth', 'Revenue', 'g'], ['op_growth', 'Operating income', 'g'], ['ni_growth', 'Net income', 'g'], ['eps_growth', 'Diluted EPS', 'g'], ['fcf_growth', 'Free cash flow', 'g']]],
      ['Returns', [['roe', 'Return on equity', 'p'], ['roa', 'Return on assets', 'p'], ['roic', 'Return on invested capital', 'p']]],
      ['Leverage and coverage', [['debt_to_equity', 'Debt to equity', 'x'], ['net_debt_ebitda', 'Net debt / EBITDA', 'x'], ['interest_cover', 'Interest cover (EBIT / interest)', 'x']]],
      ['Liquidity', [['current_ratio', 'Current ratio', 'x'], ['quick_ratio', 'Quick ratio', 'x']]],
      ['Efficiency', [['asset_turnover', 'Asset turnover', 'x'], ['dso', 'Days sales outstanding', 'd'], ['dio', 'Days inventory', 'd'], ['dpo', 'Days payables', 'd']]],
      ['Cash and capital returns', [['cash_conversion', 'Cash conversion (CFO / net income)', 'x'], ['fcf_conversion', 'FCF / net income', 'x'], ['payout', 'Dividend payout', 'p'], ['sbc_pct', 'Stock comp / revenue', 'p'], ['capex_pct', 'Capex / revenue', 'p']]]
    ];

    function ratios(t) {
      const S = vs(t), f = fundOf(t);
      if (!f) return h('div', null, loadingOrEmpty(t, 'fundamentals', 'Ratios are computed from the statements, which are not published for ' + t + ' yet.'));
      const D2 = F.derive(f, S.ratioFreq), n = D2.ends.length, keep = S.ratioFreq === 'annual' ? 6 : 8, from = Math.max(0, n - keep);
      const label = (e) => (S.ratioFreq === 'annual' ? "FY'" + e.slice(2, 4) : e.slice(2, 7).replace('-', '/'));
      const fmt = (v, k) => (!num(v) ? '–' : k === 'p' ? F.pct(v) : k === 'g' ? F.spct(v) : k === 'd' ? v.toFixed(0) : v.toFixed(2) + 'x');
      const sections = GROUPS.map(([title, rows]) => {
        const body = rows.map(([key, name, kind]) => {
          const vals = (D2[key] || []).slice(from);
          if (!vals.some(num)) return null;
          const sp = h('span', { class: 'sp' });
          sp.append(C.spark(vals, '#4DA3FF', 56, 18));
          return h('tr', null, h('th', { scope: 'row' }, name), vals.map((v) => h('td', null, fmt(v, kind))), h('td', { class: 'spark-cell' }, sp));
        }).filter(Boolean);
        if (!body.length) return null;
        return h('section', { class: 'rsec' }, h('h3', null, title), h('div', { class: 'tbl-wrap fin' }, h('table', { class: 'tbl' },
          h('thead', null, h('tr', null, h('th', { scope: 'col' }, ''), D2.ends.slice(from).map((e) => h('th', { scope: 'col' }, label(e))), h('th', { scope: 'col' }, 'Trend'))), h('tbody', null, body))));
      }).filter(Boolean);
      const dp = D2.dupont[n - 1] || {};
      const dupont = num(dp.roe) ? h('section', { class: 'rsec' }, h('h3', null, 'DuPont: where return on equity comes from'),
        h('div', { class: 'dupont' }, h('div', null, h('span', { class: 'small muted' }, 'Net margin'), h('strong', null, F.pct(dp.net_margin))), h('span', null, '×'),
          h('div', null, h('span', { class: 'small muted' }, 'Asset turnover'), h('strong', null, F.mult(dp.asset_turnover, 2))), h('span', null, '×'),
          h('div', null, h('span', { class: 'small muted' }, 'Equity multiplier'), h('strong', null, F.mult(dp.equity_multiplier, 2))), h('span', null, '='),
          h('div', null, h('span', { class: 'small muted' }, 'Return on equity'), h('strong', null, F.pct(dp.roe)))),
        note('Return on equity rises with profitability, with how hard assets work, or with leverage. A high figure built on leverage carries more risk than one built on margin.')) : null;
      return h('div', null,
        h('div', { class: 'range-bar' }, h('div', { class: 'seg-group', role: 'group', 'aria-label': 'Period' },
          ['annual', 'quarterly'].map((k) => h('button', { type: 'button', class: 'seg', 'aria-pressed': String(S.ratioFreq === k), 'data-key': 'rf-' + k, onclick: () => { S.ratioFreq = k; refreshSheet(); } }, k === 'annual' ? 'Annual' : 'Quarterly')))),
        sections, dupont,
        note('Quarterly returns use trailing four-quarter flows over average balances. Ratios are computed from company-reported GAAP statements.'));
    }

    /* ---------- valuation ---------- */
    function valuation(t) {
      const f = fundOf(t), p = priceOf(t), hist = dataOf(t, 'history');
      if (!f || !p) return h('div', null, loadingOrEmpty(t, 'fundamentals', 'Valuation needs the published statements and a price.'));
      const v = F.valuation(f, p.price, f.profile);
      const vh = hist ? F.valuationHistory(f, hist.bars) : [];
      const rows = [['pe', 'P/E (TTM)', v.pe], ['ev_ebitda', 'EV / EBITDA', v.ev_ebitda], ['ps', 'Price / sales', v.ps], ['p_fcf', 'Price / FCF', v.p_fcf]];
      const body = rows.map(([k, name, cur]) => {
        const pc = F.percentile(vh, k, cur);
        return h('tr', null, h('th', { scope: 'row' }, name), h('td', null, F.mult(cur)), h('td', null, pc ? F.mult(pc.median) : '–'), h('td', null, pc ? `${F.mult(pc.low)} to ${F.mult(pc.high)}` : '–'),
          h('td', null, pc ? h('span', { class: 'pctbar', title: `Cheaper than ${Math.round((1 - pc.pct) * 100)}% of the quarter-ends in the window` }, h('i', { style: `width:${Math.round(pc.pct * 100)}%` }), h('b', null, Math.round(pc.pct * 100) + '%')) : '–'));
      });
      const host = h('div', { class: 'chart-host' });
      const pe = vh.filter((x) => num(x.pe) && x.pe < 200).map((x) => [Date.parse(x.end) / 1000, x.pe]);
      if (pe.length > 3) requestAnimationFrame(() => C.lineChart(host, { series: [{ name: 'P/E', color: '#4DA3FF', points: pe, width: 1.8 }], height: 200, xTicks: xTicksFor(pe), xFmt: (x) => String(new Date(x * 1000).getUTCFullYear()), tipFmt: (x) => dayStr(x), yFmt: (x) => x.toFixed(1) + 'x', label: 'P/E at each quarter end', refLine: (F.percentile(vh, 'pe', v.pe) || {}).median }));
      const ev = dataOf(t, 'evidence');
      const model = ev && ev.models && ev.models.exit_pe && ev.models.exit_pe.own_median ? ev.models.exit_pe : null;
      return h('div', null,
        h('section', { class: 'rsec' }, h('h3', null, 'Today’s multiples'),
          kv([['Market cap', F.money(v.mcap)], ['Enterprise value', F.money(v.ev)], ['P/E (TTM)', F.mult(v.pe)], ['EV / EBITDA', F.mult(v.ev_ebitda)], ['EV / sales', F.mult(v.ev_sales)], ['Price / sales', F.mult(v.ps)],
            ['Price / free cash flow', F.mult(v.p_fcf)], ['Price / book', F.mult(v.pb)], ['FCF yield', F.pct(v.fcf_yield)], ['Earnings yield', F.pct(v.earnings_yield)], ['Dividend yield', F.pct(v.div_yield)]])),
        h('section', { class: 'rsec' }, h('h3', null, 'Against its own history'),
          vh.length >= 6 ? h('div', { class: 'tbl-wrap' }, h('table', { class: 'tbl' }, h('thead', null, h('tr', null, ['', 'Now', 'Median', 'Range', 'Cheapness'].map((x) => h('th', { scope: 'col' }, x)))), h('tbody', null, body))) : empty('Needs at least six quarters of statements and price history. ' + NOT_PUBLISHED),
          pe.length > 3 ? host : null,
          note('Multiples at each quarter end use the close on or before that date over trailing-four-quarter GAAP figures. A low percentile means the stock is cheaper than it usually has been on that measure; it says nothing about why.')),
        model ? h('section', { class: 'rsec' }, h('h3', null, 'What the research assumes'),
          h('p', null, `The engine’s base exit multiple is ${model.engine}x. Half-reversion to this company’s own median P/E would give about ${model.value}x. ${model.verdict ? 'The engine is ' + model.verdict + '.' : ''}`)) : null,
        targetsBlock(t, p));
    }

    /* ---------- management ---------- */
    function gauge(score) {
      return h('div', { class: 'gauge', role: 'img', 'aria-label': `Score ${score} of 100` }, h('i', { style: `width:${Math.max(2, Math.min(100, score))}%` }));
    }
    function management(t) {
      const m = dataOf(t, 'mgmt');
      if (!m) return h('div', null, loadingOrEmpty(t, 'mgmt', 'The management record is not published for ' + t + ' yet. ' + NOT_PUBLISHED));
      const c = m.composite || {};
      const out = [h('section', { class: 'rsec' }, h('h3', null, 'Management record'),
        h('div', { class: 'mq-head' }, h('div', { class: 'mq-score num' }, c.score != null ? Math.round(c.score) : '–', h('span', null, ' / 100')), h('div', null, h('strong', null, c.grade || ''), h('p', { class: 'small muted' }, `Evidence coverage ${Math.round((c.coverage || 0) * 100)}% of the model`))),
        c.score != null ? gauge(c.score) : null,
        note(m.note || ''))];
      out.push(h('section', { class: 'rsec' }, h('h3', null, 'What the score is made of'),
        h('ul', { class: 'mq-list' }, (m.components || []).map((x) => h('li', null,
          h('div', { class: 'mq-row' }, h('span', null, x.label), h('span', { class: 'num' }, x.score != null ? Math.round(x.score) : 'not retrieved')),
          x.score != null ? gauge(x.score) : h('div', { class: 'gauge off' }),
          h('p', { class: 'small muted' }, x.note || 'Not enough data to score this component. Its weight is dropped, not guessed.'))))));
      const sp = m.surprises;
      if (sp && sp.rows && sp.rows.length) {
        const host = h('div', { class: 'chart-host' });
        requestAnimationFrame(() => C.barChart(host, { labels: sp.rows.map((r) => r.date.slice(2, 7).replace('-', '/')), height: 190, label: 'EPS: estimate versus reported',
          bars: [{ name: 'Estimate', color: '#8A97A8', values: sp.rows.map((r) => r.estimate) }, { name: 'Reported', color: '#4DA3FF', values: sp.rows.map((r) => r.actual) }], fmt: (v) => v.toFixed(2) }));
        out.push(h('section', { class: 'rsec' }, h('h3', null, 'Earnings against consensus'),
          kv([['Beats', `${sp.beats} of ${sp.n}`], ['In line', String(sp.inline)], ['Misses', String(sp.misses)], ['Average surprise', F.spct(sp.avg_surprise_pct / 100, 1)], ['Worst miss', F.spct(sp.worst_pct / 100, 1)], ['Quarters without a miss', String(sp.streak_no_miss)]]),
          host, note('Analyst consensus is a moving target that managements help set, so a long beat streak shows skill at managing expectations as much as at running the business. Estimates come from Yahoo Finance.')));
      }
      const g = m.guidance;
      out.push(h('section', { class: 'rsec' }, h('h3', null, 'Guidance record'),
        g && g.n ? h('div', null,
          kv([['Verified guides', String(g.n)], ['At or above the range', `${g.hits} (${Math.round(g.hit_rate * 100)}%)`], ['Beat the top of the range', String(g.beats)], ['Missed', String(g.misses)], ['Cuts as share of revisions', Math.round((g.cut_rate || 0) * 100) + '%']]),
          h('div', { class: 'tbl-wrap' }, h('table', { class: 'tbl' }, h('thead', null, h('tr', null, ['Metric', 'Period', 'Guided', 'Actual', 'Result'].map((x) => h('th', { scope: 'col' }, x)))),
            h('tbody', null, (g.entries || []).slice(-12).reverse().map((e) => h('tr', { title: e.quote_guide }, h('th', { scope: 'row' }, e.metric.replace('_', ' ')), h('td', null, e.period), h('td', null, `${e.guided_low}${e.guided_high !== e.guided_low ? ' to ' + e.guided_high : ''}`), h('td', null, String(e.actual)), h('td', null, h('span', { class: 'pill ' + (e.outcome === 'miss' ? 'weak' : e.outcome === 'beat' ? 'strong' : 'moderate') }, e.outcome))))))),
          note('Each row is built from two quoted sentences in the company’s own earnings releases, checked word for word against the source text. Hover a row to read the guidance sentence.')) :
          empty('Not retrieved. The guidance record is built from earnings-release text. It needs the optional model key in the pipeline settings and several quarters of releases, and it fills as they are parsed' + (m.releases_parsed ? ` (${m.releases_parsed} releases read so far).` : '.'))));
      const cap = m.capital || {};
      const capRows = [['Average ROIC', cap.roic_avg_pct != null ? cap.roic_avg_pct + '%' : null], ['Latest ROIC', cap.roic_latest_pct != null ? cap.roic_latest_pct + '%' : null],
        ['Share count change', cap.share_change_pct_pa != null ? F.spct(cap.share_change_pct_pa / 100, 1) + ' a year' : null], ['Dividends + buybacks / FCF', cap.payout_of_fcf_pct != null ? cap.payout_of_fcf_pct + '%' : null],
        ['Goodwill / assets', cap.goodwill_pct_assets != null ? cap.goodwill_pct_assets + '%' : null, cap.goodwill_drift_pts != null ? `${cap.goodwill_drift_pts >= 0 ? '+' : ''}${cap.goodwill_drift_pts} pts over the window` : null]].filter((r) => r[1]);
      if (capRows.length) out.push(h('section', { class: 'rsec' }, h('h3', null, 'Capital allocation'), kv(capRows)));
      if (m.insiders) out.push(h('section', { class: 'rsec' }, h('h3', null, 'Insiders, last 12 months'), kv([['Open-market buys', String(m.insiders.buy_count)], ['Sales', String(m.insiders.sell_count)], ['Value bought', F.money(m.insiders.bought_value / 1e6)], ['Value sold', F.money(m.insiders.sold_value / 1e6)]]), note('Executives sell for tax and diversification all the time. Open-market buying is the rarer and more informative signal.')));
      if ((m.gaps || []).length) out.push(h('section', { class: 'rsec' }, h('h3', null, 'What is missing'), h('ul', { class: 'list' }, m.gaps.map((x) => h('li', null, x)))));
      out.push(sourceBadge(cs(t).mgmt));
      return h('div', null, out);
    }

    /* ---------- news ---------- */
    function newsTab(t) {
      const d = dataOf(t, 'news');
      const items = (d && d.items) || [];
      if (!items.length) return loadingOrEmpty(t, 'news', 'No headlines published for ' + t + ' yet.');
      return h('div', null, h('ul', { class: 'rows' }, items.slice(0, 15).map((n) => {
        const u = safeUrl(n.url);
        return h('li', { class: 'row row-static news' }, h('span', { class: 'row-main' },
          u ? h('a', { class: 'row-title', href: u, target: '_blank', rel: 'noopener' }, n.title) : h('span', { class: 'row-title' }, n.title),
          h('br'), h('span', { class: 'row-sub' }, [n.source, n.t ? when(n.t * 1000) : null].filter(Boolean).join(' · '))));
      })), note('Headlines link to the publisher. The app does not summarise or rate them.'), sourceBadge(cs(t).news));
    }

    /* ---------- the page ---------- */
    function body(t) {
      const S = vs(t);
      switch (S.tab) {
        case 'chart': return chartTab(t);
        case 'financials': return financials(t);
        case 'ratios': return ratios(t);
        case 'valuation': return valuation(t);
        case 'management': return management(t);
        case 'thesis': return kit.thesis(t);
        case 'news': return newsTab(t);
        default: return overview(t);
      }
    }

    function stockSheet(t) {
      load(t);
      const page = h('div', { class: 'stock' }, header(t), tabsBar(t), h('div', { class: 'stock-body' }, body(t)));
      // statement and ratio tables open at the latest period; the first column stays pinned
      requestAnimationFrame(() => document.querySelectorAll('.tbl-wrap.fin').forEach((w) => { w.scrollLeft = w.scrollWidth; }));
      return page;
    }

    function open(t, tab) {
      if (tab) vs(t).tab = tab;
      pushSheet(nameOf(t), () => stockSheet(t));
    }

    return { open, stockSheet, priceOf, cache, view };
  };
})();
