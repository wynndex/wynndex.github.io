/*
 * Lootrun reroll optimizer.
 *
 * Model
 * -----
 * Each pull independently has a small chance of producing each rare pool item.
 * Rare items always make the 45-item offer, so the number of copies of item i in
 * an offer is ~ Poisson(pulls * p_i), and an offer's value is the sum of
 * copies * price over the pool. Everything else in an offer (common items,
 * liquid emeralds) is assumed to be the same on average every roll, so it
 * cancels out of the take-vs-reroll comparison.
 *
 * Per-pull rates were fitted to community data (lr-rates - Sheet1.csv):
 *   mythics: total rate = K_MYTHIC * (count + 1), split evenly between them
 *   augments / wards: K_AUGMENT / K_WARD per item
 *   shiny: 1 in 100,000
 *
 * Decision: optimal stopping. Let X be a fresh offer's value and c_k the value
 * of holding k rerolls (playing optimally afterwards):
 *   c_1 = E[X],  c_k = E[max(X, c_{k-1})]
 * With R rerolls left, reroll iff the current offer is worth less than c_R.
 */
(function () {
  'use strict';

  // ---- Constants -----------------------------------------------------------

  var K_MYTHIC = 1 / 28289;
  var K_AUGMENT = 1 / 5625;
  var K_WARD = 1 / 6280;
  var SHINY_RATE = 1 / 100000;

  // Verdict is a "toss-up" when reroll and take are within this fraction.
  var TOSS_UP = 0.05;

  var CATS = [
    { id: 'mythic', label: 'Mythics', one: 'mythic', rate: function (n) { return K_MYTHIC * (n + 1) / n; } },
    { id: 'augment', label: 'Augments', one: 'augment', rate: function () { return K_AUGMENT; } },
    { id: 'ward', label: 'Wards', one: 'ward', rate: function () { return K_WARD; } },
  ];

  // Items that appear as mythics in Wynnventory's pool data but are augments
  // (lowercase). Add new ones here.
  var AUGMENT_NAMES = ['corkian simulator', 'corkian insulator'];

  var API_BASE = 'https://wynnventory.com/api/v2';
  var STATE_KEY = 'wynndex.reroll.v1';
  var API_KEY_KEY = 'wynndex.wynnventoryKey';

  var E_EB = 64;
  var E_LE = 64 * 64;
  var E_STX = 64 * 64 * 64;

  // Price colour scale per category: prices at/below `lo` are muted, at/above
  // `hi` fully vibrant (see priceColor).
  var PRICE_SCALE = {
    mythic: { lo: 32 * E_LE, hi: 3 * E_STX },
    augment: { lo: E_STX + 32 * E_LE, hi: 2 * E_STX + 32 * E_LE },
    ward: { lo: E_STX, hi: 3 * E_STX },
  };

  // ---- Storage (best effort) -----------------------------------------------

  function load(key) {
    try { return window.localStorage.getItem(key); } catch (e) { return null; }
  }
  function save(key, value) {
    try {
      if (value === null) window.localStorage.removeItem(key);
      else window.localStorage.setItem(key, value);
    } catch (e) { /* storage unavailable */ }
  }

  // ---- Emerald parsing / formatting ----------------------------------------

  var UNIT = { stx: E_STX, le: E_LE, eb: E_EB, e: 1 };

  // Returns emeralds, null for empty input, or NaN when unparseable.
  function parseEm(input) {
    var s = String(input || '').trim().toLowerCase().replace(/,/g, '');
    if (!s) return null;
    var re = /(\d*\.?\d+)\s*(stx|le|eb|e)?/g;
    var total = 0;
    var m;
    while ((m = re.exec(s))) total += parseFloat(m[1]) * UNIT[m[2] || 'le'];
    if (s.replace(re, '').trim() !== '') return NaN;
    return total;
  }

  function trim(n, digits) {
    return String(parseFloat(n.toFixed(digits)));
  }

  function fmtEm(e) {
    var sign = e < 0 ? '-' : '';
    var a = Math.abs(e);
    if (a >= E_STX) return sign + trim(a / E_STX, 2) + 'stx';
    if (a >= E_LE) return sign + trim(a / E_LE, 1) + 'le';
    if (a >= E_EB) return sign + trim(a / E_EB, 1) + 'eb';
    return sign + Math.round(a) + 'e';
  }

  function fmtPct(p) {
    if (p > 0 && p < 0.001) return '<0.1%';
    return trim(p * 100, 1) + '%';
  }

  // ---- State ---------------------------------------------------------------

  function blankRow(cat) {
    return { cat: cat, name: '', price: '', slots: 1, count: 0, api: null };
  }

  // How many times an item appears in the pool; each slot adds a full share of
  // the drop rate (two Corkian Simulator slots = twice the chance).
  function slotsOf(row) {
    return Math.max(1, parseInt(row.slots, 10) || 1);
  }

  // The loaded camp (and its items, counts and prices) and the shiny price
  // start fresh on every page load; everything else in `state` is remembered.
  var NOT_SAVED = ['camp', 'rows', 'shinyPrice', 'pulls', 'rerolls'];

  var state = {
    pulls: '',
    rerolls: '',
    emCur: '',
    emTyp: '',
    source: 'lowest',
    camp: '',
    rows: [], // filled by loading a camp
    shinyPrice: '', // optional; counted only when set
  };

  (function restore() {
    var raw = load(STATE_KEY);
    if (!raw) return;
    try {
      var s = JSON.parse(raw);
      Object.keys(state).forEach(function (k) {
        if (k in s && NOT_SAVED.indexOf(k) === -1) state[k] = s[k];
      });
    } catch (e) { /* ignore corrupt state */ }
  })();

  var saveTimer = null;
  function persist() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(function () {
      save(STATE_KEY, JSON.stringify(state, function (k, v) {
        return this === state && NOT_SAVED.indexOf(k) !== -1 ? undefined : v;
      }));
    }, 300);
  }

  // ---- DOM helpers ---------------------------------------------------------

  function $(id) { return document.getElementById(id); }

  function el(tag, attrs, children) {
    var node = document.createElement(tag);
    Object.keys(attrs || {}).forEach(function (k) {
      if (k === 'text') node.textContent = attrs[k];
      else if (k === 'className') node.className = attrs[k];
      else node.setAttribute(k, attrs[k]);
    });
    (children || []).forEach(function (c) { if (c) node.appendChild(c); });
    return node;
  }

  function markInvalid(input, value) {
    input.classList.toggle('invalid', typeof value === 'number' && isNaN(value));
  }

  // ---- Pool cards ----------------------------------------------------------

  // Item textures live in reroll/textures/, picked by kind rather than name:
  //   mythics  -> their weapon/armour subtype (dagger.png, boots.png, ...),
  //               from `subType` in data/lootpools.json
  //   wards    -> their colour ("Pink Ward" -> pink.png)
  //   augments -> their name ("Corkian Simulator" -> corkian_simulator.png)
  // Anything without a texture falls back to the placeholder.
  var TEXTURE_DIR = 'textures/';
  var PLACEHOLDER_IMG = 'data:image/svg+xml,' + encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" shape-rendering="crispEdges" fill="#ffffff33">' +
    '<path d="M5 2h6v1H5zM4 3h2v2H4zM10 3h2v3H10zM9 6h2v1H9zM7 7h3v1H7zM7 8h2v2H7zM7 11h2v2H7z"/></svg>');

  // Muted grey-blue for cheap items up to vibrant blue for pricey ones.
  function priceColor(cat, v) {
    var scale = PRICE_SCALE[cat];
    if (!scale || !v) return '';
    var t = Math.min(1, Math.max(0, (v - scale.lo) / (scale.hi - scale.lo)));
    return 'hsl(205, ' + Math.round(10 + 90 * t) + '%, ' + Math.round(74 + 2 * t) + '%)';
  }

  function textureOf(row) {
    var file;
    if (row.cat === 'mythic') file = row.subType;
    else if (row.cat === 'ward') file = row.name.split(' ')[0];
    else file = row.name.replace(/\s+/g, '_');
    return file ? TEXTURE_DIR + file.toLowerCase() + '.png' : PLACEHOLDER_IMG;
  }

  function ago(iso) {
    var mins = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
    if (!(mins >= 0)) return '';
    if (mins < 2) return 'just now';
    if (mins < 90) return mins + ' min ago';
    var hours = Math.round(mins / 60);
    if (hours < 36) return hours + 'h ago';
    return Math.round(hours / 24) + ' days ago';
  }

  // "Prices from Wynnventory" credit under the cards.
  function renderCredit() {
    var credit = $('price-credit');
    credit.textContent = '';
    var priced = state.rows.some(function (r) { return r.api; });
    credit.hidden = !priced;
    if (!priced) return;
    var live = state.rows.some(function (r) { return r.live; });
    var when = !live && sharedPrices && sharedPrices.updated_at ? ago(sharedPrices.updated_at) : '';
    credit.appendChild(document.createTextNode((live ? 'Live prices' : 'Prices') + ' provided by '));
    credit.appendChild(el('a', { href: 'https://wynnventory.com', target: '_blank', text: 'Wynnventory' }));
    credit.appendChild(document.createTextNode(when ? ', updated ' + when + '.' : '.'));
  }

  function renderPool() {
    var pool = $('pool');
    pool.textContent = '';
    renderCredit();

    if (!state.rows.length) {
      pool.appendChild(el('dull', { text: 'Load a camp to see its items.' }));
      return;
    }

    // Augments and wards together, then mythics on their own row(s).
    [['augment', 'ward'], ['mythic']].forEach(function (cats) {
      var rows = [];
      cats.forEach(function (cat) {
        state.rows.forEach(function (r) { if (r.cat === cat) rows.push(r); });
      });
      if (rows.length) pool.appendChild(el('div', { className: 'item-grid' }, rows.map(renderCard)));
    });
  }

  // Prices autofilled from Wynnventory are read-only; anything else can be
  // typed straight into the label (contenteditable, so it looks the same).
  function renderPrice(row) {
    var autofilled = !!row.api && pickPrice(row.api, state.source) !== null;
    var price = el('span', { className: 'item-price' });

    function show() {
      var v = parseEm(row.price);
      // Valid prices are shown normalised (e.g. "2.5stx"); bad input is kept as typed.
      price.textContent = v ? fmtEm(v) : (v === null || v === 0 ? '' : row.price);
      paint();
    }
    function paint() {
      var v = parseEm(row.price);
      price.classList.toggle('invalid', typeof v === 'number' && isNaN(v));
      price.style.color = priceColor(row.cat, v);
    }

    if (autofilled) {
      price.title = apiTitle(row.api);
      show();
      return price;
    }

    try { price.contentEditable = 'plaintext-only'; } catch (e) { price.contentEditable = 'true'; }
    price.spellcheck = false;
    price.classList.add('editable');
    price.title = 'Type a price, e.g. 2.5stx or 1stx 20le (bare numbers are LE)';
    price.addEventListener('input', function () {
      row.price = price.textContent.trim();
      paint();
      changed();
    });
    price.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' || e.key === 'Escape') { e.preventDefault(); price.blur(); }
    });
    price.addEventListener('blur', show);
    show();
    return price;
  }

  function renderCard(row) {
    var price = renderPrice(row);

    var src = textureOf(row);
    var img = el('img', { className: 'item-img' + (src === PLACEHOLDER_IMG ? ' placeholder' : ''), alt: '', src: src });
    img.addEventListener('error', function () {
      img.src = PLACEHOLDER_IMG;
      img.classList.add('placeholder');
    }, { once: true });

    var count = el('input', { type: 'number', min: '0', step: '1', title: 'How many are in your current offer' });
    count.value = row.count;

    var card = el('div', { className: 'item-card' }, [
      price,
      slotsOf(row) > 1 ? el('span', { className: 'item-slots', text: 'x' + slotsOf(row), title: 'Appears ' + slotsOf(row) + ' times in the pool' }) : null,
      el('div', { className: 'item-art' }, [img]),
      el('div', { className: 'item-name', text: row.name }),
      count,
    ]);
    card.classList.toggle('in-offer', row.count > 0);

    count.addEventListener('input', function () {
      row.count = Math.max(0, parseInt(count.value, 10) || 0);
      card.classList.toggle('in-offer', row.count > 0);
      changed();
    });
    return card;
  }

  // ---- Static inputs -------------------------------------------------------

  function bindInputs() {
    [['pulls', 'pulls'], ['rerolls', 'rerolls'], ['em-current', 'emCur'], ['em-typical', 'emTyp']].forEach(function (pair) {
      var input = $(pair[0]);
      // Inputs commented out in the HTML (e.g. the emerald fields): clear any saved value so it can't affect results.
      if (!input) { state[pair[1]] = ''; return; }
      input.value = state[pair[1]];
      input.addEventListener('input', function () {
        state[pair[1]] = input.value;
        if (input.type === 'text') markInvalid(input, parseEm(input.value));
        changed();
      });
      if (input.type === 'text') markInvalid(input, parseEm(input.value));
    });

    var price = $('shiny-price');
    price.addEventListener('input', function () {
      state.shinyPrice = price.value;
      markInvalid(price, parseEm(price.value));
      changed();
    });
  }

  // ---- Math ----------------------------------------------------------------

  // Exact distribution of an offer's value as sorted (values, probs) arrays.
  // items: [{ p: per-pull chance, v: value in emeralds }]
  function offerDistribution(items, pulls) {
    var eps = 1e-13;
    for (;;) {
      var dist = new Map([[0, 1]]);
      var tooBig = false;

      for (var i = 0; i < items.length && !tooBig; i++) {
        var it = items[i];
        if (!(it.v > 0) || !(it.p > 0)) continue;

        var lambda = pulls * it.p;
        var pmf = [];
        var pk = Math.exp(-lambda);
        var cum = 0;
        for (var k = 0; k < 1000; k++) {
          if (k > 0) pk = pk * lambda / k;
          pmf.push(pk);
          cum += pk;
          if (k > lambda && 1 - cum < eps) break;
        }

        var next = new Map();
        dist.forEach(function (px, x) {
          for (var c = 0; c < pmf.length; c++) {
            var q = px * pmf[c];
            if (q < eps) { if (c > lambda) break; else continue; }
            var key = Math.round(x + c * it.v);
            next.set(key, (next.get(key) || 0) + q);
          }
        });
        dist = next;
        if (dist.size > 400000) tooBig = true;
      }

      if (tooBig) { eps *= 10; continue; }

      var vals = Array.from(dist.keys()).sort(function (a, b) { return a - b; });
      var total = 0;
      vals.forEach(function (v) { total += dist.get(v); });
      var probs = vals.map(function (v) { return dist.get(v) / total; });
      return { vals: vals, probs: probs };
    }
  }

  function prepareStats(d) {
    // suffix sums of p and x*p for fast E[max(X, c)] and P(X > c).
    var n = d.vals.length;
    var sufP = new Float64Array(n + 1);
    var sufXP = new Float64Array(n + 1);
    for (var i = n - 1; i >= 0; i--) {
      sufP[i] = sufP[i + 1] + d.probs[i];
      sufXP[i] = sufXP[i + 1] + d.vals[i] * d.probs[i];
    }
    function firstAbove(c) {
      var lo = 0, hi = n;
      while (lo < hi) {
        var mid = (lo + hi) >> 1;
        if (d.vals[mid] > c) hi = mid; else lo = mid + 1;
      }
      return lo;
    }
    return {
      mean: sufXP[0],
      pAbove: function (c) { return sufP[firstAbove(c)]; },
      eMax: function (c) {
        var i = firstAbove(c);
        return c * (1 - sufP[i]) + sufXP[i];
      },
    };
  }

  // Chance that rerolling now, then playing optimally, ends with an offer worth
  // more than `current`. After a roll with k rerolls still in hand you keep it
  // iff it beats thresholds[k] (same rule as eMax); with none left you must.
  //   q(0) = P(X > cur)
  //   q(k) = P(X > max(c_k, cur)) + P(X <= c_k) * q(k-1)
  // and the answer is q(R-1).
  function chanceOfMore(stats, thresholds, rerolls, current) {
    var q = stats.pAbove(current);
    for (var k = 1; k < rerolls; k++) {
      var c = thresholds[k];
      q = stats.pAbove(Math.max(c, current)) + (1 - stats.pAbove(c)) * q;
    }
    return q;
  }

  // ---- Compute & render result ---------------------------------------------

  // The Result header doubles as the verdict: coloured word + short reason.
  // setVerdict(null) puts back the plain "Result" title.
  function setVerdict(kind, word, reason) {
    var header = $('result-header');
    header.textContent = '';
    header.className = 'header' + (kind ? ' verdict ' + kind : '');
    if (!kind) { header.textContent = 'Result'; return; }
    header.appendChild(el('span', { className: 'verdict-word', text: word }));
    header.appendChild(document.createTextNode(' '));
    header.appendChild(el('dull', { text: reason }));
  }

  // Red outline on the inputs still needed for a result: pulls, rerolls left,
  // and the camp (until one is loaded).
  function markNeeded() {
    $('pulls').classList.toggle('needed', !(parseInt(state.pulls, 10) > 0));
    $('rerolls').classList.toggle('needed', !(parseInt(state.rerolls, 10) >= 0));
    $('camp').classList.toggle('needed', !state.rows.length);
  }

  function compute() {
    var out = $('result');
    out.textContent = '';
    setVerdict(null);
    markNeeded();

    function msg(text) { out.appendChild(el('dull', { text: text })); }

    var pulls = parseInt(state.pulls, 10);
    var rerolls = parseInt(state.rerolls, 10);
    if (!(pulls > 0) || !(rerolls >= 0)) return msg('Fill in pulls and rerolls left to see a result.');

    var items = [];
    var current = 0;
    var unpriced = 0;
    var bad = false;
    var expected = {};

    CATS.forEach(function (cat) {
      var rows = state.rows.filter(function (r) { return r.cat === cat.id; });
      if (!rows.length) return;
      var n = rows.reduce(function (sum, r) { return sum + slotsOf(r); }, 0);
      var p = cat.rate(n);
      expected[cat.id] = pulls * p * n;
      rows.forEach(function (r) {
        var v = parseEm(r.price);
        if (v === null) { unpriced++; v = 0; }
        if (isNaN(v)) { bad = true; return; }
        items.push({ p: p * slotsOf(r), v: v });
        current += (r.count || 0) * v;
      });
    });

    // Shiny: only counted when a price is entered. It's a possible reroll
    // outcome; the current offer is assumed not to contain one.
    var sv = parseEm(state.shinyPrice);
    if (sv !== null) {
      if (isNaN(sv)) bad = true;
      else {
        items.push({ p: SHINY_RATE, v: sv });
        expected.shiny = pulls * SHINY_RATE;
      }
    }

    var emCur = parseEm(state.emCur);
    var emTyp = parseEm(state.emTyp);
    if ((emCur !== null && isNaN(emCur)) || (emTyp !== null && isNaN(emTyp))) bad = true;

    if (bad) return msg('Some prices or emerald amounts could not be read (highlighted in red).');
    if (!items.some(function (it) { return it.v > 0; })) return msg('No item prices yet. Click "enter price" on an item to type one.');

    var emDelta = emCur !== null && emTyp !== null ? emCur - emTyp : 0;
    current += emDelta;

    var stats = prepareStats(offerDistribution(items, pulls));

    // thresholds[k] = value of holding k rerolls (k >= 1)
    var thresholds = [null, stats.mean];
    for (var k = 2; k <= Math.max(rerolls, 1); k++) thresholds.push(stats.eMax(thresholds[k - 1]));

    // Verdict (shown in the Result section's header)
    if (rerolls === 0) {
      setVerdict('take', 'Take it', 'No rerolls left.');
    } else {
      var keepValue = thresholds[rerolls];
      var reroll = current < keepValue;
      // Within TOSS_UP of each other (relative to the larger), call it a toss-up.
      var close = Math.abs(keepValue - current) <= TOSS_UP * Math.max(current, keepValue);
      var kind = close ? 'tossup' : reroll ? 'reroll' : 'take';
      setVerdict(kind, close ? 'Toss-up' : reroll ? 'Reroll' : 'Take it',
        (reroll && current === 0
          ? '\u{1F6A8} It says you have nothing selected!! Make sure to input your rewards!'
          : reroll
          ? 'Rerolling is worth ' + fmtEm(keepValue - current) + ' more on average' +
            (close ? ', but this depends on your raw LE offers.' : '.')
          : 'Taking it is worth ' + fmtEm(current - keepValue) + ' more than rerolling' +
            (close ? ', but this depends on your raw LE offers.' : '.')));
      // Always offered while rerolls remain, whatever the verdict, so it
      // doesn't vanish as the current offer is being typed in.
      out.appendChild(rerollButton(rerolls));
    }

    var lines = [
      ['Current',fmtEm(current) + (emDelta ? ' (incl. ' + (emDelta > 0 ? '+' : '') + fmtEm(emDelta) + ' emeralds vs typical)' : '')],
    ];
    if (rerolls > 0) {
      // Expected value of rerolling (playing optimally afterwards), plus the
      // chance that doing so ends with more than the current offer.
      lines.push(['Expected',fmtEm(thresholds[rerolls]) +
        ' (' + fmtPct(chanceOfMore(stats, thresholds, rerolls, current)) + ' chance of more)']);
    }
    out.appendChild(el('table', { className: 'data summary' }, [el('tbody', {}, lines.map(function (l) {
      return el('tr', {}, [el('td', { text: l[0] }), el('td', { text: l[1] })]);
    }))]));

    var exp = [];
    if (expected.mythic !== undefined) exp.push(trim(expected.mythic, 2) + ' mythics');
    if (expected.augment !== undefined) exp.push(trim(expected.augment, 2) + ' augments');
    if (expected.ward !== undefined) exp.push(trim(expected.ward, 2) + ' wards');
    if (expected.shiny !== undefined) exp.push(trim(expected.shiny, 3) + ' shinies');
    var notes = 'Expected per roll: ' + exp.join(', ') + '.';
    if (unpriced) notes += ' ' + unpriced + ' item' + (unpriced === 1 ? ' has' : 's have') + ' no price and count' + (unpriced === 1 ? 's' : '') + ' as worthless.';
    out.appendChild(el('dull', { className: 'notes', text: notes }));
  }

  var computeTimer = null;
  // Shown under the "Reroll" verdict: spends one reroll and clears the current
  // offer (item counts and liquid emeralds) so the next one can be entered.
  function rerollButton(rerolls) {
    var btn = el('button', {
      type: 'button',
      className: 'reroll-button',
      text: 'Click me to reroll; ' + rerolls + ' roll' + (rerolls === 1 ? '' : 's') + ' left.',
    });
    btn.addEventListener('click', function () {
      state.rerolls = String(Math.max(0, rerolls - 1));
      $('rerolls').value = state.rerolls;
      state.rows.forEach(function (r) { r.count = 0; });
      var em = $('em-current');
      if (em) { state.emCur = ''; em.value = ''; markInvalid(em, null); }
      renderPool();
      changed();
    });
    return btn;
  }

  function changed() {
    persist();
    clearTimeout(computeTimer);
    computeTimer = setTimeout(compute, 120);
  }

  // ---- Camp pools (Wynncraft, via data/lootpools.json) ---------------------

  // Snapshot of Wynncraft's /v3/map/loot-pools written by a scheduled GitHub
  // Action (scripts/update_lootpools.py). The Wynncraft API itself can't be
  // called from the browser (CORS).
  var POOLS_URL = '/data/lootpools.json';

  // Hourly Wynnventory price snapshot for every pool item, written by a
  // scheduled GitHub Action (scripts/update_prices.py) so visitors get prices
  // without a key of their own. A personal key fetches live prices instead.
  var PRICES_URL = '/data/prices.json';
  var sharedPrices = null; // { updated_at, items: { name: stats } }

  function loadSharedPrices() {
    fetch(PRICES_URL, { cache: 'no-cache' }).then(function (res) {
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return res.json();
    }).then(function (data) {
      sharedPrices = data;
      applyShared();
      applySource();
      renderPool();
      changed();
    }).catch(function () { /* no snapshot yet: manual or personal-key prices only */ });
  }

  // Fill rows from the snapshot, leaving live (personal-key) prices alone.
  function applyShared() {
    if (!sharedPrices || !sharedPrices.items) return;
    state.rows.forEach(function (row) {
      if (row.live) return;
      var stats = sharedPrices.items[row.name];
      if (stats) row.api = stats;
    });
  }
  var camps = [];

  function setCampStatus(text) { $('camp-status').textContent = text; }

  // "CORKIAN INSULATOR" -> "Corkian Insulator"; other names are left alone.
  function displayName(name) {
    if (name !== name.toUpperCase()) return name;
    return name.toLowerCase().replace(/\b\w/g, function (c) { return c.toUpperCase(); });
  }

  function classify(reward) {
    if (reward.shiny) return 'shiny';
    // Augments are listed as plain items but drop at augment rates.
    if (AUGMENT_NAMES.indexOf(String(reward.name).toLowerCase()) !== -1) return 'augment';
    if (reward.type === 'WARD') return 'ward';
    if (reward.tier === 'MYTHIC') return 'mythic';
    return null;
  }

  function loadPools() {
    fetch(POOLS_URL, { cache: 'no-cache' }).then(function (res) {
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return res.json();
    }).then(function (data) {
      camps = data.camps || [];
      var select = $('camp');
      select.textContent = '';
      camps.forEach(function (c) { select.appendChild(el('option', { value: c.name, text: c.name })); });
      // Default to Molten Heights (if this week's data has it), else the first camp.
      var preferred = state.camp || camps.map(function (c) { return c.name; }).find(function (n) { return /molten heights/i.test(n); });
      if (preferred) select.value = preferred;
    }).catch(function (err) {
      $('camp').textContent = '';
      $('camp').appendChild(el('option', { value: '', text: 'No pool data' }));
      setCampStatus('Could not load camp pools (' + err.message + '). Try reloading the page.');
    });
  }

  function loadCamp() {
    var camp = camps.find(function (c) { return c.name === $('camp').value; });
    if (!camp) return;
    state.camp = camp.name;

    // Repeats are pool slots recorded in `amount` (e.g. Corkian Simulator x2);
    // each slot adds a full share of the drop chance.
    var rows = [];
    var byKey = {};
    var shinyName = '';
    (camp.rewards || []).forEach(function (reward) {
      var cat = classify(reward);
      if (!cat || !reward.name) return;
      var name = displayName(reward.name);
      if (cat === 'shiny') { shinyName = shinyName || name; return; }
      var amount = parseInt(reward.amount, 10);
      var key = cat + ':' + name;
      var row = byKey[key];
      if (!row) {
        row = byKey[key] = blankRow(cat);
        row.name = name;
        row.subType = reward.subType || '';
        row.slots = 0;
        rows.push(row);
      }
      row.slots += amount > 0 ? amount : 1;
    });

    state.rows = rows;
    applyShared();
    applySource();
    $('shiny-name').textContent = shinyName;
    setCampStatus('');
    renderPool();
    changed();
    if (apiKey) fetchPrices();
  }

  // ---- Wynnventory (prices only) -------------------------------------------

  var apiKey = load(API_KEY_KEY) || '';

  function setStatus(text) { $('api-status').textContent = text; }

  function api(path) {
    return fetch(API_BASE + path, { headers: { 'X-API-Key': apiKey } }).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (body) {
        if (!res.ok) {
          var err = new Error((body.error && body.error.message) || ('HTTP ' + res.status));
          err.status = res.status;
          throw err;
        }
        return body.data;
      });
    });
  }

  function pickPrice(stats, source) {
    if (!stats) return null;
    var order = source === 'smooth'
      ? ['unidentified_average_p50_ema_price', 'average_p50_ema_price']
      : ['unidentified_lowest_price', 'lowest_price'];
    for (var i = 0; i < order.length; i++) {
      if (typeof stats[order[i]] === 'number') return stats[order[i]];
    }
    return null;
  }

  function apiTitle(stats) {
    return 'Wynnventory: lowest ' + fmtEm(pickPrice(stats, 'lowest') || 0) +
      ', smoothed ' + fmtEm(pickPrice(stats, 'smooth') || 0) +
      ', ' + ((stats.unidentified_count || 0) + (stats.total_count || 0)) + ' listings';
  }

  function applySource() {
    state.rows.forEach(function (row) {
      if (!row.api) return;
      var p = pickPrice(row.api, state.source);
      if (p !== null) row.price = fmtEm(p); // no market data: keep any typed price
    });
  }

  function connect() {
    if (!apiKey) {
      $('api-controls').hidden = true;
      setStatus('');
      return;
    }
    setStatus('Checking key...');
    api('/status').then(function () {
      $('api-controls').hidden = false;
      setStatus('Key works. Live prices are fetched when you load a camp.');
    }).catch(function (err) {
      $('api-controls').hidden = true;
      setStatus('Wynnventory error: ' + err.message);
    });
  }

  function fetchPrices() {
    var targets = state.rows.filter(function (r) { return r.name; });
    if (!targets.length || !apiKey) return;
    setStatus('Fetching prices...');
    var failed = 0;
    var denied = false;
    Promise.all(targets.map(function (row) {
      return api('/market/items/' + encodeURIComponent(row.name) + '/price').then(function (stats) {
        row.api = stats;
        row.live = true;
      }).catch(function (err) {
        failed++;
        if (err.status === 401 || err.status === 403) denied = true;
        // keep any snapshot price for this item
      });
    })).then(function () {
      applySource();
      renderPool();
      changed();
      if (denied) return setStatus('Wynnventory refused the price requests. Does your key have the read:market scope?');
      setStatus('Prices loaded' + (failed ? ' (' + failed + ' item' + (failed === 1 ? '' : 's') + ' had no market data)' : '') +
        '. Hover a price to see Wynnventory\'s numbers.');
    });
  }

  function bindApi() {
    var keyInput = $('api-key');
    keyInput.value = apiKey;
    $('price-source').value = state.source;

    $('api-save').addEventListener('click', function () {
      apiKey = keyInput.value.trim();
      save(API_KEY_KEY, apiKey || null);
      connect();
    });
    $('api-forget').addEventListener('click', function () {
      apiKey = '';
      keyInput.value = '';
      save(API_KEY_KEY, null);
      connect();
    });
    $('camp-load').addEventListener('click', loadCamp);
    $('price-refresh').addEventListener('click', fetchPrices);
    $('price-source').addEventListener('change', function () {
      state.source = $('price-source').value;
      applySource();
      renderPool();
      changed();
    });
  }

  // ---- Init ----------------------------------------------------------------

  bindInputs();
  bindApi();
  applySource();
  renderPool();
  compute();
  loadPools();
  loadSharedPrices();
  connect();
})();
