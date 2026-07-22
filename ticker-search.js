// Shared ticker-search bar — injected on every page except index.html so
// visitors can pull up any stock's chart from wherever they land. If a
// page already renders its own search (quotes / watchlist / ticker), we
// skip the inject so we don't duplicate the box.
//
// The injected bar slides in as a compact strip right below the site
// header. Same behavior as the existing search: type a symbol, press
// Enter or GO, land on ticker.html?sym=X.

(function () {
  // Bail if this page already has its own search form — no duplicates.
  if (document.getElementById('tickerSearchForm')) return;
  // Homepage explicitly opts out via body[data-no-ticker-search].
  if (document.body && document.body.hasAttribute('data-no-ticker-search')) return;

  const CSS = `
    .gts-bar {
      background: var(--bg, #0a1218);
      border-bottom: 1px solid var(--border, #223347);
      padding: 0.5rem 1rem;
    }
    .gts-form {
      max-width: 720px;
      margin: 0 auto;
      display: flex;
      align-items: center;
      gap: 0.55rem;
    }
    .gts-form label {
      font-family: 'JetBrains Mono', ui-monospace, monospace;
      font-size: 0.72rem;
      letter-spacing: 0.08em;
      text-transform: uppercase;
      color: var(--text-dim, #8892a6);
      white-space: nowrap;
    }
    .gts-form input {
      flex: 1;
      min-width: 0;
      font: inherit;
      font-family: 'JetBrains Mono', monospace;
      font-size: 0.9rem;
      font-weight: 600;
      letter-spacing: 0.04em;
      padding: 0.4rem 0.7rem;
      background: rgba(255, 255, 255, 0.04);
      border: 1px solid var(--border, #223347);
      border-radius: 4px;
      color: var(--text, #e6edf3);
    }
    .gts-form input::placeholder { color: var(--text-dim, #8892a6); font-weight: 500; }
    .gts-form input:focus {
      outline: none;
      border-color: var(--warn, #ffb658);
      background: rgba(255, 182, 88, 0.06);
    }
    .gts-form button {
      font: inherit;
      font-family: 'JetBrains Mono', monospace;
      font-size: 0.78rem;
      font-weight: 700;
      letter-spacing: 0.05em;
      padding: 0.4rem 1rem;
      background: var(--warn, #ffb658);
      color: #0a1218;
      border: 1px solid var(--warn, #ffb658);
      border-radius: 4px;
      cursor: pointer;
      white-space: nowrap;
    }
    .gts-form button:hover { filter: brightness(1.1); }
    @media (max-width: 480px) {
      .gts-form label { display: none; }
    }
  `;
  const style = document.createElement('style');
  style.textContent = CSS;
  document.head.appendChild(style);

  const bar = document.createElement('div');
  bar.className = 'gts-bar';
  bar.innerHTML = `
    <form class="gts-form" id="tickerSearchForm" role="search" aria-label="Ticker lookup">
      <label for="tickerSearchInput">Look up any ticker &rarr;</label>
      <input type="text" id="tickerSearchInput" placeholder="AAPL, NVDA, SPY…" autocomplete="off" spellcheck="false" required />
      <button type="submit">GO &rarr;</button>
    </form>
  `;

  // Prefer inserting right after the site header so it sits above the
  // page content but below the brand + nav. Fallback: prepend to <main>.
  function mount() {
    const header = document.querySelector('.site-header');
    if (header && header.parentNode) {
      header.parentNode.insertBefore(bar, header.nextSibling);
    } else {
      const main = document.querySelector('main');
      (main || document.body).prepend(bar);
    }
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', mount, { once: true });
  } else {
    mount();
  }

  document.addEventListener('submit', (e) => {
    const form = e.target.closest('#tickerSearchForm.gts-form');
    if (!form) return;
    e.preventDefault();
    const input = form.querySelector('#tickerSearchInput');
    const raw = ((input && input.value) || '').trim().toUpperCase();
    if (!raw) return;
    const sym = raw.replace(/[^A-Z0-9.\-\^]/g, '');
    if (!sym) return;
    window.location.href = 'ticker.html?sym=' + encodeURIComponent(sym);
  });
})();
