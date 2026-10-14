/* lib.js: pure logic, no DOM. Runs in the browser (window.Lib) and in Node (require). */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Lib = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const FORCES = ['rivalry', 'buyers', 'suppliers', 'entrants', 'substitutes'];
  const FORCE_LABEL = {
    rivalry: 'Rivalry',
    buyers: 'Buyer power',
    suppliers: 'Supplier power',
    entrants: 'New entrants',
    substitutes: 'Substitutes'
  };
  const FORCE_TRENDS = ['strengthening', 'stable', 'weakening'];
  const BASES = ['filing', 'computed', 'management', 'judgment'];
  const TIERS = ['H', 'M', 'L'];

  const DEFAULT_HOLDINGS = [
    { ticker: 'MSFT', weight: 14 },
    { ticker: 'V', weight: 12 },
    { ticker: 'LLY', weight: 12 },
    { ticker: 'LIN', weight: 10 },
    { ticker: 'COST', weight: 10 },
    { ticker: 'GOOGL', weight: 10 },
    { ticker: 'JPM', weight: 9 },
    { ticker: 'WM', weight: 8 },
    { ticker: 'MU', weight: 8 },
    { ticker: 'KO', weight: 7 }
  ];

  const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const pad = (n) => String(n).padStart(2, '0');
  const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));
  const num = (x) => (typeof x === 'number' && isFinite(x) ? x : null);

  /* ---------- prices and portfolio ---------- */

  function pctChange(close, prev) {
    if (num(close) === null || num(prev) === null || prev === 0) return null;
    return close / prev - 1;
  }

  function cleanHoldings(holdings) {
    const seen = new Set();
    const out = [];
    for (const h of holdings || []) {
      if (!h || typeof h.ticker !== 'string') continue;
      const t = h.ticker.trim().toUpperCase();
      const w = Number(h.weight);
      if (!t || seen.has(t) || !isFinite(w) || w < 0) continue;
      seen.add(t);
      out.push({ ticker: t, weight: w });
    }
    return out;
  }

  function totalWeight(holdings) {
    return cleanHoldings(holdings).reduce((s, h) => s + h.weight, 0);
  }

  /* Weighted one day move over the holdings that have prices.
     Weights are treated as relative, so they need not sum to 100. */
  function portfolioMove(holdings, prices) {
    const hs = cleanHoldings(holdings).filter((h) => h.weight > 0);
    const total = hs.reduce((s, h) => s + h.weight, 0);
    const covered = [];
    for (const h of hs) {
      const p = prices && prices[h.ticker];
      const chg = p ? pctChange(p.close, p.prev) : null;
      if (chg !== null) covered.push({ ticker: h.ticker, weightRaw: h.weight, change: chg });
    }
    const coveredW = covered.reduce((s, c) => s + c.weightRaw, 0);
    if (!coveredW) return { move: null, coverage: 0, contributions: [], best: null, worst: null };
    const contributions = covered.map((c) => {
      const w = c.weightRaw / coveredW;
      return { ticker: c.ticker, weight: w, change: c.change, contribution: w * c.change };
    });
    const move = contributions.reduce((s, c) => s + c.contribution, 0);
    const sorted = contributions.slice().sort((a, b) => b.contribution - a.contribution);
    return {
      move,
      coverage: total ? coveredW / total : 0,
      contributions: sorted,
      best: sorted[0],
      worst: sorted[sorted.length - 1]
    };
  }

  /* ---------- digest ranking ---------- */

  function exposureOf(item, holdings) {
    const hs = cleanHoldings(holdings);
    const total = hs.reduce((s, h) => s + h.weight, 0);
    if (!total) return 0;
    const set = new Set((item.tickers || []).map((t) => String(t).toUpperCase()));
    let w = 0;
    for (const h of hs) if (set.has(h.ticker)) w += h.weight;
    return w / total;
  }

  function scoreItem(item, holdings) {
    const exp = Math.min(1, exposureOf(item, holdings) * 3); // a third of the book saturates it
    const mat = clamp(Number(item.materiality) || 1, 1, 5);
    const thesisLink = item.tags && (item.tags.falsifier || item.tags.force) ? 1 : 0;
    return mat * (1 + 4 * exp) + thesisLink;
  }

  function rankItems(items, holdings) {
    return (items || [])
      .map((item) => {
        const exposure = exposureOf(item, holdings);
        return { item, exposure, score: scoreItem(item, holdings) };
      })
      .filter((r) => r.exposure > 0 || (Number(r.item.materiality) || 0) >= 4)
      .sort((a, b) => b.score - a.score || String(a.item.id).localeCompare(String(b.item.id)));
  }

  function splitDigest(items, holdings, limit) {
    const ranked = rankItems(items, holdings);
    const attention = ranked.slice(0, limit).map((r) => r.item);
    const used = new Set(attention.map((i) => i.id));
    const hs = cleanHoldings(holdings).sort((a, b) => b.weight - a.weight);
    const oneLiners = [];
    for (const h of hs) {
      const match = ranked.find((r) => !used.has(r.item.id) && (r.item.tickers || []).map((t) => String(t).toUpperCase()).includes(h.ticker));
      if (match) oneLiners.push({ ticker: h.ticker, item: match.item });
    }
    return { attention, oneLiners };
  }

  /* ---------- dates ---------- */

  function sgt(ms) {
    const d = new Date(ms + 8 * 3600 * 1000);
    return { y: d.getUTCFullYear(), m: d.getUTCMonth(), d: d.getUTCDate(), dow: d.getUTCDay(), hh: d.getUTCHours(), mm: d.getUTCMinutes() };
  }

  function formatSgt(ms) {
    const p = sgt(ms);
    return `${DAYS[p.dow]} ${p.d} ${MONTHS[p.m]}, ${pad(p.hh)}:${pad(p.mm)} SGT`;
  }

  function formatDateLabel(iso) {
    const d = new Date(iso + 'T00:00:00Z');
    if (isNaN(d)) return String(iso);
    return `${DAYS[d.getUTCDay()]} ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`;
  }

  function staleness(generatedAtIso, nowMs, maxHours) {
    const gen = Date.parse(generatedAtIso);
    if (isNaN(gen)) return { known: false, stale: true, hours: null };
    const hours = (nowMs - gen) / 3600000;
    return { known: true, stale: hours > (maxHours || 30), hours: Math.max(0, hours) };
  }

  /* The digest is built at 07:00 SGT. Sunday and Monday mornings in Singapore fall on
     US weekends, and Saturday morning covers Friday's US session. */
  function marketNote(digest) {
    if (digest && digest.market_note) return digest.market_note;
    const gen = digest && Date.parse(digest.generated_at);
    if (!gen || isNaN(gen)) return null;
    const dow = sgt(gen).dow;
    if (dow === 0 || dow === 1) return 'US markets were closed. Prices show the last close.';
    if (dow === 6) return "This covers Friday's US session.";
    return null;
  }

  function upcoming(calendar, fromIso, days) {
    const from = Date.parse(String(fromIso).slice(0, 10) + 'T00:00:00Z');
    if (isNaN(from)) return [];
    const to = from + (days || 7) * 86400000;
    return (calendar || [])
      .filter((e) => {
        const t = Date.parse(e.date + 'T00:00:00Z');
        return !isNaN(t) && t >= from && t <= to;
      })
      .sort((a, b) => a.date.localeCompare(b.date) || String(a.label).localeCompare(String(b.label)));
  }

  /* ---------- Porter cards ---------- */

  function computeVerdict(scores, reconciliationStatus) {
    const vals = FORCES.map((f) => scores[f]);
    if (vals.some((v) => !Number.isInteger(v) || v < 1 || v > 5)) return 'Insufficient evidence';
    if (reconciliationStatus === 'conflict') return 'Contested';
    const low = vals.filter((v) => v <= 2).length;
    const high = vals.filter((v) => v >= 4).length;
    if (low >= 2) return 'Weak';
    if (low === 0 && high >= 3 && reconciliationStatus === 'pass') return 'Strong';
    return 'Moderate';
  }

  function forceScores(card) {
    const out = {};
    for (const f of FORCES) out[f] = card && card.forces && card.forces[f] ? card.forces[f].score : undefined;
    return out;
  }

  /* Checks the evidence rules from the rubric so a weak card is flagged, not hidden. */
  function validateCard(card) {
    const problems = [];
    if (!card || typeof card !== 'object') return { ok: false, problems: ['Card is missing.'] };
    for (const f of FORCES) {
      const force = card.forces && card.forces[f];
      if (!force) { problems.push(`${FORCE_LABEL[f]}: missing.`); continue; }
      if (!Number.isInteger(force.score) || force.score < 1 || force.score > 5) problems.push(`${FORCE_LABEL[f]}: score must be a whole number from 1 to 5.`);
      if (!FORCE_TRENDS.includes(force.trend)) problems.push(`${FORCE_LABEL[f]}: trend is missing.`);
      const ev = Array.isArray(force.evidence) ? force.evidence : [];
      if (ev.length < 2) problems.push(`${FORCE_LABEL[f]}: needs at least two evidence items.`);
      if (!ev.some((e) => e.basis === 'filing' || e.basis === 'computed')) problems.push(`${FORCE_LABEL[f]}: needs at least one filing or computed item.`);
      if (ev.length && ev.every((e) => e.basis === 'management') && force.score > 3) problems.push(`${FORCE_LABEL[f]}: management claims alone cap the score at 3.`);
      for (const e of ev) {
        if (!BASES.includes(e.basis)) problems.push(`${FORCE_LABEL[f]}: an evidence item has no basis.`);
        if (!TIERS.includes(e.tier)) problems.push(`${FORCE_LABEL[f]}: an evidence item has no confidence tier.`);
        if (!e.source || !e.source.title || !e.source.date) problems.push(`${FORCE_LABEL[f]}: an evidence item has no source and date.`);
      }
    }
    const fals = Array.isArray(card.falsifiers) ? card.falsifiers : [];
    if (fals.length < 2 || fals.length > 3) problems.push('Needs two or three falsifiers.');
    if (fals.some((x) => !x.threshold)) problems.push('Every falsifier needs a numeric threshold.');
    const status = card.reconciliation && card.reconciliation.status;
    const expected = computeVerdict(forceScores(card), status);
    if (card.verdict !== expected) problems.push(`Verdict says ${card.verdict} but the scores give ${expected}.`);
    return { ok: problems.length === 0, problems };
  }

  /* Lowest scoring force for each held name that has a card, weakest first. */
  function weakestForces(cards, holdings) {
    const out = [];
    for (const h of cleanHoldings(holdings)) {
      const card = cards && cards[h.ticker];
      if (!card || !card.forces) continue;
      let worst = null;
      for (const f of FORCES) {
        const s = card.forces[f] && card.forces[f].score;
        if (Number.isInteger(s) && (worst === null || s < worst.score)) worst = { ticker: h.ticker, force: f, score: s };
      }
      if (worst) out.push(worst);
    }
    return out.sort((a, b) => a.score - b.score || a.ticker.localeCompare(b.ticker));
  }

  /* Falsifiers on watch or tripped. Pass holdings to limit to the user's book. */
  function falsifiersAtRisk(cards, holdings) {
    const held = holdings ? new Set(cleanHoldings(holdings).map((h) => h.ticker)) : null;
    const out = [];
    for (const [ticker, card] of Object.entries(cards || {})) {
      if (held && !held.has(ticker)) continue;
      for (const f of card.falsifiers || []) {
        if (f.status === 'watch' || f.status === 'tripped') out.push({ ticker, id: f.id, text: f.text, threshold: f.threshold, status: f.status });
      }
    }
    return out.sort((a, b) => (a.status === b.status ? a.ticker.localeCompare(b.ticker) : a.status === 'tripped' ? -1 : 1));
  }

  /* ---------- Ask Claude prompt ---------- */

  const ASK_QUESTIONS = [
    'Challenge the lowest score on this card and argue the opposite case.',
    'What would have to be true for this thesis to break, and which falsifier would show it first?',
    'Compare this card with the closest peer in the universe.',
    'Explain this card in plain language for a busy investor.'
  ];

  /* The Ask Claude hand-off. Everything Claude needs travels inside the prompt, so no connector is
     required. Two versions: `full` is copied to the clipboard; `compact` is short enough to ride in a
     claude.ai/new?q= link. */
  const pctText = (x) => (x === null || x === undefined ? 'n/a' : (x > 0 ? '+' : x < 0 ? '-' : '') + Math.abs(x * 100).toFixed(2) + '%');
  const src = (s) => (s ? `${s.title || 'source'}${s.date ? ', ' + s.date : ''}${s.url ? ' <' + s.url + '>' : ''}` : 'no source');

  function buildAskPrompt(opts) {
    const card = opts.card;
    const price = opts.price || null;
    const news = (opts.news || []).slice(0, 4);
    const asOf = opts.snapshotLabel || '';
    const rules = [
      'Rules: argue only from the facts supplied in this chat and name the source when you use one.',
      'Say so when evidence is missing instead of estimating. Do not do arithmetic from memory.',
      'This is a dated snapshot, not live data. Do not describe it as current.',
      'You may add general knowledge, but label it clearly as outside the snapshot.'
    ];
    const head = [
      `I am reviewing the thesis card for ${card.name || card.ticker} (${card.ticker}), card ${card.id}, version ${card.version}, as of ${card.as_of}.`,
      card.data_note ? `Data note: ${card.data_note}` : null,
      `Verdict: ${card.verdict}. Trend: ${card.trend}. Confidence: ${card.confidence}.`,
      `Question: ${opts.question}`
    ].filter(Boolean);

    const scores = FORCES.map((f) => {
      const x = card.forces && card.forces[f];
      return x ? `${FORCE_LABEL[f]} ${x.score}/5 (${x.trend})` : null;
    }).filter(Boolean).join('; ');
    const fals = (card.falsifiers || []).map((f) => `${f.id}: ${f.threshold} [${f.status}]`);

    const compact = [].concat(head, [
      'Scores (5 means the force is weak for the company): ' + scores + '.',
      'Falsifiers: ' + fals.join('; ') + '.',
      rules[0] + ' ' + rules[1] + ' ' + rules[2],
      'My next message pastes the full evidence with sources. Wait for it before concluding.'
    ]).join('\n');

    let compactText = compact;
    const full = [].concat(head, ['', 'SCORES (5 means the force is weak for the company, so pricing power is safer):', scores]);
    if (card.summary) full.push('', 'SUMMARY: ' + card.summary);
    full.push('', 'EVIDENCE BY FORCE:');
    for (const f of FORCES) {
      const x = card.forces && card.forces[f];
      if (!x) continue;
      full.push(`${FORCE_LABEL[f]} ${x.score}/5, ${x.trend}${x.firm_adjust ? ', firm adjustment ' + x.firm_adjust : ''}`);
      for (const e of x.evidence || []) full.push(`- [${e.basis}, tier ${e.tier}] ${e.text} (${src(e.source)})`);
    }
    if ((card.supporting || []).length) { full.push('', 'SUPPORTING:'); card.supporting.forEach((e) => full.push(`- ${e.text} (${src(e.source)})`)); }
    if ((card.counter || []).length) { full.push('', 'COUNTER-ARGUMENTS:'); card.counter.forEach((e) => full.push(`- ${e.text} (${src(e.source)})`)); }
    full.push('', 'FALSIFIERS (what would prove the thesis wrong):');
    (card.falsifiers || []).forEach((f) => full.push(`- ${f.id}: ${f.text} Threshold: ${f.threshold}. Status: ${f.status}.`));
    const rec = card.reconciliation;
    if (rec) {
      full.push('', `RECONCILIATION (does the story match the numbers?): ${rec.status}`);
      (rec.tests || []).forEach((t) => full.push(`- ${t.name}: ${t.result}`));
      if (rec.story) full.push('Story: ' + rec.story);
      if (rec.numbers) full.push('Numbers: ' + rec.numbers);
    }
    if (price) full.push('', `PRICE SNAPSHOT${asOf ? ' (' + asOf + ')' : ''}: last close ${price.close}, previous close ${price.prev}, one-day move ${pctText(pctChange(price.close, price.prev))}.`);
    if (news.length) {
      full.push('', 'NEWS IN THE SNAPSHOT:');
      news.forEach((n) => full.push(`- ${n.headline}. ${n.why} (${src(n.source)})`));
    }
    if (opts.includeHoldings) {
      const hs = cleanHoldings(opts.holdings).filter((h) => h.weight > 0);
      if (hs.length) {
        const line = 'My holdings, as weights: ' + hs.map((h) => `${h.ticker} ${h.weight}`).join(', ') + '.';
        full.push('', line);
        compactText += '\n' + line;
      }
    }
    full.push('', rules.join(' '));
    return { full: full.join('\n'), compact: compactText };
  }

  /* ---------- feedback ---------- */

  function recordFeedback(store, itemId, value, note, atIso) {
    const next = Object.assign({}, store || {});
    next[itemId] = { value, note: (note || '').slice(0, 500), at: atIso };
    return next;
  }

  function feedbackToText(store, meta) {
    const rows = Object.entries(store || {}).sort((a, b) => String(a[1].at).localeCompare(String(b[1].at)));
    const head = `Feedback export${meta && meta.app ? ' for ' + meta.app : ''}. ${rows.length} item${rows.length === 1 ? '' : 's'}.`;
    const body = rows.map(([id, f]) => `${id}\t${f.value}\t${f.at}${f.note ? '\t' + f.note.replace(/\s+/g, ' ') : ''}`);
    return [head, 'item, rating, time, note'].concat(body).join('\n');
  }

  function parseBackup(text, knownTickers) {
    let data;
    try { data = JSON.parse(text); } catch (e) { return { ok: false, error: 'That is not valid backup text.' }; }
    if (!data || !Array.isArray(data.holdings)) return { ok: false, error: 'The backup has no holdings list.' };
    const holdings = cleanHoldings(data.holdings);
    if (!holdings.length) return { ok: false, error: 'The backup has no usable holdings.' };
    if (knownTickers) {
      const known = new Set(knownTickers);
      const unknown = holdings.filter((h) => !known.has(h.ticker)).map((h) => h.ticker);
      if (unknown.length) return { ok: false, error: 'Not in the universe: ' + unknown.join(', ') + '.' };
    }
    const fb = data.feedback && typeof data.feedback === 'object' && !Array.isArray(data.feedback) ? data.feedback : {};
    const disputes = Array.isArray(data.disputes) ? data.disputes.filter((d) => d && typeof d.ticker === 'string' && typeof d.driver === 'string' && typeof d.to === 'number') : null;
    const tilt = data.tilt && typeof data.tilt.growth === 'number' && typeof data.tilt.risk === 'number' ? { growth: data.tilt.growth, risk: data.tilt.risk } : null;
    const deepen = Array.isArray(data.deepen) ? data.deepen.filter((x) => typeof x === 'string') : null;
    return { ok: true, holdings, feedback: fb, disputes, tilt, deepen };
  }

  return {
    FORCES, FORCE_LABEL, FORCE_TRENDS, DEFAULT_HOLDINGS, ASK_QUESTIONS,
    pctChange, cleanHoldings, totalWeight, portfolioMove,
    exposureOf, scoreItem, rankItems, splitDigest,
    sgt, formatSgt, formatDateLabel, staleness, marketNote, upcoming,
    computeVerdict, validateCard, weakestForces, falsifiersAtRisk,
    buildAskPrompt, recordFeedback, feedbackToText, parseBackup
  };
});
