import express from 'express';
import { supabase } from '../lib/supabase.js';
import { requireAuth, requireRole } from '../lib/auth.js';
import { testConnection } from '../lib/crm.js';

const router = express.Router();

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isUuid = (v) => typeof v === 'string' && UUID_RE.test(v);

// All admin routes require auth + admin/manager role
router.use(requireAuth());
router.use(requireRole('admin', 'manager'));

// ── REPS MANAGEMENT ─────────────────────────────────────────

/** GET /api/admin/reps — list all reps for the rooftop */
router.get('/reps', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('reps')
      .select('id, name, nickname, email, role, department, phone, active, onboarded, photo_url, created_at')
      .eq('rooftop_id', req.rep.rooftop_id)
      .order('name');
    if (error) throw error;
    res.json({ reps: data || [] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/** PUT /api/admin/reps/:id — update a rep */
router.put('/reps/:id', async (req, res) => {
  try {
    if (!isUuid(req.params.id)) return res.status(400).json({ error: 'Invalid rep id' });
    const allowed = ['name', 'nickname', 'title', 'email', 'role', 'department', 'phone', 'active', 'photo_url'];
    const updates = {};
    for (const k of allowed) if (req.body[k] !== undefined) updates[k] = req.body[k];

    const { data, error } = await supabase
      .from('reps')
      .update(updates)
      .eq('id', req.params.id)
      .eq('rooftop_id', req.rep.rooftop_id)
      .select()
      .single();
    if (error) throw error;
    res.json({ success: true, rep: data });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/** DELETE /api/admin/reps/:id — deactivate a rep */
router.delete('/reps/:id', async (req, res) => {
  try {
    if (!isUuid(req.params.id)) return res.status(400).json({ error: 'Invalid rep id' });
    await supabase
      .from('reps')
      .update({ active: false })
      .eq('id', req.params.id)
      .eq('rooftop_id', req.rep.rooftop_id);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── ROOFTOP SETTINGS ────────────────────────────────────────

/** GET /api/admin/settings — rooftop settings */
router.get('/settings', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('rooftops')
      .select('*')
      .eq('id', req.rep.rooftop_id)
      .single();
    if (error) throw error;
    res.json({ rooftop: data });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/** PUT /api/admin/settings — update rooftop settings */
router.put('/settings', async (req, res) => {
  try {
    const allowed = ['name', 'dealer_group', 'website_url', 'logo_url', 'brand_color', 'brand_color_2', 'phone', 'address', 'city', 'state', 'zip', 'inventory_feed_url'];
    const updates = {};
    for (const k of allowed) if (req.body[k] !== undefined) updates[k] = req.body[k];

    const { data, error } = await supabase
      .from('rooftops')
      .update(updates)
      .eq('id', req.rep.rooftop_id)
      .select()
      .single();
    if (error) throw error;
    res.json({ success: true, rooftop: data });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── CRM CONNECTIONS ─────────────────────────────────────────

/** GET /api/admin/crm — list CRM connections */
router.get('/crm', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('crm_connections')
      .select('id, provider, dealer_id, endpoint_url, active, last_sync_at, created_at')
      .eq('rooftop_id', req.rep.rooftop_id);
    if (error) throw error;
    res.json({ connections: data || [] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/** POST /api/admin/crm — add a CRM connection */
router.post('/crm', async (req, res) => {
  try {
    const { provider, api_key, api_secret, dealer_id, endpoint_url, config } = req.body;
    if (!provider || !api_key) return res.status(400).json({ error: 'provider and api_key required' });

    const { data, error } = await supabase
      .from('crm_connections')
      .upsert({
        rooftop_id: req.rep.rooftop_id,
        provider,
        api_key,
        api_secret: api_secret || null,
        dealer_id: dealer_id || null,
        endpoint_url: endpoint_url || null,
        config: config || {},
        active: true,
      }, { onConflict: 'rooftop_id,provider' })
      .select()
      .single();
    if (error) throw error;
    res.json({ success: true, connection: data });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/** POST /api/admin/crm/test — test CRM credentials without persisting.
 *  Body: { id } to test a saved connection, or { provider, api_key, api_secret?, dealer_id?, endpoint_url?, config? } */
router.post('/crm/test', async (req, res) => {
  try {
    const { id, provider, api_key, api_secret, dealer_id, endpoint_url, config } = req.body;

    let connection;
    if (id) {
      if (!isUuid(id)) return res.status(400).json({ error: 'Invalid connection id' });
      const { data, error } = await supabase
        .from('crm_connections')
        .select('*')
        .eq('id', id)
        .eq('rooftop_id', req.rep.rooftop_id)
        .single();
      if (error || !data) return res.status(404).json({ error: 'Connection not found' });
      connection = data;
    } else {
      if (!provider || !api_key) return res.status(400).json({ error: 'provider and api_key required' });
      connection = {
        provider,
        api_key,
        api_secret: api_secret || null,
        dealer_id: dealer_id || null,
        endpoint_url: endpoint_url || null,
        config: config || {},
      };
    }

    const result = await testConnection(connection);
    console.log(`[admin] CRM test ${connection.provider}: ${result.success ? 'ok' : result.error}`);
    res.json({ ok: result.success, message: result.success ? 'Connection successful' : (result.error || 'Connection failed') });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/** DELETE /api/admin/crm/:id — remove a CRM connection */
router.delete('/crm/:id', async (req, res) => {
  try {
    if (!isUuid(req.params.id)) return res.status(400).json({ error: 'Invalid connection id' });
    await supabase
      .from('crm_connections')
      .delete()
      .eq('id', req.params.id)
      .eq('rooftop_id', req.rep.rooftop_id);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── OVERLAY CONFIG ──────────────────────────────────────────

/** GET /api/admin/overlays — list website overlay configs */
router.get('/overlays', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('overlay_configs')
      .select('*, reps(name), videos(short_code, customer_name)')
      .eq('rooftop_id', req.rep.rooftop_id);
    if (error) throw error;
    res.json({ overlays: data || [] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/** POST /api/admin/overlays — create overlay config */
router.post('/overlays', async (req, res) => {
  try {
    const { rep_id, video_id, position, trigger_delay, pages, cta_text } = req.body;
    const { data, error } = await supabase
      .from('overlay_configs')
      .insert({
        rooftop_id: req.rep.rooftop_id,
        rep_id: rep_id || null,
        video_id: video_id || null,
        position: position || 'bottom-right',
        trigger_delay: trigger_delay || 3,
        pages: pages || ['*'],
        cta_text: cta_text || 'Watch Video',
      })
      .select()
      .single();
    if (error) throw error;
    res.json({ success: true, overlay: data });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── INVENTORY MANAGEMENT ────────────────────────────────────

/** GET /api/admin/inventory — list inventory */
router.get('/inventory', async (req, res) => {
  try {
    const { status = 'available', limit = 100 } = req.query;
    const safeLimit = Math.min(Math.max(parseInt(limit, 10) || 100, 1), 500);
    const { data, error } = await supabase
      .from('inventory')
      .select('*')
      .eq('rooftop_id', req.rep.rooftop_id)
      .eq('status', status)
      .order('created_at', { ascending: false })
      .limit(safeLimit);
    if (error) throw error;
    res.json({ inventory: data || [] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/** POST /api/admin/inventory — add/update vehicle */
router.post('/inventory', async (req, res) => {
  try {
    const { vin, stock_number, year, make, model, trim, exterior_color, interior_color, msrp, sale_price, mileage, body_style, engine, transmission, drivetrain, photos, features } = req.body;
    if (!vin) return res.status(400).json({ error: 'vin required' });

    const { data, error } = await supabase
      .from('inventory')
      .upsert({
        rooftop_id: req.rep.rooftop_id,
        vin, stock_number, year, make, model, trim, exterior_color, interior_color,
        msrp, sale_price, mileage, body_style, engine, transmission, drivetrain,
        photos: photos || [], features: features || [],
        updated_at: new Date().toISOString(),
      }, { onConflict: 'rooftop_id,vin' })
      .select()
      .single();
    if (error) throw error;
    res.json({ success: true, vehicle: data });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
