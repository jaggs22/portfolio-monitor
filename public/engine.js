/* Scenario engine. Pure functions, no DOM, no network. Works in Node and the browser.
   Everything is deterministic and every judgment input is exposed so the user can dispute it. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Engine = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const DRIVERS = ['rev_cagr', 'margin_end', 'share_chg', 'exit_pe'];
  const DRIVER_META = {
    rev_cagr: { label: 'Revenue growth', unit: '% a year', step: 0.5, cls: 'growth' },
    margin_end: { label: 'Net margin in year 3', unit: '%', step: 0.5, cls: 'margin' },
    share_chg: { label: 'Share count change', unit: '% a year', step: 0.25, cls: 'capital' },
    exit_pe: { label: 'Exit P/E multiple', unit: 'x', step: 0.5, cls: 'multiple' }
  };
  const STANCES = ['Underweight', 'Lean negative', 'Neutral', 'Lean positive', 'Overweight'];

  const round = (x, d) => { const k = Math.pow(10, d == null ? 2 : d); return Math.round(x * k) / k; };

  /* CAPM hurdle with a Blume-adjusted beta (raw beta pulled a third of the way to 1). */
  function adjBeta(beta) { return 0.67 * beta + 0.33; }
  function hurdle(beta, rates) { return (rates.rf + adjBeta(beta) * rates.erp) / 100; }

  function driverValue(research, key, scen, overrides) {
    const d = research.drivers[key];
    let v = d[scen];
    if (overrides && overrides[key] !== undefined && overrides[key] !== null) v += overrides[key] - d.base;
    return v;
  }

  /* One scenario: revenue, margin, share count and multiple give an exit price and a return. */
  function runScenario(research, price, scen, overrides) {
    const b = research.base, N = research.horizon || 3;
    const g = driverValue(research, 'rev_cagr', scen, overrides) / 100;
    const m = driverValue(research, 'margin_end', scen, overrides) / 100;
    const s = driverValue(research, 'share_chg', scen, overrides) / 100;
    const pe = driverValue(research, 'exit_pe', scen, overrides);
    const rev = b.rev0 * Math.pow(1 + g, N);
    const shares = b.shares0 * Math.pow(1 + s, N);
    const eps = (rev * m) / shares;
    const exitPrice = eps * pe;
    let div = 0, d = b.div || 0;
    for (let i = 1; i <= N; i++) { d *= 1 + Math.max(g, 0) * 0.6; div += d; }
    const total = (exitPrice + div) / price;
    const irr = total > 0 ? Math.pow(total, 1 / N) - 1 : -1;
    return { rev, eps, exitPrice, div, total: total - 1, irr, g, m, s, pe };
  }

  function normProbs(p, tilt) {
    const t = tilt || { growth: 50, risk: 50 };
    const bear = p.bear * (Math.max(t.risk, 1) / 50);
    const bull = p.bull * (Math.max(t.growth, 1) / 50);
    const base = p.base;
    const sum = bear + bull + base;
    return { bear: bear / sum, base: base / sum, bull: bull / sum };
  }

  function stanceOf(edge) {
    if (edge >= 0.04) return 4;
    if (edge >= 0.015) return 3;
    if (edge > -0.015) return 2;
    if (edge > -0.04) return 1;
    return 0;
  }

  function dataQuality(research) {
    const ds = DRIVERS.map((k) => research.drivers[k]);
    const judg = ds.filter((d) => d.kind === 'judgment').length / ds.length;
    const age = Math.max(0, (Date.now() - Date.parse(research.as_of)) / 86400000);
    const stale = Math.min(age / 180, 1);
    return Math.max(0, 1 - 0.35 * judg - 0.3 * stale);
  }

  function evaluate(research, market, rates, opts) {
    opts = opts || {};
    const overrides = opts.overrides || null;
    const price = market.price;
    const hr = hurdle(market.beta, rates);
    const sc = {};
    for (const k of ['bear', 'base', 'bull']) sc[k] = runScenario(research, price, k, overrides);
    const p = normProbs(research.probs, opts.tilt);
    const expectedIrr = p.bear * sc.bear.irr + p.base * sc.base.irr + p.bull * sc.bull.irr;
    const edge = expectedIrr - hr;
    const downside = Math.max(0.0001, -Math.min(sc.bear.total, 0));
    const upside = Math.max(0, sc.bull.total);
    const skew = upside / downside; // capped upside-to-downside ratio
    const idx = stanceOf(edge);
    const conv = Math.min(Math.abs(edge) / 0.06, 1) * 0.6 + dataQuality(research) * 0.4;
    let conviction = conv >= 0.65 ? 'High' : conv >= 0.4 ? 'Medium' : 'Low';
    const nJudg = DRIVERS.filter((k) => research.drivers[k].kind === 'judgment').length;
    const spread = sc.bull.irr - sc.bear.irr;
    if (nJudg >= 3 && conviction === 'High') conviction = 'Medium';
    if (spread > 0.5) conviction = 'Low'; // a wider than 50 point bear-to-bull range is not a confident call
    const eps0 = research.base.eps0;
    return {
      ticker: research.ticker, price, hurdle: hr, scenarios: sc, probs: p,
      expectedIrr, edge, stance: STANCES[idx], stanceIdx: idx, conviction, convScore: conv,
      skew: Math.min(skew, 99), currentPE: price / eps0, earningsYield: eps0 / price,
      divYield: (research.base.div || 0) / price
    };
  }

  /* Revenue growth that would make the base case earn exactly the hurdle: what the price already assumes. */
  function impliedGrowth(research, market, rates, opts) {
    const hr = hurdle(market.beta, rates);
    const f = (g) => runScenario(research, market.price, 'base', Object.assign({}, (opts && opts.overrides) || {}, { rev_cagr: g })).irr - hr;
    let lo = -30, hi = 60;
    if (f(lo) > 0) return lo;
    if (f(hi) < 0) return hi;
    for (let i = 0; i < 60; i++) { const mid = (lo + hi) / 2; if (f(mid) < 0) lo = mid; else hi = mid; }
    return (lo + hi) / 2;
  }

  /* Tornado: change in base-case annual return for a standard flex of each driver. */
  function sensitivity(research, market, rates, opts) {
    const flex = { rev_cagr: 2, margin_end: 2, share_chg: 1, exit_pe: 3 };
    const baseIrr = runScenario(research, market.price, 'base', opts && opts.overrides).irr;
    return DRIVERS.map((k) => {
      const cur = driverValue(research, k, 'base', opts && opts.overrides);
      const up = runScenario(research, market.price, 'base', Object.assign({}, (opts && opts.overrides) || {}, { [k]: cur + flex[k] })).irr;
      const dn = runScenario(research, market.price, 'base', Object.assign({}, (opts && opts.overrides) || {}, { [k]: cur - flex[k] })).irr;
      return { key: k, label: DRIVER_META[k].label, flex: flex[k], unit: DRIVER_META[k].unit, up: up - baseIrr, down: dn - baseIrr };
    }).sort((a, b) => Math.abs(b.up - b.down) - Math.abs(a.up - a.down));
  }

  /* A dispute is {ticker, driver, to, reason, note}. Engine recomputes and describes the change. */
  function overridesFrom(disputes, ticker) {
    const o = {};
    for (const d of disputes || []) if (d.ticker === ticker && DRIVERS.includes(d.driver)) o[d.driver] = d.to;
    return Object.keys(o).length ? o : null;
  }

  function diff(research, market, rates, disputes, opts) {
    const baseline = evaluate(research, market, rates, { tilt: null });
    const overrides = overridesFrom(disputes, research.ticker);
    const yours = evaluate(research, market, rates, { overrides, tilt: opts && opts.tilt });
    const changes = [];
    for (const k of DRIVERS) {
      const a = research.drivers[k].base;
      const b = overrides && overrides[k] !== undefined ? overrides[k] : a;
      if (b !== a) changes.push({ key: k, label: DRIVER_META[k].label, from: a, to: b, unit: DRIVER_META[k].unit });
    }
    const dIrr = yours.scenarios.base.irr - baseline.scenarios.base.irr;
    const dEdge = yours.edge - baseline.edge;
    let context = 'No change from the baseline.';
    if (changes.length || (opts && opts.tilt)) {
      const first = changes[0];
      const flip = yours.stance !== baseline.stance;
      context = (first ? `Your ${first.label.toLowerCase()} of ${first.to}${first.unit.charAt(0) === '%' ? '%' : first.unit === 'x' ? 'x' : ''} (engine: ${first.from}) ` : 'Your weights ') +
        `${dEdge >= 0 ? 'adds' : 'takes away'} ${Math.abs(dEdge * 100).toFixed(1)} points of expected annual return over the hurdle, ` +
        (flip ? `which moves the stance from ${baseline.stance} to ${yours.stance}.` : `so the stance stays ${yours.stance}.`);
    }
    const impl = impliedGrowth(research, market, rates, { overrides });
    return { baseline, yours, changes, dBaseIrr: dIrr, dEdge, context, stanceChanged: yours.stance !== baseline.stance, impliedGrowth: impl };
  }

  /* Challenge style: steelman the engine's number, then quantify the user's, then show the tripwires. */
  function challenge(research, market, rates, dispute, disputes) {
    const d = research.drivers[dispute.driver];
    const meta = DRIVER_META[dispute.driver];
    const without = (disputes || []).filter((x) => !(x.ticker === dispute.ticker && x.driver === dispute.driver));
    const withOnly = without.concat([dispute]);
    const a = evaluate(research, market, rates, { overrides: overridesFrom(without, research.ticker) });
    const b = evaluate(research, market, rates, { overrides: overridesFrom(withOnly, research.ticker) });
    const move = dispute.to - d.base;
    const per = (b.scenarios.base.irr - a.scenarios.base.irr) * 100;
    const range = [d.bear, d.bull];
    const outside = dispute.to < Math.min(d.bear, d.bull) || dispute.to > Math.max(d.bear, d.bull);
    const related = (research.tripwires || []).filter((t) => (t.drivers || []).includes(dispute.driver));
    return {
      steelman: d.why,
      source: d.source || null,
      kind: d.kind,
      quantified: `Moving ${meta.label.toLowerCase()} from ${d.base} to ${dispute.to} (${move >= 0 ? '+' : ''}${round(move, 2)}) changes the base-case annual return by ${per >= 0 ? '+' : ''}${per.toFixed(1)} points.`,
      range,
      outside,
      rangeNote: outside ? `This is outside the engine's own bear to bull range (${range[0]} to ${range[1]}), so it needs evidence the range does not already cover.` : `This sits inside the engine's bear to bull range (${range[0]} to ${range[1]}).`,
      tripwires: related,
      before: a, after: b
    };
  }

  /* Philosophy profile learned from disputes: direction and driver class counts, in plain words. */
  function profile(disputes, researchMap) {
    const n = (disputes || []).length;
    if (!n) return { n: 0, lines: [], tilt: { growth: 50, risk: 50 } };
    const tally = { growth: { up: 0, down: 0 }, margin: { up: 0, down: 0 }, capital: { up: 0, down: 0 }, multiple: { up: 0, down: 0 } };
    for (const d of disputes) {
      const r = researchMap && researchMap[d.ticker];
      if (!r || !r.drivers[d.driver]) continue;
      const cls = DRIVER_META[d.driver].cls;
      const dir = d.to > r.drivers[d.driver].base ? 'up' : 'down';
      // share count: lower is better for holders, so "up" in view means a larger cut
      const dd = d.driver === 'share_chg' ? (dir === 'up' ? 'down' : 'up') : dir;
      tally[cls][dd]++;
    }
    const lines = [];
    const word = { growth: 'growth', margin: 'margins', capital: 'buybacks', multiple: 'the exit multiple' };
    for (const k of Object.keys(tally)) {
      const t = tally[k], tot = t.up + t.down;
      if (!tot) continue;
      if (t.up > t.down) lines.push(`More optimistic than the engine on ${word[k]} (${t.up} of ${tot} disputes).`);
      else if (t.down > t.up) lines.push(`More cautious than the engine on ${word[k]} (${t.down} of ${tot} disputes).`);
      else lines.push(`Split on ${word[k]} (${t.up} up, ${t.down} down).`);
    }
    const ups = Object.values(tally).reduce((s, t) => s + t.up, 0);
    const downs = Object.values(tally).reduce((s, t) => s + t.down, 0);
    const bias = ups - downs;
    const tilt = { growth: 50 + Math.max(-25, Math.min(25, bias * 5)), risk: 50 - Math.max(-25, Math.min(25, bias * 5)) };
    return { n, tally, lines, tilt, bias: bias > 0 ? 'optimistic' : bias < 0 ? 'cautious' : 'balanced' };
  }

  /* Lenses: named investors' standing questions, scored on numbers the engine already has. */
  const LENS_CHECKS = {
    earnings_yield_vs_rf: (ev, r, mk, rates) => ({ pass: ev.earningsYield * 100 > rates.rf * 0.6, text: `Earnings yield ${(ev.earningsYield * 100).toFixed(1)}% against a ${rates.rf}% 10-year Treasury.` }),
    margin_of_safety: (ev) => ({ pass: ev.scenarios.bear.total > -0.35 && ev.edge > 0, text: `Bear case ${(ev.scenarios.bear.total * 100).toFixed(0)}% over three years; edge over hurdle ${(ev.edge * 100).toFixed(1)} points.` }),
    skew: (ev) => ({ pass: ev.skew >= 1.5, text: `Upside to downside ratio ${ev.skew.toFixed(1)} to 1.` }),
    moat: (ev, r) => ({ pass: (r.moat && r.moat.rating >= 4), text: r.moat ? `Moat rated ${r.moat.rating} of 5: ${r.moat.summary}` : 'No moat read for this name.' }),
    implied_gap: (ev, r, mk, rates, impl) => ({ pass: impl <= r.drivers.rev_cagr.base, text: `The price implies ${impl.toFixed(1)}% revenue growth; the engine's base case is ${r.drivers.rev_cagr.base}%.` }),
    judgment_share: (ev, r) => { const j = DRIVERS.filter((k) => r.drivers[k].kind === 'judgment').length; return { pass: j <= 2, text: `${j} of 4 drivers are engine judgment rather than sourced.` }; },
    leverage: (ev, r) => (r.quality && r.quality.leverage_note ? { pass: !!r.quality.leverage_ok, text: r.quality.leverage_note } : { pass: null, text: 'Leverage not retrieved for this name.' }),
    incentives: (ev, r) => (r.quality && r.quality.incentive_note ? { pass: !!r.quality.incentive_ok, text: r.quality.incentive_note } : { pass: null, text: 'Incentive structure not reviewed.' }),
    capital_allocation: (ev, r) => ({ pass: r.drivers.share_chg.base < 0, text: `Base case assumes the share count moves ${r.drivers.share_chg.base}% a year.` })
  };

  function lensRead(lens, research, ev, market, rates) {
    const impl = impliedGrowth(research, market, rates, {});
    const rows = lens.checks.map((id) => {
      const fn = LENS_CHECKS[id];
      const out = fn ? fn(ev, research, market, rates, impl) : { pass: null, text: 'Check not available.' };
      return Object.assign({ id }, out);
    });
    const scored = rows.filter((r) => r.pass !== null);
    const passes = scored.filter((r) => r.pass).length;
    return { id: lens.id, name: lens.name, rows, passes, of: scored.length, own: (research.lenses && research.lenses[lens.id]) || null };
  }

  /* Valuation row for names without a research file: only what the market data supports. */
  function lightValuation(mk, rates) {
    const pos = mk.hi > mk.lo ? (mk.price - mk.lo) / (mk.hi - mk.lo) : null;
    return {
      pos, dist: { fromHigh: mk.price / mk.hi - 1, fromLow: mk.price / mk.lo - 1 },
      divYield: mk.div ? mk.div / mk.price : 0,
      hurdle: hurdle(mk.beta, rates), mcap: mk.mcap
    };
  }

  /* Technical read with its reasons, from the 52-week range and the day's move (no price series needed). */
  function technicalRead(mk) {
    const v = lightValuation(mk, { rf: 0, erp: 0 });
    const reasons = [];
    let score = 0;
    if (v.pos !== null) {
      if (v.pos > 0.85) { score += 1; reasons.push(`Trading in the top ${Math.round((1 - v.pos) * 100)}% of its 52-week range, a strong tape.`); }
      else if (v.pos < 0.2) { score -= 1; reasons.push(`Sitting ${Math.round(v.pos * 100)}% of the way up its 52-week range, a weak tape.`); }
      else reasons.push(`Mid-range: ${Math.round(v.pos * 100)}% of the way up its 52-week range.`);
    }
    if (v.dist.fromHigh < -0.25) { score -= 1; reasons.push(`${Math.abs(v.dist.fromHigh * 100).toFixed(0)}% below its 52-week high.`); }
    else if (v.dist.fromHigh > -0.03) reasons.push('Within 3% of its 52-week high.');
    if (typeof mk.chg === 'number' && Math.abs(mk.chg) >= 2) { reasons.push(`Moved ${mk.chg > 0 ? '+' : ''}${mk.chg.toFixed(1)}% on the day, larger than a normal session.`); score += mk.chg > 0 ? 0.5 : -0.5; }
    const label = score >= 1 ? 'Constructive' : score <= -1 ? 'Weak' : 'Neutral';
    return { label, reasons, pos: v.pos };
  }

  /* Diff of two research baselines, used when a filing updates the live baseline. */
  function baselineChange(prev, next) {
    const out = [];
    for (const k of ['rev0', 'eps0', 'shares0', 'div']) {
      if (prev.base[k] !== next.base[k]) out.push({ key: k, from: prev.base[k], to: next.base[k] });
    }
    return out;
  }

  /* Apply a filing to the research baseline. Filings carry growth ratios (new TTM over TTM at the
     period the research was built from) so GAAP movements update the company's adjusted baseline
     without swapping definitions. Drivers are left alone. */
  function rebaseFromFiling(research, filing) {
    const r = JSON.parse(JSON.stringify(research));
    if (filing.eps_ratio) r.base.eps0 = round(r.base.eps0 * filing.eps_ratio, 2);
    if (filing.rev_ratio) r.base.rev0 = round(r.base.rev0 * filing.rev_ratio, 2);
    if (filing.shares_ratio) r.base.shares0 = round(r.base.shares0 * filing.shares_ratio, 4);
    if (filing.eps) r.base.eps0 = filing.eps; // demo fixtures may set absolute values
    if (filing.revenue) r.base.rev0 = filing.revenue;
    if (filing.shares) r.base.shares0 = filing.shares;
    r.live = { period: filing.period, accession: filing.accession, filed: filing.filed || null };
    return r;
  }

  /* Year-by-year base path. Year 0 is the current fiscal year the research is anchored on (eps0, rev0).
     Revenue compounds at the growth driver, net margin moves in a straight line from today's to the year-N margin,
     and the share count changes at the buyback driver. Year N matches runScenario exactly. */
  function path(research, scen, overrides) {
    const b = research.base, N = research.horizon || 3;
    const g = driverValue(research, 'rev_cagr', scen || 'base', overrides) / 100;
    const mEnd = driverValue(research, 'margin_end', scen || 'base', overrides) / 100;
    const s = driverValue(research, 'share_chg', scen || 'base', overrides) / 100;
    const m0 = (b.eps0 * b.shares0) / b.rev0;
    const out = [];
    let d = b.div || 0;
    for (let t = 0; t <= N; t++) {
      const rev = b.rev0 * Math.pow(1 + g, t);
      const m = m0 + (mEnd - m0) * (t / N);
      const shares = b.shares0 * Math.pow(1 + s, t);
      if (t > 0) d *= 1 + Math.max(g, 0) * 0.6;
      out.push({ t, rev, margin: m, shares, eps: t === 0 ? b.eps0 : (rev * m) / shares, dps: d });
    }
    return out;
  }

  const RATINGS = ['Underweight', 'Equal weight', 'Overweight'];
  /* Twelve-month view. The target applies a multiple to next year's EPS, so in a year the stock is valued on the
     same "current fiscal year" basis it is today. The target multiple moves one year's worth (1/N) of the way from
     today's P/E toward the scenario's exit P/E. Total return adds a year of dividends. Rating: Overweight if that
     return beats the cost of equity by 5 points or more, Underweight if it falls 5 points or more short. */
  function target(research, market, rates, opts) {
    opts = opts || {};
    const N = research.horizon || 3, price = market.price;
    const pe0 = price / research.base.eps0;
    const hr = hurdle(market.beta, rates);
    const one = (scen) => {
      const p = path(research, scen, opts.overrides);
      const exit = driverValue(research, 'exit_pe', scen, opts.overrides);
      const tpe = pe0 + (exit - pe0) / N;
      const value = p[1].eps * tpe;
      return { value, pe: tpe, eps1: p[1].eps, ret: value / price - 1 + p[1].dps / price };
    };
    const base = one('base'), bull = one('bull'), bear = one('bear');
    const spread = base.ret - hr;
    const rating = spread >= 0.05 ? RATINGS[2] : spread <= -0.05 ? RATINGS[0] : RATINGS[1];
    return { pt: base.value, upside: base.value / price - 1, totalReturn: base.ret, divYield: path(research, 'base', opts.overrides)[1].dps / price,
      hurdle: hr, spread, rating, pe0, targetPE: base.pe, eps1: base.eps1, bull, bear, base, path: path(research, 'base', opts.overrides) };
  }

  return {
    DRIVERS, DRIVER_META, STANCES, LENS_CHECKS, RATINGS, path, target,
    adjBeta, hurdle, runScenario, evaluate, impliedGrowth, sensitivity, overridesFrom, diff, challenge,
    profile, lensRead, lightValuation, technicalRead, baselineChange, rebaseFromFiling, normProbs, stanceOf, round
  };
});
