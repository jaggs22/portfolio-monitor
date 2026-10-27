/* Financial ratios and valuation maths. Pure functions over the normalized statements the pipeline publishes
   (USD millions, per-share in USD, shares in millions). Nothing here touches the DOM. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Fin = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const num = (x) => (typeof x === 'number' && isFinite(x) ? x : null);
  const div = (a, b) => (num(a) !== null && num(b) !== null && b !== 0 ? a / b : null);
  const sub = (a, b) => (num(a) !== null && num(b) !== null ? a - b : null);
  const avg2 = (a, b) => (num(a) !== null && num(b) !== null ? (a + b) / 2 : num(a) !== null ? a : num(b));

  const rowsOf = (st, freq) => (st && st[freq] && st[freq].rows) || {};
  const endsOf = (st, freq) => (st && st[freq] && st[freq].period_ends) || [];
  const col = (rows, k, n) => (rows[k] && rows[k].length === n ? rows[k] : new Array(n).fill(null));

  /* Rolling sum of the last four values, aligned to the latest of the four (null until four exist). */
  function rolling4(xs) {
    return xs.map((_, i) => {
      if (i < 3) return null;
      const w = xs.slice(i - 3, i + 1);
      return w.every((v) => num(v) !== null) ? w[0] + w[1] + w[2] + w[3] : null;
    });
  }

  /* Year-on-year growth: annual vs previous year, quarterly vs the same quarter a year earlier. */
  function yoy(xs, lag) {
    return xs.map((v, i) => (i >= lag && num(v) !== null && num(xs[i - lag]) !== null && xs[i - lag] > 0 ? v / xs[i - lag] - 1 : null));
  }

  /* Everything derivable for one frequency. Flow-based returns use trailing-four-quarter flows for quarterly data
     so a quarter's ROE is annualised properly rather than multiplied by four. */
  function derive(st, freq) {
    const ends = endsOf(st, freq), n = ends.length, R = rowsOf(st, freq);
    const g = (k) => col(R, k, n);
    const q = freq === 'quarterly';
    const flow = (k) => (q ? rolling4(g(k)) : g(k));
    const rev = g('revenue'), cogs = g('cogs'), gp = g('gross_profit'), op = g('op_income'), ni = g('net_income');
    const ebitda = g('ebitda'), fcf = g('fcf'), cfo = g('cfo'), capex = g('capex'), sbc = g('sbc'), da = g('da');
    const out = { ends, freq };
    const ratio = (a, b) => a.map((x, i) => div(x, b[i]));
    out.gross_margin = rev.map((r, i) => div(num(gp[i]) !== null ? gp[i] : sub(r, cogs[i]), r));
    out.op_margin = ratio(op, rev);
    out.net_margin = ratio(ni, rev);
    out.ebitda_margin = ratio(ebitda, rev);
    out.fcf_margin = ratio(fcf, rev);
    out.rnd_pct = ratio(g('rnd'), rev);
    out.sga_pct = ratio(g('sga'), rev);
    out.capex_pct = ratio(capex, rev);
    out.sbc_pct = ratio(sbc, rev);
    out.tax_rate = ratio(g('tax'), g('pretax'));
    const lag = q ? 4 : 1;
    out.rev_growth = yoy(rev, lag);
    out.op_growth = yoy(op, lag);
    out.ni_growth = yoy(ni, lag);
    out.eps_growth = yoy(g('eps_diluted'), lag);
    out.fcf_growth = yoy(fcf, lag);
    out.ebitda_growth = yoy(ebitda, lag);
    out.cash_conversion = ratio(cfo, ni);
    out.fcf_conversion = ratio(fcf, ni);

    const bs = (k) => g(k);
    const eq = bs('equity'), ta = bs('total_assets'), debt = bs('total_debt'), cash = bs('cash'), sti = bs('st_investments');
    const niF = flow('net_income'), opF = flow('op_income'), revF = flow('revenue'), ebF = flow('ebitda');
    const taxRate = out.tax_rate.map((t) => (num(t) !== null && t >= 0 && t <= 0.4 ? t : 0.21));
    const avgBal = (xs) => xs.map((x, i) => (i > 0 ? avg2(x, xs[i - 1]) : x));
    const aEq = avgBal(eq), aTa = avgBal(ta);
    out.roe = ratio(niF, aEq);
    out.roa = ratio(niF, aTa);
    const ic = eq.map((e, i) => (num(e) !== null ? e + (debt[i] || 0) - (cash[i] || 0) - (sti[i] || 0) : null));
    out.roic = opF.map((o, i) => (num(o) !== null && num(ic[i]) !== null && ic[i] > 0 ? o * (1 - taxRate[i]) / avg2(ic[i], i > 0 ? ic[i - 1] : null) : null));
    out.asset_turnover = ratio(revF, aTa);
    out.equity_multiplier = ratio(aTa, aEq);
    out.debt_to_equity = ratio(debt, eq);
    out.net_debt = g('net_debt');
    out.net_debt_ebitda = ratio(out.net_debt, ebF);
    out.interest_cover = ratio(q ? rolling4(g('op_income')) : op, q ? rolling4(g('interest_expense')) : g('interest_expense'));
    out.current_ratio = ratio(bs('current_assets'), bs('current_liabilities'));
    out.quick_ratio = bs('current_liabilities').map((l, i) => div((cash[i] || 0) + (sti[i] || 0) + (bs('receivables')[i] || 0), l));
    const days = q ? 91.3 * 4 : 365;
    const cogsF = q ? rolling4(cogs) : cogs;
    out.dso = bs('receivables').map((x, i) => (div(x, revF[i]) !== null ? div(x, revF[i]) * days : null));
    out.dio = bs('inventory').map((x, i) => (div(x, cogsF[i]) !== null ? div(x, cogsF[i]) * days : null));
    out.dpo = bs('payables').map((x, i) => (div(x, cogsF[i]) !== null ? div(x, cogsF[i]) * days : null));
    out.payout = ratio(g('dividends'), ni);
    out.buyback_pct_fcf = ratio(g('buybacks'), fcf);
    out.dupont = ni.map((_, i) => ({ net_margin: div(niF[i], revF[i]), asset_turnover: out.asset_turnover[i], equity_multiplier: out.equity_multiplier[i], roe: out.roe[i] }));
    return out;
  }

  function cagr(xs, years) {
    const v = xs.filter((x) => num(x) !== null && x > 0);
    if (v.length < years + 1) return null;
    return Math.pow(v[v.length - 1] / v[v.length - 1 - years], 1 / years) - 1;
  }

  const last = (xs) => { for (let i = xs.length - 1; i >= 0; i--) if (num(xs[i]) !== null) return xs[i]; return null; };

  /* Multiples from the live price and trailing-twelve-month flows. Shares are the latest diluted count. */
  function valuation(st, price, profile) {
    if (!st || num(price) === null) return null;
    const R = rowsOf(st, 'quarterly'), n = endsOf(st, 'quarterly').length;
    const t = st.ttm || {};
    const lastBs = (k) => (R[k] ? last(R[k]) : null);
    let shares = t.shares_diluted || lastBs('shares_diluted');
    // guard against a bad share count in the statements: fall back to Yahoo's shares outstanding
    const so = profile && num(profile.shares_outstanding) ? profile.shares_outstanding / 1e6 : null;
    if (!(num(shares) && shares > 0) || (so && Math.abs(shares / so - 1) > 0.3)) shares = so || null;
    let mcap = num(shares) !== null ? price * shares : (profile && profile.market_cap) || null;
    // multi-class issuers (Visa) report a diluted count that differs from the market's: defer to Yahoo's market cap
    const ymc = profile && num(profile.market_cap) ? profile.market_cap / 1e6 : null;
    if (ymc && num(mcap) && Math.abs(mcap / ymc - 1) > 0.1) { mcap = ymc; shares = ymc / price; }
    const debt = lastBs('total_debt'), cash = lastBs('cash'), sti = lastBs('st_investments');
    const ev = num(mcap) !== null && num(debt) !== null ? mcap + debt - (cash || 0) - (sti || 0) : null;
    const eq = lastBs('equity');
    const o = { price, mcap, ev, shares };
    o.pe = num(t.eps_diluted) && t.eps_diluted > 0 ? price / t.eps_diluted : null;
    o.ev_ebitda = div(ev, t.ebitda > 0 ? t.ebitda : null);
    o.ev_sales = div(ev, t.revenue);
    o.ps = div(mcap, t.revenue);
    o.p_fcf = t.fcf > 0 ? div(mcap, t.fcf) : null;
    o.pb = eq > 0 ? div(mcap, eq) : null;
    o.fcf_yield = num(t.fcf) !== null && mcap ? t.fcf / mcap : null;
    o.earnings_yield = o.pe ? 1 / o.pe : null;
    o.div_yield = num(t.dividends) !== null && mcap ? t.dividends / mcap : null;
    o.eps_ttm = t.eps_diluted;
    o.n = n;
    return o;
  }

  /* Multiple at each quarter end: the close on or before the date over trailing-four-quarter flows. */
  function valuationHistory(st, bars) {
    const ends = endsOf(st, 'quarterly'), R = rowsOf(st, 'quarterly'), n = ends.length;
    if (!bars || !bars.length || n < 8) return [];
    const eps = rolling4(col(R, 'eps_diluted', n)), rev = rolling4(col(R, 'revenue', n)), fcf = rolling4(col(R, 'fcf', n)), ebitda = rolling4(col(R, 'ebitda', n));
    const sh = col(R, 'shares_diluted', n), debt = col(R, 'total_debt', n), cash = col(R, 'cash', n), sti = col(R, 'st_investments', n);
    const day = (t) => new Date(t * 1000).toISOString().slice(0, 10);
    const out = [];
    let j = 0;
    for (let i = 3; i < n; i++) {
      while (j + 1 < bars.length && day(bars[j + 1][0]) <= ends[i]) j++;
      if (day(bars[0][0]) > ends[i]) continue;
      const px = bars[j][4];
      const mcap = num(sh[i]) !== null ? px * sh[i] : null;
      const ev = mcap !== null && num(debt[i]) !== null ? mcap + debt[i] - (cash[i] || 0) - (sti[i] || 0) : null;
      out.push({ end: ends[i], price: px,
        pe: eps[i] > 0 ? px / eps[i] : null, ps: div(mcap, rev[i]), p_fcf: fcf[i] > 0 ? div(mcap, fcf[i]) : null,
        ev_ebitda: ebitda[i] > 0 ? div(ev, ebitda[i]) : null });
    }
    return out;
  }

  function percentile(history, key, current) {
    const xs = history.map((h) => h[key]).filter((x) => num(x) !== null && x > 0 && x < 500);
    if (xs.length < 6 || num(current) === null) return null;
    const sorted = xs.slice().sort((a, b) => a - b);
    const med = sorted.length % 2 ? sorted[(sorted.length - 1) / 2] : (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2;
    return { median: med, low: sorted[0], high: sorted[sorted.length - 1], pct: xs.filter((x) => x <= current).length / xs.length, n: xs.length };
  }

  /* ---------- formatting ---------- */
  function money(m, d) {
    if (num(m) === null) return '–';
    const a = Math.abs(m), s = m < 0 ? '-' : '';
    if (a >= 1e6) return s + '$' + (a / 1e6).toFixed(d == null ? 2 : d) + 'T';
    if (a >= 1e3) return s + '$' + (a / 1e3).toFixed(d == null ? 1 : d) + 'B';
    return s + '$' + a.toFixed(a >= 100 ? 0 : 1) + 'M';
  }
  const pct = (x, d) => (num(x) === null ? '–' : (x * 100).toFixed(d == null ? 1 : d) + '%');
  const spct = (x, d) => (num(x) === null ? '–' : (x >= 0 ? '+' : '-') + Math.abs(x * 100).toFixed(d == null ? 1 : d) + '%');
  const mult = (x, d) => (num(x) === null ? '–' : x.toFixed(d == null ? 1 : d) + 'x');
  const dec = (x, d) => (num(x) === null ? '–' : x.toFixed(d == null ? 2 : d));

  return { derive, valuation, valuationHistory, percentile, cagr, rolling4, yoy, last, money, pct, spct, mult, dec, num };
});
