/* Markets tab: a live board of the covered names (our own feed) plus TradingView's free embeddable widgets for
   charting, heatmap, overview and technicals. The TradingView widgets run in the browser and show the data TradingView
   allows on its free tier (delayed for most US exchanges); they cost nothing and need no key. */
(function () {
  'use strict';
  const D = window.DataApi, C = window.Charts;

  const EXCHANGE = { MSFT: 'NASDAQ', GOOGL: 'NASDAQ', COST: 'NASDAQ', AMZN: 'NASDAQ', LIN: 'NASDAQ', MU: 'NASDAQ' };
  const tvSymbol = (t) => `${EXCHANGE[t] || 'NYSE'}:${t}`;
  const SRC = 'https://s3.tradingview.com/external-embedding/';

  /* Mount one TradingView widget. config is the JSON the widget reads from its script body. */
  function tvWidget(name, config, height) {
    const box = document.createElement('div');
    box.className = 'tradingview-widget-container tv-box';
    box.style.height = height + 'px';
    const inner = document.createElement('div');
    inner.className = 'tradingview-widget-container__widget';
    inner.style.height = '100%';
    const s = document.createElement('script');
    s.type = 'text/javascript'; s.async = true; s.src = `${SRC}embed-widget-${name}.js`;
    s.text = JSON.stringify(Object.assign({ colorTheme: 'dark', isTransparent: true, locale: 'en' }, config));
    box.append(inner);
    box.dataset.pending = '1';
    box._mount = () => { if (box.dataset.pending) { delete box.dataset.pending; box.append(s); } };
    return box;
  }

  function lazyMount(boxes) {
    if (typeof IntersectionObserver === 'undefined') { boxes.forEach((b) => b._mount()); return; }
    const io = new IntersectionObserver((es) => es.forEach((e) => { if (e.isIntersecting) { e.target._mount(); io.unobserve(e.target); } }), { rootMargin: '300px' });
    boxes.forEach((b) => io.observe(b));
  }

  window.makeMarketsUI = function (kit) {
    const { h, state, nameOf } = kit;
    const view = state.mk = state.mk || { symbol: 'V', tape: true };

    function board() {
      const tickers = state.data.universe.map((u) => u.ticker);
      const body = h('tbody');
      const status = h('span', { class: 'small muted' });
      const draw = () => {
        const L = D.live;
        const q = state.mkQuotes && state.mkQuotes.quotes ? state.mkQuotes.quotes : {};
        body.replaceChildren(...tickers.map((t) => {
          const lq = L.quotes[t], pq = q[t], m = state.data.market.stocks[t];
          const price = lq ? lq.price : pq ? pq.price : m ? m.price : null;
          const chg = lq && lq.change_pct != null ? lq.change_pct / 100 : pq && pq.pct != null ? pq.pct / 100 : m && m.chg != null ? m.chg / 100 : null;
          const tier = (state.uniMap[t] || {}).tier;
          const prev = state.mkPrev && state.mkPrev[t];
          const flash = prev != null && price != null && price !== prev ? (price > prev ? ' flash-up' : ' flash-down') : '';
          return h('tr', { class: 'mk-row' + flash, onclick: () => kit.openStock(t), tabindex: '0', role: 'button', onkeydown: (e) => { if (e.key === 'Enter') kit.openStock(t); } },
            h('th', { scope: 'row' }, h('span', { class: 'tickers' }, t), h('span', { class: 'small muted mk-name' }, ' ' + nameOf(t))),
            h('td', { class: 'num' }, price != null ? '$' + price.toFixed(2) : 'n/a'),
            h('td', { class: 'num chg ' + (chg > 0 ? 'up' : chg < 0 ? 'down' : '') }, chg == null ? 'n/a' : (chg >= 0 ? '+' : '-') + Math.abs(chg * 100).toFixed(2) + '%'),
            h('td', null, tier === 'core' ? h('span', { class: 'pill moderate' }, 'Core') : tier === 'lighter' ? h('span', { class: 'pill' }, 'Lighter') : null));
        }));
        state.mkPrev = Object.fromEntries(tickers.map((t) => [t, L.quotes[t] ? L.quotes[t].price : null]));
        status.textContent = L.ok && L.asof ? `Live feed, updated ${new Date(L.asof).toLocaleTimeString()}. Refreshes every 30 seconds while this tab is open.`
          : state.mkQuotes && state.mkQuotes.asof ? `Pipeline snapshot from ${state.mkQuotes.asof.replace('T', ' ').slice(0, 16)} UTC. The live feed is not answering, so this refreshes every ten minutes in market hours.`
            : 'Snapshot prices from the last data build. The live feed is not answering.';
      };
      D.get('quotes').then((r) => { state.mkQuotes = r.data; draw(); });
      draw();
      const unsub = D.subscribe(tickers, draw);
      state.mkUnsub = unsub;
      return h('section', { class: 'rsec' }, h('h3', null, 'Covered names'),
        h('div', { class: 'tbl-wrap' }, h('table', { class: 'tbl mk-board' }, h('thead', null, h('tr', null, ['', 'Price', 'Day', ''].map((x) => h('th', { scope: 'col' }, x)))), body)),
        status);
    }

    function chartBlock() {
      const tickers = state.data.universe.map((u) => u.ticker);
      const holder = h('div', { class: 'tv-holder' });
      const mount = () => {
        const w = tvWidget('advanced-chart', { symbol: tvSymbol(view.symbol), interval: 'D', timezone: 'America/New_York', theme: 'dark', style: '1', withdateranges: true, allow_symbol_change: true, hide_side_toolbar: true, save_image: false, autosize: true, studies: ['STD;SMA'] }, 460);
        holder.replaceChildren(w);
        lazyMount([w]);
      };
      const chips = h('div', { class: 'seg-group', role: 'group', 'aria-label': 'Chart symbol' }, tickers.map((t) =>
        h('button', { type: 'button', class: 'seg', 'aria-pressed': String(view.symbol === t), onclick: (e) => {
          view.symbol = t;
          e.currentTarget.parentNode.querySelectorAll('.seg').forEach((b) => b.setAttribute('aria-pressed', String(b.textContent === t)));
          mount();
        } }, t)));
      mount();
      return h('section', { class: 'rsec' }, h('h3', null, 'Live chart'), chips, holder,
        h('p', { class: 'small muted' }, 'TradingView’s free chart widget. Most US quotes are delayed by up to 15 minutes on the free tier. The widget lets you change interval, add indicators and draw.'));
    }

    function widgets() {
      const all = state.data.universe.map((u) => u.ticker);
      const overview = tvWidget('market-overview', {
        dateRange: '1D', showChart: true, width: '100%', height: 420, showSymbolLogo: false, showFloatingTooltip: false,
        tabs: [
          { title: 'Indices', symbols: [{ s: 'FOREXCOM:SPXUSD', d: 'S&P 500' }, { s: 'FOREXCOM:NSXUSD', d: 'Nasdaq 100' }, { s: 'FOREXCOM:DJI', d: 'Dow Jones' }, { s: 'CAPITALCOM:RTY', d: 'Russell 2000' }, { s: 'CBOE:VIX', d: 'VIX' }] },
          { title: 'Core', symbols: ['V', 'LIN', 'LLY', 'MU', 'PG'].map((t) => ({ s: tvSymbol(t), d: nameOf(t) })) },
          { title: 'Basic view', symbols: all.filter((t) => !['V', 'LIN', 'LLY', 'MU', 'PG'].includes(t)).map((t) => ({ s: tvSymbol(t), d: nameOf(t) })) }
        ] }, 440);
      const heat = tvWidget('stock-heatmap', { exchanges: [], dataSource: 'SPX500', grouping: 'sector', blockSize: 'market_cap_basic', blockColor: 'change', hasTopBar: false, isDataSetEnabled: false, isZoomEnabled: true, hasSymbolTooltip: true, width: '100%', height: 420 }, 440);
      const tech = tvWidget('technical-analysis', { symbol: tvSymbol(view.symbol), interval: '1D', width: '100%', height: 400, showIntervalTabs: true }, 420);
      lazyMount([overview, heat, tech]);
      return [
        h('section', { class: 'rsec' }, h('h3', null, 'Markets today'), overview),
        h('section', { class: 'rsec' }, h('h3', null, 'S&P 500 heatmap'), heat, h('p', { class: 'small muted' }, 'Block size is market value, colour is today’s move. It shows the whole index, not just the covered names.')),
        h('section', { class: 'rsec' }, h('h3', null, 'Technical summary for ' + view.symbol), tech, h('p', { class: 'small muted' }, 'TradingView’s own oscillator and moving-average tally. Change the symbol in the chart above, then reopen this tab to refresh it.'))
      ];
    }

    function tape() {
      const t = tvWidget('ticker-tape', { symbols: state.data.universe.map((u) => ({ proName: tvSymbol(u.ticker), title: u.ticker })), showSymbolLogo: false, displayMode: 'adaptive' }, 76);
      lazyMount([t]);
      return t;
    }

    function build() {
      if (state.mkUnsub) { state.mkUnsub(); state.mkUnsub = null; }
      return [
        h('section', null, h('h2', null, 'Markets'), tape()),
        board(),
        chartBlock(),
        ...widgets(),
        h('p', { class: 'small muted' }, 'Widgets are provided by TradingView and load from their servers. If your network blocks them, the covered-names board above still works from this app’s own feed.')
      ];
    }
    return { build, tvSymbol };
  };
})();
