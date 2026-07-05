/**
 * AFSession — shared session manager for all AutoFilm pages.
 *
 * Persists the Supabase session + rep profile in localStorage,
 * transparently refreshes expired access tokens, and exposes
 * an authenticated fetch wrapper.
 *
 *   <script src="assets/session.js"></script>
 *   const session = AFSession.get();          // { access_token, ... } | null
 *   const rep = AFSession.rep();              // rep profile | null
 *   await AFSession.fetch(url, opts);         // fetch with Bearer + auto-refresh
 *   AFSession.requireAuth();                  // redirect to login if signed out
 *   AFSession.logout();
 */
(function () {
  'use strict';

  const KEY = 'af_session';
  const REP_KEY = 'af_rep';

  const API = window.AF_API || ((location.hostname === 'localhost' || location.hostname === '127.0.0.1')
    ? 'http://localhost:3001' : 'https://api.autofilm.io');

  function get() {
    try { return JSON.parse(localStorage.getItem(KEY)) || null; } catch { return null; }
  }

  function rep() {
    try { return JSON.parse(localStorage.getItem(REP_KEY)) || null; } catch { return null; }
  }

  function set(session, repProfile) {
    if (session) localStorage.setItem(KEY, JSON.stringify(session));
    if (repProfile !== undefined && repProfile !== null) {
      localStorage.setItem(REP_KEY, JSON.stringify(repProfile));
      if (repProfile.rooftop_id) localStorage.setItem('af_rooftop_id', repProfile.rooftop_id);
      if (repProfile.id) localStorage.setItem('af_rep_id', repProfile.id);
    }
  }

  function clear() {
    localStorage.removeItem(KEY);
    localStorage.removeItem(REP_KEY);
  }

  function isExpired(session) {
    if (!session?.expires_at) return false;
    // 60s early-refresh margin
    return (session.expires_at * 1000) - 60_000 < Date.now();
  }

  let refreshing = null;

  async function refresh() {
    // Coalesce concurrent refreshes into a single request
    if (refreshing) return refreshing;
    const session = get();
    if (!session?.refresh_token) return null;

    refreshing = (async () => {
      try {
        const res = await fetch(`${API}/api/auth/refresh`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ refresh_token: session.refresh_token }),
        });
        if (!res.ok) { clear(); return null; }
        const data = await res.json();
        set(data.session, null);
        return data.session;
      } catch { return null; }
      finally { refreshing = null; }
    })();

    return refreshing;
  }

  async function token() {
    let session = get();
    if (!session) return null;
    if (isExpired(session)) session = await refresh();
    return session?.access_token || null;
  }

  async function authedFetch(url, opts = {}) {
    const t = await token();
    const headers = { ...(opts.headers || {}) };
    if (t) headers['Authorization'] = `Bearer ${t}`;
    let res = await fetch(url, { ...opts, headers });

    // One retry after a forced refresh on 401
    if (res.status === 401 && get()?.refresh_token) {
      const fresh = await refresh();
      if (fresh?.access_token) {
        headers['Authorization'] = `Bearer ${fresh.access_token}`;
        res = await fetch(url, { ...opts, headers });
      }
    }
    return res;
  }

  function requireAuth() {
    if (!get()?.access_token) {
      location.replace('autofilm-login.html');
      return false;
    }
    return true;
  }

  function logout() {
    clear();
    location.replace('autofilm-login.html');
  }

  /**
   * Register the service worker and subscribe this browser to Web Push,
   * saving the subscription to the rep's profile. Call once after sign-in:
   *   AFSession.enablePush('<VAPID_PUBLIC_KEY>')
   */
  async function enablePush(vapidPublicKey) {
    if (!('serviceWorker' in navigator) || !('PushManager' in window)) return false;
    try {
      const reg = await navigator.serviceWorker.register('/sw.js');
      const permission = await Notification.requestPermission();
      if (permission !== 'granted') return false;

      const toUint8 = (b64) => {
        const pad = '='.repeat((4 - b64.length % 4) % 4);
        const raw = atob((b64 + pad).replace(/-/g, '+').replace(/_/g, '/'));
        return Uint8Array.from(raw, c => c.charCodeAt(0));
      };

      const sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: toUint8(vapidPublicKey),
      });

      const res = await authedFetch(`${API}/api/auth/profile`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ push_subscription: sub.toJSON() }),
      });
      return res.ok;
    } catch (e) {
      console.warn('[AFSession] Push setup failed:', e.message);
      return false;
    }
  }

  window.AFSession = { get, rep, set, clear, refresh, token, fetch: authedFetch, requireAuth, logout, enablePush, API };
})();
