#!/usr/bin/env node
/**
 * One-time (idempotent) Stripe setup for AutoFilm's 3-tier pricing ladder.
 *
 * Creates the Products and recurring Prices for the Sales / Service / Complete
 * tiers (monthly + annual) plus the All-Apps Unlimited bundle, then prints the
 * STRIPE_PRICE_* env var lines to paste into Render (or your .env).
 *
 * Safe to re-run: products are created with fixed ids and prices are keyed by
 * Stripe `lookup_key`, so a second run reuses whatever already exists instead
 * of creating duplicates.
 *
 * Usage:
 *   STRIPE_SECRET_KEY=sk_live_... node scripts/stripe-setup-prices.mjs
 *   # dry run against test mode first:
 *   STRIPE_SECRET_KEY=sk_test_... node scripts/stripe-setup-prices.mjs
 *
 * This script never reads or writes any secret other than STRIPE_SECRET_KEY
 * from the environment. It does not touch the database.
 */

const API = 'https://api.stripe.com/v1';
const KEY = process.env.STRIPE_SECRET_KEY;

if (!KEY) {
  console.error('✖ STRIPE_SECRET_KEY is not set. Run with:\n  STRIPE_SECRET_KEY=sk_live_... node scripts/stripe-setup-prices.mjs');
  process.exit(1);
}
const MODE = KEY.startsWith('sk_live') ? 'LIVE' : 'TEST';

/** Form-encode a flat object (values may be nested one level for metadata). */
function encode(obj, prefix = '') {
  return Object.entries(obj)
    .filter(([, v]) => v !== undefined && v !== null)
    .map(([k, v]) => {
      const name = prefix ? `${prefix}[${k}]` : k;
      return typeof v === 'object'
        ? encode(v, name)
        : `${encodeURIComponent(name)}=${encodeURIComponent(v)}`;
    })
    .join('&');
}

async function stripe(method, path, params) {
  const opts = {
    method,
    headers: { Authorization: `Bearer ${KEY}`, 'Stripe-Version': '2024-06-20' },
  };
  let url = `${API}${path}`;
  if (params && method === 'GET') url += `?${encode(params)}`;
  else if (params) {
    opts.headers['Content-Type'] = 'application/x-www-form-urlencoded';
    opts.body = encode(params);
  }
  const res = await fetch(url, opts);
  const data = await res.json();
  if (!res.ok) {
    const err = new Error(data?.error?.message || `Stripe ${res.status}`);
    err.code = data?.error?.code;
    err.status = res.status;
    throw err;
  }
  return data;
}

/** Create a product with a fixed id, or fetch it if it already exists. */
async function ensureProduct(id, name, description) {
  try {
    const p = await stripe('POST', '/products', {
      id, name, description,
      metadata: { autofilm_tier: id },
    });
    console.log(`  · product ${id} created`);
    return p;
  } catch (e) {
    if (e.code === 'resource_already_exists') {
      console.log(`  · product ${id} exists — reusing`);
      return stripe('GET', `/products/${id}`);
    }
    throw e;
  }
}

/** Find a price by lookup_key, or create it. Amount is in cents. */
async function ensurePrice(lookupKey, product, unitAmount, interval, nickname) {
  const found = await stripe('GET', '/prices', {
    lookup_keys: [lookupKey], active: 'true', limit: 1,
  });
  if (found.data?.length) {
    console.log(`  · price ${lookupKey} exists — reusing (${found.data[0].id})`);
    return found.data[0];
  }
  const price = await stripe('POST', '/prices', {
    product,
    currency: 'usd',
    unit_amount: unitAmount,
    recurring: { interval },
    lookup_key: lookupKey,
    nickname,
    metadata: { autofilm_tier: product },
  });
  console.log(`  · price ${lookupKey} created (${price.id})`);
  return price;
}

// Tier catalog. unit_amount is in cents. Annual prices bill once per year at
// the discounted "$X/mo billed annually" rate (12 × the annual monthly rate).
const CATALOG = [
  { id: 'autofilm_sales',    name: 'AutoFilm — Sales',    desc: 'Personalized sales videos, walkarounds, AI scripts, branded pages, sales analytics. Per rooftop · unlimited users.',
    prices: [
      { env: 'STRIPE_PRICE_SALES_MONTHLY',    key: 'af_sales_monthly',    amount: 39900,  interval: 'month', nick: 'Sales — monthly ($399/mo)' },
      { env: 'STRIPE_PRICE_SALES_ANNUAL',     key: 'af_sales_annual',     amount: 418800, interval: 'year',  nick: 'Sales — annual ($349/mo billed yearly, $4,188/yr)' },
    ] },
  { id: 'autofilm_service',  name: 'AutoFilm — Service',  desc: 'Technician video MPI, AI transcription, timestamped findings, customer approvals, service analytics, vehicle-value offer. Per rooftop · unlimited users.',
    prices: [
      { env: 'STRIPE_PRICE_SERVICE_MONTHLY',  key: 'af_service_monthly',  amount: 59900,  interval: 'month', nick: 'Service — monthly ($599/mo)' },
      { env: 'STRIPE_PRICE_SERVICE_ANNUAL',   key: 'af_service_annual',   amount: 598800, interval: 'year',  nick: 'Service — annual ($499/mo billed yearly, $5,988/yr)' },
    ] },
  { id: 'autofilm_complete', name: 'AutoFilm — Complete', desc: 'Everything in Sales + Service, unified management, shared vehicle records, cross-department analytics, priority support. Per rooftop · unlimited users.',
    prices: [
      { env: 'STRIPE_PRICE_COMPLETE_MONTHLY', key: 'af_complete_monthly', amount: 89900,  interval: 'month', nick: 'Complete — monthly ($899/mo)' },
      { env: 'STRIPE_PRICE_COMPLETE_ANNUAL',  key: 'af_complete_annual',  amount: 958800, interval: 'year',  nick: 'Complete — annual ($799/mo billed yearly, $9,588/yr)' },
    ] },
  { id: 'autofilm_bundle',   name: 'All-Apps Unlimited',  desc: 'AutoCurb + AutoLabels + AutoFilm + AutoFrame suite bundle. Per rooftop · unlimited users.',
    prices: [
      { env: 'STRIPE_PRICE_BUNDLE',           key: 'af_bundle_monthly',   amount: 379400, interval: 'month', nick: 'All-Apps Unlimited — monthly ($3,794/mo)' },
    ] },
];

(async () => {
  console.log(`\nAutoFilm Stripe price setup — ${MODE} mode\n`);
  const envLines = [];
  for (const tier of CATALOG) {
    console.log(`${tier.name}:`);
    const product = await ensureProduct(tier.id, tier.name, tier.desc);
    for (const p of tier.prices) {
      const price = await ensurePrice(p.key, product.id, p.amount, p.interval, p.nick);
      envLines.push(`${p.env}=${price.id}`);
    }
  }

  console.log(`\n${'─'.repeat(60)}`);
  console.log(`Paste these into Render → Environment (${MODE} keys):\n`);
  console.log(envLines.join('\n'));
  console.log(`\nAlso ensure STRIPE_SECRET_KEY and STRIPE_WEBHOOK_SECRET are set.`);
  console.log(`${'─'.repeat(60)}\n`);
})().catch((e) => {
  console.error(`\n✖ Setup failed: ${e.message}${e.code ? ` (${e.code})` : ''}`);
  process.exit(1);
});
