/**
 * Stripe client — zero-dependency implementation over the Stripe REST API.
 *
 * Why not the stripe npm package: fewer moving parts, no version pinning
 * headaches, and the subset we need (Checkout, Billing Portal, Subscriptions,
 * webhook verification) is a thin HTTP layer.
 *
 * Env:
 *   STRIPE_SECRET_KEY      sk_live_... / sk_test_...
 *   STRIPE_WEBHOOK_SECRET  whsec_...
 *   STRIPE_PRICE_STANDARD  price id for AutoFilm standalone ($299/rooftop/mo)
 *   STRIPE_PRICE_BUNDLE    price id for suite bundle ($599/rooftop/mo)
 */

import crypto from 'crypto';

const API = 'https://api.stripe.com/v1';

/** Flatten a nested object into Stripe's form-encoded bracket syntax. */
function formEncode(obj, prefix = '') {
  const parts = [];
  for (const [key, value] of Object.entries(obj)) {
    if (value === undefined || value === null) continue;
    const name = prefix ? `${prefix}[${key}]` : key;
    if (Array.isArray(value)) {
      value.forEach((v, i) => {
        if (typeof v === 'object') parts.push(formEncode(v, `${name}[${i}]`));
        else parts.push(`${encodeURIComponent(`${name}[${i}]`)}=${encodeURIComponent(v)}`);
      });
    } else if (typeof value === 'object') {
      parts.push(formEncode(value, name));
    } else {
      parts.push(`${encodeURIComponent(name)}=${encodeURIComponent(value)}`);
    }
  }
  return parts.filter(Boolean).join('&');
}

/** Make an authenticated Stripe API request. */
export async function stripeRequest(method, path, params = null) {
  if (!process.env.STRIPE_SECRET_KEY) {
    throw new Error('STRIPE_SECRET_KEY not configured');
  }

  const opts = {
    method,
    headers: {
      'Authorization': `Bearer ${process.env.STRIPE_SECRET_KEY}`,
      'Stripe-Version': '2024-06-20',
    },
    signal: AbortSignal.timeout(15000),
  };

  let url = `${API}${path}`;
  if (params && method === 'GET') {
    url += `?${formEncode(params)}`;
  } else if (params) {
    opts.headers['Content-Type'] = 'application/x-www-form-urlencoded';
    opts.body = formEncode(params);
  }

  const res = await fetch(url, opts);
  const data = await res.json();

  if (!res.ok) {
    const msg = data?.error?.message || `Stripe API error ${res.status}`;
    const err = new Error(msg);
    err.stripeCode = data?.error?.code;
    err.status = res.status;
    throw err;
  }

  return data;
}

/**
 * Verify a Stripe webhook signature (Stripe-Signature header).
 * Implements the documented scheme: HMAC-SHA256 of `${timestamp}.${rawBody}`.
 *
 * @param {Buffer|string} rawBody - the exact raw request body
 * @param {string} sigHeader - the Stripe-Signature header
 * @param {number} toleranceSecs - max clock skew (default 300s)
 * @returns {boolean}
 */
export function verifyStripeSignature(rawBody, sigHeader, toleranceSecs = 300) {
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!secret || !sigHeader) return false;

  const parts = Object.fromEntries(
    sigHeader.split(',').map(kv => {
      const idx = kv.indexOf('=');
      return [kv.slice(0, idx).trim(), kv.slice(idx + 1)];
    })
  );

  const timestamp = parseInt(parts.t, 10);
  const signature = parts.v1;
  if (!timestamp || !signature) return false;

  // Reject stale events (replay protection)
  if (Math.abs(Date.now() / 1000 - timestamp) > toleranceSecs) return false;

  const payload = `${timestamp}.${rawBody.toString('utf8')}`;
  const expected = crypto.createHmac('sha256', secret).update(payload).digest('hex');

  try {
    return crypto.timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(signature, 'hex'));
  } catch {
    return false;
  }
}

/** Plan catalog — maps friendly plan names to Stripe price env vars. */
export function getPriceId(plan) {
  const prices = {
    standard: process.env.STRIPE_PRICE_STANDARD,
    bundle: process.env.STRIPE_PRICE_BUNDLE,
  };
  return prices[plan] || prices.standard;
}

export const TRIAL_DAYS = parseInt(process.env.STRIPE_TRIAL_DAYS || '30', 10);
