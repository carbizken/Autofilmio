import express from 'express';
import { supabase } from '../lib/supabase.js';
import { requireAuth } from '../lib/auth.js';
import { createAvatar, generateAvatarVideo, checkVideoStatus, generateAvatarScript } from '../lib/avatar.js';
import { nanoid } from 'nanoid';
import { kvPut } from '../lib/cloudflare.js';
import { twilioClient, TWILIO_FROM } from '../lib/twilio.js';
import { guardedSms } from '../lib/consent.js';
import { sendVideoEmail } from '../lib/email.js';
import { syncVideoEvent } from '../lib/crm.js';

const router = express.Router();
const CF_WORKER_URL = process.env.CF_WORKER_URL || 'https://links.autofilm.io';

/**
 * POST /api/avatar/create
 * Create a personalized AI avatar for a rep.
 * Body: { training_video_url }
 */
router.post('/create', requireAuth(), async (req, res) => {
  try {
    const { training_video_url } = req.body;
    if (!training_video_url) return res.status(400).json({ error: 'training_video_url required' });

    const result = await createAvatar(req.rep.id, training_video_url, req.rep.name);
    res.json({ success: true, ...result });
  } catch (err) {
    console.error('[avatar] Create error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/avatar/generate
 * Generate a personalized video using the rep's AI avatar.
 * Body: { customer_name, vehicle?, scenario?, background? }
 */
router.post('/generate', requireAuth(), async (req, res) => {
  try {
    const { customer_name, vehicle, scenario = 'welcome', background } = req.body;
    if (!customer_name) return res.status(400).json({ error: 'customer_name required' });

    // Get rep's avatar ID
    const { data: repData } = await supabase
      .from('reps')
      .select('avatar_id, name, nickname, rooftops(name, brand_color)')
      .eq('id', req.rep.id)
      .single();

    if (!repData?.avatar_id) {
      return res.status(400).json({ error: 'No avatar created yet. Upload a training video first.' });
    }

    const repName = repData.nickname || repData.name.split(' ')[0];
    const dealerName = repData.rooftops?.name || '';

    // Generate personalized script
    const script = await generateAvatarScript({
      customerName: customer_name,
      repName,
      dealerName,
      vehicle,
      scenario,
    });

    // Generate the video
    const result = await generateAvatarVideo({
      avatarId: repData.avatar_id,
      script,
      repName,
      background,
    });

    // Create video record
    const shortCode = nanoid(8);
    const { data: videoRow, error: vidErr } = await supabase
      .from('videos')
      .insert({
        rep_id: req.rep.id,
        rooftop_id: req.rep.rooftop_id,
        short_code: shortCode,
        type: 'avatar',
        customer_name: customer_name,
        vehicle: vehicle || null,
      })
      .select()
      .single();

    if (vidErr || !videoRow) throw new Error(`Failed to create video record: ${vidErr?.message || 'no row'}`);

    // Poll for completion in background
    pollVideoCompletion(result.video_id, videoRow.id, shortCode).catch(
      err => console.error('[avatar] Poll error:', err.message)
    );

    res.json({
      success: true,
      video_id: videoRow.id,
      short_code: shortCode,
      heygen_video_id: result.video_id,
      status: result.status,
      script,
    });

  } catch (err) {
    console.error('[avatar] Generate error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/avatar/auto-send
 * Auto-generate + send an avatar video to a lead.
 * Used by the AI BDC Assistant for speed-to-lead.
 * Body: { customer_name, customer_phone, customer_email?, vehicle?, scenario? }
 */
router.post('/auto-send', requireAuth(), async (req, res) => {
  try {
    const { customer_name, customer_phone, customer_email, vehicle, scenario = 'welcome' } = req.body;
    if (!customer_name || !customer_phone) {
      return res.status(400).json({ error: 'customer_name and customer_phone required' });
    }

    const { data: repData } = await supabase
      .from('reps')
      .select('avatar_id, name, nickname, rooftops(name, brand_color)')
      .eq('id', req.rep.id)
      .single();

    if (!repData?.avatar_id) {
      return res.status(400).json({ error: 'No avatar. Upload training video first.' });
    }

    const repName = repData.nickname || repData.name.split(' ')[0];
    const dealerName = repData.rooftops?.name || '';

    const script = await generateAvatarScript({
      customerName: customer_name, repName, dealerName, vehicle, scenario,
    });

    const result = await generateAvatarVideo({
      avatarId: repData.avatar_id, script, repName,
    });

    const shortCode = nanoid(8);
    const { data: videoRow, error: vidErr } = await supabase
      .from('videos')
      .insert({
        rep_id: req.rep.id,
        rooftop_id: req.rep.rooftop_id,
        short_code: shortCode,
        type: 'avatar',
        customer_name, customer_phone, customer_email,
        vehicle: vehicle || null,
      })
      .select()
      .single();

    if (vidErr || !videoRow) throw new Error(`Failed to create video record: ${vidErr?.message || 'no row'}`);

    // Poll + auto-send when ready
    pollAndSend(result.video_id, videoRow.id, shortCode, {
      customer_name, customer_phone, customer_email,
      repName, dealerName, vehicle, rooftopId: req.rep.rooftop_id,
      brandColor: repData.rooftops?.brand_color,
    }).catch(err => console.error('[avatar] Auto-send error:', err.message));

    res.json({
      success: true,
      video_id: videoRow.id,
      short_code: shortCode,
      status: 'generating',
      message: 'Avatar video is being generated and will be sent automatically',
    });

  } catch (err) {
    console.error('[avatar] Auto-send error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/avatar/status/:heygen_video_id
 * Check HeyGen video generation status.
 */
router.get('/status/:heygen_video_id', async (req, res) => {
  try {
    const status = await checkVideoStatus(req.params.heygen_video_id);
    res.json(status);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── BACKGROUND HELPERS ──────────────────────────────────────

async function pollVideoCompletion(heygenVideoId, videoId, shortCode, maxAttempts = 60) {
  for (let i = 0; i < maxAttempts; i++) {
    await new Promise(r => setTimeout(r, 5000));
    const status = await checkVideoStatus(heygenVideoId);
    if (status.status === 'completed' && status.video_url) {
      await supabase.from('videos').update({
        playback_source: 'heygen',
        external_video_url: status.video_url,
        thumbnail_url: status.thumbnail_url,
        duration: status.duration,
      }).eq('id', videoId);

      await kvPut(`v_${shortCode}`, `https://autofilm.io/autofilm-player.html?code=${shortCode}&video_url=${encodeURIComponent(status.video_url)}`);
      console.log(`[avatar] Video ${shortCode} ready`);
      return;
    }
    if (status.status === 'failed') {
      console.error(`[avatar] Video ${shortCode} failed`);
      return;
    }
  }
}

async function pollAndSend(heygenVideoId, videoId, shortCode, opts) {
  for (let i = 0; i < 60; i++) {
    await new Promise(r => setTimeout(r, 5000));
    const status = await checkVideoStatus(heygenVideoId);
    if (status.status === 'completed' && status.video_url) {
      await supabase.from('videos').update({
        playback_source: 'heygen',
        external_video_url: status.video_url,
        thumbnail_url: status.thumbnail_url,
        duration: status.duration,
      }).eq('id', videoId);

      const shortUrl = `${CF_WORKER_URL}/v/${shortCode}`;
      const playerUrl = `https://autofilm.io/autofilm-player.html?code=${shortCode}&rep=${encodeURIComponent(opts.repName)}&dealer=${encodeURIComponent(opts.dealerName)}&video_url=${encodeURIComponent(status.video_url)}`;
      await kvPut(`v_${shortCode}`, playerUrl);

      // Send SMS
      const firstName = opts.customer_name.split(' ')[0];
      const smsBody = (opts.vehicle
        ? `Hey ${firstName}, ${opts.repName} at ${opts.dealerName} recorded a personal video about the ${opts.vehicle} for you 🎬\n\nWatch it here: ${shortUrl}`
        : `Hey ${firstName}, ${opts.repName} at ${opts.dealerName} has a personal video for you 🎬\n\nWatch it here: ${shortUrl}`)
        + '\n\nReply STOP to opt out';

      const smsResult = await guardedSms(twilioClient, {
        body: smsBody, from: TWILIO_FROM, to: opts.customer_phone,
      });
      if (smsResult.blocked) {
        console.log(`[avatar] Auto-send blocked — customer opted out`);
        return;
      }

      // Send email if available
      if (opts.customer_email) {
        await sendVideoEmail({
          to: opts.customer_email, customerName: opts.customer_name,
          repName: opts.repName, dealerName: opts.dealerName,
          shortUrl, vehicle: opts.vehicle, thumbnailUrl: status.thumbnail_url,
          brandColor: opts.brandColor || '#D94F00',
        }).catch(e => console.error('[avatar] Email error:', e.message));
      }

      await supabase.from('videos').update({
        sent_at: new Date().toISOString(),
      }).eq('id', videoId);

      syncVideoEvent(opts.rooftopId, {
        action: 'video_sent', video_id: videoId, short_code: shortCode,
        customer_phone: opts.customer_phone, customer_email: opts.customer_email,
      }).catch(() => {});

      console.log(`[avatar] Auto-sent ${shortCode} to ${opts.customer_name}`);
      return;
    }
    if (status.status === 'failed') {
      console.error(`[avatar] Auto-send failed for ${shortCode}`);
      return;
    }
  }
}

export default router;
