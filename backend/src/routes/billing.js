import express from 'express';
import { supabase } from '../lib/supabase.js';
import { requireAuth, requireRole } from '../lib/auth.js';
import { stripeRequest, verifyStripeSignature, getPriceId, TRIAL_DAYS } from '../lib/stripe.js';

const router = express.Router();

const APP_URL = process.env.APP_URL || 'https://autofilm.io';

/**
 * POST /api/billing/checkout
 * Admin starts a subscription for their rooftop.
 * Body: { plan?: 'standard' | 'bundle', return_to?: string }
 * return_to is an optional same-origin path (e.g. '/autofilm-onboard.html')
 * Stripe redirects back to with ?billing=success|canceled appended.
 * Returns: { checkout_url }
 */
router.post('/checkout', requireAuth(), requireRole('admin', 'manager'), async (req, res) => {
  try {
    const { plan = 'standard', return_to } = req.body;

    // Whitelist the plan so the charged price and the plan we persist can't
    // diverge (an arbitrary plan string would otherwise land in metadata).
    if (!['standard', 'bundle'].includes(plan)) {
      return res.status(400).json({ error: `Invalid plan: ${plan}` });
    }

    // Only allow absolute paths on our own origin (no '//host', no query) —
    // anything else falls back to the settings page.
    const returnPath = (typeof return_to === 'string' && /^\/(?!\/)[\w./-]*$/.test(return_to))
      ? return_to
      : '/autofilm-settings.html';
    const priceId = getPriceId(plan);
    if (!priceId) return res.status(500).json({ error: `No Stripe price configured for plan: ${plan}` });

    const { data: rooftop, error } = await supabase
      .from('rooftops')
      .select('id, name, stripe_customer_id, subscription_status')
      .eq('id', req.rep.rooftop_id)
      .single();
    if (error || !rooftop) return res.status(404).json({ error: 'Rooftop not found' });

    if (['active', 'trialing'].includes(rooftop.subscription_status)) {
      return res.status(409).json({ error: 'Rooftop already has an active subscription. Use the billing portal to change plans.' });
    }

    // Reuse the Stripe customer if we have one, otherwise create it
    let customerId = rooftop.stripe_customer_id;
    if (!customerId) {
      const customer = await stripeRequest('POST', '/customers', {
        name: rooftop.name,
        email: req.rep.email,
        metadata: { rooftop_id: rooftop.id },
      });
      customerId = customer.id;
      await supabase.from('rooftops').update({ stripe_customer_id: customerId }).eq('id', rooftop.id);
    }

    const session = await stripeRequest('POST', '/checkout/sessions', {
      mode: 'subscription',
      customer: customerId,
      line_items: [{ price: priceId, quantity: 1 }],
      subscription_data: {
        trial_period_days: TRIAL_DAYS,
        metadata: { rooftop_id: rooftop.id, plan },
      },
      success_url: `${APP_URL}${returnPath}?billing=success`,
      cancel_url: `${APP_URL}${returnPath}?billing=canceled`,
      allow_promotion_codes: true,
      metadata: { rooftop_id: rooftop.id, plan },
    });

    console.log(`[billing] Checkout session ${session.id} for rooftop ${rooftop.id} (${plan})`);
    res.json({ checkout_url: session.url });

  } catch (err) {
    console.error('[billing] Checkout error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/billing/portal
 * Open the Stripe Billing Portal (update card, view invoices, cancel).
 * Returns: { portal_url }
 */
router.post('/portal', requireAuth(), requireRole('admin', 'manager'), async (req, res) => {
  try {
    const { data: rooftop } = await supabase
      .from('rooftops')
      .select('stripe_customer_id')
      .eq('id', req.rep.rooftop_id)
      .single();

    if (!rooftop?.stripe_customer_id) {
      return res.status(404).json({ error: 'No billing account yet. Start a subscription first.' });
    }

    const session = await stripeRequest('POST', '/billing_portal/sessions', {
      customer: rooftop.stripe_customer_id,
      return_url: `${APP_URL}/autofilm-settings.html`,
    });

    res.json({ portal_url: session.url });

  } catch (err) {
    console.error('[billing] Portal error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/billing/status
 * Subscription status for the caller's rooftop.
 */
router.get('/status', requireAuth(), async (req, res) => {
  try {
    const { data: rooftop, error } = await supabase
      .from('rooftops')
      .select('plan, subscription_status, trial_ends_at, current_period_end, stripe_customer_id')
      .eq('id', req.rep.rooftop_id)
      .single();
    if (error) throw error;

    res.json({
      plan: rooftop.plan,
      status: rooftop.subscription_status || 'none',
      trial_ends_at: rooftop.trial_ends_at,
      current_period_end: rooftop.current_period_end,
      has_billing_account: !!rooftop.stripe_customer_id,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/billing/webhook
 * Stripe event webhook. Requires the raw body captured by the
 * express.json verify hook in index.js (req.rawBody).
 */
router.post('/webhook', async (req, res) => {
  const sig = req.headers['stripe-signature'];

  if (!verifyStripeSignature(req.rawBody || '', sig)) {
    console.warn('[billing] Webhook signature verification FAILED');
    return res.status(400).json({ error: 'Invalid signature' });
  }

  const event = req.body;
  console.log(`[billing] Webhook: ${event.type}`);

  try {
    switch (event.type) {
      case 'checkout.session.completed': {
        const session = event.data.object;
        const rooftopId = session.metadata?.rooftop_id;
        if (rooftopId && session.subscription) {
          await supabase.from('rooftops').update({
            stripe_subscription_id: session.subscription,
            subscription_status: 'trialing',
            plan: session.metadata?.plan || 'standard',
            active: true,
          }).eq('id', rooftopId);
          console.log(`[billing] Subscription started for rooftop ${rooftopId}`);
        }
        break;
      }

      case 'customer.subscription.updated':
      case 'customer.subscription.created': {
        const sub = event.data.object;
        const rooftopId = sub.metadata?.rooftop_id;
        const update = {
          subscription_status: sub.status,
          stripe_subscription_id: sub.id,
          trial_ends_at: sub.trial_end ? new Date(sub.trial_end * 1000).toISOString() : null,
          current_period_end: sub.current_period_end ? new Date(sub.current_period_end * 1000).toISOString() : null,
          active: ['active', 'trialing', 'past_due'].includes(sub.status),
        };
        // Keep plan in sync with the subscribed price — upgrades/downgrades
        // happen in the Stripe billing portal, not through our checkout.
        const priceId = sub.items?.data?.[0]?.price?.id;
        if (priceId && priceId === process.env.STRIPE_PRICE_BUNDLE) {
          update.plan = 'bundle';
        } else if (priceId && priceId === process.env.STRIPE_PRICE_STANDARD) {
          update.plan = 'standard';
        }
        if (rooftopId) {
          await supabase.from('rooftops').update(update).eq('id', rooftopId);
        } else {
          // Fall back to matching by customer id
          await supabase.from('rooftops').update(update).eq('stripe_customer_id', sub.customer);
        }
        break;
      }

      case 'customer.subscription.deleted': {
        const sub = event.data.object;
        await supabase.from('rooftops').update({
          subscription_status: 'canceled',
          active: false,
        }).eq('stripe_customer_id', sub.customer);
        console.log(`[billing] Subscription canceled for customer ${sub.customer}`);
        break;
      }

      case 'invoice.payment_failed': {
        const invoice = event.data.object;
        await supabase.from('rooftops').update({
          subscription_status: 'past_due',
        }).eq('stripe_customer_id', invoice.customer);
        console.log(`[billing] Payment failed for customer ${invoice.customer}`);
        break;
      }

      default:
        // Acknowledge unhandled events quietly
        break;
    }

    res.json({ received: true });

  } catch (err) {
    console.error('[billing] Webhook handler error:', err.message);
    // 500 makes Stripe retry — correct behavior for transient DB failures
    res.status(500).json({ error: err.message });
  }
});

export default router;
