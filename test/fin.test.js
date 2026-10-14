const assert = require('assert');
const F = require('../public/fin.js');

const n = 12;
const ends = Array.from({ length: n }, (_, i) => { const y = 2024 + Math.floor((i + 2) / 4), m = ((i + 2) % 4) * 3 + 3; return `${y}-${String(m).padStart(2, '0')}-28`; });
const rev = Array.from({ length: n }, (_, i) => 100 * Math.pow(1.03, i));
const mk = (f) => rev.map(f);
const st = {
  quarterly: { period_ends: ends, rows: {
    revenue: rev, cogs: mk((r) => r * 0.4), gross_profit: mk((r) => r * 0.6), op_income: mk((r) => r * 0.3), net_income: mk((r) => r * 0.2),
    ebitda: mk((r) => r * 0.35), fcf: mk((r) => r * 0.18), cfo: mk((r) => r * 0.24), capex: mk((r) => r * 0.06), eps_diluted: mk((r) => r * 0.2 / 50),
    shares_diluted: new Array(n).fill(50), equity: mk((r) => r * 3), total_assets: mk((r) => r * 6), total_debt: mk((r) => r * 1.5), cash: mk((r) => r * 0.5),
    st_investments: new Array(n).fill(0), net_debt: mk((r) => r * 1.0), current_assets: mk((r) => r * 1.5), current_liabilities: mk((r) => r * 1), receivables: mk((r) => r * 0.5), inventory: mk((r) => r * 0.4), payables: mk((r) => r * 0.3),
    interest_expense: mk((r) => r * 0.03), dividends: mk((r) => r * 0.04), tax: mk((r) => r * 0.06), pretax: mk((r) => r * 0.26) } },
  annual: { period_ends: ['2024-12-31', '2025-12-31'], rows: { revenue: [400, 440], net_income: [80, 100], total_assets: [900, 1000], equity: [300, 350], gross_profit: [240, 270], op_income: [120, 140] } },
};
const q = F.derive(st, 'quarterly');
assert.ok(Math.abs(q.gross_margin[5] - 0.6) < 1e-9);
assert.ok(Math.abs(q.rev_growth[8] - (Math.pow(1.03, 4) - 1)) < 1e-9, 'yoy lag 4');
assert.equal(q.rev_growth[2], null);
// ROE for a quarter uses trailing-four-quarter income over average equity
const ttmNi = rev.slice(8, 12).reduce((a, b) => a + b, 0) * 0.2;
const avgEq = (rev[11] * 3 + rev[10] * 3) / 2;
assert.ok(Math.abs(q.roe[11] - ttmNi / avgEq) < 1e-9);
assert.ok(q.roic[11] > 0 && q.roic[11] < 1);
assert.ok(Math.abs(q.current_ratio[5] - 1.5) < 1e-9);
assert.ok(Math.abs(q.net_debt_ebitda[11] - (rev[11] * 1.0) / (rev.slice(8).reduce((a, b) => a + b) * 0.35)) < 1e-9);
const a = F.derive(st, 'annual');
assert.ok(Math.abs(a.rev_growth[1] - 0.1) < 1e-9 && Math.abs(a.net_margin[1] - 100 / 440) < 1e-9);
assert.ok(Math.abs(a.dupont[1].roe - (100 / 440) * (440 / 950) * (950 / 325)) < 1e-9, 'dupont multiplies out to ROE');
assert.ok(Math.abs(F.cagr([100, 110, 121, 133.1], 3) - 0.1) < 1e-9);

st.ttm = { revenue: 1000, ebitda: 300, eps_diluted: 4, fcf: 150, dividends: 40, shares_diluted: 50 };
const v = F.valuation(st, 80, {});
assert.equal(v.pe, 20); assert.equal(v.mcap, 4000);
const last = st.quarterly.rows;
const ev = 4000 + last.total_debt[11] - last.cash[11];
assert.ok(Math.abs(v.ev - ev) < 1e-6 && Math.abs(v.ev_ebitda - ev / 300) < 1e-9);
assert.ok(Math.abs(v.fcf_yield - 150 / 4000) < 1e-12 && Math.abs(v.div_yield - 0.01) < 1e-12);
assert.equal(F.valuation(st, null), null);
st.ttm.eps_diluted = -1; assert.equal(F.valuation(st, 80).pe, null, 'no P/E on negative earnings');

const bars = ends.map((e, i) => [Date.parse(e + 'T00:00:00Z') / 1000, 1, 1, 1, 50 + i * 5, 1]);
const hist = F.valuationHistory(st, bars);
assert.ok(hist.length >= 6 && hist[0].pe > 0);
const p = F.percentile(hist, 'pe', hist[hist.length - 1].pe);
assert.ok(p && p.pct > 0.8 && p.median > 0);
assert.equal(F.money(1500), '$1.5B'); assert.equal(F.money(2.5e6), '$2.50T'); assert.equal(F.money(null), '–');
assert.equal(F.pct(0.1234), '12.3%'); assert.equal(F.spct(-0.05), '-5.0%'); assert.equal(F.mult(12.34), '12.3x');
console.log('fin tests passed');
