/**
 * AutoFilm service worker — Web Push handling + light offline cache.
 *
 * Registered by app pages via:
 *   navigator.serviceWorker.register('/sw.js')
 * then subscribed with the VAPID public key and saved to the
 * rep's push_subscription via PUT /api/auth/profile.
 *
 * Cache strategy (intentionally minimal — the app is API-driven):
 *   - Navigations: network-first, falling back to a tiny inline offline page.
 *   - Same-origin static assets (assets/*.js, *.css, icons, manifest):
 *     cache-first with background fill.
 *   - Everything else (API calls, cross-origin): untouched, straight to network.
 */

const CACHE_VERSION = 'autofilm-v1';

const OFFLINE_HTML = `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>AutoFilm — Offline</title>
<style>body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#0a0a0d;color:rgba(255,255,255,.9);font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;text-align:center;padding:24px}p{max-width:320px;line-height:1.5;font-size:15px}strong{color:#ff6a2b}</style>
</head><body><p><strong>You're offline</strong><br>AutoFilm needs a connection. Check your signal and try again.</p></body></html>`;

const STATIC_ASSET_RE = /\.(?:js|css|png|jpg|jpeg|svg|webp|ico|woff2?)$|\/manifest\.webmanifest$/;

self.addEventListener('install', (event) => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys.filter((k) => k !== CACHE_VERSION).map((k) => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  // Navigations: network-first, offline fallback
  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req).catch(() =>
        new Response(OFFLINE_HTML, {
          status: 503,
          headers: { 'Content-Type': 'text/html; charset=utf-8' },
        })
      )
    );
    return;
  }

  // Same-origin static assets: cache-first
  const url = new URL(req.url);
  if (url.origin === self.location.origin && STATIC_ASSET_RE.test(url.pathname)) {
    event.respondWith(
      caches.open(CACHE_VERSION).then((cache) =>
        cache.match(req).then((hit) => {
          if (hit) return hit;
          return fetch(req).then((res) => {
            if (res.ok) cache.put(req, res.clone());
            return res;
          });
        })
      )
    );
  }
  // Everything else (APIs, cross-origin): default network behavior
});

self.addEventListener('push', (event) => {
  let payload = {};
  try { payload = event.data ? event.data.json() : {}; } catch { payload = { title: 'AutoFilm', body: event.data?.text() || '' }; }

  const title = payload.title || 'AutoFilm';
  const options = {
    body: payload.body || '',
    icon: payload.icon || '/icon-192.png',
    badge: '/icon-192.png',
    tag: payload.tag || undefined,
    requireInteraction: !!payload.requireInteraction,
    data: payload.data || {},
    vibrate: [100, 50, 100],
  };

  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const data = event.notification.data || {};

  // Route by notification type
  let url = '/autofilm-app.html';
  if (data.type === 'incoming_call' && data.call_id) {
    url = `/autofilm-call.html?call_id=${data.call_id}`;
  } else if (data.type === 'inbound_sms' && data.customer_phone) {
    url = `/autofilm-app.html#messages/${encodeURIComponent(data.customer_phone)}`;
  } else if (data.short_code) {
    url = `/autofilm-app.html#video/${data.short_code}`;
  }

  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then((wins) => {
      // Focus an existing app tab if one is open
      for (const win of wins) {
        if (win.url.includes('autofilm') && 'focus' in win) {
          win.navigate(url);
          return win.focus();
        }
      }
      return clients.openWindow(url);
    })
  );
});
