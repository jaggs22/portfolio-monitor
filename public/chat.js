/* chat.js: "Ask or add your view". A chat with the Moat Monitor analyst that knows the research on screen, plus the
   investor's own research: notes saved per stock, and disputes that move the target.
   The model runs on the device itself (WebLLM on WebGPU): no server, no key, no per-message cost, and questions
   never leave the device. The model only proposes; the investor confirms every save with one tap. */
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


    /* ---------- the on-device model ---------- */
    const WEBLLM = 'https://cdn.jsdelivr.net/npm/@mlc-ai/web-llm@0.2.86/+esm';
    const TIERS = {
      standard: { id: 'Qwen3-4B-q4f16_1-MLC', label: 'Standard', name: 'Qwen3 4B', size: 'about 2.3 GB', fit: 'Best answers. For laptops and desktops.' },
      light: { id: 'Qwen3-1.7B-q4f16_1-MLC', label: 'Light', name: 'Qwen3 1.7B', size: 'about 1 GB', fit: 'For phones and tablets.' },
      tiny: { id: 'Llama-3.2-1B-Instruct-q4f16_1-MLC', label: 'Tiny', name: 'Llama 3.2 1B', size: 'about 0.7 GB', fit: 'For older phones. Weakest answers.' }
    };
    const phoneLike = /iPhone|iPad|Android|Mobile/i.test(navigator.userAgent) || matchMedia('(max-width: 760px)').matches;
    const llm = { state: 'idle', engine: null, id: null, lib: null, p: 0, text: '', err: '', stream: null, pending: false };
    const tierKey = () => { const k = store.get('llm_tier', null); return TIERS[k] ? k : phoneLike ? 'light' : 'standard'; };
    const tier = () => TIERS[tierKey()];
    async function gpuOk() {
      if (!('gpu' in navigator)) return false;
      try { return !!(await navigator.gpu.requestAdapter()); } catch (e) { return false; }
    }
    async function lib() { if (!llm.lib) llm.lib = await import(WEBLLM); return llm.lib; }
    async function cached() { try { return await (await lib()).hasModelInCache(tier().id); } catch (e) { return false; } }
    function kick() { const k = keyOf(ctxT), xs = hist(k); if (!busy && xs.length && xs[xs.length - 1].role === 'user') generate(k); }
    let loadingP = null;
    function startEngine() { if (!loadingP) loadingP = startEngine0().finally(() => { loadingP = null; }); return loadingP; }
    async function startEngine0() {
      const T = tier();
      if (llm.engine && llm.id === T.id) return llm.engine;
      if (!(await gpuOk())) { llm.state = 'nogpu'; render(); return null; }
      llm.state = 'loading'; llm.p = 0; llm.text = 'Preparing'; llm.err = ''; render();
      try {
        const W = await lib();
        const onProgress = (r) => { llm.p = r.progress || 0; llm.text = r.text || ''; paint(); };
        if (llm.engine) await llm.engine.reload(T.id);
        else llm.engine = await W.CreateWebWorkerMLCEngine(new Worker(new URL('llm-worker.js', location.href), { type: 'module' }), T.id, { initProgressCallback: onProgress });
        llm.id = T.id; llm.state = 'ready'; store.set('llm_ok', true);
        render();
        if (llm.pending) { llm.pending = false; setTimeout(kick, 0); }
        return llm.engine;
      } catch (e) {
        llm.state = 'error'; llm.err = String((e && e.message) || e).slice(0, 160); render();
        return null;
      }
    }
    let painting = false;
    const paint = () => { if (painting) return; painting = true; requestAnimationFrame(() => { painting = false; render(); }); };
    const SYSTEM = `You are the analyst inside Moat Monitor, an equity research tool, talking to an investor.
Rules:
- Use only facts and numbers from CONTEXT or from the investor. If it is not there, say you do not have it. Never invent numbers.
- Plain English. Short: under 150 words. Use "- " bullets for lists.
- Research discussion, not personal advice. Never tell the investor to buy or sell.
- When the investor shares their own view: say what in CONTEXT supports it, what argues against it, and what evidence would settle it. Then end with one line exactly like:
[[note: their view in one sentence]]
- Only if their view gives a specific number for one model assumption (rev_cagr, margin_end, share_chg, exit_pe) that differs from the base case, add one more line exactly like:
[[dispute: driver=rev_cagr value=6.5 reason=short reason]]`;
    /* Small models read about 4,000 tokens at once, so the context keeps the most decision-relevant lines first. */
    function budgeted(t, max) {
      const lines = contextFor(t).split('\n').filter(Boolean);
      const pri = (l) => /^(FOCUS|Call:|With the investor|Investor's|Title:|- (rev_cagr|margin_end|share_chg|exit_pe))/.test(l) ? 0
        : /^(Model assumptions|FY\d|Test |Growth:|Moat:|Profitability:|Capital:|Valuation:|Risk )/.test(l) ? 1
        : /^(Moat \d|Balance sheet|Peers:|Last 12|Event|Tripwire)/.test(l) ? 2 : 3;
      const order = lines.map((l, i) => [pri(t ? l : 'x'), i]).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
      const keep = new Set(); let n = 0;
      for (const [, i] of order) { const L2 = lines[i].length + 1; if (n + L2 > max) continue; keep.add(i); n += L2; }
      return lines.filter((_, i) => keep.has(i)).join('\n');
    }
    async function generate(key) {
      const eng = await startEngine();
      if (!eng) return;
      const xs = hist(key);
      const convo = xs.slice(-5).map((m) => ({ role: m.role, content: m.content.slice(0, 700) }));
      const messages = [{ role: 'system', content: SYSTEM + '\n\nCONTEXT\n' + budgeted(ctxT, 5200) }].concat(convo);
      busy = true; llm.stream = ''; render();
      let out = '';
      try {
        const req = { messages, stream: true, temperature: 0.4, max_tokens: 520 };
        if (/^Qwen3/.test(llm.id)) req.extra_body = { enable_thinking: false };
        const chunks = await eng.chat.completions.create(req);
        for await (const c of chunks) { out += (c.choices[0] && c.choices[0].delta && c.choices[0].delta.content) || ''; llm.stream = out; paint(); }
      } catch (e) { out = out || 'The on-device analyst stopped unexpectedly. Try again, or switch to a smaller model below.'; }
      out = out.replace(/<think>[\s\S]*?(<\/think>|$)/g, '').trim() || 'No answer this time. Try rephrasing.';
      busy = false; llm.stream = null;
      const ys = hist(key);
      ys.push({ role: 'assistant', content: out, fresh: true });
      saveHist(key, ys);
      render();
    }
    function setupCard() {
      const T = tier();
      const pick = h('select', { class: 'ch-tier', 'aria-label': 'Model size' }, Object.entries(TIERS).map(([k, x]) => h('option', { value: k, selected: k === tierKey() ? '' : null }, `${x.label} · ${x.name} · ${x.size}`)));
      pick.addEventListener('change', () => { store.set('llm_tier', pick.value); if (llm.state === 'error') llm.state = 'idle'; render(); });
      if (llm.state === 'nogpu') return h('div', { class: 'ch-setup' }, h('b', null, 'This browser cannot run the on-device analyst'),
        h('p', null, 'It needs WebGPU: Chrome or Edge on a computer, Chrome on Android, or Safari on iOS 26 or macOS 26 and later. Your notes and disputes still work: tap "Save as my research" under anything you write.'));
      if (llm.state === 'loading') return h('div', { class: 'ch-setup' }, h('b', null, llm.p > 0 && llm.p < 1 ? `Downloading the analyst · ${Math.round(llm.p * 100)}%` : 'Starting the analyst on this device'),
        h('div', { class: 'ch-prog' }, h('i', { style: { width: Math.max(3, Math.round(llm.p * 100)) + '%' } })),
        h('small', null, llm.p < 1 ? `${T.label} model, ${T.size}. One time only; keep this open.` : 'Loading into memory. A few seconds.'));
      return h('div', { class: 'ch-setup' },
        h('b', null, llm.state === 'error' ? `Could not start the ${T.label} model here` : 'The analyst runs on this device'),
        h('p', null, llm.state === 'error' ? `${llm.err}. Pick a smaller model and try again.` : `Your questions and research never leave this device. The first time, it downloads the model once (${T.size}); after that it starts in seconds and works offline. Wi-Fi recommended.`),
        pick,
        btn(llm.state === 'error' ? 'Try again' : 'Download and start', () => { llm.pending = true; startEngine(); }, 'primary'));
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
      if (busy && llm.stream) body.append(h('div', { class: 'ch-msg ai' }, h('div', { class: 'ch-bub' }, md(parseTags(llm.stream.replace(/<think>[\s\S]*?(<\/think>|$)/g, '')).clean.replace(/\[\[[^\]]*$/, '')))));
      else if (busy) body.append(h('div', { class: 'ch-msg ai' }, h('div', { class: 'ch-bub ch-typing' }, h('i'), h('i'), h('i'))));
      if (llm.state !== 'ready' && (llm.state !== 'idle' || (xs.length && xs[xs.length - 1].role === 'user'))) body.append(setupCard());
      const mline = panel.querySelector('.ch-model');
      if (mline) mline.textContent = llm.state === 'ready' ? `On this device · ${tier().name}` : 'On this device · not started';
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
      if (llm.state === 'ready') { generate(key); return; }
      if (llm.state === 'loading') { llm.pending = true; render(); return; }
      if (store.get('llm_ok', false) || (await cached())) { llm.pending = true; startEngine(); return; }
      llm.state = (await gpuOk()) ? 'idle' : 'nogpu';
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
            h('div', { class: 'ch-title' }, h('b', null, 'Ask or add your view'), h('small', null, 'Answers from the research shown · runs on this device')),
            h('button', { type: 'button', class: 'ch-new', onclick: () => { saveHist(keyOf(ctxT), []); render(); } }, 'New chat'),
            h('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Close', onclick: close }, icon('close'))),
          h('div', { class: 'ch-bar' }, sel, h('div', { class: 'ch-notes' })),
          h('div', { class: 'ch-body', 'aria-live': 'polite' }),
          h('footer', { class: 'ch-foot' }, h('div', { class: 'ch-comp' }, ta, h('button', { type: 'button', class: 'ch-send', 'aria-label': 'Send', onclick: () => { const v = ta.value; ta.value = ''; grow(); send(v); } }, icon('chev'))),
            h('small', null, h('span', { class: 'ch-model' }, ''), ' · Research discussion, not advice. Notes, disputes and chats stay on this device.')));
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
