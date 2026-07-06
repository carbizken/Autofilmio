import express from 'express';
import { supabase } from '../lib/supabase.js';
import { video, defaultUploadSettings } from '../lib/mux.js';
import { sendPush } from '../lib/push.js';
import { storeThumbnails } from '../lib/thumbnail.js';
import { syncVideoEvent } from '../lib/crm.js';

const router = express.Router();

/**
 * POST /api/reply
 * Customer records a video reply from the player page.
 * No account needed — identified by parent video's short_code.
 *
 * Body: { short_code, customer_name?, customer_phone? }
 * Returns: { upload_url, upload_id, reply_id }
 */
router.post('/', async (req, res) => {
  try {
    const { short_code, customer_name, customer_phone } = req.body;

    if (!short_code) return res.status(400).json({ error: 'short_code required' });

    // 1. Find the parent video
    const { data: parentVideo, error: vidErr } = await supabase
      .from('videos')
      .select('id, rep_id, rooftop_id, customer_name, customer_phone, reps(name, push_subscription, rooftops(name))')
      .eq('short_code', short_code)
      .single();

    if (vidErr || !parentVideo) {
      return res.status(404).json({ error: 'Video not found for short_code: ' + short_code });
    }

    // 2. Create Mux upload for the reply
    const upload = await video.uploads.create({
      cors_origin: '*',
      new_asset_settings: defaultUploadSettings({ encoding_tier: 'smart' }),
    });

    // 3. Create the reply record
    const { data: reply, error: replyErr } = await supabase
      .from('video_replies')
      .insert({
        parent_video_id: parentVideo.id,
        mux_asset_id: upload.asset_id || null,
        mux_upload_id: upload.id,
        customer_name: customer_name || parentVideo.customer_name,
        customer_phone: customer_phone || parentVideo.customer_phone,
      })
      .select()
      .single();

    if (replyErr) throw replyErr;

    console.log(`[reply] Created reply ${reply.id} for video ${short_code}`);

    // 4. Send push notification to the rep
    const rep = parentVideo.reps;
    if (rep?.push_subscription) {
      const customerFirst = (customer_name || parentVideo.customer_name || 'A customer').split(' ')[0];
      await sendPush(rep.push_subscription, {
        title: 'Video Reply Received',
        body: `${customerFirst} sent you a video reply!`,
        icon: '/icon-192.png',
        data: {
          type: 'reply',
          reply_id: reply.id,
          short_code,
        },
      });
    }

    // 5. CRM sync (async)
    syncVideoEvent(parentVideo.rooftop_id, {
      action: 'reply_received',
      video_id: parentVideo.id,
      short_code,
      customer_phone: customer_phone || parentVideo.customer_phone,
    }).catch(err => console.error('[reply] CRM sync error:', err.message));

    res.json({
      success: true,
      reply_id: reply.id,
      upload_url: upload.url,
      upload_id: upload.id,
    });

  } catch (err) {
    console.error('[reply] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/reply/:id/complete
 * Called after the customer finishes uploading their reply video.
 * Finalizes the reply with the Mux playback ID.
 */
router.post('/:id/complete', async (req, res) => {
  try {
    const { id } = req.params;
    const { mux_playback_id, duration } = req.body;

    if (!mux_playback_id && !duration) {
      return res.status(400).json({ error: 'mux_playback_id or duration required' });
    }

    const update = {};
    if (mux_playback_id) update.mux_playback_id = mux_playback_id;
    if (duration) update.duration = parseInt(duration);

    const { data, error } = await supabase
      .from('video_replies')
      .update(update)
      .eq('id', id)
      .select()
      .single();

    if (error) throw error;

    // Thumbnail belongs to the REPLY record — do not touch the parent
    // video's thumbnails (that was overwriting the rep's original).
    if (mux_playback_id) {
      const { getThumbnails } = await import('../lib/thumbnail.js');
      const thumbs = getThumbnails(mux_playback_id);
      if (thumbs) {
        await supabase.from('video_replies').update({
          thumbnail_url: thumbs.static,
        }).eq('id', id);
      }
    }

    console.log(`[reply] Completed reply ${id}`);
    res.json({ success: true, reply: data });

  } catch (err) {
    console.error('[reply] Complete error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/reply/list?video_id=<uuid>
 * List all replies for a given parent video.
 */
router.get('/list', async (req, res) => {
  try {
    const { video_id, short_code } = req.query;

    let parentId = video_id;

    if (!parentId && short_code) {
      const { data } = await supabase
        .from('videos')
        .select('id')
        .eq('short_code', short_code)
        .single();
      parentId = data?.id;
    }

    if (!parentId) return res.status(400).json({ error: 'video_id or short_code required' });

    const { data, error } = await supabase
      .from('video_replies')
      .select('*')
      .eq('parent_video_id', parentId)
      .order('created_at', { ascending: false });

    if (error) throw error;

    res.json({ replies: data || [] });

  } catch (err) {
    console.error('[reply] List error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

export default router;
