/**
 * Tenant resolver for AutoFilm.
 *
 * Two deployment modes:
 *   1. STANDALONE (autofilm.io) — resolve tenant from Supabase Auth session
 *   2. BUNDLED (autocurb.io/film/*) — resolve tenant from signed JWT in X-Tenant-Token header
 *
 * The JWT contract for bundled mode:
 *   {
 *     "tenant_id": "<autocurb rooftop uuid>",
 *     "rep_id": "<autocurb rep uuid>",
 *     "rooftop_id": "<autocurb rooftop uuid>",
 *     "email": "rep@dealer.com",
 *     "name": "Ken Criscione",
 *     "iat": 1700000000,
 *     "exp": 1700003600
 *   }
 *
 * Signed with HS256 using shared secret: AUTOCURB_JWT_SECRET
 */

import { supabase } from './supabase.js';

/**
 * Express middleware: resolves tenant context and attaches to req.tenant.
 * Non-blocking — if no tenant can be resolved, req.tenant is null.
 */
export function resolveTenant() {
  return async (req, res, next) => {
    req.tenant = null;

    try {
      // Mode 1: Bundled — check for AutoCurb JWT
      const tenantToken = req.headers['x-tenant-token'];
      if (tenantToken && process.env.AUTOCURB_JWT_SECRET) {
        const payload = await verifyJwt(tenantToken, process.env.AUTOCURB_JWT_SECRET);
        if (payload) {
          req.tenant = {
            mode: 'bundled',
            rooftopId: payload.rooftop_id,
            repId: payload.rep_id,
            email: payload.email,
            name: payload.name,
            source: 'autocurb',
          };
          return next();
        }
      }

      // Mode 2: Standalone — check for Supabase Auth Bearer token
      const authHeader = req.headers.authorization;
      if (authHeader?.startsWith('Bearer ')) {
        const token = authHeader.slice(7);
        const { data: { user }, error } = await supabase.auth.getUser(token);
        if (user && !error) {
          // Look up rep by email
          const { data: rep } = await supabase
            .from('reps')
            .select('id, rooftop_id, name, role, department')
            .eq('email', user.email)
            .single();

          if (rep) {
            req.tenant = {
              mode: 'standalone',
              rooftopId: rep.rooftop_id,
              repId: rep.id,
              email: user.email,
              name: rep.name,
              role: rep.role,
              department: rep.department,
              source: 'autofilm',
            };
          }
        }
      }

      // Mode 3: API key based (for CRM integrations, webhook callbacks)
      const apiKey = req.headers['x-api-key'];
      if (apiKey && !req.tenant) {
        const { data: connection } = await supabase
          .from('crm_connections')
          .select('rooftop_id, provider')
          .eq('api_key', apiKey)
          .eq('active', true)
          .single();

        if (connection) {
          req.tenant = {
            mode: 'api',
            rooftopId: connection.rooftop_id,
            source: connection.provider,
          };
        }
      }
    } catch (err) {
      console.error('[tenant] Resolution error:', err.message);
    }

    next();
  };
}

/**
 * Middleware: require tenant to be resolved. 401 if not.
 */
export function requireTenant() {
  return (req, res, next) => {
    if (!req.tenant) {
      return res.status(401).json({ error: 'Authentication required' });
    }
    next();
  };
}

/**
 * Middleware: require specific roles.
 */
export function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.tenant) {
      return res.status(401).json({ error: 'Authentication required' });
    }
    if (req.tenant.role && !roles.includes(req.tenant.role)) {
      return res.status(403).json({ error: 'Insufficient permissions' });
    }
    next();
  };
}

/**
 * Verify a HS256 JWT using the Web Crypto API (Node 20+).
 */
async function verifyJwt(token, secret) {
  try {
    const [headerB64, payloadB64, signatureB64] = token.split('.');
    if (!headerB64 || !payloadB64 || !signatureB64) return null;

    const encoder = new TextEncoder();
    const key = await crypto.subtle.importKey(
      'raw',
      encoder.encode(secret),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['verify']
    );

    const data = encoder.encode(`${headerB64}.${payloadB64}`);
    const signature = Uint8Array.from(
      atob(signatureB64.replace(/-/g, '+').replace(/_/g, '/')),
      c => c.charCodeAt(0)
    );

    const valid = await crypto.subtle.verify('HMAC', key, signature, data);
    if (!valid) return null;

    const payload = JSON.parse(atob(payloadB64.replace(/-/g, '+').replace(/_/g, '/')));

    // Check expiration
    if (payload.exp && payload.exp < Math.floor(Date.now() / 1000)) {
      console.log('[tenant] JWT expired');
      return null;
    }

    return payload;
  } catch (err) {
    console.error('[tenant] JWT verification failed:', err.message);
    return null;
  }
}
