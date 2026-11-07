/*
 * Collapsible section headers.
 *
 * Every `.site > .header` marked `data-collapsible` becomes a toggle for the
 * blocks after it, up to the next header. Collapsed blocks get the `wx-collapsed-away` class rather than
 * `hidden`, so page scripts that show/hide those blocks themselves aren't
 * clobbered. Add `data-collapsed` to a header to start it closed. A visitor's
 * open/closed choice is remembered per page in localStorage and overrides the
 * default (best effort; it works without storage). Include with:
 *   <script src="/shared/collapse.js" defer></script>
 */
(function () {
  'use strict';

  var KEY = 'wx-collapsed:' + location.pathname;

  function load() {
    try { return JSON.parse(localStorage.getItem(KEY)) || {}; } catch (e) { return {}; }
  }
  function save(state) {
    try { localStorage.setItem(KEY, JSON.stringify(state)); } catch (e) { /* ignore */ }
  }

  // Header text without secondary <dull> bits, e.g. "Wynnventory".
  function nameOf(header) {
    var clone = header.cloneNode(true);
    clone.querySelectorAll('dull').forEach(function (d) { d.remove(); });
    return clone.textContent.trim();
  }

  function sectionOf(header) {
    var blocks = [];
    for (var n = header.nextElementSibling; n && !n.classList.contains('header'); n = n.nextElementSibling) {
      blocks.push(n);
    }
    return blocks;
  }

  function init() {
    var state = load();
    document.querySelectorAll('.site > .header[data-collapsible]').forEach(function (header) {
      var name = nameOf(header);
      header.classList.add('collapsible');
      header.tabIndex = 0;
      header.setAttribute('role', 'button');

      function apply(collapsed) {
        header.classList.toggle('collapsed', collapsed);
        header.setAttribute('aria-expanded', String(!collapsed));
        sectionOf(header).forEach(function (b) { b.classList.toggle('wx-collapsed-away', collapsed); });
      }
      function toggle() {
        var collapsed = !header.classList.contains('collapsed');
        apply(collapsed);
        state[name] = collapsed;
        save(state);
      }

      apply(name in state ? !!state[name] : header.hasAttribute('data-collapsed'));
      header.addEventListener('click', function (e) {
        if (e.target.closest('a, button, input, select')) return;
        toggle();
      });
      header.addEventListener('keydown', function (e) {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); }
      });
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
