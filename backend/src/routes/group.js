import express from 'express';
import { supabase } from '../lib/supabase.js';
import { requireAuth } from '../lib/auth.js';

const router = express.Router();

// All group data is cross-rooftop PII — auth required, and every
// query is scoped to the caller's dealer_group (never client input).
router.use(requireAuth());

const DAY_MS = 24 * 60 * 60 * 1000;
const daysAgo = (n) => new Date(Date.now() - n * DAY_MS).toISOString();

/**
 * Middleware: dealer-group gate.
 * Caller must be an admin AND their rooftop must belong to a dealer group.
 * Attaches req.group = { name, rooftops: [{ id, name, active }] }.
 */
async function requireGroup(req, res, next) {
  try {
    if (req.rep.role !== 'admin') {
      return res.status(403).json({ error: 'Dealer group portal requires an admin account' });
    }

    const { data: myRooftop, error: rtErr } = await supabase
      .from('rooftops')
      .select('id, name, dealer_group')
      .eq('id', req.rep.rooftop_id)
      .single();

    if (rtErr || !myRooftop) {
      return res.status(403).json({ error: 'No rooftop found for this account' });
    }
    if (!myRooftop.dealer_group) {
      return res.status(403).json({ error: 'This account is not part of a dealer group' });
    }

    const { data: rooftops, error: grpErr } = await supabase
      .from('rooftops')
      .select('id, name, active')
      .eq('dealer_group', myRooftop.dealer_group)
      .order('name');

    if (grpErr) throw grpErr;

    req.group = { name: myRooftop.dealer_group, rooftops: rooftops || [] };
    next();
  } catch (err) {
    console.error('[group] Group gate error:', err.message);
    res.status(500).json({ error: err.message });
  }
}

router.use(requireGroup);

/**
 * GET /api/group/overview
 * Group name, rooftop count, per-rooftop 30-day rollups
 * (sends, watch rate, avg max_watch_pct, active reps, prior-30d sends
 * for trend) + group totals. One videos query for all rooftops.
 */
router.get('/overview', async (req, res) => {
  try {
    const rooftopIds = req.group.rooftops.map((r) => r.id);
    const since60 = daysAgo(60);
    const since30 = daysAgo(30);

    // One query for the whole group's last-60d sends (30d current + 30d prior)
    const [{ data: videos, error: vErr }, { data: reps, error: rErr }] = await Promise.all([
      supabase
        .from('videos')
        .select('rooftop_id, sent_at, last_watched_at, max_watch_pct')
        .in('rooftop_id', rooftopIds)
        .not('sent_at', 'is', null)
        .gte('sent_at', since60)
        .limit(10000),
      supabase
        .from('reps')
        .select('id, rooftop_id')
        .in('rooftop_id', rooftopIds)
        .eq('active', true),
    ]);

    if (vErr) throw vErr;
    if (rErr) throw rErr;

    // Per-rooftop accumulators
    const acc = {};
    for (const rt of req.group.rooftops) {
      acc[rt.id] = { sent: 0, watched: 0, pctSum: 0, prevSent: 0, activeReps: 0 };
    }

    for (const v of videos || []) {
      const a = acc[v.rooftop_id];
      if (!a) continue;
      if (v.sent_at >= since30) {
        a.sent++;
        if (v.last_watched_at) a.watched++;
        a.pctSum += v.max_watch_pct || 0;
      } else {
        a.prevSent++;
      }
    }

    for (const r of reps || []) {
      if (acc[r.rooftop_id]) acc[r.rooftop_id].activeReps++;
    }

    const rooftops = req.group.rooftops.map((rt) => {
      const a = acc[rt.id];
      return {
        id: rt.id,
        name: rt.name,
        active: rt.active,
        videos_sent_30d: a.sent,
        videos_watched_30d: a.watched,
        watch_rate: a.sent ? Math.round((a.watched / a.sent) * 100) : 0,
        avg_watch_pct: a.sent ? Math.round(a.pctSum / a.sent) : 0,
        active_reps: a.activeReps,
        prev_videos_sent_30d: a.prevSent,
      };
    });

    const totals = rooftops.reduce(
      (t, r) => ({
        videos_sent_30d: t.videos_sent_30d + r.videos_sent_30d,
        videos_watched_30d: t.videos_watched_30d + r.videos_watched_30d,
        active_reps: t.active_reps + r.active_reps,
        prev_videos_sent_30d: t.prev_videos_sent_30d + r.prev_videos_sent_30d,
        pct_sum: t.pct_sum + acc[r.id].pctSum,
      }),
      { videos_sent_30d: 0, videos_watched_30d: 0, active_reps: 0, prev_videos_sent_30d: 0, pct_sum: 0 }
    );

    res.json({
      group: req.group.name,
      rooftop_count: rooftops.length,
      rooftops,
      totals: {
        videos_sent_30d: totals.videos_sent_30d,
        videos_watched_30d: totals.videos_watched_30d,
        watch_rate: totals.videos_sent_30d
          ? Math.round((totals.videos_watched_30d / totals.videos_sent_30d) * 100)
          : 0,
        avg_watch_pct: totals.videos_sent_30d
          ? Math.round(totals.pct_sum / totals.videos_sent_30d)
          : 0,
        active_reps: totals.active_reps,
        prev_videos_sent_30d: totals.prev_videos_sent_30d,
      },
    });
  } catch (err) {
    console.error('[group] Overview error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/group/leaderboard
 * Top 20 reps across the whole group by videos sent in the last 30 days,
 * with watch rate and rooftop name.
 */
router.get('/leaderboard', async (req, res) => {
  try {
    const rooftopIds = req.group.rooftops.map((r) => r.id);
    const rooftopNames = Object.fromEntries(req.group.rooftops.map((r) => [r.id, r.name]));

    const { data: videos, error: vErr } = await supabase
      .from('videos')
      .select('rep_id, rooftop_id, sent_at, last_watched_at, max_watch_pct')
      .in('rooftop_id', rooftopIds)
      .not('sent_at', 'is', null)
      .gte('sent_at', daysAgo(30))
      .limit(10000);

    if (vErr) throw vErr;

    const byRep = {};
    for (const v of videos || []) {
      if (!v.rep_id) continue;
      const a = (byRep[v.rep_id] ||= { rep_id: v.rep_id, rooftop_id: v.rooftop_id, sent: 0, watched: 0, pctSum: 0 });
      a.sent++;
      if (v.last_watched_at) a.watched++;
      a.pctSum += v.max_watch_pct || 0;
    }

    const top = Object.values(byRep)
      .sort((a, b) => b.sent - a.sent)
      .slice(0, 20);

    // One reps query for names/photos of just the top 20
    let repInfo = {};
    if (top.length) {
      const { data: reps, error: rErr } = await supabase
        .from('reps')
        .select('id, name, nickname, photo_url')
        .in('id', top.map((r) => r.rep_id));
      if (rErr) throw rErr;
      repInfo = Object.fromEntries((reps || []).map((r) => [r.id, r]));
    }

    const leaderboard = top.map((r, i) => {
      const info = repInfo[r.rep_id] || {};
      return {
        rank: i + 1,
        rep_id: r.rep_id,
        rep_name: info.name || 'Unknown Rep',
        nickname: info.nickname || null,
        photo_url: info.photo_url || null,
        rooftop_id: r.rooftop_id,
        rooftop_name: rooftopNames[r.rooftop_id] || '',
        videos_sent_30d: r.sent,
        watch_rate: r.sent ? Math.round((r.watched / r.sent) * 100) : 0,
        avg_watch_pct: r.sent ? Math.round(r.pctSum / r.sent) : 0,
      };
    });

    res.json({ group: req.group.name, leaderboard });
  } catch (err) {
    console.error('[group] Leaderboard error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/group/rooftop/:id
 * One rooftop's detail — must belong to the caller's group.
 * Last-30d KPIs, 10 most recent sends, and rep list with per-rep 30d counts.
 */
router.get('/rooftop/:id', async (req, res) => {
  try {
    const rooftop = req.group.rooftops.find((r) => r.id === req.params.id);
    if (!rooftop) {
      return res.status(403).json({ error: 'Rooftop is not part of your dealer group' });
    }

    const since30 = daysAgo(30);

    const [
      { data: videos30, error: vErr },
      { data: recent, error: recErr },
      { data: reps, error: rErr },
    ] = await Promise.all([
      supabase
        .from('videos')
        .select('rep_id, sent_at, last_watched_at, max_watch_pct')
        .eq('rooftop_id', rooftop.id)
        .not('sent_at', 'is', null)
        .gte('sent_at', since30)
        .limit(10000),
      supabase
        .from('videos')
        .select('customer_name, vehicle, sent_at, max_watch_pct')
        .eq('rooftop_id', rooftop.id)
        .not('sent_at', 'is', null)
        .order('sent_at', { ascending: false })
        .limit(10),
      supabase
        .from('reps')
        .select('id, name, nickname, photo_url, active')
        .eq('rooftop_id', rooftop.id)
        .eq('active', true)
        .order('name'),
    ]);

    if (vErr) throw vErr;
    if (recErr) throw recErr;
    if (rErr) throw rErr;

    let sent = 0, watched = 0, pctSum = 0;
    const byRep = {};
    for (const v of videos30 || []) {
      sent++;
      if (v.last_watched_at) watched++;
      pctSum += v.max_watch_pct || 0;
      if (v.rep_id) {
        const a = (byRep[v.rep_id] ||= { sent: 0, watched: 0, pctSum: 0 });
        a.sent++;
        if (v.last_watched_at) a.watched++;
        a.pctSum += v.max_watch_pct || 0;
      }
    }

    const repList = (reps || [])
      .map((r) => {
        const a = byRep[r.id] || { sent: 0, watched: 0, pctSum: 0 };
        return {
          id: r.id,
          name: r.name,
          nickname: r.nickname,
          photo_url: r.photo_url,
          videos_sent_30d: a.sent,
          watch_rate: a.sent ? Math.round((a.watched / a.sent) * 100) : 0,
          avg_watch_pct: a.sent ? Math.round(a.pctSum / a.sent) : 0,
        };
      })
      .sort((a, b) => b.videos_sent_30d - a.videos_sent_30d);

    res.json({
      rooftop: { id: rooftop.id, name: rooftop.name, active: rooftop.active },
      kpis: {
        videos_sent_30d: sent,
        videos_watched_30d: watched,
        watch_rate: sent ? Math.round((watched / sent) * 100) : 0,
        avg_watch_pct: sent ? Math.round(pctSum / sent) : 0,
        active_reps: repList.length,
      },
      recent_sends: recent || [],
      reps: repList,
    });
  } catch (err) {
    console.error('[group] Rooftop detail error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

export default router;
