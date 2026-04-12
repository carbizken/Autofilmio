import express from 'express';
import { supabase } from '../lib/supabase.js';
import { sendPush } from '../lib/push.js';

const router = express.Router();

// Milestones that trigger push notifications
const MILESTONES = [25, 50, 75, 100];

/**
 * GET /v/:code/ping?pct=50
 * Called by player page every 5s while video plays.
 * Records watch event, sends push notification at milestones.
 */
router.get('/:code/ping', async (req, res) => {
  try {
    const { code } = req.params;
    const pct = Math.min(100, Math.max(0, parseInt(req.query.pct) || 0));
    const watchSeconds = parseInt(req.query.s) || 0;

    // 1. Find video by short_code
    const { data: videoRow, error: videoErr } = await supabase
      .from('videos')
      .select('id, rep_id, customer_name, vehicle, max_watch_pct, reps(push_subscription, name, nickname)')
      .eq('short_code', code)
      .single();

    if (videoErr || !videoRow) {
      // Don't error loudly — player pings frequently
      return res.json({ ok: true, found: false });
    }

    // 2. Insert watch event
    await supabase.from('watch_events').insert({
      video_id:      videoRow.id,
      watch_pct:     pct,
      watch_seconds: watchSeconds,
      ip:            req.headers['x-forwarded-for'] || req.ip,
      user_agent:    req.headers['user-agent'],
    });

    // 3. Check if we've crossed a milestone
    const prevMax = videoRow.max_watch_pct || 0;
    const crossedMilestone = MILESTONES.find(m => m > prevMax && m <= pct);

    if (crossedMilestone) {
      console.log(`[ping] ${code} crossed ${crossedMilestone}% — notifying rep`);

      // Update max_watch_pct + last_watched_at
      await supabase.from('videos').update({
        max_watch_pct:   pct,
        last_watched_at: new Date().toISOString(),
      }).eq('id', videoRow.id);

      // Send push notification to rep
      const rep = videoRow.reps;
      const customerName = videoRow.customer_name || 'Your customer';
      const vehicle = videoRow.vehicle ? ` — ${videoRow.vehicle}` : '';

      if (rep?.push_subscription) {
        await sendPush(rep.push_subscription, {
          title: `🔥 ${customerName} watched ${crossedMilestone}% of your video`,
          body:  `${customerName}${vehicle}`,
          icon:  '/icon-192.png',
          data:  { short_code: code, pct: crossedMilestone },
        });
      }
    } else if (pct > prevMax) {
      // Update max without notification
      await supabase.from('videos').update({
        max_watch_pct:   pct,
        last_watched_at: new Date().toISOString(),
      }).eq('id', videoRow.id);
    }

    res.json({ ok: true, pct, milestone: crossedMilestone || null });

  } catch (err) {
    console.error('[ping] Error:', err.message);
    // Never fail the player — just log
    res.json({ ok: true, error: err.message });
  }
});

export default router;
