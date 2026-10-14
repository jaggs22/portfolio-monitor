/* Small SVG chart kit: line/area with crosshair, volume bars, grouped bars with a line overlay. No dependencies.
   Charts measure their container and redraw on resize. Colours come from CSS custom properties. */
(function () {
  'use strict';
  const NS = 'http://www.w3.org/2000/svg';
  const css = (name, fb) => (getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fb);

  function el(tag, attrs, parent) {
    const e = document.createElementNS(NS, tag);
    for (const k in attrs) e.setAttribute(k, attrs[k]);
    if (parent) parent.append(e);
    return e;
  }

  function niceTicks(lo, hi, n) {
    if (!(hi > lo)) { hi = lo + 1; }
    const span = hi - lo, raw = span / Math.max(1, n), p = Math.pow(10, Math.floor(Math.log10(raw)));
    const step = [1, 2, 2.5, 5, 10].map((m) => m * p).find((s) => s >= raw) || 10 * p;
    const a = Math.floor(lo / step) * step, out = [];
    for (let v = a; v <= hi + step * 0.5; v += step) out.push(+v.toFixed(10));
    return out;
  }

  const defaultFmt = (v) => (Math.abs(v) >= 1000 ? Math.round(v).toLocaleString('en-US') : Math.abs(v) >= 100 ? v.toFixed(0) : v.toFixed(2));

  /* spec: { series:[{name,color,points:[[x,y]],width,dash,area}], volume:[[x,v]], height, xFmt(x), yFmt(y), yMin, yMax, xTicks:[x...], label } */
  function lineChart(host, spec) {
    host.classList.add('chart');
    let tip;
    function draw() {
      const W = Math.max(260, host.clientWidth || 600), H = spec.height || 260;
      host.replaceChildren();
      const pad = { l: 8, r: 52, t: 10, b: 22 };
      const volH = spec.volume && spec.volume.length ? 44 : 0;
      const svg = el('svg', { viewBox: `0 0 ${W} ${H}`, width: W, height: H, role: 'img', 'aria-label': spec.label || 'Chart' });
      host.append(svg);
      const all = spec.series.flatMap((s) => s.points);
      if (!all.length) { el('text', { x: W / 2, y: H / 2, 'text-anchor': 'middle', class: 'ch-empty' }, svg).textContent = 'No data'; return; }
      const xs = all.map((p) => p[0]), ys = all.map((p) => p[1]).filter((y) => y != null);
      const x0 = Math.min.apply(null, xs), x1 = Math.max.apply(null, xs);
      let y0 = spec.yMin != null ? spec.yMin : Math.min.apply(null, ys), y1 = spec.yMax != null ? spec.yMax : Math.max.apply(null, ys);
      const padY = (y1 - y0) * 0.06 || 1;
      if (spec.yMin == null) y0 -= padY;
      if (spec.yMax == null) y1 += padY;
      const plotH = H - pad.t - pad.b - volH, plotW = W - pad.l - pad.r;
      const X = (x) => pad.l + (x1 === x0 ? 0 : (x - x0) / (x1 - x0)) * plotW;
      const Y = (y) => pad.t + (1 - (y - y0) / (y1 - y0)) * plotH;
      const grid = css('--rule', '#1E2935'), muted = css('--muted', '#8A97A8');
      const yf = spec.yFmt || defaultFmt;
      niceTicks(y0, y1, 4).filter((v) => v >= y0 && v <= y1).forEach((v) => {
        el('line', { x1: pad.l, x2: W - pad.r, y1: Y(v), y2: Y(v), stroke: grid, 'stroke-width': 1 }, svg);
        const t = el('text', { x: W - pad.r + 6, y: Y(v) + 4, fill: muted, 'font-size': 11 }, svg); t.textContent = yf(v);
      });
      (spec.xTicks || []).forEach((xt) => {
        if (xt < x0 || xt > x1) return;
        const t = el('text', { x: X(xt), y: H - 6, fill: muted, 'font-size': 11, 'text-anchor': 'middle' }, svg);
        t.textContent = spec.xFmt ? spec.xFmt(xt) : xt;
      });
      if (volH) {
        const vmax = Math.max.apply(null, spec.volume.map((v) => v[1])) || 1, base = H - pad.b, bw = Math.max(1, plotW / spec.volume.length * 0.7);
        spec.volume.forEach((v) => el('rect', { x: X(v[0]) - bw / 2, y: base - (v[1] / vmax) * (volH - 6), width: bw, height: (v[1] / vmax) * (volH - 6), fill: grid, opacity: 0.9 }, svg));
      }
      spec.series.forEach((s) => {
        const pts = s.points.filter((p) => p[1] != null);
        if (!pts.length) return;
        const d = pts.map((p, i) => (i ? 'L' : 'M') + X(p[0]).toFixed(1) + ' ' + Y(p[1]).toFixed(1)).join('');
        if (s.area) {
          const id = 'g' + Math.random().toString(36).slice(2, 8);
          const defs = el('defs', {}, svg), g = el('linearGradient', { id, x1: 0, y1: 0, x2: 0, y2: 1 }, defs);
          el('stop', { offset: '0%', 'stop-color': s.color, 'stop-opacity': 0.28 }, g); el('stop', { offset: '100%', 'stop-color': s.color, 'stop-opacity': 0 }, g);
          el('path', { d: d + `L${X(pts[pts.length - 1][0]).toFixed(1)} ${Y(y0)}L${X(pts[0][0]).toFixed(1)} ${Y(y0)}Z`, fill: `url(#${id})` }, svg);
        }
        el('path', { d, fill: 'none', stroke: s.color, 'stroke-width': s.width || 1.6, 'stroke-linejoin': 'round', 'stroke-dasharray': s.dash || null }, svg);
      });
      if (spec.refLine != null && spec.refLine >= y0 && spec.refLine <= y1) {
        el('line', { x1: pad.l, x2: W - pad.r, y1: Y(spec.refLine), y2: Y(spec.refLine), stroke: muted, 'stroke-dasharray': '3 4', 'stroke-width': 1 }, svg);
      }
      const cross = el('line', { y1: pad.t, y2: H - pad.b, stroke: muted, 'stroke-width': 1, opacity: 0 }, svg);
      const dot = el('circle', { r: 3.5, fill: spec.series[0].color, stroke: css('--paper', '#0B0F14'), 'stroke-width': 1.5, opacity: 0 }, svg);
      tip = document.createElement('div'); tip.className = 'chart-tip'; tip.hidden = true; host.append(tip);
      const main = spec.series[0].points.filter((p) => p[1] != null);
      const move = (ev) => {
        const r = svg.getBoundingClientRect(), px = (ev.clientX - r.left) * (W / r.width);
        let lo = 0, hi = main.length - 1;
        while (hi - lo > 1) { const m = (lo + hi) >> 1; if (X(main[m][0]) < px) lo = m; else hi = m; }
        const p = Math.abs(X(main[lo][0]) - px) < Math.abs(X(main[hi][0]) - px) ? main[lo] : main[hi];
        cross.setAttribute('x1', X(p[0])); cross.setAttribute('x2', X(p[0])); cross.setAttribute('opacity', 1);
        dot.setAttribute('cx', X(p[0])); dot.setAttribute('cy', Y(p[1])); dot.setAttribute('opacity', 1);
        const extra = spec.series.slice(1).map((s) => { const q = s.points.find((z) => z[0] === p[0]); return q && q[1] != null ? `${s.name} ${yf(q[1])}` : null; }).filter(Boolean);
        tip.textContent = `${spec.tipFmt ? spec.tipFmt(p[0]) : p[0]}  ${yf(p[1])}${extra.length ? '  ·  ' + extra.join('  ·  ') : ''}`;
        tip.hidden = false;
        tip.style.left = Math.min(Math.max(8, X(p[0]) - 60), W - 190) + 'px';
      };
      const leave = () => { cross.setAttribute('opacity', 0); dot.setAttribute('opacity', 0); tip.hidden = true; };
      svg.addEventListener('pointermove', move); svg.addEventListener('pointerdown', move); svg.addEventListener('pointerleave', leave);
    }
    draw();
    if (typeof ResizeObserver !== 'undefined') {
      let w = host.clientWidth;
      const ro = new ResizeObserver(() => { if (Math.abs(host.clientWidth - w) > 4) { w = host.clientWidth; draw(); } });
      ro.observe(host);
    }
    return { redraw: draw, update(s) { spec = s; draw(); } };
  }

  /* spec: { labels:[..], bars:[{name,color,values:[..]}], line:{name,color,values:[..],fmt}, fmt, height } */
  function barChart(host, spec) {
    host.classList.add('chart');
    function draw() {
      const W = Math.max(260, host.clientWidth || 600), H = spec.height || 220;
      host.replaceChildren();
      const hasLine = spec.line && spec.line.values.some((v) => v != null);
      const pad = { l: 8, r: hasLine ? 46 : 8, t: 10, b: 24 };
      const svg = el('svg', { viewBox: `0 0 ${W} ${H}`, width: W, height: H, role: 'img', 'aria-label': spec.label || 'Bar chart' });
      host.append(svg);
      const n = spec.labels.length;
      if (!n) return;
      const vals = spec.bars.flatMap((b) => b.values).filter((v) => v != null);
      let lo = Math.min(0, Math.min.apply(null, vals)), hi = Math.max(0, Math.max.apply(null, vals));
      if (hi === lo) hi = lo + 1;
      const plotH = H - pad.t - pad.b, plotW = W - pad.l - pad.r;
      const Y = (v) => pad.t + (1 - (v - lo) / (hi - lo)) * plotH;
      const grid = css('--rule', '#1E2935'), muted = css('--muted', '#8A97A8');
      el('line', { x1: pad.l, x2: W - pad.r, y1: Y(0), y2: Y(0), stroke: muted, 'stroke-width': 1 }, svg);
      const slot = plotW / n, gw = slot * 0.74, bw = gw / spec.bars.length;
      spec.bars.forEach((b, bi) => b.values.forEach((v, i) => {
        if (v == null) return;
        const x = pad.l + i * slot + (slot - gw) / 2 + bi * bw, y = Y(Math.max(0, v)), h = Math.abs(Y(v) - Y(0));
        const rect = el('rect', { x, y, width: Math.max(1, bw - 1), height: Math.max(1, h), rx: 1.5, fill: v < 0 && b.negColor ? b.negColor : b.color }, svg);
        const t = el('title', {}, rect); t.textContent = `${spec.labels[i]}: ${(spec.fmt || defaultFmt)(v)}`;
      }));
      const step = Math.ceil(n / Math.max(2, Math.floor(plotW / 54)));
      spec.labels.forEach((l, i) => {
        if (i % step && i !== n - 1) return;
        const t = el('text', { x: pad.l + i * slot + slot / 2, y: H - 7, fill: muted, 'font-size': 11, 'text-anchor': 'middle' }, svg); t.textContent = l;
      });
      if (hasLine) {
        const lv = spec.line.values, mn = Math.min.apply(null, lv.filter((v) => v != null)), mx = Math.max.apply(null, lv.filter((v) => v != null));
        const span = mx - mn || 1, LY = (v) => pad.t + (1 - (v - (mn - span * 0.1)) / (span * 1.2)) * plotH;
        const d = lv.map((v, i) => (v == null ? null : [pad.l + i * slot + slot / 2, LY(v)])).filter(Boolean);
        el('path', { d: d.map((p, i) => (i ? 'L' : 'M') + p[0].toFixed(1) + ' ' + p[1].toFixed(1)).join(''), fill: 'none', stroke: spec.line.color, 'stroke-width': 1.8 }, svg);
        d.forEach((p, i) => { el('circle', { cx: p[0], cy: p[1], r: 2.4, fill: spec.line.color }, svg); });
        const lt = el('text', { x: W - pad.r + 5, y: LY(lv.filter((v) => v != null).slice(-1)[0]) + 4, fill: spec.line.color, 'font-size': 11 }, svg);
        lt.textContent = (spec.line.fmt || defaultFmt)(lv.filter((v) => v != null).slice(-1)[0]);
      }
    }
    draw();
    if (typeof ResizeObserver !== 'undefined') {
      let w = host.clientWidth;
      new ResizeObserver(() => { if (Math.abs(host.clientWidth - w) > 4) { w = host.clientWidth; draw(); } }).observe(host);
    }
    return { redraw: draw };
  }

  function spark(values, color, w, h) {
    const vs = values.filter((v) => v != null);
    const svg = el('svg', { viewBox: `0 0 ${w} ${h}`, width: w, height: h, class: 'spark', 'aria-hidden': 'true' });
    if (vs.length < 2) return svg;
    const lo = Math.min.apply(null, vs), hi = Math.max.apply(null, vs), sp = hi - lo || 1;
    el('path', { d: vs.map((v, i) => (i ? 'L' : 'M') + (i / (vs.length - 1) * w).toFixed(1) + ' ' + (h - 2 - ((v - lo) / sp) * (h - 4)).toFixed(1)).join(''), fill: 'none', stroke: color, 'stroke-width': 1.5, 'stroke-linejoin': 'round' }, svg);
    return svg;
  }

  window.Charts = { lineChart, barChart, spark };
})();
