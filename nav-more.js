/* BATS.CO menu — behaviour for the "More" dropdown (the last menu item).
 *
 * The stylesheet already opens the panel on hover for mouse users. This
 * file adds the rest: tap or click to open and close, ArrowDown to step
 * into the list, Escape / an outside click / focus leaving to close, a
 * "you are here" mark on More when the current page is one of its items,
 * and a flip to the left edge when the panel would run off a narrow
 * screen. Loaded with `defer` right after the menu on every page.
 */
(function () {
  'use strict';
  const wrap = document.querySelector('.site-nav .nav-more');
  if (!wrap) return;
  const btn = wrap.querySelector('.nav-more-btn');
  const menu = wrap.querySelector('.nav-more-menu');
  if (!btn || !menu) return;

  // Keep the panel on screen: it normally hangs from the button's right
  // edge; if that puts its left side off the viewport, hang it from the left.
  function place() {
    menu.classList.remove('align-left');
    const shown = getComputedStyle(menu).display !== 'none';
    if (!shown) { menu.style.visibility = 'hidden'; menu.style.display = 'flex'; }
    const r = menu.getBoundingClientRect();
    if (!shown) { menu.style.display = ''; menu.style.visibility = ''; }
    if (r.left < 8) menu.classList.add('align-left');
  }
  function setOpen(on) {
    if (on) place();
    wrap.classList.toggle('open', on);
    btn.setAttribute('aria-expanded', on ? 'true' : 'false');
  }

  btn.addEventListener('click', function (e) {
    e.preventDefault();
    setOpen(!wrap.classList.contains('open'));
  });
  wrap.addEventListener('mouseenter', place);
  btn.addEventListener('keydown', function (e) {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setOpen(true);
      const first = menu.querySelector('a');
      if (first) first.focus();
    }
  });
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && wrap.classList.contains('open')) { setOpen(false); btn.focus(); }
  });
  document.addEventListener('click', function (e) {
    if (!wrap.contains(e.target)) setOpen(false);
  });
  wrap.addEventListener('focusout', function (e) {
    if (!wrap.contains(e.relatedTarget)) setOpen(false);
  });

  // "You are here": highlight the item for the current page, and More itself.
  const here = (location.pathname.split('/').pop() || 'index.html').toLowerCase();
  menu.querySelectorAll('a').forEach(function (a) {
    const target = (a.getAttribute('href') || '').split('/').pop().split('#')[0].split('?')[0].toLowerCase();
    if (target && target === here) { a.classList.add('active'); btn.classList.add('active'); }
  });
})();
