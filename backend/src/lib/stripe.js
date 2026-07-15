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
 *
 *   Three-tier ladder (per rooftop · unlimited users). Each tier has a
 *   monthly price and a discounted price billed annually:
 *     STRIPE_PRICE_SALES_MONTHLY      Sales    $399/mo
 *     STRIPE_PRICE_SALES_ANNUAL       Sales    $349/mo billed annually ($4,188/yr)
 *     STRIPE_PRICE_SERVICE_MONTHLY    Service  $599/mo
 *     STRIPE_PRICE_SERVICE_ANNUAL     Service  $499/mo billed annually ($5,988/yr)
 *     STRIPE_PRICE_COMPLETE_MONTHLY   Complete $899/mo
 *     STRIPE_PRICE_COMPLETE_ANNUAL    Complete $799/mo billed annually ($9,588/yr)
 *     STRIPE_PRICE_BUNDLE             All-Apps Unlimited suite bundle ($3,794/mo)
 *     STRIPE_PRICE_BUNDLE_ANNUAL      optional annual bundle price
 *
 *   Legacy (kept so already-subscribed rooftops keep resolving):
 *     STRIPE_PRICE_STANDARD  retired flat AutoFilm plan
 *
 *   Run `node scripts/stripe-setup-prices.mjs` with STRIPE_SECRET_KEY set to
 *   create these products/prices in Stripe and print the env var lines.
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

/**
 * Plans a rooftop can subscribe to through checkout. `standard` is legacy —
 * not offered to new rooftops, but kept so existing subscriptions resolve.
 */
export const SUBSCRIBABLE_PLANS = ['sales', 'service', 'complete', 'bundle'];

/**
 * Plan catalog — maps a plan + billing period to its Stripe price env var.
 * Monthly is the default (it's the headline price under each plan button);
 * pass period 'annual' for the discounted billed-yearly price.
 *
 * Returns undefined when no price is configured for the requested plan —
 * callers must treat that as "not available" (a clean error), never fall
 * back to a different plan's price, so a rooftop is never charged the wrong
 * amount for the plan it picked.
 */
export function getPriceId(plan, period = 'monthly') {
  const annual = period === 'annual';
  const map = {
    sales:    annual ? process.env.STRIPE_PRICE_SALES_ANNUAL    : process.env.STRIPE_PRICE_SALES_MONTHLY,
    service:  annual ? process.env.STRIPE_PRICE_SERVICE_ANNUAL  : process.env.STRIPE_PRICE_SERVICE_MONTHLY,
    complete: annual ? process.env.STRIPE_PRICE_COMPLETE_ANNUAL : process.env.STRIPE_PRICE_COMPLETE_MONTHLY,
    bundle:   annual ? process.env.STRIPE_PRICE_BUNDLE_ANNUAL   : process.env.STRIPE_PRICE_BUNDLE,
    standard: process.env.STRIPE_PRICE_STANDARD, // legacy — monthly only
  };
  // Fall back to the monthly price if a plan has no annual price configured,
  // so a half-configured annual option degrades to monthly rather than
  // resolving to a different plan.
  if (annual && map[plan] === undefined && plan !== 'standard') {
    return getPriceId(plan, 'monthly');
  }
  return map[plan];
}

/**
 * Reverse lookup — resolve a Stripe price id back to our plan name, used by
 * the webhook to keep `rooftops.plan` in sync when a subscription's price
 * changes (upgrade/downgrade via the billing portal). Returns null when the
 * price id matches nothing configured.
 */
export function getPlanFromPriceId(priceId) {
  if (!priceId) return null;
  const env = process.env;
  const byPrice = {
    [env.STRIPE_PRICE_SALES_MONTHLY]:    'sales',
    [env.STRIPE_PRICE_SALES_ANNUAL]:     'sales',
    [env.STRIPE_PRICE_SERVICE_MONTHLY]:  'service',
    [env.STRIPE_PRICE_SERVICE_ANNUAL]:   'service',
    [env.STRIPE_PRICE_COMPLETE_MONTHLY]: 'complete',
    [env.STRIPE_PRICE_COMPLETE_ANNUAL]:  'complete',
    [env.STRIPE_PRICE_BUNDLE]:           'bundle',
    [env.STRIPE_PRICE_BUNDLE_ANNUAL]:    'bundle',
    [env.STRIPE_PRICE_STANDARD]:         'standard',
  };
  // An unset env var keys `undefined` in the object — guard against a stray
  // undefined price id matching it.
  delete byPrice.undefined;
  return byPrice[priceId] || null;
}

export const TRIAL_DAYS = parseInt(process.env.STRIPE_TRIAL_DAYS || '30', 10);
