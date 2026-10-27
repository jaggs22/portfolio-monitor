/* ui.js: the small kit every screen uses. DOM builder, formatters, icons, theme, and the window manager.
   Windows open over the page, close on Esc, a click outside or the browser back button, and stack (a dispute opens
   over the thesis window). Each window is addressable by URL hash so it can be linked and reopened. */
(function () {
  'use strict';

  function h(tag, attrs) {
    const el = document.createElement(tag);
    if (attrs) {
      for (const k in attrs) {
        const v = attrs[k];
        if (v === null || v === undefined || v === false) continue;
        if (k === 'class') el.className = v;
        else if (k === 'html') el.innerHTML = v; // static strings only
        else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
        else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
        else el.setAttribute(k, v === true ? '' : v);
      }
    }
    for (let i = 2; i < arguments.length; i++) add(el, arguments[i]);
    return el;
  }
  function add(el, kid) {
    if (kid === null || kid === undefined || kid === false) return;
    if (Array.isArray(kid)) { kid.forEach((k) => add(el, k)); return; }
    el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  }

  const num = (x) => (typeof x === 'number' && isFinite(x) ? x : null);
  const fmt = {
    num,
    pct: (x, d) => (num(x) === null ? '–' : (x * 100).toFixed(d == null ? 1 : d) + '%'),
    spct: (x, d) => (num(x) === null ? '–' : (x >= 0 ? '+' : '−') + Math.abs(x * 100).toFixed(d == null ? 1 : d) + '%'),
    pts: (x, d) => (num(x) === null ? '–' : (x >= 0 ? '+' : '−') + Math.abs(x * 100).toFixed(d == null ? 1 : d) + ' pts'),
    mult: (x, d) => (num(x) === null || x <= 0 ? '–' : x.toFixed(d == null ? 1 : d) + 'x'),
    px: (x) => (num(x) === null ? '–' : '$' + (x >= 1000 ? x.toLocaleString('en-US', { maximumFractionDigits: 2, minimumFractionDigits: 2 }) : x.toFixed(2))),
    usdB: (b) => (num(b) === null ? '–' : b >= 1000 ? '$' + (b / 1000).toFixed(2) + 'T' : b >= 100 ? '$' + Math.round(b) + 'B' : '$' + b.toFixed(1) + 'B'),
    usdM: (m) => (num(m) === null ? '–' : Math.abs(m) >= 1e6 ? (m < 0 ? '−' : '') + '$' + (Math.abs(m) / 1e6).toFixed(2) + 'T' : Math.abs(m) >= 1000 ? (m < 0 ? '−' : '') + '$' + (Math.abs(m) / 1000).toFixed(Math.abs(m) >= 10000 ? 1 : 2) + 'B' : (m < 0 ? '−' : '') + '$' + Math.round(Math.abs(m)) + 'M'),
    date: (s) => {
      const d = new Date(String(s).length <= 10 ? s + 'T00:00:00Z' : s);
      if (isNaN(d)) return String(s || '');
      return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
    },
    dayShort: (s) => {
      const d = new Date(s + 'T00:00:00Z');
      return isNaN(d) ? s : d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });
    },
    ago: (ms) => {
      if (!ms) return '';
      const m = Math.round((Date.now() - ms) / 60000);
      if (m < 2) return 'just now';
      if (m < 90) return m + ' min ago';
      if (m < 2880) return Math.round(m / 60) + ' h ago';
      return Math.round(m / 1440) + ' days ago';
    },
    dir: (x) => (num(x) === null ? '' : x > 0 ? 'up' : x < 0 ? 'down' : '')
  };

  /* Icons: 1.5px strokes, 24 grid. */
  const ICON = {
    home: '<path d="M4 11l8-6 8 6v8a1 1 0 0 1-1 1h-4v-6h-6v6H5a1 1 0 0 1-1-1z"/>',
    grid: '<rect x="4" y="4" width="6.5" height="6.5" rx="1.5"/><rect x="13.5" y="4" width="6.5" height="6.5" rx="1.5"/><rect x="4" y="13.5" width="6.5" height="6.5" rx="1.5"/><rect x="13.5" y="13.5" width="6.5" height="6.5" rx="1.5"/>',
    markets: '<path d="M4 16l4.5-5 3.5 3 6-7"/><path d="M4 20h16"/>',
    view: '<circle cx="12" cy="9" r="3.5"/><path d="M5 20c1.2-3.5 4-5 7-5s5.8 1.5 7 5"/>',
    close: '<path d="M6 6l12 12M18 6L6 18"/>',
    back: '<path d="M15 5l-7 7 7 7"/>',
    chev: '<path d="M9 5l7 7-7 7"/>',
    down: '<path d="M6 9l6 6 6-6"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    search: '<circle cx="11" cy="11" r="6"/><path d="M20 20l-4.5-4.5"/>',
    sun: '<circle cx="12" cy="12" r="4"/><path d="M12 3v2M12 19v2M3 12h2M19 12h2M5.6 5.6L7 7M17 17l1.4 1.4M5.6 18.4L7 17M17 7l1.4-1.4"/>',
    moon: '<path d="M19 14.5A7.5 7.5 0 0 1 9.5 5a7.5 7.5 0 1 0 9.5 9.5z"/>',
    dots: '<circle cx="6" cy="12" r="1.2"/><circle cx="12" cy="12" r="1.2"/><circle cx="18" cy="12" r="1.2"/>',
    expand: '<path d="M14 4h6v6M10 20H4v-6M20 4l-7 7M4 20l7-7"/>',
    ext: '<path d="M14 4h6v6M20 4l-9 9"/><path d="M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/>',
    business: '<path d="M4 20V9l8-5 8 5v11"/><path d="M9 20v-6h6v6"/>',
    shield: '<path d="M12 3l7 3v6c0 4.5-3 7.5-7 9-4-1.5-7-4.5-7-9V6z"/>',
    bars: '<path d="M5 20V10M10 20V5M15 20v-8M20 20v-5"/>',
    scale: '<path d="M12 4v16M5 8h14M5 8l-2.5 6a3 3 0 0 0 5 0zM19 8l-2.5 6a3 3 0 0 0 5 0z"/>',
    people: '<circle cx="9" cy="9" r="3"/><circle cx="17" cy="10" r="2.4"/><path d="M3.5 19c.8-3 3-4.5 5.5-4.5s4.7 1.5 5.5 4.5M15 15c2.5-.3 4.6 1 5.3 4"/>',
    tag: '<path d="M4 4h7l9 9-7 7-9-9z"/><circle cx="8.5" cy="8.5" r="1.3"/>',
    branch: '<path d="M6 4v16M6 12c6 0 6-6 12-6M6 12c6 0 6 6 12 6"/>',
    alert: '<path d="M12 4l9 16H3z"/><path d="M12 10v4M12 17h.01"/>',
    line: '<path d="M3 17l5-6 4 3 8-9"/>',
    news: '<rect x="4" y="5" width="16" height="14" rx="2"/><path d="M8 9h8M8 13h8M8 17h5"/>'
  };
  const icon = (id, cls) => h('span', { class: 'ic ' + (cls || ''), 'aria-hidden': 'true', html: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">${ICON[id] || ''}</svg>` });

  /* Brand mark: the keep (an M with battlements) inside a moat ring with a drawbridge gap. Colours follow the theme. */
  const MARK = '<svg viewBox="0 0 64 64" aria-hidden="true"><rect class="lg-t" width="64" height="64" rx="14"/><path class="lg-r" d="M25.33 51.38A20.5 20.5 0 1 1 38.67 51.38" fill="none" stroke-width="2.4" stroke-linecap="round"/><path class="lg-k" d="M21.5 41V22.5h5v3.5h3.25v-3.5h4.5v3.5h3.25v-3.5h5V41h-6v-7.2L32 37.2l-4.5-3.4V41z"/></svg>';
  const logo = (cls) => h('span', { class: 'logo ' + (cls || ''), html: MARK });

  /* Small building blocks */
  const pill = (text, kind) => h('span', { class: 'pill ' + (kind || '') }, text);
  const chg = (x, d) => h('span', { class: 'chg ' + fmt.dir(x) }, fmt.spct(x, d == null ? 2 : d));
  const eyebrow = (text) => h('div', { class: 'eyebrow' }, text);
  const seg = (options, current, onPick, label) => h('div', { class: 'seg', role: 'tablist', 'aria-label': label || 'Options' },
    options.map(([id, text]) => h('button', { type: 'button', role: 'tab', 'aria-selected': String(id === current), onclick: () => onPick(id) }, text)));
  const btn = (text, onclick, kind, attrs) => h('button', Object.assign({ type: 'button', class: 'btn ' + (kind || ''), onclick }, attrs || {}), text);
  const empty = (text) => h('p', { class: 'empty' }, text);
  const note = (text) => h('p', { class: 'note' }, text);
  const stat = (label, value, sub, cls) => h('div', { class: 'stat ' + (cls || '') }, h('div', { class: 'stat-l' }, label), h('div', { class: 'stat-v' }, value), sub ? h('div', { class: 'stat-s' }, sub) : null);

  /* Expandable row: one line visible, the detail on tap. */
  function disclose(summary, detail, opts) {
    const open = !!(opts && opts.open);
    const body = h('div', { class: 'dsc-body' }, detail);
    const row = h('div', { class: 'dsc' + (open ? ' open' : '') },
      h('button', { type: 'button', class: 'dsc-head', 'aria-expanded': String(open), onclick: () => {
        const o = !row.classList.contains('open');
        row.classList.toggle('open', o);
        row.firstChild.setAttribute('aria-expanded', String(o));
      } }, h('span', { class: 'dsc-sum' }, summary), icon('down', 'dsc-ic')),
      body);
    return row;
  }

  /* Sparkline (plain SVG polyline) */
  function spark(values, opts) {
    const o = Object.assign({ w: 120, h: 32, cls: '' }, opts || {});
    const xs = values.filter((v) => num(v) !== null);
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', `0 0 ${o.w} ${o.h}`);
    svg.setAttribute('class', 'spark ' + o.cls);
    svg.setAttribute('preserveAspectRatio', 'none');
    svg.setAttribute('aria-hidden', 'true');
    if (xs.length < 2) return svg;
    const lo = Math.min.apply(null, xs), hi = Math.max.apply(null, xs), sp = hi - lo || 1;
    const pts = values.map((v, i) => (num(v) === null ? null : `${(i / (values.length - 1)) * o.w},${o.h - 2 - ((v - lo) / sp) * (o.h - 4)}`)).filter(Boolean);
    const pl = document.createElementNS('http://www.w3.org/2000/svg', 'polyline');
    pl.setAttribute('points', pts.join(' '));
    pl.setAttribute('fill', 'none');
    pl.setAttribute('vector-effect', 'non-scaling-stroke');
    svg.append(pl);
    return svg;
  }

  /* Share bar: one horizontal bar split into parts */
  function shareBar(parts) {
    const total = parts.reduce((a, p) => a + Math.max(0, p.v), 0) || 1;
    return h('div', { class: 'sharebar', role: 'img', 'aria-label': parts.map((p) => `${p.label} ${Math.round(p.v / total * 100)}%`).join(', ') },
      parts.filter((p) => p.v > 0).map((p, i) => h('i', { style: { width: (p.v / total * 100).toFixed(2) + '%' }, class: 'sb' + (i % 6), title: `${p.label} ${Math.round(p.v / total * 100)}%` })));
  }

  /* ---------- storage ---------- */
  const store = {
    get(k, fb) { try { const v = localStorage.getItem(k); return v === null ? fb : JSON.parse(v); } catch (e) { return fb; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); return true; } catch (e) { return false; } }
  };

  /* ---------- theme ---------- */
  function applyTheme(t) {
    const root = document.documentElement;
    if (t === 'light' || t === 'dark') root.setAttribute('data-theme', t); else root.removeAttribute('data-theme');
    store.set('theme', t || 'system');
  }
  const isDark = () => {
    const t = document.documentElement.getAttribute('data-theme');
    if (t) return t === 'dark';
    return window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
  };
  applyTheme(store.get('theme', 'system'));

  /* ---------- toast ---------- */
  let toastTimer;
  function toast(msg) {
    let t = document.getElementById('toast');
    if (!t) { t = h('div', { id: 'toast', role: 'status', 'aria-live': 'polite' }); document.body.append(t); }
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove('show'), 3200);
  }

  /* ---------- window manager ---------- */
  const stack = [];
  let lastFocus = null;
  function root() {
    let r = document.getElementById('win-root');
    if (!r) { r = h('div', { id: 'win-root' }); document.body.append(r); }
    return r;
  }
  /* spec: { title, sub, build: () => node, wide, key, onClose } */
  function openWin(spec) {
    if (!stack.length) lastFocus = document.activeElement;
    stack.push(spec);
    draw(true);
  }
  function closeWin(all) {
    if (!stack.length) return;
    const gone = all ? stack.splice(0) : [stack.pop()];
    gone.forEach((s) => s.onClose && s.onClose());
    draw(true);
  }
  function refreshWin() { draw(false); }
  function draw(focus) {
    const r = root();
    const top = stack[stack.length - 1];
    if (!top) {
      r.replaceChildren();
      document.body.classList.remove('win-open');
      if (lastFocus && document.contains(lastFocus)) lastFocus.focus({ preventScroll: true });
      return;
    }
    const prevBody = r.querySelector('.win-body');
    const keep = !focus && prevBody ? prevBody.scrollTop : 0;
    const back = stack.length > 1;
    const panel = h('div', { class: 'win' + (top.wide ? ' wide' : ''), role: 'dialog', 'aria-modal': 'true', 'aria-label': top.title },
      h('div', { class: 'win-head' },
        back ? h('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Back', onclick: () => closeWin() }, icon('back')) : null,
        h('div', { class: 'win-titles' },
          top.eyebrow ? h('div', { class: 'eyebrow' }, top.eyebrow) : null,
          h('h2', { class: 'win-title' }, top.title),
          top.sub ? h('div', { class: 'win-sub' }, top.sub) : null),
        h('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Close', onclick: () => closeWin(true) }, icon('close'))),
      h('div', { class: 'win-body' }, top.build()));
    r.replaceChildren(h('div', { class: 'scrim', onclick: () => closeWin(true) }), panel);
    document.body.classList.add('win-open');
    const body = panel.querySelector('.win-body');
    if (focus) { panel.querySelector('.icon-btn').focus({ preventScroll: true }); body.scrollTop = 0; } else body.scrollTop = keep;
  }
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && stack.length) closeWin(); });

  window.UI = { h, fmt, icon, logo, MARK, pill, chg, eyebrow, seg, btn, empty, note, stat, disclose, spark, shareBar, store, applyTheme, isDark, toast,
    win: { open: openWin, close: closeWin, refresh: refreshWin, depth: () => stack.length, top: () => stack[stack.length - 1] } };
})();
