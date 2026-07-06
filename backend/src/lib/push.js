import webpush from 'web-push';
import { supabase } from './supabase.js';

// Misconfigured/absent VAPID keys must not crash the whole server on import
// (push.js is transitively imported by many routes). Fail soft — individual
// sends will then error and be swallowed by sendPush's try/catch.
try {
  webpush.setVapidDetails(
    process.env.VAPID_EMAIL,
    process.env.VAPID_PUBLIC_KEY,
    process.env.VAPID_PRIVATE_KEY
  );
} catch (err) {
  console.error('[push] VAPID setup failed — push disabled:', err.message);
}

// A hung web-push request must never block a caller that awaits sendPush
// (reply/messaging/call/mpi all await it inside a request handler).
const PUSH_TIMEOUT_MS = 10000;

/**
 * Send a push notification to a rep's browser subscription.
 * Never throws — a bad/dead subscription can't crash the caller.
 * @param {object} subscription - The rep's push_subscription from Supabase
 * @param {object} payload - { title, body, icon, data }
 */
export async function sendPush(subscription, payload) {
  if (!subscription) return;
  try {
    await Promise.race([
      webpush.sendNotification(subscription, JSON.stringify(payload)),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('push timeout')), PUSH_TIMEOUT_MS)
      ),
    ]);
    console.log('[push] Sent to rep:', payload.body);
  } catch (err) {
    // 410 Gone / 404 Not Found → subscription is permanently dead. Prune it
    // so we stop hammering a dead endpoint on every future event.
    if (err.statusCode === 410 || err.statusCode === 404) {
      console.log('[push] Subscription gone, pruning');
      if (subscription.endpoint) {
        supabase
          .from('reps')
          .update({ push_subscription: null })
          .eq('push_subscription->>endpoint', subscription.endpoint)
          .then(
            () => {},
            (e) => console.error('[push] Prune failed:', e.message)
          );
      }
      return { expired: true };
    }
    console.error('[push] Error:', err.message);
  }
}
