/* BATS.CO scroller — the ticker tape across the top of every page.
 *
 * Replaces the TradingView ticker-tape widget so every number matches the
 * rest of the site (the same Yahoo quotes, via /api/quote), the real VIX
 * can be shown, the 10-year yield reads as a plain percentage, and each
 * item links to its chart on ticker.html.
 *
 * Usage: put <div class="bats-tape" data-bats-tape></div> on the page and
 * load this file. It fills the element, refreshes once a minute while the
 * tab is visible, and scrolls with CSS — paused while the pointer is over
 * it, and standing still (swipe to scroll) for readers who ask their
 * system for reduced motion.
 */
(function () {
  'use strict';

  const ITEMS = [
    { sym: '^GSPC',    label: 'S&P 500' },
    { sym: '^NDX',     label: 'Nasdaq 100' },
    { sym: '^DJI',     label: 'Dow Jones' },
    { sym: '^RUT',     label: 'Russell 2000' },
    { sym: '^VIX',     label: 'VIX' },
    { sym: 'SPY',      label: 'SPY' },
    { sym: 'QQQ',      label: 'QQQ' },
    { sym: '^TNX',     label: '10Y Yield', kind: 'yield' },
    { sym: 'GC=F',     label: 'Gold' },
    { sym: 'CL=F',     label: 'Crude Oil' },
    { sym: 'DX-Y.NYB', label: 'US Dollar' },
    { sym: 'BTC-USD',  label: 'Bitcoin' },
    { sym: 'ETH-USD',  label: 'Ethereum' },
  ];
  const REFRESH_MS = 60000;      // /api/quote is edge-cached for 30s
  const SPEED_PX_PER_S = 40;     // scroll speed

  const CSS = `
    .bats-tape {
      position: relative; overflow: hidden; height: 42px;
      display: flex; align-items: center;
      font-size: 14px; line-height: 1;
      -webkit-mask-image: linear-gradient(90deg, transparent, #000 28px, #000 calc(100% - 28px), transparent);
              mask-image: linear-gradient(90deg, transparent, #000 28px, #000 calc(100% - 28px), transparent);
    }
    .ticker-tape-wrap { border-bottom: 1px solid rgba(139, 149, 168, 0.18); }
    .bats-tape-track {
      display: flex; width: max-content;
      animation: bats-tape-scroll var(--bats-tape-dur, 80s) linear infinite;
    }
    .bats-tape:hover .bats-tape-track,
    .bats-tape:focus-within .bats-tape-track { animation-play-state: paused; }
    .bats-tape-item {
      display: inline-flex; align-items: baseline; gap: 8px;
      padding: 0 20px; white-space: nowrap; text-decoration: none;
      border-right: 1px solid rgba(139, 149, 168, 0.18);
    }
    .bats-tape-name { font-weight: 700; color: #e8ecf4; }
    .bats-tape-item:hover .bats-tape-name,
    .bats-tape-item:focus-visible .bats-tape-name { color: #64d3ff; }
    .bats-tape-px, .bats-tape-chg {
      font-family: 'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      font-variant-numeric: tabular-nums;
    }
    .bats-tape-px  { color: #c9d1dc; }
    .bats-tape-chg { color: #8b95a8; font-size: 13px; }
    .bats-tape-chg.up   { color: #22d39a; }
    .bats-tape-chg.down { color: #ff5374; }
    @keyframes bats-tape-scroll { from { transform: translateX(0); } to { transform: translateX(-50%); } }
    @media (prefers-reduced-motion: reduce) {
      .bats-tape { overflow-x: auto; -webkit-mask-image: none; mask-image: none; }
      .bats-tape-track { animation: none; }
      .bats-tape-track > .bats-tape-copy { display: none; }
    }
    @media print { .bats-tape { display: none !important; } }
    body.chart-only .bats-tape, body.print-mode .bats-tape { display: none !important; }
  `;

  let quotes = null;
  let lastFetch = 0;
  let durationSet = false;

  const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const num = (v, d) => v.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });

  function itemHtml(item, q, copy) {
    const href = 'ticker.html?sym=' + encodeURIComponent(item.sym);
    const tab = copy ? ' tabindex="-1"' : '';
    let px = '—', chg = '', dir = '';
    if (q && Number.isFinite(q.price)) {
      const d = q.dayChange;
      dir = !Number.isFinite(d) || d === 0 ? '' : (d > 0 ? 'up' : 'down');
      const sign = d > 0 ? '+' : d < 0 ? '-' : '';
      if (item.kind === 'yield') {
        // ^TNX is quoted in percent; its daily change reads best in basis points.
        px = num(q.price, 2) + '%';
        if (Number.isFinite(d)) chg = sign + Math.round(Math.abs(d) * 100) + ' bp';
      } else {
        px = num(q.price, 2);
        if (Number.isFinite(d) && Number.isFinite(q.dayChangePct)) {
          chg = sign + num(Math.abs(d), 2) + ' (' + sign + num(Math.abs(q.dayChangePct), 2) + '%)';
        }
      }
    }
    return '<a class="bats-tape-item" href="' + href + '"' + tab + ' title="Open the ' + esc(item.label) + ' chart">' +
             '<span class="bats-tape-name">' + esc(item.label) + '</span>' +
             '<span class="bats-tape-px">' + px + '</span>' +
             (chg ? '<span class="bats-tape-chg ' + dir + '">' + chg + '</span>' : '') +
           '</a>';
  }

  function render(el) {
    const track = el.querySelector('.bats-tape-track');
    if (!track) return;
    const list = copy => ITEMS.map(it => itemHtml(it, quotes && quotes[it.sym], copy)).join('');
    // Two identical halves: the track slides left by exactly one half and
    // loops, so the seam never shows.
    track.innerHTML = '<div class="bats-tape-half" style="display:flex">' + list(false) + '</div>' +
                      '<div class="bats-tape-half bats-tape-copy" style="display:flex" aria-hidden="true">' + list(true) + '</div>';
    // Set the loop duration once real prices are in, from the width of one
    // half, so every page scrolls at the same speed. (Changing it later
    // would make the tape jump.)
    if (!durationSet && quotes) {
      const half = track.firstElementChild;
      const w = half ? half.getBoundingClientRect().width : 0;
      if (w > 0) { track.style.setProperty('--bats-tape-dur', Math.round(w / SPEED_PX_PER_S) + 's'); durationSet = true; }
    }
  }

  async function refresh(els) {
    try {
      const url = '/api/quote?syms=' + encodeURIComponent(ITEMS.map(i => i.sym).join(','));
      const r = await fetch(url, { cache: 'no-store' });
      if (!r.ok) return;
      const j = await r.json();
      if (j && j.quotes && Object.keys(j.quotes).length) {
        quotes = j.quotes;
        lastFetch = Date.now();
        els.forEach(render);
      }
    } catch (e) { /* keep the last prices; try again next tick */ }
  }

  function init() {
    const els = Array.from(document.querySelectorAll('[data-bats-tape]'));
    if (!els.length) return;
    if (!document.getElementById('bats-tape-css')) {
      const style = document.createElement('style');
      style.id = 'bats-tape-css';
      style.textContent = CSS;
      document.head.appendChild(style);
    }
    els.forEach(el => {
      el.classList.add('bats-tape');
      el.setAttribute('role', 'region');
      el.setAttribute('aria-label', 'Market prices');
      el.innerHTML = '<div class="bats-tape-track"></div>';
      render(el);                       // names with dashes until prices land
    });
    refresh(els);
    setInterval(() => { if (!document.hidden) refresh(els); }, REFRESH_MS);
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden && Date.now() - lastFetch > REFRESH_MS) refresh(els);
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
