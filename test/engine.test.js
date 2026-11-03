const assert = require('assert');
const fs = require('fs');
const E = require('../public/engine.js');
const mk = JSON.parse(fs.readFileSync(__dirname + '/../public/data/market.json'));
const rs = {};
for (const t of ['V', 'LIN', 'LLY', 'MU', 'PG']) rs[t] = JSON.parse(fs.readFileSync(`${__dirname}/../public/data/research/${t}.json`));
let n = 0; const ok = (name, fn) => { fn(); n++; console.log('ok', name); };

ok('hurdle uses adjusted beta', () => {
  assert.strictEqual(E.adjBeta(1), 1);
  assert.ok(Math.abs(E.hurdle(1, { rf: 5, erp: 5 }) - 0.10) < 1e-9);
});
ok('every research file has valid ordered scenarios', () => {
  for (const t in rs) for (const k of E.DRIVERS) {
    const d = rs[t].drivers[k];
    assert.ok(typeof d.base === 'number' && d.why && d.kind, t + k);
  }
  for (const t in rs) { const p = rs[t].probs; assert.ok(Math.abs(p.bear + p.base + p.bull - 1) < 1e-9); }
});
ok('bear < base < bull annual return for each name', () => {
  for (const t in rs) {
    const e = E.evaluate(rs[t], mk.stocks[t], mk.rates);
    assert.ok(e.scenarios.bear.irr < e.scenarios.base.irr && e.scenarios.base.irr < e.scenarios.bull.irr, t);
  }
});
ok('implied growth reproduces hurdle', () => {
  for (const t in rs) {
    const g = E.impliedGrowth(rs[t], mk.stocks[t], mk.rates);
    const r = E.runScenario(rs[t], mk.stocks[t].price, 'base', { rev_cagr: g }).irr;
    const hr = E.hurdle(mk.stocks[t].beta, mk.rates);
    if (g > -30 && g < 60) assert.ok(Math.abs(r - hr) < 1e-4, t + ' ' + r + ' ' + hr);
  }
});
ok('dispute raising exit multiple raises edge and can move stance', () => {
  const r = rs.LIN, m = mk.stocks.LIN;
  const d = E.diff(r, m, mk.rates, [{ ticker: 'LIN', driver: 'exit_pe', to: 29 }]);
  assert.ok(d.dEdge > 0);
  assert.ok(d.changes.length === 1 && d.changes[0].from === 25);
  assert.ok(/exit p\/e/i.test(d.context.toLowerCase().replace('exit p/e multiple', 'exit p/e')) || d.context.length > 10);
});
ok('no disputes means no change', () => {
  const d = E.diff(rs.V, mk.stocks.V, mk.rates, []);
  assert.strictEqual(d.dEdge, 0); assert.strictEqual(d.stanceChanged, false);
});
ok('sensitivity sorted by swing, signed correctly', () => {
  const s = E.sensitivity(rs.LLY, mk.stocks.LLY, mk.rates);
  assert.strictEqual(s.length, 4);
  for (const x of s) if (x.key !== 'share_chg') assert.ok(x.up > x.down, x.key);
  for (let i = 1; i < s.length; i++) assert.ok(Math.abs(s[i - 1].up - s[i - 1].down) >= Math.abs(s[i].up - s[i].down));
});
ok('challenge quantifies and flags out-of-range', () => {
  const c = E.challenge(rs.V, mk.stocks.V, mk.rates, { ticker: 'V', driver: 'exit_pe', to: 40 }, []);
  assert.ok(c.outside && /points/.test(c.quantified) && c.steelman.length > 20);
});
ok('profile reads disputes as direction', () => {
  const p = E.profile([{ ticker: 'V', driver: 'exit_pe', to: 30 }, { ticker: 'LIN', driver: 'exit_pe', to: 27 }, { ticker: 'LLY', driver: 'rev_cagr', to: 22 }], rs);
  assert.ok(p.lines.length >= 2 && p.bias === 'optimistic' && p.tilt.growth > 50);
});
ok('tilt changes probabilities', () => {
  const a = E.evaluate(rs.V, mk.stocks.V, mk.rates, {});
  const b = E.evaluate(rs.V, mk.stocks.V, mk.rates, { tilt: { growth: 75, risk: 25 } });
  assert.ok(b.expectedIrr > a.expectedIrr);
});
ok('lens read returns rows', () => {
  const L = JSON.parse(fs.readFileSync(__dirname + '/../public/data/lenses.json')).lenses;
  const ev = E.evaluate(rs.V, mk.stocks.V, mk.rates);
  for (const l of L) { const r = E.lensRead(l, rs.V, ev, mk.stocks.V, mk.rates); assert.ok(r.rows.length === l.checks.length); }
});
ok('light valuation and technical read for all 15', () => {
  assert.strictEqual(Object.keys(mk.stocks).length, 15);
  for (const t in mk.stocks) { const v = E.lightValuation(mk.stocks[t], mk.rates); assert.ok(v.pos >= 0 && v.pos <= 1.0001, t + v.pos); const tr = E.technicalRead(mk.stocks[t]); assert.ok(tr.reasons.length, t); }
});
ok('rebase from filing replaces starting point only', () => {
  const r = E.rebaseFromFiling(rs.LIN, { eps: 18.0, period: 'Q3 2026', accession: 'x' });
  assert.strictEqual(r.base.eps0, 18.0); assert.strictEqual(r.drivers.exit_pe.base, 25);
  assert.strictEqual(E.baselineChange(rs.LIN, r).length, 1);
});
ok('path year N equals the scenario model and year 0 equals the anchor', () => {
  for (const t in rs) {
    const p = E.path(rs[t], 'base');
    const sc = E.runScenario(rs[t], mk.stocks[t].price, 'base');
    assert.ok(Math.abs(p[0].eps - rs[t].base.eps0) < 1e-9, t);
    assert.ok(Math.abs(p[p.length - 1].eps - sc.eps) < 1e-6, t + ' ' + p[p.length - 1].eps + ' ' + sc.eps);
  }
});
ok('target: bear < base < bull, rating follows the spread to the hurdle', () => {
  for (const t in rs) {
    const x = E.target(rs[t], mk.stocks[t], mk.rates);
    assert.ok(x.bear.value < x.pt && x.pt < x.bull.value, t);
    const want = x.spread >= 0.05 ? 'Overweight' : x.spread <= -0.05 ? 'Underweight' : 'Equal weight';
    assert.strictEqual(x.capped ? x.capped.from : x.rating, want);
    if (x.capped) assert.strictEqual(x.rating, 'Equal weight');
  }
});
ok('raising the exit multiple raises the target', () => {
  const a = E.target(rs.LIN, mk.stocks.LIN, mk.rates), b = E.target(rs.LIN, mk.stocks.LIN, mk.rates, { overrides: { exit_pe: 30 } });
  assert.ok(b.pt > a.pt);
});
const load = (t) => JSON.parse(fs.readFileSync(`${__dirname}/../public/data/research/${t}.json`));
const mkt = (price, beta) => ({ price, beta });
ok('book method: justified P/TBV = (ROE - g) / (COE - g) on rolled-forward book; better earnings raise the target', () => {
  const r = load('JPM'), m = mkt(340, 1.0), rates = { rf: 5, erp: 4.5 };
  const v = E.valueOf(r, m, rates, 'base', null), hr = E.hurdle(1.0, rates);
  assert.ok(Math.abs(v.multiple - (v.roe - 0.04) / (hr - 0.04)) < 1e-9);
  assert.ok(v.basis > r.valuation.bvps0, 'book grows with retained earnings');
  const up = E.valueOf(r, m, rates, 'base', { margin_end: r.drivers.margin_end.base + 2 });
  assert.ok(up.value > v.value);
  const x = E.target(r, m, rates);
  assert.ok(x.bear.value < x.pt && x.pt < x.bull.value && x.method === 'book');
});
ok('normalised method: mid-cycle EPS averages reported years and the path; 3-year exit uses it too', () => {
  const r = load('MU'), m = mkt(800, 1.5), rates = { rf: 5, erp: 4.5 };
  const mc = E.midCycleEps(r, 'base', null), p = E.path(r, 'base');
  const want = (r.valuation.hist.reduce((a, x) => a + x.eps, 0) + p.reduce((a, x) => a + x.eps, 0)) / (r.valuation.hist.length + p.length);
  assert.ok(Math.abs(mc.eps - want) < 1e-9);
  const v = E.valueOf(r, m, rates, 'base', null);
  assert.ok(Math.abs(v.value - mc.eps * r.drivers.exit_pe.base) < 1e-9);
  const sc = E.runScenario(r, m.price, 'base');
  assert.ok(Math.abs(sc.exitPrice - mc.eps * r.drivers.exit_pe.base) < 1e-9);
});
ok('reverse DCF growth reproduces the price', () => {
  const r = load('PG'), m = mkt(160, 0.5), rates = { rf: 5, erp: 4.5 };
  const d = E.reverseDCF(r, m, rates);
  let s = 0, cf = d.cf0; for (let t = 1; t <= d.years; t++) { cf *= 1 + d.growth; s += cf / Math.pow(1 + d.r, t); }
  s += (cf * (1 + d.gt)) / (d.r - d.gt) / Math.pow(1 + d.r, d.years);
  assert.ok(Math.abs(s - m.price) < 0.01, s);
  assert.ok(E.reverseDCF(r, mkt(1e6, 0.5), rates).capped);
});
ok('variant cap: a non-neutral call needs a stated variant view; user disputes are exempt', () => {
  const r = load('PG'), rates = { rf: 5, erp: 4.5 };
  delete r.variant_view;
  const cheap = E.target(r, mkt(80, 0.5), rates);
  assert.strictEqual(cheap.capped.from, 'Overweight'); assert.strictEqual(cheap.rating, 'Equal weight');
  const mine = E.target(r, mkt(80, 0.5), rates, { overrides: { exit_pe: r.drivers.exit_pe.base } });
  assert.strictEqual(mine.capped, null); assert.strictEqual(mine.rating, 'Overweight');
  r.variant_view = { metric: 'eps', fy: r.base.fy0 + 1, consensus: 5, why: 'test', proof: { event: 'x', date: '2027-01-01' } };
  assert.strictEqual(E.target(r, mkt(80, 0.5), rates).rating, 'Overweight');
  r.variant_view.consensus = E.path(r, 'base')[1].eps * 1.02; // under 5%: not a variant
  assert.strictEqual(E.target(r, mkt(80, 0.5), rates).rating, 'Equal weight');
});
ok('variant aligns fiscal years with consensus', () => {
  const r = load('V'); r.variant_view = { metric: 'eps', fy: r.base.fy0 + 1, why: 'x' };
  const c = { fy0_end: `${r.base.fy0 + 1}-09-30`, eps0: 10, eps1: 11 };
  const v = E.variantOf(r, c);
  assert.strictEqual(v.consensus, 10); assert.ok(v.live);
});
ok('base rates: percentile interpolation and bucket choice', () => {
  const tbl = { pcts: [0, 50, 100], size_buckets: [['small', 0, 10], ['big', 10, null]], margin_buckets: [['all', null, null]],
    revenue_cagr: { '3': { big: { n: 100, p: [-0.1, 0.05, 0.2] } } }, net_margin_change_pts: { '3': { all: { n: 100, p: [-10, 0, 10] } } } };
  const b = E.baseRate(tbl, 'growth', 3, 50, 0.125);
  assert.ok(Math.abs(b.pct - 0.75) < 1e-9 && b.bucket === 'big');
  assert.strictEqual(E.baseRate(tbl, 'growth', 3, 5, 0.1), null); // no small-company row
  assert.strictEqual(E.baseRate(tbl, 'margin', 3, 25, -20).pct, 0);
});
ok('implied part: EV less the anchor segment, divided by the rest', () => {
  const r = load('AMZN'), m = mkt(250, 1.2);
  const ip = E.impliedPart(r, m), c = r.valuation.cross;
  const ev = 250 * r.base.shares0 + c.net_debt;
  assert.ok(Math.abs(ip.rest.multiple - (ev - c.anchor.ebit1 * c.anchor.multiple) / c.rest.ebit1) < 1e-9);
});
console.log(n + ' passed');
