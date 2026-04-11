import webpush from 'web-push';

webpush.setVapidDetails(
  process.env.VAPID_EMAIL,
  process.env.VAPID_PUBLIC_KEY,
  process.env.VAPID_PRIVATE_KEY
);

/**
 * Send a push notification to a rep's browser subscription.
 * @param {object} subscription - The rep's push_subscription from Supabase
 * @param {object} payload - { title, body, icon, data }
 */
export async function sendPush(subscription, payload) {
  if (!subscription) return;
  try {
    await webpush.sendNotification(subscription, JSON.stringify(payload));
    console.log('[push] Sent to rep:', payload.body);
  } catch (err) {
    // Subscription expired — clear it
    if (err.statusCode === 410) {
      console.log('[push] Subscription expired, clearing');
      return { expired: true };
    }
    console.error('[push] Error:', err.message);
  }
}
