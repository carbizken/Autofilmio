import express from 'express';
import { supabase } from '../lib/supabase.js';
import { twilioClient, TWILIO_FROM } from '../lib/twilio.js';
import { kvPut } from '../lib/cloudflare.js';
import { guardedSms } from '../lib/consent.js';
import { getThumbnails } from '../lib/thumbnail.js';
import { fireWorkflowTrigger } from '../lib/workflows.js';

const router = express.Router();

const CF_WORKER_URL = process.env.CF_WORKER_URL || 'https://links.autofilm.io';
const PLAYER_BASE   = 'https://autofilm.io/autofilm-player.html';

/**
 * POST /api/send
 * Body: { short_code, customer_name, customer_phone, vehicle?, trade_url? }
 * Returns: { success: true, sms_sid, short_url }
 */
router.post('/', async (req, res) => {
  try {
    const { short_code, customer_name, customer_phone, vehicle, trade_url } = req.body;

    if (!short_code)      return res.status(400).json({ error: 'short_code required' });
    if (!customer_name)   return res.status(400).json({ error: 'customer_name required' });
    if (!customer_phone)  return res.status(400).json({ error: 'customer_phone required' });

    // 1. Fetch video + rep info from Supabase
    const { data: videoRow, error: videoErr } = await supabase
      .from('videos')
      .select('*, reps(name, nickname, title, photo_url, rooftops(name))')
      .eq('short_code', short_code)
      .single();

    if (videoErr || !videoRow) {
      return res.status(404).json({ error: 'Video not found for short_code: ' + short_code });
    }

    const rep = videoRow.reps;
    const dealerName = rep?.rooftops?.name || 'Your Dealer';
    const repDisplay = rep?.nickname || rep?.name?.split(' ')[0] || 'Your Rep';

    // 2. Build full player URL
    const params = new URLSearchParams({
      rep:          rep?.name || '',
      rep_display:  repDisplay,
      title:        rep?.title || 'Sales Consultant',
      dealer:       dealerName,
      code:         short_code,
      customer:     customer_name,
      phone:        customer_phone,
    });

    if (videoRow.mux_playback_id) {
      params.set('playback_id', videoRow.mux_playback_id);
    }
    if (rep?.photo_url) {
      params.set('photo', rep.photo_url);
    }
    if (vehicle) {
      params.set('vehicle', vehicle);
    }
    if (trade_url) {
      params.set('trade_url', trade_url);
    }

    const playerUrl = `${PLAYER_BASE}?${params.toString()}`;
    const shortUrl  = `${CF_WORKER_URL}/v/${short_code}`;

    // 3. Store in Cloudflare KV
    await kvPut(`v_${short_code}`, playerUrl);
    console.log(`[send] KV stored: v_${short_code}`);

    // 4. Send Twilio SMS/MMS with TCPA consent guard.
    //    The animated GIF thumbnail rides along as MMS media — the rep's
    //    face moving inside the message is the biggest open-rate driver.
    const firstName = customer_name.split(' ')[0];
    const smsBody = (vehicle
      ? `Hey ${firstName}, ${repDisplay} at ${dealerName} recorded a personal video about the ${vehicle} for you 🎬\n\nWatch it here: ${shortUrl}`
      : `Hey ${firstName}, ${repDisplay} at ${dealerName} recorded a personal video for you 🎬\n\nWatch it here: ${shortUrl}`)
      + `\n\nReply STOP to opt out`;

    const thumbs = videoRow.mux_playback_id ? getThumbnails(videoRow.mux_playback_id) : null;

    const result = await guardedSms(twilioClient, {
      body: smsBody,
      from: TWILIO_FROM,
      to: customer_phone,
      mediaUrl: thumbs ? [thumbs.animatedSmall] : undefined,
    });

    if (result.blocked) {
      return res.status(403).json({ error: 'Customer has opted out of SMS. Message not sent.' });
    }

    console.log(`[send] SMS sent to ${customer_phone} — SID: ${result.sid}`);

    // 5. Update Supabase video record
    await supabase.from('videos').update({
      customer_name,
      customer_phone,
      vehicle: vehicle || null,
      sent_at: new Date().toISOString(),
    }).eq('short_code', short_code);

    // 6. Fire the video_sent workflow trigger (drip campaigns key off this)
    fireWorkflowTrigger('video_sent', {
      video_id: videoRow.id,
      short_code,
      rep_id: videoRow.rep_id,
      rooftop_id: videoRow.rooftop_id,
      customer_name,
      customer_phone,
      vehicle: vehicle || null,
      rep_name: repDisplay,
      dealer_name: dealerName,
      short_url: shortUrl,
    }).catch(e => console.error('[send] Workflow trigger error:', e.message));

    res.json({ success: true, sms_sid: result.sid, short_url: shortUrl });

  } catch (err) {
    console.error('[send] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

export default router;
