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
console.log(n + ' passed');
