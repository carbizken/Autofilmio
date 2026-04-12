import express from 'express';
import { supabase } from '../lib/supabase.js';

const router = express.Router();

/**
 * GET /api/dashboard/team?rooftop_id=<uuid>&period=week|month|all
 * Returns per-rep performance data for the manager dashboard.
 */
router.get('/team', async (req, res) => {
  try {
    const { rooftop_id, period } = req.query;
    if (!rooftop_id) return res.status(400).json({ error: 'rooftop_id required' });

    const { data, error } = await supabase
      .from('team_dashboard')
      .select('*')
      .eq('rooftop_id', rooftop_id)
      .order('videos_sent', { ascending: false });

    if (error) throw error;

    res.json({ team: data || [] });
  } catch (err) {
    console.error('[dashboard] Team error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/dashboard/kpis?rooftop_id=<uuid>
 * Returns rooftop-level KPIs.
 */
router.get('/kpis', async (req, res) => {
  try {
    const { rooftop_id } = req.query;
    if (!rooftop_id) return res.status(400).json({ error: 'rooftop_id required' });

    const { data, error } = await supabase
      .from('rooftop_kpis')
      .select('*')
      .eq('rooftop_id', rooftop_id)
      .single();

    if (error) throw error;

    res.json({ kpis: data });
  } catch (err) {
    console.error('[dashboard] KPIs error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/dashboard/activity?rooftop_id=<uuid>&limit=50
 * Returns recent video activity feed for the dashboard.
 */
router.get('/activity', async (req, res) => {
  try {
    const { rooftop_id, limit = 50 } = req.query;
    if (!rooftop_id) return res.status(400).json({ error: 'rooftop_id required' });

    const { data, error } = await supabase
      .from('videos')
      .select('id, short_code, customer_name, customer_phone, vehicle, type, sent_at, last_watched_at, max_watch_pct, thumbnail_url, reps(name, photo_url)')
      .eq('rooftop_id', rooftop_id)
      .order('created_at', { ascending: false })
      .limit(parseInt(limit));

    if (error) throw error;

    res.json({ activity: data || [] });
  } catch (err) {
    console.error('[dashboard] Activity error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/dashboard/leaderboard?rooftop_id=<uuid>&period=week|month
 * Returns ranked rep leaderboard by videos sent + engagement.
 */
router.get('/leaderboard', async (req, res) => {
  try {
    const { rooftop_id } = req.query;
    if (!rooftop_id) return res.status(400).json({ error: 'rooftop_id required' });

    const { data, error } = await supabase
      .from('team_dashboard')
      .select('rep_id, rep_name, photo_url, total_videos, videos_sent, videos_this_week, videos_this_month, avg_watch_pct, hot_leads, replies_received')
      .eq('rooftop_id', rooftop_id)
      .eq('active', true)
      .order('videos_this_month', { ascending: false });

    if (error) throw error;

    // Add rank
    const leaderboard = (data || []).map((rep, i) => ({ rank: i + 1, ...rep }));

    res.json({ leaderboard });
  } catch (err) {
    console.error('[dashboard] Leaderboard error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/dashboard/crm-status?rooftop_id=<uuid>
 * Returns CRM connection status and recent sync activity.
 */
router.get('/crm-status', async (req, res) => {
  try {
    const { rooftop_id } = req.query;
    if (!rooftop_id) return res.status(400).json({ error: 'rooftop_id required' });

    const { data: connections } = await supabase
      .from('crm_connections')
      .select('id, provider, active, last_sync_at')
      .eq('rooftop_id', rooftop_id);

    const { data: recentSyncs } = await supabase
      .from('crm_sync_log')
      .select('id, crm_provider, action, status, created_at')
      .eq('rooftop_id', rooftop_id)
      .order('created_at', { ascending: false })
      .limit(20);

    res.json({
      connections: connections || [],
      recent_syncs: recentSyncs || [],
    });
  } catch (err) {
    console.error('[dashboard] CRM status error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

export default router;
