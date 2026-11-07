/*
 * Lootrun camp ranking.
 *
 * Score = SCORE_SCALE * average LE per pull from the camp's rare rewards /
 * minutes per challenge (entered per camp). LE per pull is sum(per-pull rate * price) over
 * the pool's mythics, augments and wards, using the same drop-rate model as
 * reroll/reroll.js (keep the constants below in sync with it). Shinies (manual
 * prices only) and everything else in an offer are left out.
 *
 * Pools come from data/lootpools.json, prices from the data/prices.json
 * snapshot (lowest unidentified listing, falling back to identified).
 */
(function () {
  'use strict';

  // Same as reroll/reroll.js.
  var K_MYTHIC = 1 / 28289;
  var K_AUGMENT = 1 / 5625;
  var K_WARD = 1 / 6280;
  var AUGMENT_NAMES = ['corkian simulator', 'corkian insulator'];

  var E_LE = 64 * 64;
  // Default minutes per challenge, matched against camp names; camps not
  // listed (e.g. new ones) use DEFAULT_MINUTES.
  var DEFAULT_MINUTES = 1;
  var CAMP_MINUTES = [
    [/molten heights/i, 0.75],
    [/corkus/i, 0.85],
    [/canyon of the lost/i, 0.85],
    [/sky islands/i, 0.85],
    [/silent expanse/i, 0.9],
    [/fruma/i, 1.1],
  ];

  function defaultMinutes(name) {
    var hit = CAMP_MINUTES.find(function (c) { return c[0].test(name); });
    return hit ? hit[1] : DEFAULT_MINUTES;
  }
  // Raw LE-per-pull-per-minute values are tiny; scale them to readable numbers.
  var SCORE_SCALE = 200;
  // Score colour: muted at/below lo, fully vibrant blue at/above hi.
  var SCORE_COLOR = { lo: 5, hi: 45 };
  var STATE_KEY = 'wynndex.camps.v1';
  // Item textures are shared with the reroll page (see textureOf there).
  var TEXTURE_DIR = '../reroll/textures/';

  // Re-rank this long after the last edit, so cards don't jump while typing.
  var RESORT_DELAY = 1000;

  // ---- Storage (best effort) -----------------------------------------------

  // { minutes: { campName: "3" } }
  var state = { minutes: {} };
  try {
    var saved = JSON.parse(window.localStorage.getItem(STATE_KEY) || 'null');
    if (saved && saved.minutes) state.minutes = saved.minutes;
  } catch (e) { /* ignore */ }

  function persist() {
    try { window.localStorage.setItem(STATE_KEY, JSON.stringify(state)); } catch (e) { /* ignore */ }
  }

  // ---- Helpers -------------------------------------------------------------

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

  // Same formatting and colour scale as reroll.js.
  var E_EB = 64;
  var E_STX = 64 * 64 * 64;
  var PRICE_SCALE = {
    mythic: { lo: 32 * E_LE, hi: 3 * E_STX },
    augment: { lo: E_STX + 32 * E_LE, hi: 2 * E_STX + 32 * E_LE },
    ward: { lo: E_STX, hi: 3 * E_STX },
  };

  function trim(n, digits) {
    return String(parseFloat(n.toFixed(digits)));
  }

  function fmtEm(e) {
    if (e >= E_STX) return trim(e / E_STX, 2) + 'stx';
    if (e >= E_LE) return trim(e / E_LE, 1) + 'le';
    if (e >= E_EB) return trim(e / E_EB, 1) + 'eb';
    return Math.round(e) + 'e';
  }

  // Muted grey-blue at/below lo up to vibrant blue at/above hi.
  function blueScale(v, lo, hi) {
    var t = Math.min(1, Math.max(0, (v - lo) / (hi - lo)));
    return 'hsl(205, ' + Math.round(10 + 90 * t) + '%, ' + Math.round(74 + 2 * t) + '%)';
  }

  function priceColor(cat, v) {
    var scale = PRICE_SCALE[cat];
    if (!scale || !v) return '';
    return blueScale(v, scale.lo, scale.hi);
  }

  function sig(n) {
    if (!n) return '0';
    return String(parseFloat(n.toPrecision(3)));
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

  // "CORKIAN INSULATOR" -> "Corkian Insulator"; other names are left alone.
  function displayName(name) {
    if (name !== name.toUpperCase()) return name;
    return name.toLowerCase().replace(/\b\w/g, function (c) { return c.toUpperCase(); });
  }

  function classify(reward) {
    if (reward.shiny) return 'shiny';
    if (AUGMENT_NAMES.indexOf(String(reward.name).toLowerCase()) !== -1) return 'augment';
    if (reward.type === 'WARD') return 'ward';
    if (reward.tier === 'MYTHIC') return 'mythic';
    return null;
  }

  function priceOf(prices, name) {
    var stats = prices && prices.items && prices.items[name];
    if (!stats) return null;
    if (typeof stats.unidentified_lowest_price === 'number') return stats.unidentified_lowest_price;
    if (typeof stats.lowest_price === 'number') return stats.lowest_price;
    return null;
  }

  // ---- Scoring -------------------------------------------------------------

  // Average LE per pull, how many rare items had no price, and the rare items
  // themselves (repeats merged into one entry with more slots). Shinies are
  // shown but not scored (their prices are manual-only on the reroll page).
  function campValue(camp, prices) {
    var slots = { mythic: [], augment: [], ward: [] };
    var shinies = [];
    var byKey = {};
    (camp.rewards || []).forEach(function (r) {
      var cat = classify(r);
      if (!cat || !r.name) return;
      var n = parseInt(r.amount, 10);
      var name = displayName(r.name);
      if (cat === 'shiny') {
        shinies.push({ cat: r.tier === 'MYTHIC' ? 'mythic' : 'other', shiny: true, name: 'Shiny ' + name, tracker: r.shinyTracker || '', subType: r.subType || '', slots: n > 0 ? n : 1 });
        return;
      }
      var key = cat + ':' + name;
      if (!byKey[key]) slots[cat].push(byKey[key] = { cat: cat, name: name, subType: r.subType || '', slots: 0 });
      byKey[key].slots += n > 0 ? n : 1;
    });

    var mythicSlots = slots.mythic.reduce(function (s, it) { return s + it.slots; }, 0);
    var rate = {
      mythic: mythicSlots ? K_MYTHIC * (mythicSlots + 1) / mythicSlots : 0,
      augment: K_AUGMENT,
      ward: K_WARD,
    };

    var perPull = 0;
    var unpriced = 0;
    Object.keys(slots).forEach(function (cat) {
      slots[cat].forEach(function (it) {
        var price = it.price = priceOf(prices, it.name);
        if (price === null) { unpriced++; return; }
        perPull += rate[cat] * it.slots * price / E_LE;
      });
    });
    return { perPull: perPull, unpriced: unpriced, items: shinies.concat(slots.mythic, slots.augment, slots.ward) };
  }

  function minutesOf(name) {
    var m = parseFloat(state.minutes[name] !== undefined ? state.minutes[name] : defaultMinutes(name));
    return m > 0 ? m : null;
  }

  // ---- Render --------------------------------------------------------------

  // Same mapping as reroll.js: mythics by subtype, wards by colour, augments by name.
  function textureOf(item) {
    var file;
    if (item.subType) file = item.subType;
    else if (item.cat === 'ward') file = item.name.split(' ')[0];
    else file = item.name.replace(/\s+/g, '_');
    return file ? TEXTURE_DIR + file.toLowerCase() + '.png' : null;
  }

  // One small icon per rare pool item. Hovering one enlarges it and shows a
  // tooltip with its name, plus its count when it's in the pool more than once.
  // An item's price, or for shinies (no market price; they're priced by hand
  // on the reroll page) what they track, e.g. "Mobs Killed".
  function valueOf(it, className) {
    if (it.shiny) return it.tracker ? el('span', { className: className + ' tracker', text: it.tracker }) : null;
    if (it.price === null || it.price === undefined) return el('span', { className: className, text: 'no price' });
    var line = el('span', { className: className, text: fmtEm(it.price) });
    line.style.color = priceColor(it.cat, it.price);
    return line;
  }

  function iconImg(it, className) {
    var src = textureOf(it);
    var img = el('img', { className: className, alt: '', src: src || '' });
    img.addEventListener('error', function () { img.classList.add('missing'); }, { once: true });
    if (!src) img.classList.add('missing');
    return img;
  }

  // Back of a card: icon | name | price (or tracker), scrollable.
  function poolList(items) {
    return el('div', { className: 'pool-list' }, items.map(function (it) {
      return el('div', { className: 'pool-row' }, [
        el('span', { className: 'pool-row-icon' }, [
          iconImg(it, 'pool-row-img'),
          it.shiny ? el('img', { className: 'pool-row-glint', alt: '', src: TEXTURE_DIR + 'shiny.png' }) : null,
        ]),
        el('span', { className: 'pool-row-name ' + it.cat }, [
          document.createTextNode(it.name),
          it.slots > 1 ? el('span', { className: 'pool-row-count', text: ' x' + it.slots }) : null,
        ]),
        valueOf(it, 'pool-row-value'),
      ]);
    }));
  }

  function poolIcons(items) {
    return el('div', { className: 'item-art pool-icons' }, items.map(function (it) {
      var src = textureOf(it);
      var img = el('img', { className: 'pool-icon-img', alt: it.name, src: src || '' });
      var icon = el('span', { className: 'pool-icon' }, [
        el('span', { className: 'pool-icon-art' }, [
          img,
          it.shiny ? el('img', { className: 'pool-icon-glint', alt: '', src: TEXTURE_DIR + 'shiny.png' }) : null,
        ]),
        el('span', { className: 'pool-tip' }, [
          el('span', { className: 'pool-tip-title' }, [
            el('span', { className: 'pool-tip-name ' + it.cat, text: it.name }),
            it.slots > 1 ? el('span', { className: 'pool-tip-count', text: 'x' + it.slots }) : null,
          ]),
          valueOf(it, 'pool-tip-price'),
        ]),
      ]);
      img.addEventListener('error', function () { icon.classList.add('missing'); }, { once: true });
      if (!src) icon.classList.add('missing');
      return icon;
    }));
  }

  var cards = []; // { name, value, node, scoreNode }

  function updateScore(card) {
    var mins = minutesOf(card.name);
    card.score = mins ? SCORE_SCALE * card.value.perPull / mins : -1;
    card.scoreNode.textContent = mins ? sig(card.score) : '?';
    card.scoreNode.style.color = mins ? blueScale(card.score, SCORE_COLOR.lo, SCORE_COLOR.hi) : '';
    card.scoreNode.title = sig(card.value.perPull) + ' le per pull' + (mins ? ' / ' + mins + ' min per challenge' : '') +
      (card.value.unpriced ? ' (' + card.value.unpriced + ' unpriced item' + (card.value.unpriced === 1 ? '' : 's') + ' counted as 0)' : '');
  }

  function rank() {
    var grid = $('ranking');
    cards.slice().sort(function (a, b) { return b.score - a.score; }).forEach(function (c) { grid.appendChild(c.node); });
  }

  function renderCard(camp, prices) {
    var card = { name: camp.name, value: campValue(camp, prices) };
    card.scoreNode = el('span', { className: 'item-price' });

    var input = el('input', { type: 'number', min: '0.05', step: '0.05', title: 'Minutes per challenge at this camp' });
    input.value = state.minutes[camp.name] !== undefined ? state.minutes[camp.name] : defaultMinutes(camp.name);

    // Clicking a card flips it over to a plain list of its items (easier to
    // read on phones than the hover tooltips); clicking again flips it back.
    card.node = el('div', { className: 'flip-card', tabindex: '0' }, [
      el('div', { className: 'flip-inner' }, [
        card.front = el('div', { className: 'item-card wide flip-front' }, [
          card.scoreNode,
          poolIcons(card.value.items),
          el('div', { className: 'item-name', text: camp.name }),
          input,
        ]),
        card.back = el('div', { className: 'item-card wide flip-back' }, [poolList(card.value.items)]),
      ]),
    ]);
    // The hidden face is also inert, so its input and tooltips can't be reached.
    function flip() {
      var flipped = card.node.classList.toggle('flipped');
      card.front.inert = flipped;
      card.back.inert = !flipped;
    }
    card.back.inert = true;
    card.node.addEventListener('click', function (e) {
      if (e.target.closest('.stepper, input')) return; // editing minutes, not flipping
      flip();
    });
    card.node.addEventListener('keydown', function (e) {
      if (e.target !== card.node || (e.key !== 'Enter' && e.key !== ' ')) return;
      e.preventDefault();
      flip();
    });

    var timer = null;
    input.addEventListener('input', function () {
      state.minutes[camp.name] = input.value;
      persist();
      updateScore(card);
      clearTimeout(timer);
      timer = setTimeout(rank, RESORT_DELAY);
    });

    updateScore(card);
    return card;
  }

  function render(pools, prices) {
    var grid = $('ranking');
    grid.textContent = '';
    cards = (pools.camps || []).map(function (camp) { return renderCard(camp, prices); });
    cards.forEach(function (c) { grid.appendChild(c.node); });
    rank();

    var notes = $('ranking-notes');
    notes.textContent = '';
    if (!prices) {
      notes.textContent = 'No price data available yet, so every camp scores 0.';
      return;
    }
    notes.appendChild(document.createTextNode('Prices provided by '));
    notes.appendChild(el('a', { href: 'https://wynnventory.com', target: '_blank', text: 'Wynnventory' }));
    var when = prices.updated_at ? ago(prices.updated_at) : '';
    notes.appendChild(document.createTextNode(when ? ', updated ' + when + '.' : '.'));
  }

  function getJson(url) {
    return fetch(url, { cache: 'no-cache' }).then(function (res) {
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return res.json();
    });
  }

  Promise.all([
    getJson('/data/lootpools.json'),
    getJson('/data/prices.json').catch(function () { return null; }),
  ]).then(function (res) {
    render(res[0], res[1]);
  }).catch(function (err) {
    $('ranking').textContent = '';
    $('ranking').appendChild(el('dull', { text: 'Could not load camp pools (' + err.message + '). Try reloading the page.' }));
  });
})();
