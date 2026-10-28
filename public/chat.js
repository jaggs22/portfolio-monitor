/* chat.js: "Ask or add your view". A chat with the Moat Monitor analyst (Workers AI via /api/chat) that knows the
   research on screen, plus the investor's own research: notes saved per stock, and disputes that move the target.
   The model only proposes; the investor confirms every save with one tap. Everything stays on this device. */
(function () {
  'use strict';
  const { h, fmt, icon, btn, store, toast } = window.UI;
  const E = window.Engine, L = window.Lib;

  window.makeChat = function (kit) {
    const { state, nameOf, CO } = kit;
    let ctxT = null, panel = null, busy = false;

    /* ---------- the investor's own research ---------- */
    const notesAll = () => store.get('notes', {}) || {};
    const notesOf = (t) => notesAll()[t] || [];
    function addNote(t, text) {
      const all = notesAll();
      all[t] = (all[t] || []).concat([{ id: Date.now().toString(36), text: text.trim().slice(0, 1200), at: Date.now() }]);
      store.set('notes', all);
      kit.render();
    }
    function delNote(t, id) {
      const all = notesAll();
      all[t] = (all[t] || []).filter((n) => n.id !== id);
      if (!all[t].length) delete all[t];
      store.set('notes', all);
      kit.render();
    }
    const hist = (key) => store.get('chat:' + key, []) || [];
    const saveHist = (key, xs) => store.set('chat:' + key, xs.slice(-30));

    /* ---------- context the model sees: only what the app already shows ---------- */
    function contextFor(t) {
      const lines = [];
      const U = state.data.universe;
      lines.push(`Coverage: ${U.length} US stocks. Full research: ${U.filter((u) => u.tier === 'core').map((u) => u.name).join(', ')}. Lighter research: ${U.filter((u) => u.tier === 'lighter').map((u) => u.name).join(', ')}. Basics only: ${U.filter((u) => u.tier === 'basic').map((u) => u.name).join(', ')}.`);
      const hs = L.cleanHoldings(state.holdings);
      if (hs.length) lines.push(`The investor's book (dollars): ${hs.map((x) => `${x.ticker} ${Math.round(x.weight)}`).join(', ')}.`);
      U.filter((u) => u.tier !== 'basic').forEach((u) => { const c = CO.callOf(u.ticker, false); if (c) lines.push(`${u.name} (${u.ticker}): ${c.rating}, 12-month target $${c.pt.toFixed(2)} (${fmt.spct(c.upside, 1)}).`); });
      if (!t) return lines.join('\n');
      const u = state.uniMap[t] || {}, p = CO.priceOf(t), r = CO.researchOf(t), rv = CO.review(t), c = CO.callOf(t, false), cm = CO.callOf(t, true);
      lines.push('', `FOCUS: ${nameOf(t)} (${t}), ${u.sector || ''}, research depth: ${u.tier}. Price $${p ? p.price.toFixed(2) : 'n/a'}.`);
      if (c) lines.push(`Call: ${c.rating}. 12-month target $${c.pt.toFixed(2)} = FY+1 EPS $${c.eps1.toFixed(2)} x ${c.targetPE.toFixed(1)}x. Upside ${fmt.spct(c.upside, 1)}, total return ${fmt.spct(c.totalReturn, 1)} vs cost of equity ${fmt.pct(c.hurdle)}. Downside case $${c.bear.value.toFixed(2)}, upside case $${c.bull.value.toFixed(2)}. Rule: Overweight if total return beats cost of equity by 5 points, Underweight if 5 points short.`);
      if (cm && c && cm.pt !== c.pt) lines.push(`With the investor's disputes: ${cm.rating}, target $${cm.pt.toFixed(2)}.`);
      if (rv) {
        lines.push(`Title: ${rv.title}. Lead: ${CO.fill(t, rv.lead)}`);
        (rv.arguments || []).forEach((a) => lines.push(`${a.label}: ${CO.fill(t, a.text)}`));
        (rv.thesis_long || []).forEach((x) => lines.push('Thesis: ' + CO.fill(t, x)));
        lines.push(`How it makes money: ${rv.model}`);
        lines.push(`Moat ${rv.moat.rating}/5: ${rv.moat.sources.join('; ')}. Threat: ${rv.moat.threat}`);
        lines.push(`Balance sheet: ${rv.balance.read} ${rv.balance.facts.join('; ')}`);
        rv.risks.forEach((x) => lines.push(`Risk (${x.cat || ''}): ${x.cause}. ${x.how} Watch: ${x.watch}.`));
        (rv.upside_risks || []).forEach((x) => lines.push(`Upside risk: ${x.cause}. ${x.how}`));
        lines.push(`Peers, for the premium: ${rv.peer_read.why_premium} Against: ${rv.peer_read.why_not}`);
      } else if (r) lines.push(`Thesis: ${r.header.thesis}`);
      if (r) {
        lines.push('Model assumptions (downside / base / upside):');
        E.DRIVERS.forEach((k) => { const d = r.drivers[k], m = E.DRIVER_META[k]; lines.push(`- ${k} (${m.label}, ${m.unit}): ${d.bear} / ${d.base} / ${d.bull}${rv && rv.forecast_basis ? '. Basis: ' + rv.forecast_basis[k] : ''}`); });
        (r.tripwires || []).forEach((tw) => lines.push(`Tripwire: ${tw.text} (last ${tw.current == null ? 'n/a' : tw.current} ${tw.unit || ''}).`));
        (r.catalysts || []).forEach((x) => lines.push(`Event ${x.date}: ${x.label}. ${x.note || ''}`));
      }
      const e = CO.estimates(t);
      if (e) e.rows.forEach((x) => lines.push(`${x.label}: our EPS $${x.eps.toFixed(2)}${x.cEps ? `, consensus $${x.cEps.toFixed(2)}` : ''}; our revenue $${(x.rev / 1000).toFixed(1)}B${x.cRev ? `, consensus $${(x.cRev / 1000).toFixed(1)}B` : ''}.`));
      CO.framework(t).forEach((x) => lines.push(`Test ${x.label}: ${x.value} (${x.light === 'g' ? 'positive' : x.light === 'r' ? 'negative' : 'neutral'}), ${x.why}.`));
      const ps = CO.peerStats(t);
      if (ps && ps.me) lines.push(`Peers: ${ps.peers.map((x) => x.name).join(', ')}. NTM EV/EBITDA ${fmt.mult(ps.me.ntm.ev_ebitda)} vs median ${fmt.mult(ps.med('ntm', 'ev_ebitda'))}; NTM P/E ${fmt.mult(ps.me.ntm.pe)} vs ${fmt.mult(ps.med('ntm', 'pe'))}.`);
      const s = CO.finSnapshot(t);
      if (s) lines.push(`Last 12 months: revenue growth ${fmt.spct(s.growth, 1)}, operating margin ${fmt.pct(s.opm)}, ROIC ${fmt.pct(s.roic)}, net debt/EBITDA ${s.ndE == null ? 'n/a' : s.ndE.toFixed(1) + 'x'}.`);
      const mine = state.disputes.filter((d) => d.ticker === t);
      if (mine.length) lines.push(`Investor's disputes: ${mine.map((d) => `${d.driver} ${d.from} -> ${d.to}${d.note ? ' (' + d.note + ')' : ''}`).join('; ')}.`);
      const ns = notesOf(t);
      if (ns.length) lines.push(`Investor's own research notes: ${ns.map((n) => n.text).join(' | ')}`);
      return lines.join('\n');
    }

    /* ---------- tiny safe markdown: paragraphs, bullets, bold ---------- */
    function md(text) {
      const out = [];
      let ul = null;
      const inline = (s) => s.split(/(\*\*[^*]+\*\*)/g).map((x) => (/^\*\*[^*]+\*\*$/.test(x) ? h('b', null, x.slice(2, -2)) : x));
      text.split(/\n+/).forEach((ln) => {
        const m = ln.match(/^\s*[-*•]\s+(.*)/);
        if (m) { if (!ul) { ul = h('ul'); out.push(ul); } ul.append(h('li', null, inline(m[1]))); return; }
        ul = null;
        if (ln.trim()) out.push(h('p', null, inline(ln.trim())));
      });
      return out;
    }
    function parseTags(text) {
      const acts = [];
      const clean = text.replace(/\[\[(note|dispute):\s*([^\]]+)\]\]/gi, (_, kind, body) => {
        if (kind.toLowerCase() === 'note') acts.push({ kind: 'note', text: body.trim() });
        else {
          const g = (k) => { const m = body.match(new RegExp(k + '\\s*=\\s*([^=]+?)(?=\\s+\\w+\\s*=|$)')); return m ? m[1].trim() : null; };
          const driver = g('driver'), value = Number(String(g('value') || '').replace(/[^0-9.\-]/g, ''));
          if (E.DRIVERS.includes(driver) && isFinite(value)) acts.push({ kind: 'dispute', driver, value, reason: g('reason') || '' });
        }
        return '';
      }).trim();
      return { clean, acts };
    }

    /* ---------- actions the model proposes, confirmed by the investor ---------- */
    function actionCard(t, a) {
      if (!t) return null;
      if (a.kind === 'note') {
        const b = btn([icon('plus'), 'Save to my research'], () => { addNote(t, a.text); b.replaceWith(h('span', { class: 'ch-done' }, 'Saved to your research on ' + nameOf(t))); }, 'small');
        return h('div', { class: 'ch-act' }, h('div', { class: 'ch-act-t' }, h('span', { class: 'eyebrow' }, 'Your view'), h('p', null, a.text)), b);
      }
      const r = CO.researchOf(t), m = E.DRIVER_META[a.driver];
      if (!r || !m) return null;
      const from = r.drivers[a.driver].base;
      if (from === a.value) return null;
      const before = CO.callOf(t, true);
      const b = btn('Apply to my view', () => {
        state.disputes = state.disputes.filter((x) => !(x.ticker === t && x.driver === a.driver)).concat([{ id: t + '-' + a.driver, ticker: t, driver: a.driver, to: a.value, from, reason: 'chat', note: a.reason, ts: Date.now() }]);
        kit.save(); kit.render();
        const after = CO.callOf(t, true);
        b.replaceWith(h('span', { class: 'ch-done' }, `Applied. Your target ${fmt.px(before.pt)} → ${fmt.px(after.pt)}, ${after.rating}.`));
      }, 'small primary');
      return h('div', { class: 'ch-act' }, h('div', { class: 'ch-act-t' }, h('span', { class: 'eyebrow' }, 'Change an assumption'), h('p', null, `${m.label}: ${from} → ${a.value} ${m.unit}`), a.reason ? h('small', null, a.reason) : null), b);
    }

    /* ---------- panel ---------- */
    const keyOf = (t) => t || 'general';
    function suggestions(t) {
      if (!t) return ['Which of the full-research names looks cheapest?', 'What is coming up this month?', 'How do ratings work here?'];
      const c = CO.callOf(t, false);
      return [`I have a view on ${nameOf(t)}`, c ? `What would make this ${c.rating === 'Overweight' ? 'Equal weight' : 'Overweight'}?` : 'What matters most here?', 'What is the biggest risk?', 'Explain the target'];
    }
    function render() {
      if (!panel) return;
      const t = ctxT, key = keyOf(t), xs = hist(key);
      const body = panel.querySelector('.ch-body');
      const sel = panel.querySelector('.ch-ctx');
      sel.value = t || '';
      body.replaceChildren();
      if (!xs.length) {
        body.append(h('div', { class: 'ch-empty' },
          h('h3', null, t ? `Your view on ${nameOf(t)}` : 'Ask, or add your own research'),
          h('p', null, t ? 'Tell the analyst what you know or believe. It will test your view against the research, save it to your notes, and, if you give a number, show what it does to the target.' : 'Ask about any stock we cover, or share your own research. Pick a stock above to focus the conversation.'),
          h('div', { class: 'ch-sugg' }, suggestions(t).map((q) => h('button', { type: 'button', onclick: () => { if (/^I have a view/.test(q)) { const ta = panel.querySelector('textarea'); ta.value = ''; ta.placeholder = `My view on ${nameOf(t)}: …`; ta.focus(); } else send(q); } }, q)))));
      }
      xs.forEach((m, i) => {
        if (m.role === 'user') {
          const save = t ? h('button', { type: 'button', class: 'ch-save', onclick: (e) => { addNote(t, m.content); e.currentTarget.replaceWith(h('span', { class: 'ch-done' }, 'Saved')); } }, 'Save as my research') : null;
          body.append(h('div', { class: 'ch-msg me' }, h('div', { class: 'ch-bub' }, m.content), save));
        } else {
          const { clean, acts } = parseTags(m.content);
          body.append(h('div', { class: 'ch-msg ai' }, h('div', { class: 'ch-bub' }, md(clean)), m.fresh && i === xs.length - 1 ? acts.map((a) => actionCard(t, a)) : null));
        }
      });
      if (busy) body.append(h('div', { class: 'ch-msg ai' }, h('div', { class: 'ch-bub ch-typing' }, h('i'), h('i'), h('i'))));
      const ns = t ? notesOf(t) : [];
      panel.querySelector('.ch-notes').replaceChildren(...(ns.length ? [h('button', { type: 'button', class: 'ch-notes-btn', onclick: () => kit.go(`c/${t}`) }, icon('report'), `${ns.length} note${ns.length === 1 ? '' : 's'} in your research on ${nameOf(t)}`)] : []));
      requestAnimationFrame(() => { body.scrollTop = body.scrollHeight; });
    }
    async function send(q) {
      const text = String(q || '').trim();
      if (!text || busy) return;
      const key = keyOf(ctxT), xs = hist(key).map((m) => ({ role: m.role, content: m.content }));
      xs.push({ role: 'user', content: text });
      saveHist(key, xs);
      busy = true; render();
      let reply = null, err = null;
      try {
        const r = await fetch('/api/chat', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ messages: xs.slice(-12), context: contextFor(ctxT) }) });
        const j = await r.json().catch(() => ({}));
        if (r.ok && j.reply) reply = j.reply; else err = j.error || 'The analyst is unavailable right now.';
      } catch (e) { err = 'No connection. Your message is kept; try again when you are online.'; }
      busy = false;
      const ys = hist(key).map((m) => ({ role: m.role, content: m.content }));
      ys.push({ role: 'assistant', content: reply || err, fresh: !!reply });
      saveHist(key, ys);
      render();
    }
    function open(t, opts) {
      ctxT = t && state.uniMap[t] ? t : null;
      if (!panel) {
        const ta = h('textarea', { rows: '1', placeholder: 'Ask a question or share your view…', 'aria-label': 'Message' });
        const grow = () => { ta.style.height = 'auto'; ta.style.height = Math.min(160, ta.scrollHeight) + 'px'; };
        ta.addEventListener('input', grow);
        ta.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); const v = ta.value; ta.value = ''; grow(); send(v); } });
        const sel = h('select', { class: 'ch-ctx', 'aria-label': 'Focus' }, h('option', { value: '' }, 'All coverage'), state.data.universe.map((u) => h('option', { value: u.ticker }, u.name)));
        sel.addEventListener('change', () => { ctxT = sel.value || null; render(); });
        panel = h('aside', { class: 'chat', role: 'dialog', 'aria-label': 'Ask or add your view' },
          h('header', { class: 'ch-head' },
            h('div', { class: 'ch-title' }, h('b', null, 'Ask or add your view'), h('small', null, 'Moat Monitor analyst · answers from the research shown')),
            h('button', { type: 'button', class: 'ch-new', onclick: () => { saveHist(keyOf(ctxT), []); render(); } }, 'New chat'),
            h('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Close', onclick: close }, icon('close'))),
          h('div', { class: 'ch-bar' }, sel, h('div', { class: 'ch-notes' })),
          h('div', { class: 'ch-body', 'aria-live': 'polite' }),
          h('footer', { class: 'ch-foot' }, h('div', { class: 'ch-comp' }, ta, h('button', { type: 'button', class: 'ch-send', 'aria-label': 'Send', onclick: () => { const v = ta.value; ta.value = ''; grow(); send(v); } }, icon('chev'))),
            h('small', null, 'Research discussion, not advice. Saved notes and disputes stay on this device.')));
        document.body.append(panel);
        document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && panel && panel.classList.contains('open') && !document.querySelector('.win')) close(); });
      }
      panel.classList.add('open');
      document.body.classList.add('chat-open');
      render();
      const ta = panel.querySelector('textarea');
      if (opts && opts.view && ctxT) ta.placeholder = `My view on ${nameOf(ctxT)}: …`;
      else ta.placeholder = 'Ask a question or share your view…';
      if (opts && opts.prefill) ta.value = opts.prefill;
      setTimeout(() => ta.focus(), 120);
    }
    function close() { if (panel) panel.classList.remove('open'); document.body.classList.remove('chat-open'); }

    /* The always-visible entry point, and the per-company prompt. */
    function fab(t) {
      return h('button', { type: 'button', class: 'fab', onclick: () => open(t, { view: !!t }) }, icon('chat'), h('span', null, t ? `Your view on ${nameOf(t)}?` : 'Ask or add your view'));
    }
    function viewPrompt(t) {
      const ns = notesOf(t), ds = state.disputes.filter((d) => d.ticker === t);
      return h('section', { class: 'yv' },
        h('button', { type: 'button', class: 'yv-in', onclick: () => open(t, { view: true }) }, icon('chat'), h('span', null, `What do you know about ${nameOf(t)} that we don't?`), h('b', null, 'Add your view')),
        ns.length || ds.length ? h('div', { class: 'yv-list' },
          h('span', { class: 'eyebrow' }, 'Your research'),
          ns.map((n) => h('div', { class: 'yv-note' }, h('p', null, n.text), h('small', null, new Date(n.at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })), h('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Delete note', onclick: () => delNote(t, n.id) }, icon('close')))),
          ds.map((d) => h('div', { class: 'yv-note disp' }, h('p', null, `${E.DRIVER_META[d.driver].label}: ${d.from} → ${d.to} ${E.DRIVER_META[d.driver].unit}${d.note ? '. ' + d.note : ''}`), h('small', null, 'Dispute'), h('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Withdraw dispute', onclick: () => { state.disputes = state.disputes.filter((x) => x !== d); kit.save(); kit.render(); } }, icon('close'))))) : null);
    }
    return { open, close, fab, viewPrompt, notesOf, notesAll, delNote, contextFor };
  };
})();
