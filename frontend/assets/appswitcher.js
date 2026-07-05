/**
 * AppSwitcher — the shared product-suite switcher.
 *
 * Every signed-in page across the suite shows this dropdown in the
 * top bar. Locked products show a lock icon and link to pricing;
 * unlocked products deep-link with the shared session (same Supabase
 * auth = seamless switching).
 *
 * Usage on any page:
 *   <div id="app-switcher"></div>
 *   <script src="assets/appswitcher.js"></script>
 *   <script>AppSwitcher.mount('#app-switcher', { currentApp: 'autovideo' });</script>
 *
 * Entitlements come from GET /api/entitlements (via AFSession.fetch when
 * session.js is loaded), cached in sessionStorage for 5 minutes. When the
 * API is unreachable or the page has no session, we fall back to the
 * legacy localStorage `af_products` list (JSON array of app ids), and
 * finally to unlocking only the current app.
 */
(function () {
  'use strict';

  const PRODUCTS = [
    { id: 'autocurb',   name: 'Autocurb.io', desc: 'Used car acquisition & trade value', url: 'https://autocurb.io',            icon: '🚗' },
    { id: 'cleardeal',  name: 'Clear Deal',  desc: 'Deal desk & transaction clarity',    url: 'https://autocurb.io/cleardeal',  icon: '🤝' },
    { id: 'autolabels', name: 'AutoLabels',  desc: 'Vehicle passport & history',         url: 'https://autolabels.autocurb.io', icon: '🏷️' },
    { id: 'autoframe',  name: 'AutoFrame',   desc: 'Inventory media studio',             url: 'https://autoframe.autocurb.io',  icon: '🖼️' },
    { id: 'autovideo',  name: 'AutoVideo',   desc: 'Personal video messaging',           url: 'https://autofilm.io/autofilm-app.html', icon: '🎬' },
  ];

  const PRICING_URL = 'https://autocurb.io/pricing';

  // Backend entitlement keys → switcher product ids.
  // AutoVideo is the switcher name for AutoFilm; Clear Deal ships with AutoCurb.
  const ENTITLEMENT_KEY = {
    autocurb:   'autocurb',
    cleardeal:  'autocurb',
    autolabels: 'autolabels',
    autoframe:  'autoframe',
    autovideo:  'autofilm',
  };

  const CACHE_KEY = 'afsw_entitlements';
  const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

  // Same API resolution as session.js
  const API = window.AF_API || ((location.hostname === 'localhost' || location.hostname === '127.0.0.1')
    ? 'http://localhost:3001' : 'https://api.autofilm.io');

  /** Legacy fallback: localStorage list, else just the current app. */
  function activeProducts(currentApp) {
    try {
      const stored = JSON.parse(localStorage.getItem('af_products'));
      if (Array.isArray(stored) && stored.length) return new Set(stored);
    } catch { /* fall through */ }
    return new Set([currentApp]);
  }

  /** Map an entitlements payload's products object to a set of switcher ids. */
  function entitledProducts(entitlements, currentApp) {
    const products = entitlements?.products;
    if (!products || typeof products !== 'object') return null;
    const set = new Set([currentApp]); // the app you're on is always shown as yours
    for (const p of PRODUCTS) {
      if (products[ENTITLEMENT_KEY[p.id]]) set.add(p.id);
    }
    return set;
  }

  /** Fetch /api/entitlements with a 5-minute sessionStorage cache. Null on any failure. */
  async function fetchEntitlements() {
    try {
      const cached = JSON.parse(sessionStorage.getItem(CACHE_KEY));
      if (cached?.data && (Date.now() - cached.ts) < CACHE_TTL) return cached.data;
    } catch { /* stale or corrupt cache — refetch */ }

    if (!window.AFSession?.fetch || !window.AFSession.get()) return null;

    try {
      const res = await window.AFSession.fetch(`${API}/api/entitlements`);
      if (!res.ok) return null;
      const data = await res.json();
      try { sessionStorage.setItem(CACHE_KEY, JSON.stringify({ ts: Date.now(), data })); } catch { /* quota */ }
      return data;
    } catch {
      return null;
    }
  }

  function css() {
    if (document.getElementById('afsw-css')) return;
    const s = document.createElement('style');
    s.id = 'afsw-css';
    s.textContent = `
.afsw{position:relative;font-family:'Geist',-apple-system,sans-serif;user-select:none}
.afsw-btn{display:flex;align-items:center;gap:8px;padding:7px 12px;border-radius:9px;background:rgba(255,255,255,.05);border:1px solid rgba(255,255,255,.09);color:rgba(255,255,255,.85);font-size:12.5px;font-weight:700;cursor:pointer;transition:all .14s;font-family:inherit}
.afsw-btn:hover{background:rgba(255,255,255,.09);border-color:rgba(255,255,255,.16)}
.afsw-btn .caret{font-size:9px;opacity:.5;transition:transform .18s}
.afsw.open .caret{transform:rotate(180deg)}
.afsw-menu{position:absolute;top:calc(100% + 8px);right:0;width:280px;background:#111116;border:1px solid rgba(255,255,255,.1);border-radius:14px;box-shadow:0 20px 60px rgba(0,0,0,.6);z-index:500;overflow:hidden;display:none;animation:afswIn .16s ease}
.afsw.open .afsw-menu{display:block}
@keyframes afswIn{from{opacity:0;transform:translateY(-6px)}to{opacity:1;transform:none}}
.afsw-hdr{padding:11px 16px 9px;font-size:9.5px;font-weight:800;letter-spacing:.12em;text-transform:uppercase;color:rgba(255,255,255,.35);display:flex;justify-content:space-between;align-items:center}
.afsw-count{font-family:'Geist Mono',monospace;font-weight:600;letter-spacing:0;text-transform:none}
.afsw-item{display:flex;align-items:center;gap:11px;padding:10px 16px;text-decoration:none;color:rgba(255,255,255,.9);transition:background .12s}
.afsw-item:hover{background:rgba(255,255,255,.04)}
.afsw-item.locked{opacity:.45;cursor:pointer}
.afsw-item.current{background:rgba(217,79,0,.09)}
.afsw-ico{width:32px;height:32px;border-radius:9px;background:rgba(255,255,255,.06);display:flex;align-items:center;justify-content:center;font-size:15px;flex-shrink:0}
.afsw-item.current .afsw-ico{background:rgba(217,79,0,.18)}
.afsw-name{font-size:13px;font-weight:700;display:flex;align-items:center;gap:6px}
.afsw-desc{font-size:10.5px;color:rgba(255,255,255,.4);margin-top:1px}
.afsw-lock{font-size:10px}
.afsw-badge{font-size:8.5px;font-weight:800;letter-spacing:.08em;text-transform:uppercase;padding:2px 6px;border-radius:10px;background:rgba(217,79,0,.15);color:#E85A0A}
.afsw-upgrade{display:block;margin:8px 12px 12px;padding:10px;text-align:center;border-radius:10px;background:#D94F00;color:#fff;font-size:12px;font-weight:800;text-decoration:none;transition:background .14s}
.afsw-upgrade:hover{background:#E85A0A}
`;
    document.head.appendChild(s);
  }

  function render(host, currentApp, active) {
    const current = PRODUCTS.find(p => p.id === currentApp) || PRODUCTS[0];

    const items = PRODUCTS.map(p => {
      const unlocked = active.has(p.id);
      const isCurrent = p.id === currentApp;
      if (isCurrent) {
        return `<div class="afsw-item current">
          <div class="afsw-ico">${p.icon}</div>
          <div><div class="afsw-name">${p.name} <span class="afsw-badge">You're here</span></div><div class="afsw-desc">${p.desc}</div></div>
        </div>`;
      }
      if (unlocked) {
        return `<a class="afsw-item" href="${p.url}">
          <div class="afsw-ico">${p.icon}</div>
          <div><div class="afsw-name">${p.name}</div><div class="afsw-desc">${p.desc}</div></div>
        </a>`;
      }
      return `<div class="afsw-item locked" onclick="window.open('${PRICING_URL}','_blank')" title="Upgrade to unlock">
        <div class="afsw-ico">${p.icon}</div>
        <div><div class="afsw-name">${p.name} <span class="afsw-lock">🔒</span></div><div class="afsw-desc">${p.desc}</div></div>
      </div>`;
    }).join('');

    const wasOpen = host.querySelector('#afswRoot')?.classList.contains('open');

    host.innerHTML = `
      <div class="afsw" id="afswRoot">
        <button class="afsw-btn" type="button">
          <span>${current.icon}</span><span>${current.name}</span><span class="caret">▼</span>
        </button>
        <div class="afsw-menu">
          <div class="afsw-hdr"><span>Products</span><span class="afsw-count">${active.size} of ${PRODUCTS.length} active</span></div>
          ${items}
          ${active.size < PRODUCTS.length ? `<a class="afsw-upgrade" href="${PRICING_URL}" target="_blank" rel="noopener">Upgrade Plan</a>` : ''}
        </div>
      </div>`;

    const root = host.querySelector('#afswRoot');
    if (wasOpen) root.classList.add('open');
    root.querySelector('.afsw-btn').addEventListener('click', e => {
      e.stopPropagation();
      root.classList.toggle('open');
    });
    if (!host._afswDocClose) {
      host._afswDocClose = true;
      document.addEventListener('click', () => {
        host.querySelector('#afswRoot')?.classList.remove('open');
      });
    }
  }

  function mount(selector, { currentApp = 'autovideo' } = {}) {
    css();
    const host = typeof selector === 'string' ? document.querySelector(selector) : selector;
    if (!host) return;

    // Paint immediately from the local fallback, then refresh from the API.
    render(host, currentApp, activeProducts(currentApp));

    fetchEntitlements().then(ent => {
      const set = entitledProducts(ent, currentApp);
      if (!set) return; // graceful fallback: keep the local render
      setProducts([...set]); // keep the legacy localStorage cache in sync
      render(host, currentApp, set);
    });
  }

  /** Called by settings page after /api/billing/status to sync entitlements. */
  function setProducts(ids) {
    localStorage.setItem('af_products', JSON.stringify(ids));
  }

  window.AppSwitcher = { mount, setProducts, PRODUCTS };
})();
