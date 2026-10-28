/* install.js: the app asks to be installed the moment a phone opens it, instead of waiting for the browser.
   No mobile browser lets a page install itself without a tap, so the app does everything up to that tap:
   - Android (Chrome, Edge, Samsung, Opera, Brave): catches the browser's install event and offers its own Install
     button, which opens the real install dialog in one tap.
   - iPhone and iPad (Safari, Chrome, Edge, Firefox): Apple offers no install API, so it shows the exact steps with
     the icons the user will see.
   - In-app browsers (WhatsApp, Instagram, LinkedIn and so on) cannot install apps; it asks to open the link in the
     real browser and offers to copy it.
   It shows before sign-in, because on iPhone an installed app keeps its own storage, separate from Safari. */
(function () {
  'use strict';
  const ua = navigator.userAgent || '';
  const standalone = () => matchMedia('(display-mode: standalone)').matches || matchMedia('(display-mode: fullscreen)').matches || navigator.standalone === true;
  const isIOS = /iPhone|iPad|iPod/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const isAndroid = /Android/.test(ua);
  const mobile = isIOS || isAndroid || /Mobile/.test(ua);
  const inApp = /FBAN|FBAV|Instagram|LinkedInApp|Line\/|Twitter|MicroMessenger|WhatsApp|Snapchat|TikTok|GSA\//.test(ua);
  const browser = isIOS ? (/CriOS/.test(ua) ? 'chrome' : /EdgiOS/.test(ua) ? 'edge' : /FxiOS/.test(ua) ? 'firefox' : 'safari')
    : /SamsungBrowser/.test(ua) ? 'samsung' : /Firefox/.test(ua) ? 'firefox' : /EdgA/.test(ua) ? 'edge' : /OPR\//.test(ua) ? 'opera' : 'chrome';
  const SNOOZE = 'install_snooze_until';
  let deferred = null;

  window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); deferred = e; refresh(); });
  window.addEventListener('appinstalled', () => { deferred = null; close(); try { localStorage.setItem(SNOOZE, String(Date.now() + 3650 * 864e5)); } catch (x) { /* ignore */ } });

  const svg = (d, cls) => `<svg class="${cls || ''}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
  const ICON = {
    share: svg('<path d="M12 3v12M8 7l4-4 4 4"/><path d="M6 11H5a1 1 0 0 0-1 1v8a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-8a1 1 0 0 0-1-1h-1"/>'),
    add: svg('<rect x="4" y="4" width="16" height="16" rx="4"/><path d="M12 8.5v7M8.5 12h7"/>'),
    more: svg('<circle cx="6" cy="12" r="1.3"/><circle cx="12" cy="12" r="1.3"/><circle cx="18" cy="12" r="1.3"/>'),
    kebab: svg('<circle cx="12" cy="6" r="1.3"/><circle cx="12" cy="12" r="1.3"/><circle cx="12" cy="18" r="1.3"/>'),
    menu: svg('<path d="M5 7h14M5 12h14M5 17h14"/>'),
    phone: svg('<rect x="7" y="3" width="10" height="18" rx="2.5"/><path d="M11 18h2"/>'),
    check: svg('<path d="M5 12.5l4.5 4.5L19 7.5"/>')
  };
  const step = (n, html) => `<li><span class="ins-n">${n}</span><span class="ins-s">${html}</span></li>`;
  const k = (ic, label) => `<b class="ins-k">${ICON[ic]}${label ? `<span>${label}</span>` : ''}</b>`;

  function steps() {
    if (inApp) return { lead: 'This in-app browser cannot install apps. Open the link in your phone’s browser, then install from there.', list: [
      step(1, `Tap ${k('more')} or ${k('kebab')} in this window`),
      step(2, `Choose <b>Open in ${isIOS ? 'Safari' : 'Chrome'}</b> (or Open in browser)`)], copy: true };
    if (isIOS) {
      if (browser === 'safari') return { lead: 'Three taps. It then opens full screen from your home screen, like any app.', list: [
        step(1, `Tap ${k('share', 'Share')} in the toolbar. If you only see ${k('more')}, tap it first, then Share.`),
        step(2, `Scroll down and tap ${k('add', 'Add to Home Screen')}`),
        step(3, 'If you see <b>Open as Web App</b>, keep it on. Tap <b>Add</b>')] };
      return { lead: 'Three taps. It then opens full screen from your home screen, like any app.', list: [
        step(1, `Tap ${k('share', 'Share')} ${browser === 'chrome' ? 'at the top right of the address bar' : browser === 'firefox' ? `inside the ${k('menu')} menu` : `inside the ${k('more')} menu`}`),
        step(2, `Tap ${k('add', 'Add to Home Screen')}`),
        step(3, 'Tap <b>Add</b>')] };
    }
    if (deferred) return { lead: 'Full screen, faster to open, and one tap from your home screen.', list: [], install: true };
    const where = browser === 'samsung' ? [step(1, `Tap ${k('menu')} at the bottom`), step(2, 'Tap <b>Add page to</b>, then <b>Home screen</b>')]
      : browser === 'firefox' ? [step(1, `Tap ${k('kebab')}`), step(2, 'Tap <b>Install</b> or <b>Add to Home screen</b>')]
      : [step(1, `Tap ${k('kebab')} at the top right`), step(2, 'Tap <b>Install app</b> or <b>Add to Home screen</b>')];
    return { lead: 'Two taps. It then opens full screen from your home screen, like any app.', list: where };
  }

  let sheet = null;
  function close() { if (sheet) { sheet.remove(); sheet = null; document.body.classList.remove('ins-open'); } }
  function snooze(days) { try { localStorage.setItem(SNOOZE, String(Date.now() + days * 864e5)); } catch (x) { /* ignore */ } close(); }
  function render() {
    const s = steps();
    sheet.querySelector('.ins-lead').textContent = s.lead;
    sheet.querySelector('.ins-steps').innerHTML = s.list.join('');
    sheet.querySelector('.ins-steps').hidden = !s.list.length;
    const act = sheet.querySelector('.ins-act');
    act.innerHTML = '';
    if (s.install) {
      const b = document.createElement('button');
      b.type = 'button'; b.className = 'btn primary ins-go'; b.innerHTML = `${ICON.phone}<span>Install Moat Monitor</span>`;
      b.onclick = async () => { const d = deferred; if (!d) return; d.prompt(); const r = await d.userChoice.catch(() => null); deferred = null; if (r && r.outcome === 'accepted') close(); else render(); };
      act.append(b);
    }
    if (s.copy) {
      const b = document.createElement('button');
      b.type = 'button'; b.className = 'btn ins-go'; b.textContent = 'Copy link';
      b.onclick = () => { (navigator.clipboard ? navigator.clipboard.writeText(location.href) : Promise.reject()).then(() => { b.textContent = 'Link copied'; }, () => { b.textContent = location.host; }); };
      act.append(b);
    }
    const later = document.createElement('button');
    later.type = 'button'; later.className = 'ins-later'; later.textContent = 'Not now, use it in the browser';
    later.onclick = () => snooze(3);
    act.append(later);
  }
  function refresh() { if (sheet) render(); }
  function open(force) {
    if (standalone() || sheet) return;
    if (!force) {
      if (!mobile) return;
      let until = 0;
      try { until = Number(localStorage.getItem(SNOOZE)) || 0; } catch (x) { /* ignore */ }
      if (until > Date.now()) return;
    }
    const logo = (window.UI && window.UI.MARK) || '';
    sheet = document.createElement('div');
    sheet.className = 'ins';
    sheet.setAttribute('role', 'dialog');
    sheet.setAttribute('aria-modal', 'true');
    sheet.setAttribute('aria-labelledby', 'ins-h');
    sheet.innerHTML = `<div class="ins-card">
      <div class="ins-top"><span class="ins-logo">${logo}</span><div><h2 id="ins-h">Get the Moat Monitor app</h2><p class="ins-lead"></p></div></div>
      <ol class="ins-steps"></ol>
      <div class="ins-act"></div></div>`;
    sheet.addEventListener('click', (e) => { if (e.target === sheet) snooze(3); });
    document.body.append(sheet);
    document.body.classList.add('ins-open');
    render();
    // Android: if the browser's install event has not arrived yet, give it a moment, then re-render with the button.
    if (isAndroid && !deferred) setTimeout(refresh, 2500);
  }
  window.MoatInstall = { open: () => open(true), available: () => mobile && !standalone() };
  const start = () => open(false);
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();
})();
