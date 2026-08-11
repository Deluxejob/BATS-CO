// Share strip — reusable share-buttons component.
//
// Auto-injects a set of X / LinkedIn / Reddit / Email / Copy-link buttons
// wherever the page includes a `<div data-share-strip></div>` placeholder,
// then wires each button to the platform's public share intent (no
// third-party JS, no cookies, no tokens).
//
// URL / title / body text default to:
//   URL   = location.href  (with a &sym=X preserved for ticker pages)
//   TITLE = document.title
//   TEXT  = <meta name="description"> content
//
// Any of those can be overridden on the placeholder itself:
//   <div data-share-strip data-share-url="..." data-share-title="..." data-share-text="..."></div>
//
// Styles live in styles.css under the `.share-strip` selector — the JS
// only injects markup + wires clicks.
//
// Included on:
//   index.html, ticker.html, valuations.html, risk-watch.html, markets.html

(function () {
  const SVG = {
    x: '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M18.244 2H21l-6.52 7.451L22.5 22h-6.828l-5.35-6.996L4.24 22H1.482l6.98-7.977L1.5 2h6.977l4.84 6.398L18.244 2Zm-1.194 18.4h1.523L7.03 3.51H5.39l11.66 16.89Z"/></svg>',
    linkedin: '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M20.447 20.452h-3.554v-5.569c0-1.328-.024-3.037-1.85-3.037-1.853 0-2.136 1.447-2.136 2.939v5.667H9.354V9h3.414v1.561h.049c.476-.9 1.637-1.85 3.37-1.85 3.601 0 4.267 2.37 4.267 5.455v6.286zM5.337 7.433a2.062 2.062 0 0 1-2.063-2.065 2.063 2.063 0 1 1 2.063 2.065zm1.782 13.019H3.555V9h3.564v11.452zM22.225 0H1.771C.792 0 0 .774 0 1.729v20.542C0 23.227.792 24 1.771 24h20.451C23.2 24 24 23.227 24 22.271V1.729C24 .774 23.2 0 22.222 0h.003z"/></svg>',
    reddit: '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 0C5.373 0 0 5.373 0 12s5.373 12 12 12 12-5.373 12-12S18.627 0 12 0zm5.01 4.744c.688 0 1.25.561 1.25 1.249a1.25 1.25 0 0 1-2.498.056l-2.597-.547-.8 3.747c1.824.07 3.48.632 4.674 1.488.308-.309.73-.491 1.207-.491.968 0 1.754.786 1.754 1.754 0 .716-.435 1.333-1.01 1.614a3.111 3.111 0 0 1 .042.52c0 2.657-3.09 4.812-6.9 4.812-3.808 0-6.9-2.155-6.9-4.812 0-.185.02-.36.05-.53a1.755 1.755 0 0 1-.997-1.604c0-.968.785-1.754 1.754-1.754.474 0 .903.184 1.212.487.688-.457 1.583-.822 2.599-1.06.415-.098.815-.174 1.19-.226l.842-3.966.203-.94 2.925.617.13-.036c-.005-.086-.017-.171-.017-.26 0-.688.561-1.249 1.249-1.249l-.001-.006zM9.25 12A1.25 1.25 0 0 0 8 13.25 1.25 1.25 0 0 0 9.25 14.5 1.25 1.25 0 0 0 10.5 13.25 1.25 1.25 0 0 0 9.25 12zm5.5 0a1.25 1.25 0 0 0-1.25 1.25 1.25 1.25 0 0 0 1.25 1.25 1.25 1.25 0 0 0 1.25-1.25A1.25 1.25 0 0 0 14.75 12zm-5.466 3.99a.327.327 0 0 0-.231.094.33.33 0 0 0 0 .463c.842.842 2.484.913 2.961.913.477 0 2.105-.056 2.961-.913a.361.361 0 0 0 .029-.463.33.33 0 0 0-.464 0c-.547.533-1.684.73-2.512.73-.828 0-1.979-.196-2.512-.73a.326.326 0 0 0-.232-.095z"/></svg>',
    email: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="5" width="18" height="14" rx="2"/><path d="m3 7 9 6 9-6"/></svg>',
    copy: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/></svg>',
  };

  const HTML = `
    <span class="share-label">Share this:</span>
    <div class="share-btns">
      <a class="share-btn x" data-share="x" href="#" aria-label="Share on X" title="Share on X">${SVG.x}</a>
      <a class="share-btn linkedin" data-share="linkedin" href="#" aria-label="Share on LinkedIn" title="Share on LinkedIn">${SVG.linkedin}</a>
      <a class="share-btn reddit" data-share="reddit" href="#" aria-label="Share on Reddit" title="Share on Reddit">${SVG.reddit}</a>
      <a class="share-btn email" data-share="email" href="#" aria-label="Share via email" title="Share via email">${SVG.email}</a>
      <button class="share-btn copy" data-share="copy" type="button" aria-label="Copy link" title="Copy link">${SVG.copy}</button>
    </div>
  `;

  function init(strip) {
    // Fill from data-* attributes on the placeholder, or auto-detect from the page.
    // URL: prefer the FULL current URL (including query params like ?sym=AAPL)
    // so a ticker-page share carries the symbol; strip out any cache-busters.
    const cleanUrl = (u) => {
      try {
        const parsed = new URL(u, location.origin);
        // Drop known cache-buster keys that make ugly share URLs
        ['nc', 'nocache', 'bust', 'cachebust', '_'].forEach(k => parsed.searchParams.delete(k));
        return parsed.toString();
      } catch (_) { return u; }
    };
    const URL_  = strip.dataset.shareUrl   || cleanUrl(location.href);
    const TITLE = strip.dataset.shareTitle || document.title || 'BATS.CO';
    const descMeta = document.querySelector('meta[name="description"]');
    const TEXT  = strip.dataset.shareText  || (descMeta && descMeta.content) || TITLE;

    strip.classList.add('share-strip');
    if (!strip.hasAttribute('aria-label')) strip.setAttribute('aria-label', 'Share this page');
    strip.innerHTML = HTML;

    const enc = encodeURIComponent;
    const intents = {
      x:        'https://twitter.com/intent/tweet?url=' + enc(URL_) + '&text=' + enc(TITLE),
      linkedin: 'https://www.linkedin.com/sharing/share-offsite/?url=' + enc(URL_),
      reddit:   'https://www.reddit.com/submit?url=' + enc(URL_) + '&title=' + enc(TITLE),
      email:    'mailto:?subject=' + enc(TITLE) + '&body=' + enc(TEXT + '\n\n' + URL_),
    };

    strip.addEventListener('click', async (e) => {
      const btn = e.target.closest('[data-share]');
      if (!btn) return;
      const kind = btn.dataset.share;

      if (kind === 'copy') {
        e.preventDefault();
        try {
          await navigator.clipboard.writeText(URL_);
          const original = btn.getAttribute('title');
          btn.classList.add('copied');
          btn.setAttribute('title', 'Copied!');
          setTimeout(() => { btn.classList.remove('copied'); btn.setAttribute('title', original); }, 1600);
        } catch (_) { /* clipboard blocked — silent fail */ }
        return;
      }

      // Native mobile share sheet — swap in when it exists, saves users
      // the "which app do I want" hunt on iOS/Android. Desktop keeps the
      // dedicated per-platform buttons.
      if (kind === 'x' && navigator.share && matchMedia('(pointer: coarse)').matches) {
        e.preventDefault();
        try { await navigator.share({ title: TITLE, text: TEXT, url: URL_ }); } catch (_) {}
        return;
      }

      const url = intents[kind];
      if (url) {
        if (kind === 'email') { window.location.href = url; }
        else { window.open(url, '_blank', 'noopener'); }
        e.preventDefault();
      }
    });
  }

  function boot() {
    document.querySelectorAll('[data-share-strip]').forEach(init);
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
