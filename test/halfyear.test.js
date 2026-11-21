/* Half-yearly reporters (Rolls-Royce): the "quarterly" block holds halves and meta.periods_per_year is 2.
   Also compiles every browser script so a duplicate declaration cannot ship again. */
const assert = require('assert');
const fs = require('fs');
const vm = require('vm');
const F = require('../public/fin.js');

const ends = ['2024-06-30', '2024-12-31', '2025-06-30', '2025-12-31', '2026-06-30'];
const rev = [100, 110, 120, 130, 140];
const st = {
  meta: { periods_per_year: 2 },
  quarterly: { period_ends: ends, rows: {
    revenue: rev, op_income: rev.map((r) => r * 0.2), net_income: rev.map((r) => r * 0.1), eps_diluted: rev.map((r) => r * 0.001),
    equity: [null, 50, 55, 60, 65], total_assets: [null, 400, 410, 420, 430], cash: [null, 30, 31, 32, 33], current_liabilities: [null, 100, 100, 100, 100],
    receivables: [null, null, 40, 41, 42], interest_expense: [5, 5, 5, 5, 5], shares_diluted: [10, 10, 10, 10, 10] } },
  annual: { period_ends: [], rows: {} },
};
assert.strictEqual(F.ppyOf(st), 2);
assert.strictEqual(F.ppyOf({ meta: {} }), 4);
const q = F.derive(st, 'quarterly');
assert.ok(Math.abs(q.rev_growth[2] - (120 / 100 - 1)) < 1e-12, 'half-year growth is against the same half a year earlier');
assert.strictEqual(q.rev_growth[1], null);
assert.ok(Math.abs(q.roe[2] - (0.1 * (110 + 120)) / ((50 + 55) / 2)) < 1e-12, 'ROE uses two-half trailing profit');
assert.ok(Math.abs(q.interest_cover[1] - (0.2 * 210) / 10) < 1e-12);
assert.strictEqual(q.quick_ratio[1], null, 'no receivables means no quick ratio, not an understated one');
assert.deepStrictEqual(F.rollingN([1, 2, 3, 4], 2), [null, 3, 5, 7]);
assert.deepStrictEqual(F.rolling4([1, 2, 3, 4, 5]), [null, null, null, 10, 14]);

for (const f of fs.readdirSync('public').filter((x) => x.endsWith('.js'))) {
  new vm.Script(fs.readFileSync('public/' + f, 'utf8'), { filename: f });
}
console.log('half-year and syntax tests passed');
