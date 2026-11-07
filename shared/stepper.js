/*
 * Custom up/down buttons for number inputs.
 *
 * Native spin arrows can't be restyled in Firefox, so style.css hides them
 * everywhere and this script wraps every <input type="number"> (including ones
 * added later, e.g. table rows built by page scripts) in:
 *
 *   <span class="stepper"> input <span class="stepper-buttons"> ▲ ▼ </span></span>
 *
 * The buttons call stepUp()/stepDown() and fire `input` + `change`, so page
 * scripts listening on the input react exactly as if the user had typed.
 * Holding a button repeats. Include with: <script src="/shared/stepper.js"></script>
 *
 * Other inputs (e.g. text prices like "15le") opt in with a `data-stepper`
 * attribute. Their buttons and the arrow keys fire a `stepper-step` event
 * (detail: +1 or -1) instead, and the page does the stepping itself.
 */
(function () {
  'use strict';

  function custom(input, dir) {
    input.dispatchEvent(new CustomEvent('stepper-step', { detail: dir, bubbles: true }));
  }

  function makeButton(input, dir) {
    var btn = document.createElement('button');
    btn.type = 'button';
    btn.tabIndex = -1; // keyboard users already have arrow keys
    btn.className = dir > 0 ? 'stepper-up' : 'stepper-down';
    btn.setAttribute('aria-label', dir > 0 ? 'Increase' : 'Decrease');

    var delay = null, repeat = null;
    function stop() {
      clearTimeout(delay);
      clearInterval(repeat);
      delay = repeat = null;
    }
    function step() {
      if (input.disabled || input.readOnly) return stop();
      if (input.type !== 'number') return custom(input, dir);
      var before = input.value;
      try {
        if (dir > 0) input.stepUp(); else input.stepDown();
      } catch (e) { return stop(); }
      if (input.value === before) return stop(); // hit min/max
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
    }

    btn.addEventListener('pointerdown', function (e) {
      if (e.button !== 0) return;
      e.preventDefault(); // keep focus where it is
      stop();
      step();
      delay = setTimeout(function () { repeat = setInterval(step, 50); }, 400);
    });
    ['pointerup', 'pointerleave', 'pointercancel'].forEach(function (t) {
      btn.addEventListener(t, stop);
    });
    return btn;
  }

  function enhance(input) {
    var parent = input.parentNode;
    if (!parent || (parent.classList && parent.classList.contains('stepper'))) return;

    var wrap = document.createElement('span');
    wrap.className = 'stepper';
    var buttons = document.createElement('span');
    buttons.className = 'stepper-buttons';
    buttons.appendChild(makeButton(input, 1));
    buttons.appendChild(makeButton(input, -1));

    parent.insertBefore(wrap, input);
    wrap.appendChild(input);
    wrap.appendChild(buttons);

    // Number inputs step on arrow keys natively; give opted-in ones the same.
    if (input.type !== 'number') {
      input.addEventListener('keydown', function (e) {
        if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
        if (input.disabled || input.readOnly) return;
        e.preventDefault();
        custom(input, e.key === 'ArrowUp' ? 1 : -1);
      });
    }
  }

  var SELECTOR = 'input[type="number"], input[data-stepper]';

  function scan(root) {
    if (root.nodeType !== 1) return;
    if (root.matches(SELECTOR)) enhance(root);
    root.querySelectorAll(SELECTOR).forEach(enhance);
  }

  new MutationObserver(function (records) {
    records.forEach(function (r) { r.addedNodes.forEach(scan); });
  }).observe(document.documentElement, { childList: true, subtree: true });

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { scan(document.body); });
  } else {
    scan(document.body);
  }
})();
