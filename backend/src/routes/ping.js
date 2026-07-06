import express from 'express';
import { supabase } from '../lib/supabase.js';
import { sendPush } from '../lib/push.js';
import { fireWorkflowTrigger } from '../lib/workflows.js';
import { syncVideoEvent } from '../lib/crm.js';

const router = express.Router();

// Milestones that trigger push notifications
const MILESTONES = [25, 50, 75, 100];

/**
 * GET /v/:code/ping?pct=50
 * Called by player page every 5s while video plays.
 * Records watch event, sends push notification at milestones,
 * fires workflow triggers and CRM sync at 75%+.
 */
router.get('/:code/ping', async (req, res) => {
  try {
    const { code } = req.params;
    const pct = Math.min(100, Math.max(0, parseInt(req.query.pct) || 0));
    const watchSeconds = parseInt(req.query.s) || 0;

    // 1. Find video by short_code
    const { data: videoRow, error: videoErr } = await supabase
      .from('videos')
      .select('id, rep_id, rooftop_id, customer_name, customer_phone, customer_email, vehicle, short_code, max_watch_pct, reps(push_subscription, name, nickname)')
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

    // 3. Check if we've crossed a milestone. A single ping can jump past
    // several at once (the viewer seeks ahead, or pings were dropped), so
    // take the HIGHEST milestone crossed — otherwise a jump from 10% to 80%
    // would notify "25%" and never fire the 75% hot-lead trigger.
    const prevMax = videoRow.max_watch_pct || 0;
    const crossed = MILESTONES.filter(m => m > prevMax && m <= pct);
    const crossedMilestone = crossed.length ? crossed[crossed.length - 1] : undefined;

    if (crossedMilestone) {
      // Atomic guard: only the ping that actually advances max_watch_pct
      // past the milestone wins. Concurrent 5s pings can't double-notify.
      const { data: winner } = await supabase.from('videos').update({
        max_watch_pct:   pct,
        last_watched_at: new Date().toISOString(),
      }).eq('id', videoRow.id).lt('max_watch_pct', crossedMilestone).select('id');

      if (!winner?.length) {
        return res.json({ ok: true, pct, milestone: null });
      }

      console.log(`[ping] ${code} crossed ${crossedMilestone}% — notifying rep`);

      // Send push notification to rep
      const rep = videoRow.reps;
      const customerName = videoRow.customer_name || 'Your customer';
      const vehicle = videoRow.vehicle ? ` — ${videoRow.vehicle}` : '';

      if (rep?.push_subscription) {
        const pushResult = await sendPush(rep.push_subscription, {
          title: `🔥 ${customerName} watched ${crossedMilestone}% of your video`,
          body:  `${customerName}${vehicle}`,
          icon:  '/icon-192.png',
          data:  { short_code: code, pct: crossedMilestone },
        });
        // Prune dead subscriptions so we stop retrying them forever
        if (pushResult?.expired && videoRow.rep_id) {
          await supabase.from('reps').update({ push_subscription: null }).eq('id', videoRow.rep_id);
        }
      }

      // 4. At 75%+ this is a hot lead: fire workflows + CRM sync (non-blocking)
      if (crossedMilestone >= 75 && videoRow.rooftop_id) {
        const ctx = {
          video_id: videoRow.id,
          short_code: code,
          rep_id: videoRow.rep_id,
          rooftop_id: videoRow.rooftop_id,
          customer_name: videoRow.customer_name,
          customer_phone: videoRow.customer_phone,
          customer_email: videoRow.customer_email,
          vehicle: videoRow.vehicle,
          watch_pct: crossedMilestone,
          rep_name: rep?.nickname || rep?.name?.split(' ')[0] || 'Your Rep',
        };
        fireWorkflowTrigger('video_watched_75', ctx)
          .catch(e => console.error('[ping] Workflow trigger error:', e.message));
        syncVideoEvent(videoRow.rooftop_id, {
          action: 'video_watched',
          video_id: videoRow.id,
          short_code: code,
          customer_phone: videoRow.customer_phone,
          customer_email: videoRow.customer_email,
          watch_pct: crossedMilestone,
        }).catch(e => console.error('[ping] CRM sync error:', e.message));
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
