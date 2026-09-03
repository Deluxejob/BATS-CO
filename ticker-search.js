// Shared ticker-search bar + autocomplete controller.
//
// Two jobs:
//   1. On pages that don't have their own search form, inject a compact
//      strip right below the site header (skipped by opting out via
//      body[data-no-ticker-search], or if the page already has a
//      #tickerSearchForm — quotes / watchlist / ticker do).
//   2. On EVERY page load, attach a Yahoo-backed autocomplete dropdown
//      to any known search input on the page (#tickerSearchInput OR
//      #homeTickerSearchInput). That way "apple" resolves to AAPL
//      without the visitor knowing the ticker.
//
// Autocomplete backing: /api/search?q=... (Vercel serverless proxy of
// Yahoo Finance's search endpoint). Debounced ~200ms so we're not
// firing on every keystroke. Keyboard navigable (↑↓ + Enter + Esc).
// Row click OR Enter-on-selection navigates to ticker.html?sym=X#top.

(function () {

  // ==========================================================
  //  AUTOCOMPLETE controller — reusable across all search inputs
  // ==========================================================

  const AUTO_CSS = `
    .ta-wrap { position: relative; }
    .ta-menu {
      position: absolute;
      top: 100%; left: 0; right: 0;
      z-index: 1000;
      margin-top: 4px;
      background: var(--bg-elevated, #0f1a24);
      border: 1px solid var(--border, #223347);
      border-radius: 6px;
      box-shadow: 0 12px 28px rgba(0,0,0,0.45);
      max-height: 320px;
      overflow-y: auto;
      font-family: 'JetBrains Mono', ui-monospace, monospace;
      font-size: 0.78rem;
    }
    .ta-menu[hidden] { display: none; }
    .ta-row {
      display: grid;
      grid-template-columns: minmax(70px, auto) 1fr auto;
      gap: 0.6rem;
      padding: 0.5rem 0.7rem;
      cursor: pointer;
      border-bottom: 1px solid rgba(34, 51, 71, 0.4);
      color: var(--text, #e6edf3);
      transition: background 0.08s;
    }
    .ta-row:last-child { border-bottom: none; }
    .ta-row:hover, .ta-row.ta-active {
      background: rgba(255, 182, 88, 0.10);
    }
    .ta-sym {
      font-weight: 700;
      color: var(--warn, #ffb658);
      letter-spacing: 0.05em;
    }
    .ta-name {
      color: var(--text, #e6edf3);
      font-family: 'Inter', sans-serif;
      font-size: 0.8rem;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      min-width: 0;
    }
    .ta-meta {
      color: var(--text-dim, #8892a6);
      font-size: 0.66rem;
      letter-spacing: 0.06em;
      text-transform: uppercase;
      white-space: nowrap;
      align-self: center;
    }
    .ta-empty {
      padding: 0.6rem 0.7rem;
      color: var(--text-dim, #8892a6);
      font-style: italic;
      font-size: 0.72rem;
      text-align: center;
    }
  `;
  let autoCssInjected = false;
  function ensureAutoCss() {
    if (autoCssInjected) return;
    autoCssInjected = true;
    const s = document.createElement('style');
    s.textContent = AUTO_CSS;
    document.head.appendChild(s);
  }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[<>&"']/g, c => (
      {'<':'&lt;','>':'&gt;','&':'&amp;','"':'&quot;',"'":'&#39;'}[c]
    ));
  }

  function goToSymbol(sym) {
    if (!sym) return;
    // Same navigation shape as the plain form-submit handler below —
    // /ticker.html?sym=XXX#top scrolls into the ticker page header.
    window.location.href = 'ticker.html?sym=' + encodeURIComponent(sym) + '#top';
  }

  // Attach the autocomplete controller to a single (input, form) pair.
  // Safe to call more than once with the same input — idempotent via
  // a flag on the element.
  function attachAutocomplete(input) {
    if (!input || input.dataset.taAttached === '1') return;
    input.dataset.taAttached = '1';
    ensureAutoCss();

    // Wrap the input so the dropdown can absolute-position under it.
    // If the input already lives inside a flex-item with something else
    // (the form's Go button, a label), we insert the wrapper AROUND
    // just the input.
    const wrap = document.createElement('div');
    wrap.className = 'ta-wrap';
    input.parentNode.insertBefore(wrap, input);
    wrap.appendChild(input);

    const menu = document.createElement('div');
    menu.className = 'ta-menu';
    menu.hidden = true;
    menu.setAttribute('role', 'listbox');
    wrap.appendChild(menu);

    let debounceId = null;
    let lastQuery = '';
    let lastResults = [];
    let activeIdx = -1;
    let requestSeq = 0;

    function close() {
      menu.hidden = true;
      activeIdx = -1;
    }

    function renderRows(results) {
      lastResults = results;
      if (!results.length) {
        menu.innerHTML = '<div class="ta-empty">No matches. Press Enter to search as ticker.</div>';
        menu.hidden = false;
        activeIdx = -1;
        return;
      }
      menu.innerHTML = results.map((r, i) => {
        // Native browser tooltip on the row — shows the untruncated
        // "SYM — Full Company Name" pair after a short hover, so a
        // reader who sees only "Apple Ho…" or "Microsoft Corp…"
        // ellipsized in the row can hover to confirm it's the right one.
        const tip = esc(r.symbol) + ' — ' + esc(r.name);
        return `
          <div class="ta-row" role="option" data-idx="${i}" data-sym="${esc(r.symbol)}" title="${tip}">
            <span class="ta-sym">${esc(r.symbol)}</span>
            <span class="ta-name">${esc(r.name)}</span>
            <span class="ta-meta">${esc(r.type)}${r.exchange ? ' · ' + esc(r.exchange) : ''}</span>
          </div>
        `;
      }).join('');
      menu.hidden = false;
      activeIdx = -1;
    }

    function highlight() {
      const rows = menu.querySelectorAll('.ta-row');
      rows.forEach((r, i) => r.classList.toggle('ta-active', i === activeIdx));
      const el = rows[activeIdx];
      if (el) el.scrollIntoView({ block: 'nearest' });
    }

    async function runSearch(q) {
      const mySeq = ++requestSeq;
      try {
        const r = await fetch('/api/search?q=' + encodeURIComponent(q), { cache: 'no-store' });
        if (mySeq !== requestSeq) return;         // out-of-order — a newer query has been fired
        if (!r.ok) return close();
        const j = await r.json();
        if (mySeq !== requestSeq) return;
        renderRows(Array.isArray(j.results) ? j.results : []);
      } catch (_) {
        close();
      }
    }

    input.addEventListener('input', () => {
      const q = input.value.trim();
      lastQuery = q;
      if (debounceId) clearTimeout(debounceId);
      if (q.length < 1) { close(); return; }
      // Debounce so we're not firing on every keystroke — 200ms hits
      // Yahoo often enough to feel live but coalesces bursts.
      debounceId = setTimeout(() => runSearch(q), 200);
    });

    input.addEventListener('keydown', (e) => {
      if (menu.hidden) return;
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        activeIdx = Math.min(lastResults.length - 1, activeIdx + 1);
        highlight();
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        activeIdx = Math.max(-1, activeIdx - 1);
        highlight();
      } else if (e.key === 'Enter') {
        if (activeIdx >= 0 && lastResults[activeIdx]) {
          e.preventDefault();
          goToSymbol(lastResults[activeIdx].symbol);
        }
        // else: fall through to native form submit — user typed raw
        //       text and pressed Enter; the form handler navigates
        //       using whatever they typed.
      } else if (e.key === 'Escape') {
        close();
      }
    });

    // Mouse-select. Uses mousedown (not click) so the input's blur
    // handler doesn't fire and close the menu before the click lands.
    menu.addEventListener('mousedown', (e) => {
      const row = e.target.closest('.ta-row');
      if (!row) return;
      e.preventDefault();
      goToSymbol(row.dataset.sym);
    });

    // Close on blur (short delay so mousedown can register first).
    input.addEventListener('blur', () => {
      setTimeout(close, 120);
    });
    // Close if the user clicks outside the wrap entirely.
    document.addEventListener('mousedown', (e) => {
      if (!wrap.contains(e.target)) close();
    });
  }

  // Expose so pages that build their own inputs after our initial mount
  // (rare, but possible) can attach on demand.
  window.attachTickerAutocomplete = attachAutocomplete;

  // ==========================================================
  //  BAR INJECTION (only on pages that don't have their own form)
  // ==========================================================

  const BAR_CSS = `
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
    /* Wrap the ta-wrap div (from the autocomplete controller) so it
       inherits the flex-grow that used to belong to the input itself.
       Without this the input collapses to its natural width once we
       nest it inside the .ta-wrap div. */
    .gts-form .ta-wrap { flex: 1; min-width: 0; }
    @media (max-width: 480px) {
      .gts-form label { display: none; }
    }
  `;

  function injectBar() {
    if (document.getElementById('tickerSearchForm')) return false;
    if (document.body && document.body.hasAttribute('data-no-ticker-search')) return false;

    const style = document.createElement('style');
    style.textContent = BAR_CSS;
    document.head.appendChild(style);

    const bar = document.createElement('div');
    bar.className = 'gts-bar';
    bar.innerHTML = `
      <form class="gts-form" id="tickerSearchForm" role="search" aria-label="Ticker lookup">
        <label for="tickerSearchInput">Look up any ticker or company &rarr;</label>
        <input type="text" id="tickerSearchInput" placeholder="AAPL, Apple, Vanguard Total Stock…" autocomplete="off" spellcheck="false" required />
        <button type="submit">GO &rarr;</button>
      </form>
    `;

    const header = document.querySelector('.site-header');
    if (header && header.parentNode) {
      header.parentNode.insertBefore(bar, header.nextSibling);
    } else {
      const main = document.querySelector('main');
      (main || document.body).prepend(bar);
    }
    return true;
  }

  // ==========================================================
  //  MOUNT — inject the bar (if applicable), then attach the
  //  autocomplete controller to every known search input.
  // ==========================================================

  function mount() {
    injectBar();
    // Attach to whatever's on the page — the just-injected input, and/or
    // any existing search inputs on pages that ship their own form
    // (index / quotes / watchlist / ticker).
    ['tickerSearchInput', 'homeTickerSearchInput'].forEach(id => {
      const el = document.getElementById(id);
      if (el) attachAutocomplete(el);
    });
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', mount, { once: true });
  } else {
    mount();
  }

  // ==========================================================
  //  Fallback form-submit handler for the injected bar. If the user
  //  types raw text and hits Enter (no autocomplete selection), we
  //  still navigate to ticker.html?sym=<typed>. Uppercases + strips
  //  invalid chars so a typed name doesn't produce a broken URL.
  // ==========================================================
  document.addEventListener('submit', (e) => {
    const form = e.target.closest('#tickerSearchForm.gts-form');
    if (!form) return;
    e.preventDefault();
    const input = form.querySelector('#tickerSearchInput');
    const raw = ((input && input.value) || '').trim().toUpperCase();
    if (!raw) return;
    const sym = raw.replace(/[^A-Z0-9.\-\^]/g, '');
    if (!sym) return;
    goToSymbol(sym);
  });
})();
