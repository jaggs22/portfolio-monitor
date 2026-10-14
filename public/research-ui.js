/* Research screens: fundamentals card, dispute flow, baseline-vs-your-view diff, profile, tracker reads.
   Built by app.js with a small kit of its helpers. All numbers come from engine.js. */
(function () {
  'use strict';
  const E = window.Engine;

  window.makeResearchUI = function (kit) {
    const { h, state, store, pushSheet, popSheet, refreshSheet, render, toast, safeUrl, nameOf } = kit;

    /* ---------- state kept in this browser only ---------- */
    state.disputes = store.get('disputes', []) || [];
    state.tilt = store.get('tilt', null);
    state.deepen = store.get('deepen', []) || [];
    state.cardMode = {};
    state.evidence = state.evidence || {};
    state.mgmtMini = state.mgmtMini || {};
    state.demoFilings = {};
    const save = () => { store.set('disputes', state.disputes); store.set('tilt', state.tilt); store.set('deepen', state.deepen); };

    /* ---------- data access ---------- */
    const rates = () => state.data.market.rates;
    const mkOf = (t) => {
      const m = state.data.market.stocks[t];
      if (!m) return null;
      const q = state.data.live && state.data.live.quotes && state.data.live.quotes[t];
      return q && q.price ? Object.assign({}, m, { price: q.price, live: q.asof || true }) : m;
    };
    function filingFor(t) {
      const live = state.data.live && state.data.live.filings && state.data.live.filings[t];
      return state.demoFilings[t] || live || null;
    }
    /* The pipeline's evidence file recomputes tripwire readings from reported statements. A reading replaces the
       hand-entered status only when the statement basis matches the tripwire's basis (comparable); otherwise it is
       shown beside the hand figure and changes nothing. */
    function withEvidence(r, t) {
      const ev = state.evidence[t];
      if (!ev || !ev.tripwires || !ev.tripwires.length) return r;
      const by = {}; ev.tripwires.forEach((x) => { by[x.id] = x; });
      return Object.assign({}, r, { tripwires: r.tripwires.map((tw) => {
        const a = by[tw.id];
        if (!a) return tw;
        const o = Object.assign({}, tw, { auto: a });
        if (a.comparable && a.status) { o.status = a.status === 'ok' ? 'holding' : a.status; if (a.note) o.note = a.note; }
        return o;
      }) });
    }
    function researchOf(t) {
      const r0 = state.data.research && state.data.research[t];
      if (!r0) return null;
      const f = filingFor(t);
      if (f && (f.period || '') > (r0.base_period_end || r0.as_of || '')) return withEvidence(E.rebaseFromFiling(r0, f), t);
      return withEvidence(r0, t);
    }
    const rawResearch = (t) => (state.data.research || {})[t] || null;
    const tilt = () => state.tilt || { growth: 50, risk: 50 };
    const evalFor = (t, withMine) => {
      const r = researchOf(t), m = mkOf(t);
      if (!r || !m) return null;
      return E.evaluate(r, m, rates(), withMine ? { overrides: E.overridesFrom(state.disputes, t), tilt: tilt() } : {});
    };

    /* ---------- tiny formatters ---------- */
    const pc = (x, d) => (x * 100).toFixed(d == null ? 1 : d) + '%';
    const spc = (x, d) => (x >= 0 ? '+' : '-') + Math.abs(x * 100).toFixed(d == null ? 1 : d) + '%';
    const usd = (x) => '$' + (x >= 100 ? Math.round(x).toLocaleString('en-US') : x.toFixed(2));
    const pts = (x) => (x >= 0 ? '+' : '-') + Math.abs(x * 100).toFixed(1) + ' pts';
    const stanceClass = (s) => (s === 'Overweight' || s === 'Lean positive' ? 'strong' : s === 'Neutral' ? 'moderate' : 'weak');
    const stancePill = (s) => h('span', { class: 'pill ' + stanceClass(s) }, s);
    const kind = (k) => h('span', { class: 'kind ' + k, title: k === 'sourced' ? 'Taken from a company filing or release' : 'The engine’s own judgment. Open to dispute.' }, k === 'sourced' ? 'Sourced' : 'Judgment');
    const link = (s) => { const u = safeUrl(s.url); return u ? h('a', { href: u, target: '_blank', rel: 'noopener' }, s.title) : s.title; };
    const sec = (title, ...kids) => h('section', { class: 'rsec' }, h('h3', null, title), ...kids);
    function table(head, rows, cls) {
      return h('div', { class: 'tbl-wrap' }, h('table', { class: 'tbl ' + (cls || '') },
        h('thead', null, h('tr', null, head.map((x) => h('th', { scope: 'col' }, x)))),
        h('tbody', null, rows.map((r) => h('tr', null, r.map((c, i) => (i === 0 ? h('th', { scope: 'row' }, c) : h('td', null, c))))))));
    }

    /* ---------- tripwires ---------- */
    function tripStatus(t) {
      if (t.status) return t.status;
      if (t.threshold === null || t.current === null || t.threshold === undefined) return 'watch';
      const d = Math.max(Math.abs(t.threshold), 1e-9);
      const margin = t.op === '<' ? (t.current - t.threshold) / d : (t.threshold - t.current) / d;
      return margin <= 0 ? 'tripped' : margin < 0.15 ? 'watch' : 'holding';
    }


    /* ---------- evidence refresh: review flags, statistical cross-check, management summary ---------- */
    function reviewBanner(t) {
      const ev = state.evidence[t];
      if (!ev) return null;
      const items = (ev.needs_review || []);
      if (!items.length) return h('p', { class: 'small muted auto-ok' }, `Evidence refreshed ${(ev.asof || '').slice(0, 10)}: no review flags. Tripwire readings and model checks recompute from each new filing.`);
      return h('div', { class: 'banner warn review', role: 'status' }, h('strong', null, 'Needs a human look. '),
        'The numbers refresh automatically; the narrative below does not.',
        h('ul', { class: 'list tight' }, items.map((x) => h('li', null, x.text))));
    }

    function modelCheck(t) {
      const ev = state.evidence[t], r = rawResearch(t);
      if (!ev || !ev.models || !r) return null;
      const names = { rev_cagr: 'Revenue growth', margin_end: 'Net margin, year 3', share_chg: 'Share count change', exit_pe: 'Exit P/E' };
      const rows = Object.keys(names).map((k) => {
        const m = ev.models[k];
        if (!m || m.value === undefined) return null;
        const unit = k === 'exit_pe' ? 'x' : '%';
        return [names[k], r.drivers[k].base + unit, m.value + unit, h('span', { class: 'pill ' + (m.flag ? 'watch' : 'holding') }, m.flag ? 'far apart' : 'close'), h('span', { class: 'small muted' }, m.method)];
      }).filter(Boolean);
      if (!rows.length) return null;
      return sec('Statistical cross-check', h('p', { class: 'small muted' }, 'Simple models fitted to the company’s own reported history, run automatically on each data refresh. They sit beside the engine’s numbers; they do not change them.'),
        h('div', { class: 'tbl-wrap' }, h('table', { class: 'tbl' }, h('thead', null, h('tr', null, ['Driver', 'Engine base', 'History implies', 'Gap', 'Method'].map((x) => h('th', { scope: 'col' }, x)))),
          h('tbody', null, rows.map((row) => h('tr', null, row.map((c, i) => (i === 0 ? h('th', { scope: 'row' }, c) : h('td', { class: i === 4 ? 'wrap' : '' }, c)))))))));
    }

    function mgmtMini(t) {
      const m = state.mgmtMini[t];
      if (!m || !m.composite || m.composite.score == null) return null;
      return sec('Management record', h('p', null, h('strong', null, `${Math.round(m.composite.score)} of 100, ${m.composite.grade.toLowerCase()}. `), `Rests on ${Math.round(m.composite.coverage * 100)}% of the model; the rest is reported as not retrieved rather than guessed.`),
        h('button', { class: 'btn small', type: 'button', onclick: () => kit.openStock(t, 'management') }, 'Open the management record'));
    }

    function loadEvidence() {
      const ts = Object.keys(state.data.research || {});
      ts.forEach((t) => {
        window.DataApi.get('evidence', t).then((r) => { if (r.data && r.data.tripwires) { state.evidence[t] = r.data; render(); } });
        window.DataApi.get('mgmt', t).then((r) => { if (r.data && r.data.composite) { state.mgmtMini[t] = r.data; } });
      });
    }

    /* ---------- valuation row (every stock) ---------- */
    function valuationCells(t) {
      const m = mkOf(t); if (!m) return null;
      const r = researchOf(t);
      const v = E.lightValuation(m, rates());
      if (r) {
        const ev = evalFor(t, true);
        return { pe: ev.currentPE.toFixed(1) + 'x', yld: pc(ev.divYield), hurdle: pc(ev.hurdle), pos: v.pos, stance: ev.stance, expected: pc(ev.expectedIrr) };
      }
      return { pe: 'n/a', yld: pc(v.divYield), hurdle: pc(v.hurdle), pos: v.pos, stance: null, expected: null };
    }
    function valuationLine(t) {
      const c = valuationCells(t); if (!c) return null;
      const bits = [];
      bits.push(c.pe !== 'n/a' ? `P/E ${c.pe}` : 'P/E not sourced');
      bits.push(`Yield ${c.yld}`);
      if (c.pos !== null) bits.push(`${Math.round(c.pos * 100)}% of 52-wk range`);
      bits.push(`Hurdle ${c.hurdle}`);
      return bits.join(' · ');
    }
    const depthOf = (t) => { const r = rawResearch(t); return r ? r.depth : 'none'; };
    const depthPill = (t) => { const d = depthOf(t); return d === 'deep' ? h('span', { class: 'pill moderate' }, 'Full research') : d === 'lighter' ? h('span', { class: 'pill contested' }, 'Lighter') : h('span', { class: 'pill pending' }, 'Deepen this name'); };

    /* ---------- the fundamentals card ---------- */
    function fundamentals(t) {
      const r = researchOf(t), m = mkOf(t);
      const out = h('div', { class: 'fund' });
      if (!m) { out.append(h('p', { class: 'muted' }, 'No market data for this name.')); return out; }
      if (!r) { out.append(...unresearched(t, m)); return out; }

      const base = evalFor(t, false), mine = evalFor(t, true);
      const hasMine = E.overridesFrom(state.disputes, t) || state.tilt;
      const shown = hasMine ? mine : base;

      out.append(h('div', { class: 'stance-head' },
        h('div', { class: 'stance-top' }, stancePill(base.stance), h('span', { class: 'muted' }, `Engine conviction: ${base.conviction}`), depthPill(t),
          hasMine ? h('span', { class: 'yours' }, 'Your view: ', stancePill(mine.stance)) : null),
        h('p', { class: 'stance-line' }, r.header.one_liner),
        h('p', { class: 'small muted' }, 'This is the engine’s own position, computed before any dispute. Treat it as something to challenge, not a verdict.'),
        h('div', { class: 'kpis' },
          kpi('Expected return', pc(base.expectedIrr), 'a year, probability-weighted'),
          kpi('Hurdle', pc(base.hurdle), `CAPM: ${rates().rf}% + adj. beta × ${rates().erp}%`),
          kpi('Edge', pts(base.edge), 'over the hurdle'),
          kpi('Price', usd(m.price), base.currentPE.toFixed(1) + 'x EPS'))));

      const f = filingFor(t);
      if (f) out.append(liveBanner(t, f));
      const rv = reviewBanner(t);
      if (rv) out.append(rv);
      out.append(h('p', null, r.header.thesis));

      if (state.disputes.some((d) => d.ticker === t) || state.tilt) out.append(diffPanel(t));

      // pillars
      out.append(sec('Pillars', ...r.pillars.map((p) => h('div', { class: 'pillar' },
        h('div', { class: 'pillar-title' }, p.title), h('p', null, p.claim),
        h('ul', { class: 'evidence' }, p.evidence.map((e) => h('li', null, e.t, ' ', h('span', { class: 'small muted' }, `(${e.src})`)))),
        h('p', { class: 'small' }, h('strong', null, 'Test: '), p.test)))));

      // variant view
      const vv = r.variant;
      out.append(sec('Variant view',
        h('div', { class: 'split' },
          h('div', null, h('h3', null, 'What the market assumes'), h('p', null, vv.street)),
          h('div', null, h('h3', null, 'The engine’s view'), h('p', null, vv.ours))),
        h('p', null, h('strong', null, 'Where this could be wrong: '), vv.could_be_wrong),
        h('p', null, h('strong', null, 'What would change the view: '), vv.would_change_mind),
        h('p', { class: 'small muted' }, `At ${usd(m.price)} the price already implies about ${E.impliedGrowth(r, m, rates(), { overrides: E.overridesFrom(state.disputes, t) }).toFixed(1)}% revenue growth a year to earn the hurdle. The engine’s base case is ${r.drivers.rev_cagr.base}%.`)));

      // drivers (disputable)
      const ov = E.overridesFrom(state.disputes, t) || {};
      out.append(sec('Drivers: tap Dispute to challenge a number',
        h('p', { class: 'small muted' }, `Three-year horizon. “Judgment” means the engine chose the number; “Sourced” means it comes from a filing.`),
        ...E.DRIVERS.map((k) => {
          const d = r.drivers[k], meta = E.DRIVER_META[k];
          const mineV = ov[k];
          return h('div', { class: 'drv' },
            h('div', { class: 'drv-head' }, h('span', { class: 'drv-name' }, meta.label), kind(d.kind),
              h('span', { class: 'drv-val num' }, mineV !== undefined ? h('span', null, h('s', { class: 'muted' }, String(d.base)), ' ', String(mineV)) : String(d.base), ' ', meta.unit)),
            h('div', { class: 'small muted' }, `Bear ${d.bear} · Base ${d.base} · Bull ${d.bull}`),
            h('p', { class: 'small' }, d.why, ' ', h('span', { class: 'muted' }, `(${d.source})`)),
            h('button', { class: 'btn small', type: 'button', onclick: () => pushSheet('Dispute', () => disputeSheet(t, k)) }, mineV !== undefined ? 'Edit my dispute' : 'Dispute'));
        })));

      // scenarios
      const sc = shown.scenarios, pr = shown.probs;
      out.append(sec(hasMine ? 'Scenarios (three years, your view)' : 'Scenarios (three years)', table(['', 'Bear', 'Base', 'Bull'], [
        ['Probability', pc(pr.bear, 0), pc(pr.base, 0), pc(pr.bull, 0)],
        ['Revenue growth', ...['bear', 'base', 'bull'].map((k) => (sc[k].g * 100).toFixed(1) + '%')],
        ['Net margin', ...['bear', 'base', 'bull'].map((k) => (sc[k].m * 100).toFixed(1) + '%')],
        ['EPS in year 3', ...['bear', 'base', 'bull'].map((k) => usd(sc[k].eps))],
        ['Exit P/E', ...['bear', 'base', 'bull'].map((k) => sc[k].pe.toFixed(1) + 'x')],
        ['Implied price', ...['bear', 'base', 'bull'].map((k) => usd(sc[k].exitPrice))],
        ['Annual return', ...['bear', 'base', 'bull'].map((k) => spc(sc[k].irr))]]),
        h('p', { class: 'small muted' }, `Upside to downside ${shown.skew.toFixed(1)} to 1. Returns include dividends, exclude tax and costs.`)));

      // sensitivity
      const sens = E.sensitivity(r, m, rates(), { overrides: E.overridesFrom(state.disputes, t) });
      const maxSwing = Math.max(...sens.map((s) => Math.max(Math.abs(s.up), Math.abs(s.down))), 0.0001);
      out.append(sec(hasMine ? 'Sensitivity of the base-case return (your view)' : 'Sensitivity of the base-case return',
        ...sens.map((s) => h('div', { class: 'tor' },
          h('div', { class: 'tor-l' }, `${s.label} ±${s.flex}${s.unit.startsWith('%') ? ' pts' : s.unit === 'x' ? 'x' : ''}`),
          h('div', { class: 'tor-bar', 'aria-hidden': 'true' },
            h('i', { class: 'neg', style: `width:${Math.min(50, Math.abs(Math.min(s.up, s.down)) / maxSwing * 50)}%` }),
            h('i', { class: 'pos', style: `width:${Math.min(50, Math.abs(Math.max(s.up, s.down)) / maxSwing * 50)}%` })),
          h('div', { class: 'tor-v num' }, `${pts(Math.min(s.up, s.down))} / ${pts(Math.max(s.up, s.down))}`)))));

      // moat + quality
      out.append(sec('Moat and quality',
        h('p', null, h('strong', null, `Moat ${r.moat.rating} of 5. `), r.moat.summary),
        h('p', { class: 'small muted' }, r.moat.detail),
        r.quality.leverage_note ? h('p', null, h('strong', null, 'Leverage: '), r.quality.leverage_note) : h('p', { class: 'small muted' }, 'Leverage not retrieved.'),
        r.quality.incentive_note ? h('p', null, h('strong', null, 'Incentives: '), r.quality.incentive_note) : null,
        ...(r.quality.checks || []).map((c) => h('p', { class: 'small' }, c))));

      const mc = modelCheck(t);
      if (mc) out.append(mc);

      // tripwires
      out.append(sec('Tripwires', h('p', { class: 'small muted' }, 'Conditions that would break the view. Status compares the last reported number with the line.'),
        h('ul', { class: 'rows' }, r.tripwires.map((tw) => {
          const st = tripStatus(tw);
          return h('li', { class: 'row row-static' },
            h('span', { class: 'row-main' }, h('span', { class: 'row-title' }, tw.text), h('br'),
              h('span', { class: 'row-sub' }, `Last: ${tw.current === null ? 'n/a' : tw.current} ${tw.unit || ''} · ${tw.src}${tw.note ? ' · ' + tw.note : ''}`),
              tw.auto ? [h('br'), h('span', { class: 'row-sub auto' }, `Recomputed from filings: ${tw.auto.auto_value} (${tw.auto.basis}, period ending ${tw.auto.period_end})${tw.auto.comparable ? '' : '. Different basis from the line, so reference only'}`)] : null),
            h('span', { class: 'pill ' + st }, st));
        }))));

      // catalysts
      out.append(sec('Catalysts', h('ul', { class: 'rows' }, r.catalysts.map((c) => h('li', { class: 'row row-static' },
        h('span', { class: 'row-main' }, h('span', { class: 'row-title' }, c.label), h('br'), h('span', { class: 'row-sub' }, c.note || '')),
        h('span', { class: 'row-end small ' + (c.confirmed ? '' : 'muted') }, c.confirmed ? c.date : 'Unconfirmed'))))));

      const mm = mgmtMini(t);
      if (mm) out.append(mm);
      if ((r.risks || []).length) out.append(sec('Risks', h('ul', { class: 'list' }, r.risks.map((x) => h('li', null, x)))));

      // lenses
      out.append(lensSection(t, r, shown, m));

      // sources and gaps
      out.append(sec('Sources', h('ul', { class: 'list' }, r.sources.map((s) => h('li', null, h('span', { class: 'tier' }, s.tier), link(s), ` (${s.date})`))),
        h('p', { class: 'small muted' }, 'Tier A is the issuer’s SEC filing, B is bank or consultancy research, C is aggregator data or press.'),
        (r.gaps || []).length ? h('p', { class: 'small' }, h('strong', null, 'Not retrieved: '), r.gaps.join(' ')) : null));

      out.append(h('p', { style: 'margin-top:16px' },
        h('button', { class: 'btn', type: 'button', onclick: () => kit.askAbout(t) }, 'Ask Claude about this')));
      return out;
    }

    const kpi = (l, v, s) => h('div', { class: 'kpi' }, h('div', { class: 'kpi-l' }, l), h('div', { class: 'kpi-v num' }, v), h('div', { class: 'kpi-s' }, s));

    function unresearched(t, m) {
      const v = E.lightValuation(m, rates()), tr = E.technicalRead(m);
      const asked = state.deepen.includes(t);
      return [
        h('div', { class: 'stance-head' },
          h('div', { class: 'stance-top' }, h('span', { class: 'pill pending' }, 'No stance yet'), depthPill(t)),
          h('p', { class: 'stance-line' }, 'The engine has not researched this name, so it states no recommendation rather than guess one.'),
          h('div', { class: 'kpis' },
            kpi('Price', usd(m.price), '52-wk ' + usd(m.lo) + ' to ' + usd(m.hi)),
            kpi('Yield', pc(v.divYield), 'trailing dividend'),
            kpi('Hurdle', pc(v.hurdle), 'CAPM, adjusted beta'),
            kpi('Market cap', '$' + (m.mcap >= 1000 ? (m.mcap / 1000).toFixed(2) + 'T' : Math.round(m.mcap) + 'B'), 'beta ' + m.beta))),
        sec('What the market data does tell us', h('p', null, `Technical read: ${tr.label}.`), h('ul', { class: 'list' }, tr.reasons.map((x) => h('li', null, x))),
          h('p', { class: 'small muted' }, `Earnings per share and revenue for this name are not in the engine, so P/E and the scenarios are not computed.`)),
        sec('Deepen this name', h('p', null, 'Deepening adds a filing-based research file: pillars, variant view, drivers, scenarios, tripwires. It is built name by name from the latest filings.'),
          h('p', { class: 'inline' },
            h('button', { class: 'btn primary', type: 'button', disabled: asked, onclick: () => { state.deepen.push(t); save(); toast('Added to your deepen list.'); refreshSheet(); } }, asked ? 'On your deepen list' : 'Add to deepen list'),
            asked ? h('button', { class: 'btn', type: 'button', onclick: () => { state.deepen = state.deepen.filter((x) => x !== t); save(); refreshSheet(); } }, 'Remove') : null))
      ];
    }

    /* ---------- live baseline ---------- */
    function liveBanner(t, f) {
      const raw = rawResearch(t), now = researchOf(t);
      const ch = E.baselineChange(raw, now);
      const labels = { rev0: 'Revenue ($B)', eps0: 'EPS', shares0: 'Shares (B)', div: 'Dividend' };
      const demo = !!state.demoFilings[t];
      const before = E.evaluate(raw, mkOf(t), rates(), {}), after = E.evaluate(now, mkOf(t), rates(), {});
      return h('div', { class: 'banner info live' },
        h('strong', null, demo ? 'DEMO: replayed filing event. ' : 'Baseline updated from a filing. '),
        `${f.form || 'Filing'} for ${f.label || f.period}${f.filed ? ', filed ' + f.filed : ''}${f.accession ? ' (' + f.accession + ')' : ''}. `,
        demo ? 'Illustrative numbers, not a real filing. ' : '',
        ch.length ? ch.map((c) => `${labels[c.key]}: ${c.from} → ${c.to}`).join('; ') + '. ' : '',
        `Expected return ${pc(before.expectedIrr)} → ${pc(after.expectedIrr)}; stance ${before.stance === after.stance ? 'unchanged (' + after.stance + ')' : before.stance + ' → ' + after.stance}.`);
    }

    /* ---------- lens panel ---------- */
    function lensSection(t, r, ev, m) {
      const lenses = state.data.lenses;
      const box = h('div', null);
      const body = h('div', null);
      let cur = state.lensPick || lenses.lenses[0].id;
      const draw = () => {
        const L1 = lenses.lenses.find((x) => x.id === cur);
        const rd = E.lensRead(L1, r, ev, m, rates());
        body.replaceChildren(
          h('p', { class: 'small muted' }, L1.tagline),
          h('p', null, rd.own || 'No lens note written for this name yet.'),
          h('ul', { class: 'rows' }, rd.rows.map((x) => h('li', { class: 'row row-static' },
            h('span', { class: 'row-main' }, h('span', { class: 'row-sub', style: 'color:var(--ink)' }, x.text)),
            h('span', { class: 'pill ' + (x.pass === null ? 'pending' : x.pass ? 'holding' : 'tripped') }, x.pass === null ? 'n/a' : x.pass ? 'pass' : 'flag')))),
          h('p', { class: 'small muted' }, `${rd.passes} of ${rd.of} checks pass.`));
        chips.forEach((c, i) => c.setAttribute('aria-pressed', String(lenses.lenses[i].id === cur)));
      };
      const chips = lenses.lenses.map((l) => h('button', { class: 'chip', type: 'button', 'aria-pressed': 'false', onclick: () => { cur = l.id; state.lensPick = cur; draw(); } }, l.name));
      box.append(h('div', { class: 'seg-group', role: 'group', 'aria-label': 'Lens' }, chips), body, h('p', { class: 'small muted' }, lenses.note));
      draw();
      return sec('Lenses', box);
    }

    /* ---------- dispute flow: steelman, quantify, tripwires ---------- */
    function disputeSheet(t, driver) {
      const r = researchOf(t), m = mkOf(t), d = r.drivers[driver], meta = E.DRIVER_META[driver];
      const existing = state.disputes.find((x) => x.ticker === t && x.driver === driver);
      const out = h('div', null);
      out.append(h('h2', { class: 'card-title' }, `${nameOf(t)}: ${meta.label}`),
        h('p', { class: 'muted' }, `The engine uses ${d.base} ${meta.unit} (bear ${d.bear}, bull ${d.bull}). ${d.kind === 'sourced' ? 'This number is sourced from a filing.' : 'This number is the engine’s own judgment.'}`));
      const input = h('input', { type: 'number', step: String(meta.step), inputmode: 'decimal', 'aria-label': 'Your value' });
      input.value = existing ? existing.to : d.base;
      const reasons = [['forecast', 'I forecast differently'], ['data', 'The data is wrong'], ['multiple', 'The market will pay a different multiple'], ['risk', 'A risk is missing'], ['other', 'Other']];
      const reason = h('select', { 'aria-label': 'Reason' }, reasons.map(([v, l]) => h('option', { value: v }, l)));
      if (existing) reason.value = existing.reason;
      const note = h('textarea', { placeholder: 'Your reasoning, in a sentence or two', 'aria-label': 'Your reasoning', maxlength: '400' });
      if (existing) note.value = existing.note || '';
      const result = h('div', { 'aria-live': 'polite' });
      out.append(h('label', { class: 'fld' }, `Your value (${meta.unit})`, input), h('label', { class: 'fld' }, 'Why', reason), note,
        h('p', { class: 'inline' },
          h('button', { class: 'btn primary', type: 'button', onclick: () => {
            const to = Number(input.value);
            if (!isFinite(to)) { toast('Enter a number.'); return; }
            if (to === d.base) { toast('That equals the engine’s number.'); return; }
            const disp = { id: t + '-' + driver, ticker: t, driver, to, from: d.base, reason: reason.value, note: note.value.trim(), ts: Date.now() };
            const c = E.challenge(r, m, rates(), disp, state.disputes);
            result.replaceChildren(...[
              h('h3', null, '1. The case for the engine’s number'), h('p', null, c.steelman), h('p', { class: 'small muted' }, `Basis: ${c.kind}. ${c.source || ''}`),
              h('h3', null, '2. What your number does'), h('p', null, c.quantified), h('p', { class: 'small muted' }, c.rangeNote),
              h('p', null, `Expected return moves from ${pc(c.before.expectedIrr)} to ${pc(c.after.expectedIrr)}; stance ${c.before.stance === c.after.stance ? 'stays ' + c.after.stance : c.before.stance + ' → ' + c.after.stance}.`),
              ...(c.tripwires.length ? [h('h3', null, '3. Tripwires that test it'), h('ul', { class: 'list' }, c.tripwires.map((x) => h('li', null, x.text, ' ', h('span', { class: 'pill ' + tripStatus(x) }, tripStatus(x)))))] : []),
              h('p', { class: 'inline' },
                h('button', { class: 'btn primary', type: 'button', onclick: () => {
                  state.disputes = state.disputes.filter((x) => !(x.ticker === t && x.driver === driver)).concat([disp]);
                  save(); popSheet(); toast('Dispute saved. Your view is recomputed.'); render(); refreshSheet();
                } }, 'Keep my view'),
                h('button', { class: 'btn', type: 'button', onclick: () => result.replaceChildren(h('p', { class: 'muted' }, 'Reconsidered. Nothing saved.')) }, 'Reconsider'))]);
          } }, existing ? 'Challenge and update' : 'Challenge it'),
          existing ? h('button', { class: 'btn', type: 'button', onclick: () => { state.disputes = state.disputes.filter((x) => x !== existing); save(); popSheet(); render(); refreshSheet(); } }, 'Withdraw dispute') : null),
        result);
      return out;
    }

    /* ---------- baseline vs your view ---------- */
    function diffPanel(t) {
      const r = researchOf(t), m = mkOf(t);
      const df = E.diff(r, m, rates(), state.disputes, { tilt: state.tilt });
      const a = df.baseline, b = df.yours;
      const row = (l, x, y) => [l, x, y];
      return h('div', { class: 'diff' },
        h('h3', null, 'Baseline vs your view'),
        h('p', null, df.context),
        table(['', 'Engine baseline', 'Your view'], [
          row('Stance', a.stance, b.stance),
          row('Expected return', pc(a.expectedIrr), pc(b.expectedIrr)),
          row('Edge over hurdle', pts(a.edge), pts(b.edge)),
          row('Base-case return', spc(a.scenarios.base.irr), spc(b.scenarios.base.irr)),
          row('Base-case price', usd(a.scenarios.base.exitPrice), usd(b.scenarios.base.exitPrice)),
          row('Growth the price implies', E.impliedGrowth(r, m, rates(), {}).toFixed(1) + '%', df.impliedGrowth.toFixed(1) + '%')], 'diff-tbl'),
        df.changes.length ? h('ul', { class: 'list' }, df.changes.map((c) => h('li', null, `${c.label}: engine ${c.from}, yours ${c.to} ${c.unit}`))) : null,
        h('button', { class: 'btn small', type: 'button', onclick: () => { state.disputes = state.disputes.filter((x) => x.ticker !== t); save(); render(); refreshSheet(); } }, 'Reset to engine baseline'));
    }

    /* ---------- toggle wrapper for the card sheet ---------- */
    function cardWithToggle(t, porterBuilder) {
      const hasCard = !!(state.data.cards && state.data.cards[t]);
      const mode0 = state.cardMode[t] || (rawResearch(t) || !hasCard ? 'fund' : 'porter');
      const body = h('div', null);
      const btns = [];
      const setMode = (m) => {
        state.cardMode[t] = m;
        body.replaceChildren(m === 'fund' ? fundamentals(t) : porterBuilder(t));
        btns.forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.mode === m)));
      };
      const mk = (id, label) => { const b = h('button', { class: 'seg', type: 'button', 'data-mode': id, 'aria-pressed': 'false', onclick: () => setMode(id) }, label); btns.push(b); return b; };
      const head = h('div', null,
        h('div', { class: 'card-top' }, h('h2', { class: 'card-title' }, nameOf(t)), depthPill(t)),
        h('p', { class: 'small muted' }, valuationLine(t) || ''),
        h('div', { class: 'seg-group', role: 'group', 'aria-label': 'View' }, mk('porter', 'Industry structure'), mk('fund', 'Fundamentals')));
      setMode(mode0);
      return h('div', null, head, body);
    }

    /* ---------- the Your view tab ---------- */
    function yourView() {
      const out = [];
      const prof = E.profile(state.disputes, state.data.research);
      out.push(h('section', null, h('h2', null, 'Your view'),
        h('p', { class: 'muted' }, 'Every dispute you make teaches the engine how you think. It stays on this device until you export it.')));

      const ps = h('section', null, h('h3', null, 'Your philosophy so far'));
      if (!prof.n) ps.append(h('p', { class: 'empty' }, 'No disputes yet. Open a Fundamentals card and dispute a driver to start your profile.'));
      else ps.append(h('p', null, `Across ${prof.n} dispute${prof.n === 1 ? '' : 's'} you lean ${prof.bias}.`), h('ul', { class: 'list' }, prof.lines.map((l) => h('li', null, l))));
      out.push(ps);

      const wg = h('input', { type: 'range', min: '10', max: '90', step: '5', 'aria-label': 'Growth weight' });
      const wr = h('input', { type: 'range', min: '10', max: '90', step: '5', 'aria-label': 'Downside weight' });
      const t0 = tilt(); wg.value = t0.growth; wr.value = t0.risk;
      const lab = h('p', { class: 'small muted' });
      const upd = () => { lab.textContent = `Growth weight ${wg.value}, downside weight ${wr.value}. At 50 and 50 the engine’s own probabilities are used.`; };
      upd();
      wg.addEventListener('input', upd); wr.addEventListener('input', upd);
      out.push(h('section', null, h('h3', null, 'Weights'),
        h('p', { class: 'muted' }, 'How much weight your view gives the bull case versus the bear case. It changes the probabilities of the three scenarios on every research card.'),
        h('label', { class: 'fld' }, 'Weight on growth', wg), h('label', { class: 'fld' }, 'Weight on downside', wr), lab,
        h('p', { class: 'inline' },
          h('button', { class: 'btn primary', type: 'button', onclick: () => { state.tilt = { growth: Number(wg.value), risk: Number(wr.value) }; save(); render(); toast('Weights saved.'); } }, 'Save weights'),
          prof.n ? h('button', { class: 'btn', type: 'button', onclick: () => { wg.value = prof.tilt.growth; wr.value = prof.tilt.risk; upd(); } }, 'Use my profile’s suggestion') : null,
          h('button', { class: 'btn', type: 'button', onclick: () => { state.tilt = null; save(); render(); toast('Weights reset.'); } }, 'Reset'))));

      const dl = h('section', null, h('h3', null, 'Your disputes'));
      if (!state.disputes.length) dl.append(h('p', { class: 'empty' }, 'None yet.'));
      else dl.append(h('ul', { class: 'rows' }, state.disputes.map((d) => h('li', { class: 'row' },
        h('button', { class: 'row-btn', type: 'button', onclick: () => pushSheet(nameOf(d.ticker), () => { state.cardMode[d.ticker] = 'fund'; return cardWithToggle(d.ticker, kit.porterSheet); }) },
          h('span', { class: 'row-main' }, h('span', { class: 'row-title' }, h('span', { class: 'tickers' }, d.ticker), ' ', E.DRIVER_META[d.driver].label), h('br'),
            h('span', { class: 'row-sub' }, `Engine ${d.from}, yours ${d.to}. ${d.note || ''}`)),
          h('span', { class: 'chev', 'aria-hidden': 'true' }, '›'))))));
      out.push(dl);

      const dp = h('section', null, h('h3', null, 'Names to deepen'));
      state.deepen = state.deepen.filter((x) => state.data.market.stocks[x] && !rawResearch(x));
      dp.append(state.deepen.length ? h('p', null, state.deepen.join(', ')) : h('p', { class: 'empty' }, 'None. Open any name without research and tap “Add to deepen list”.'));
      out.push(dp);

      // live baseline status and the demo replay
      const live = state.data.live;
      const ls = h('section', null, h('h3', null, 'Live baseline'),
        h('p', { class: 'muted' }, live && live.generated_at ? `Last refreshed ${live.generated_at}. Source: ${live.source}.` : 'No live refresh has reached this device yet, so research uses the filings it was built from.'),
        h('p', { class: 'small muted' }, 'When a company files a 10-Q or 10-K, the backend reads the SEC feed and rebuilds the starting EPS, revenue and share count. The drivers stay yours to dispute.'),
        h('p', { class: 'inline' },
          h('button', { class: 'btn', type: 'button', onclick: () => {
            state.demoFilings.LIN = { form: '10-Q', period: '2026-09-30', label: 'Q3 2026 (DEMO)', filed: '2026-10-29', accession: 'demo-fixture', eps: 18.2, revenue: 37.4, shares: 0.462 };
            render(); toast('Replayed a demo filing for Linde.'); pushSheet('Linde', () => { state.cardMode.LIN = 'fund'; return cardWithToggle('LIN', kit.porterSheet); });
          } }, 'Replay a filing event (demo)'),
          Object.keys(state.demoFilings).length ? h('button', { class: 'btn', type: 'button', onclick: () => { state.demoFilings = {}; render(); } }, 'Clear demo') : null),
        h('p', { class: 'small muted' }, 'The replay uses an illustrative fixture, labelled DEMO on the card. It is not a real filing.'));
      out.push(ls);
      return out;
    }

    /* ---------- tracker additions ---------- */
    const chartUrl = (t) => 'https://finance.yahoo.com/chart/' + encodeURIComponent(t);
    function positionRead(holdings) {
      const s = h('section', { class: 'wide' }, h('h2', null, 'Position read'),
        h('p', { class: 'small muted' }, 'Valuation, technical read with reasons, and a short checklist for each holding. Technicals use the 52-week range and the day’s move.'));
      const today = new Date('2026-10-14T00:00:00Z');
      for (const x of holdings) {
        const m = mkOf(x.ticker); if (!m) continue;
        const r = researchOf(x.ticker), ev = r ? evalFor(x.ticker, true) : null, tr = E.technicalRead(m);
        const checks = [];
        if (r) {
          const trips = r.tripwires.map(tripStatus);
          checks.push([!trips.includes('tripped') && !trips.includes('watch'), trips.filter((z) => z !== 'holding').length ? `${trips.filter((z) => z !== 'holding').length} tripwire(s) on watch or tripped` : 'All tripwires holding']);
          const next = (r.catalysts || []).filter((c) => c.confirmed).map((c) => (Date.parse(c.date) - today) / 86400000).filter((d) => d >= 0).sort((a, b) => a - b)[0];
          checks.push([next === undefined || next > 14, next === undefined ? 'No confirmed catalyst date' : `Confirmed catalyst in ${Math.round(next)} days`]);
          const age = (today - Date.parse(r.as_of)) / 86400000;
          checks.push([age < 120, `Research built from a filing ${Math.round(age)} days old`]);
          checks.push([ev.edge > -0.015, `Stance ${ev.stance}; ${pts(ev.edge)} versus the hurdle`]);
        } else {
          checks.push([false, 'No research yet: deepen this name before sizing a position']);
        }
        s.append(h('div', { class: 'pos' },
          h('div', { class: 'pos-head' }, h('span', { class: 'tickers' }, x.ticker), ' ', nameOf(x.ticker), ' ', ev ? stancePill(ev.stance) : depthPill(x.ticker)),
          h('div', { class: 'small muted' }, valuationLine(x.ticker)),
          h('div', { class: 'small' }, h('strong', null, `Technical: ${tr.label}. `), tr.reasons.join(' ')),
          h('ul', { class: 'checks' }, checks.map(([ok, txt]) => h('li', { class: ok ? 'ok' : 'flag' }, h('span', { 'aria-hidden': 'true' }, ok ? '✓ ' : '! '), txt))),
          h('p', { class: 'inline' },
            h('button', { class: 'btn small', type: 'button', onclick: () => pushSheet(nameOf(x.ticker), () => kit.cardSheet(x.ticker)) }, 'Open research'),
            h('a', { class: 'btn small', href: chartUrl(x.ticker), target: '_blank', rel: 'noopener' }, 'Open chart'))));
      }
      return s;
    }

    function macroAndWatch(holdings) {
      const rt = rates();
      const s = h('section', { class: 'wide' }, h('h2', null, 'Research watch'),
        h('p', { class: 'small muted' }, `Rates behind every hurdle: 10-year Treasury ${rt.rf}%, equity risk premium ${rt.erp}%. ${state.data.market.source} as of ${state.data.market.as_of}.`));
      const items = [];
      for (const x of holdings) {
        const r = researchOf(x.ticker); if (!r) continue;
        for (const tw of r.tripwires) { const st = tripStatus(tw); if (st !== 'holding') items.push({ t: x.ticker, text: tw.text, st }); }
        for (const c of r.catalysts) items.push({ t: x.ticker, text: c.label, st: c.confirmed ? 'dated' : 'unconfirmed', date: c.date });
      }
      if (!items.length) s.append(h('p', { class: 'empty' }, 'None of your holdings have research yet.'));
      else s.append(h('ul', { class: 'rows' }, items.slice(0, 10).map((i) => h('li', { class: 'row row-static' },
        h('span', { class: 'row-main' }, h('span', { class: 'row-title' }, h('span', { class: 'tickers' }, i.t), ' ', i.text)),
        h('span', { class: 'pill ' + (i.st === 'dated' || i.st === 'unconfirmed' ? 'pending' : i.st) }, i.st === 'dated' ? i.date : i.st)))));
      return s;
    }

    return { cardWithToggle, yourView, positionRead, macroAndWatch, valuationLine, valuationCells, depthPill, stancePill, researchOf, evalFor, rawResearch, loadEvidence };
  };
})();
