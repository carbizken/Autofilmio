import express from 'express';
import { supabase } from '../lib/supabase.js';
import { requireAuth, requireRole } from '../lib/auth.js';

const router = express.Router();

const APP_URL = process.env.APP_URL || 'https://autofilm.io';

/**
 * POST /api/auth/signup
 * Register a new user (admin creating their account during onboarding).
 * Body: { email, password, name }
 */
router.post('/signup', async (req, res) => {
  try {
    const { email, password, name } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'email and password required' });

    // Create Supabase Auth user
    const { data: authData, error: authErr } = await supabase.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
    });

    if (authErr) {
      if (authErr.message.includes('already registered')) {
        return res.status(409).json({ error: 'Email already registered' });
      }
      throw authErr;
    }

    // Check if rep record exists (created during onboarding)
    const { data: existingRep } = await supabase
      .from('reps')
      .select('id, rooftop_id')
      .eq('email', email)
      .single();

    if (existingRep) {
      // Update existing rep with confirmed status
      await supabase.from('reps').update({ onboarded: true }).eq('id', existingRep.id);
    }

    // Sign in immediately
    const { data: session, error: signInErr } = await supabase.auth.signInWithPassword({ email, password });
    if (signInErr) throw signInErr;

    console.log(`[auth] Signup: ${email}`);

    res.json({
      success: true,
      user: { id: authData.user.id, email },
      session: {
        access_token: session.session.access_token,
        refresh_token: session.session.refresh_token,
        expires_at: session.session.expires_at,
      },
      rep: existingRep || null,
    });

  } catch (err) {
    console.error('[auth] Signup error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/auth/login
 * Sign in with email + password.
 * Body: { email, password }
 */
router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'email and password required' });

    const { data, error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    // Get rep record
    const { data: rep } = await supabase
      .from('reps')
      .select('id, rooftop_id, name, nickname, role, department, photo_url, onboarded, rooftops(name, brand_color, logo_url)')
      .eq('email', email)
      .single();

    console.log(`[auth] Login: ${email}`);

    res.json({
      success: true,
      session: {
        access_token: data.session.access_token,
        refresh_token: data.session.refresh_token,
        expires_at: data.session.expires_at,
      },
      rep,
    });

  } catch (err) {
    console.error('[auth] Login error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/auth/magic-link
 * Send a magic link email for passwordless sign-in.
 * Body: { email }
 */
router.post('/magic-link', async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: 'email required' });

    // Verify the rep exists
    const { data: rep } = await supabase
      .from('reps')
      .select('id, name')
      .eq('email', email)
      .single();

    if (!rep) {
      return res.status(404).json({ error: 'No account found for this email' });
    }

    const { error } = await supabase.auth.signInWithOtp({
      email,
      options: {
        emailRedirectTo: `${APP_URL}/autofilm-app.html`,
      },
    });

    if (error) throw error;

    console.log(`[auth] Magic link sent: ${email}`);
    res.json({ success: true, message: 'Check your email for the login link' });

  } catch (err) {
    console.error('[auth] Magic link error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/auth/refresh
 * Refresh an expired access token.
 * Body: { refresh_token }
 */
router.post('/refresh', async (req, res) => {
  try {
    const { refresh_token } = req.body;
    if (!refresh_token) return res.status(400).json({ error: 'refresh_token required' });

    const { data, error } = await supabase.auth.refreshSession({ refresh_token });
    if (error) {
      return res.status(401).json({ error: 'Invalid refresh token' });
    }

    res.json({
      success: true,
      session: {
        access_token: data.session.access_token,
        refresh_token: data.session.refresh_token,
        expires_at: data.session.expires_at,
      },
    });

  } catch (err) {
    console.error('[auth] Refresh error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/auth/reset-password
 * Send a password reset email.
 * Body: { email }
 */
router.post('/reset-password', async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: 'email required' });

    const { error } = await supabase.auth.resetPasswordForEmail(email, {
      redirectTo: `${APP_URL}/autofilm-app.html?reset=true`,
    });

    if (error) throw error;

    console.log(`[auth] Password reset sent: ${email}`);
    res.json({ success: true, message: 'Check your email for the reset link' });

  } catch (err) {
    console.error('[auth] Reset error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/auth/update-password
 * Update password (user is authenticated).
 * Body: { new_password }
 */
router.post('/update-password', requireAuth(), async (req, res) => {
  try {
    const { new_password } = req.body;
    if (!new_password || new_password.length < 8) {
      return res.status(400).json({ error: 'Password must be at least 8 characters' });
    }

    const token = req.headers.authorization.slice(7);
    const { error } = await supabase.auth.admin.updateUserById(req.user.id, {
      password: new_password,
    });

    if (error) throw error;

    console.log(`[auth] Password updated: ${req.user.email}`);
    res.json({ success: true });

  } catch (err) {
    console.error('[auth] Update password error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/auth/invite
 * Admin invites a new rep. Creates rep record + sends magic link.
 * Body: { email, name, role?, department? }
 */
router.post('/invite', requireAuth(), requireRole('admin', 'manager'), async (req, res) => {
  try {
    const { email, name, role = 'sales', department = 'sales' } = req.body;
    if (!email || !name) return res.status(400).json({ error: 'email and name required' });

    // Check if already exists
    const { data: existing } = await supabase
      .from('reps')
      .select('id')
      .eq('email', email)
      .single();

    if (existing) {
      return res.status(409).json({ error: 'A rep with this email already exists' });
    }

    // Create rep record
    const { data: rep, error: repErr } = await supabase
      .from('reps')
      .insert({
        rooftop_id: req.rep.rooftop_id,
        name,
        email,
        role,
        department,
        onboarded: false,
      })
      .select()
      .single();

    if (repErr) throw repErr;

    // Create Supabase Auth user with auto-generated password
    // They'll use magic link to set their own password
    const tempPassword = crypto.randomUUID();
    await supabase.auth.admin.createUser({
      email,
      password: tempPassword,
      email_confirm: true,
    });

    // Send magic link as the invite email
    await supabase.auth.signInWithOtp({
      email,
      options: {
        emailRedirectTo: `${APP_URL}/autofilm-app.html?invited=true&setup=true`,
      },
    });

    console.log(`[auth] Invited ${name} (${email}) by ${req.rep.name}`);

    res.json({ success: true, rep });

  } catch (err) {
    console.error('[auth] Invite error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/auth/me
 * Get current user's profile (rep + rooftop).
 */
router.get('/me', requireAuth(), async (req, res) => {
  const { data: rep } = await supabase
    .from('reps')
    .select('*, rooftops(id, name, brand_color, logo_url, website_url, plan, active)')
    .eq('id', req.rep.id)
    .single();

  res.json({ rep });
});

/**
 * PUT /api/auth/profile
 * Update current user's profile.
 * Body: { name?, nickname?, title?, phone?, photo_url?, push_subscription? }
 */
router.put('/profile', requireAuth(), async (req, res) => {
  try {
    const allowed = ['name', 'nickname', 'title', 'phone', 'photo_url', 'push_subscription'];
    const updates = {};
    for (const key of allowed) {
      if (req.body[key] !== undefined) updates[key] = req.body[key];
    }

    if (Object.keys(updates).length === 0) {
      return res.status(400).json({ error: 'No fields to update' });
    }

    const { data, error } = await supabase
      .from('reps')
      .update(updates)
      .eq('id', req.rep.id)
      .select()
      .single();

    if (error) throw error;

    res.json({ success: true, rep: data });

  } catch (err) {
    console.error('[auth] Profile update error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

export default router;
