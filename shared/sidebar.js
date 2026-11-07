/*
 * Wynndex navigation sidebar.
 *
 * Add to any page on wynndex.github.io (including pages hosted from other
 * repos, like /wynnilla) with:
 *
 *   <script src="/shared/sidebar.js"></script>
 *
 * It loads its own stylesheet and builds the sidebar, so edits made here
 * show up on every page automatically.
 */
(function () {
  var BASE = '/shared/';

  var ICONS = '/textures/';

  // Each entry shows as its icon; the label appears in a tooltip on hover.
  var LINKS = [
    { label: 'Wynnilla', href: '/wynnilla/', icon: 'wynnilla.png' },
    { label: 'Camps', href: '/camps/', icon: 'camp.png' },
    { label: 'Reroll', href: '/reroll/', icon: 'reroll.png' },
  ];

  var css = document.createElement('link');
  css.rel = 'stylesheet';
  css.href = BASE + 'sidebar.css';
  document.head.appendChild(css);

  function build() {
    var path = window.location.pathname + '/';

    var nav = document.createElement('nav');
    nav.className = 'wx-sidebar';

    function item(className, href, icon, label) {
      var a = document.createElement('a');
      a.className = className;
      a.href = href;
      a.setAttribute('aria-label', label);
      // The wrapper is masked to the icon's shape so the active page's icon
      // can be tinted (see .wx-active in sidebar.css).
      var wrap = document.createElement('span');
      wrap.className = 'wx-sidebar-icon';
      wrap.style.setProperty('--wx-icon', 'url("' + ICONS + icon + '")');
      var img = document.createElement('img');
      img.src = ICONS + icon;
      img.alt = '';
      wrap.appendChild(img);
      a.appendChild(wrap);
      return a;
    }

    nav.appendChild(item('wx-sidebar-logo', '/', 'logo.png', 'Wynndex'));

    LINKS.forEach(function (link) {
      var a = item('wx-sidebar-link', link.href, link.icon, link.label);
      var tip = document.createElement('span');
      tip.className = 'wx-sidebar-tip';
      tip.textContent = link.label;
      a.appendChild(tip);
      if (path.indexOf(link.href) === 0) a.classList.add('wx-active');
      nav.appendChild(a);
    });

    document.body.prepend(nav);
    document.body.classList.add('wx-has-sidebar');
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', build);
  } else {
    build();
  }
})();
