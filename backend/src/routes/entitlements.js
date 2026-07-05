/**
 * Entitlements — read-only source of truth for what a rooftop's
 * subscription unlocks across the suite (AutoFilm, AutoCurb,
 * AutoLabels, AutoFrame).
 *
 * Consumed by:
 *   - the shared app switcher (frontend/assets/appswitcher.js) via the
 *     rep's Supabase session
 *   - sibling apps server-side via the X-Tenant-Token HS256 JWT
 *     (verified upstream by resolveTenant() in index.js — see lib/tenant.js)
 *
 * No mutation endpoints here by design — billing webhooks own the writes.
 */

import express from 'express';
import { supabase } from '../lib/supabase.js';
import { requireAuth } from '../lib/auth.js';

const router = express.Router();

/**
 * Middleware: accept EITHER a resolved tenant (X-Tenant-Token JWT or
 * API key, attached as req.tenant by the global resolveTenant()) OR an
 * AutoFilm rep session (Supabase Bearer token via requireAuth).
 */
function requireCaller() {
  const repAuth = requireAuth();
  return (req, res, next) => {
    if (req.tenant?.rooftopId) return next();
    return repAuth(req, res, next);
  };
}

/**
 * Derive the product map from plan + subscription state.
 * Rules:
 *   - active/trialing on 'standard' → autofilm only
 *   - active/trialing on 'bundle'   → all four suite products
 *   - past_due                      → access continues while rooftops.active
 *     is still true (mirrors the grace behavior billing.js already models
 *     in its subscription.updated handler)
 *   - canceled / none / anything else → nothing
 */
function deriveProducts(rooftop) {
  const status = rooftop.subscription_status || 'none';
  const entitled =
    ['active', 'trialing'].includes(status) ||
    (status === 'past_due' && rooftop.active === true);

  const bundle = entitled && rooftop.plan === 'bundle';

  return {
    autofilm: entitled,
    autocurb: bundle,
    autolabels: bundle,
    autoframe: bundle,
  };
}

/**
 * GET /api/entitlements
 * Entitlements for the caller's rooftop.
 * Returns: { rooftop_id, plan, status, trial_ends_at, products }
 */
router.get('/', requireCaller(), async (req, res) => {
  try {
    const rooftopId = req.tenant?.rooftopId || req.rep?.rooftop_id;
    if (!rooftopId) {
      return res.status(401).json({ error: 'No rooftop in auth context' });
    }

    const { data: rooftop, error } = await supabase
      .from('rooftops')
      .select('id, plan, subscription_status, trial_ends_at, active')
      .eq('id', rooftopId)
      .single();

    if (error || !rooftop) {
      console.warn(`[entitlements] Rooftop not found: ${rooftopId}`);
      return res.status(404).json({ error: 'Rooftop not found' });
    }

    res.json({
      rooftop_id: rooftop.id,
      plan: rooftop.plan,
      status: rooftop.subscription_status || 'none',
      trial_ends_at: rooftop.trial_ends_at,
      products: deriveProducts(rooftop),
    });
  } catch (err) {
    console.error('[entitlements] Lookup error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

export default router;
