/**
 * AutoFilm Auth System
 *
 * Built on Supabase Auth with:
 *   - Email + password sign up/in
 *   - Magic link (passwordless) sign in
 *   - Invite flow: admin invites rep → magic link email → profile setup
 *   - Session validation middleware
 *   - Role-based access control
 */

import { supabase } from './supabase.js';

/**
 * Middleware: validate Supabase Auth session from Bearer token.
 * Attaches req.user (Supabase user) and req.rep (AutoFilm rep record).
 */
export function requireAuth() {
  return async (req, res, next) => {
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'Missing authorization token' });
    }

    const token = authHeader.slice(7);

    try {
      const { data: { user }, error } = await supabase.auth.getUser(token);
      if (error || !user) {
        return res.status(401).json({ error: 'Invalid or expired token' });
      }

      // Look up the rep record
      const { data: rep, error: repErr } = await supabase
        .from('reps')
        .select('id, rooftop_id, name, nickname, email, role, department, active, photo_url, onboarded')
        .eq('email', user.email)
        .single();

      if (repErr || !rep) {
        return res.status(403).json({ error: 'No rep account found for this email' });
      }

      if (!rep.active) {
        return res.status(403).json({ error: 'Account is deactivated' });
      }

      req.user = user;
      req.rep = rep;
      next();
    } catch (err) {
      console.error('[auth] Validation error:', err.message);
      res.status(401).json({ error: 'Authentication failed' });
    }
  };
}

/**
 * Middleware: require specific roles.
 * Use after requireAuth().
 */
export function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.rep) return res.status(401).json({ error: 'Not authenticated' });
    if (!roles.includes(req.rep.role)) {
      return res.status(403).json({ error: `Requires role: ${roles.join(' or ')}` });
    }
    next();
  };
}

/**
 * Middleware: require same rooftop (prevent cross-tenant access).
 * Checks req.params.rooftop_id or req.body.rooftop_id against req.rep.rooftop_id.
 */
export function requireSameRooftop() {
  return (req, res, next) => {
    const target = req.params.rooftop_id || req.body.rooftop_id || req.query.rooftop_id;
    if (target && target !== req.rep.rooftop_id) {
      return res.status(403).json({ error: 'Access denied: different rooftop' });
    }
    next();
  };
}
