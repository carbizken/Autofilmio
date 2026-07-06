import express from 'express';
import { supabase } from '../lib/supabase.js';
import { requireAuth } from '../lib/auth.js';

const router = express.Router();

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// All dashboard data is tenant-scoped PII — auth required,
// and the rooftop always comes from the authenticated rep.
router.use(requireAuth());

/**
 * GET /api/dashboard/team?rooftop_id=<uuid>&period=week|month|all
 * Returns per-rep performance data for the manager dashboard.
 */
router.get('/team', async (req, res) => {
  try {
    const rooftop_id = req.rep.rooftop_id;

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
    const rooftop_id = req.rep.rooftop_id;

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
    const rooftop_id = req.rep.rooftop_id;
    const { limit = 50 } = req.query;
    const safeLimit = Math.min(Math.max(parseInt(limit, 10) || 50, 1), 200);

    const { data, error } = await supabase
      .from('videos')
      .select('id, short_code, customer_name, customer_phone, vehicle, type, sent_at, last_watched_at, max_watch_pct, thumbnail_url, reps(name, photo_url)')
      .eq('rooftop_id', rooftop_id)
      .order('created_at', { ascending: false })
      .limit(safeLimit);

    if (error) throw error;

    res.json({ activity: data || [] });
  } catch (err) {
    console.error('[dashboard] Activity error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/dashboard/videos
 * Returns the authenticated rep's own videos with watch stats, newest first.
 */
router.get('/videos', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('videos')
      .select('id, short_code, customer_name, vehicle, sent_at, last_watched_at, max_watch_pct, created_at, mux_playback_id')
      .eq('rep_id', req.rep.id)
      .order('created_at', { ascending: false })
      .limit(50);

    if (error) throw error;

    res.json({ videos: data || [] });
  } catch (err) {
    console.error('[dashboard] Videos error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/dashboard/heatmap?video_id=<uuid>
 * Retention curve for one video, aggregated from watch_events into
 * twenty 5%-buckets: buckets[i].viewers = distinct viewers whose max
 * watch_pct reached at least that bucket (viewers approximated by
 * ip + user_agent since pings carry no session id).
 */
router.get('/heatmap', async (req, res) => {
  try {
    const { video_id } = req.query;
    if (!video_id) return res.status(400).json({ error: 'video_id is required' });
    if (!UUID_RE.test(video_id)) return res.status(400).json({ error: 'Invalid video_id' });

    // Ownership: rep's own video, or same rooftop for admin/manager.
    const { data: videoRow, error: vErr } = await supabase
      .from('videos')
      .select('id, rep_id, rooftop_id')
      .eq('id', video_id)
      .maybeSingle();
    if (vErr) throw vErr;
    if (!videoRow) return res.status(404).json({ error: 'Video not found' });

    const isOwner = videoRow.rep_id === req.rep.id;
    const isManager = ['admin', 'manager'].includes(req.rep.role)
      && videoRow.rooftop_id === req.rep.rooftop_id;
    if (!isOwner && !isManager) {
      return res.status(403).json({ error: 'Access denied' });
    }

    const { data: events, error: eErr } = await supabase
      .from('watch_events')
      .select('watch_pct, ip, user_agent')
      .eq('video_id', video_id)
      .limit(10000);
    if (eErr) throw eErr;

    // Max watch_pct per viewer (ip|user_agent key; fall back to per-event).
    const viewerMax = new Map();
    let anon = 0;
    for (const ev of events || []) {
      const key = (ev.ip || ev.user_agent) ? `${ev.ip || ''}|${ev.user_agent || ''}` : `anon_${anon++}`;
      const pct = Math.max(0, Math.min(100, ev.watch_pct || 0));
      if (!viewerMax.has(key) || viewerMax.get(key) < pct) viewerMax.set(key, pct);
    }

    const maxes = [...viewerMax.values()];
    const total_viewers = maxes.length;

    // buckets[i] = viewers who reached at least i*5 percent (0,5,...,95).
    const buckets = Array.from({ length: 20 }, (_, i) => ({
      pct: i * 5,
      viewers: maxes.filter(m => m >= i * 5).length,
    }));

    const avg_max_pct = total_viewers
      ? Math.round(maxes.reduce((a, b) => a + b, 0) / total_viewers)
      : 0;

    res.json({ video_id, buckets, total_viewers, avg_max_pct });
  } catch (err) {
    console.error('[dashboard] Heatmap error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/dashboard/leaderboard?rooftop_id=<uuid>&period=week|month
 * Returns ranked rep leaderboard by videos sent + engagement.
 */
router.get('/leaderboard', async (req, res) => {
  try {
    const rooftop_id = req.rep.rooftop_id;

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
    const rooftop_id = req.rep.rooftop_id;

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
