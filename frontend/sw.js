/**
 * AutoFilm service worker — Web Push handling.
 *
 * Registered by app pages via:
 *   navigator.serviceWorker.register('/sw.js')
 * then subscribed with the VAPID public key and saved to the
 * rep's push_subscription via PUT /api/auth/profile.
 */

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
