import express from 'express';
import crypto from 'crypto';
import { supabase } from '../lib/supabase.js';
import { kvPut } from '../lib/cloudflare.js';
import { storeThumbnails } from '../lib/thumbnail.js';

const router = express.Router();

/**
 * Verify a Mux webhook signature (Mux-Signature header, same t/v1 HMAC
 * scheme as Stripe). Skipped when MUX_WEBHOOK_SECRET isn't configured
 * so local dev keeps working.
 */
function verifyMuxSignature(rawBody, sigHeader) {
  const secret = process.env.MUX_WEBHOOK_SECRET;
  if (!secret) return true; // not configured — accept (dev mode)
  if (!sigHeader) return false;

  const parts = Object.fromEntries(
    sigHeader.split(',').map(kv => {
      const idx = kv.indexOf('=');
      return [kv.slice(0, idx).trim(), kv.slice(idx + 1)];
    })
  );
  if (!parts.t || !parts.v1) return false;

  const payload = `${parts.t}.${rawBody.toString('utf8')}`;
  const expected = crypto.createHmac('sha256', secret).update(payload).digest('hex');
  try {
    return crypto.timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(parts.v1, 'hex'));
  } catch {
    return false;
  }
}

/**
 * POST /api/webhooks/mux
 * Mux fires video.asset.ready when encoding finishes. This closes the gap
 * where /api/upload times out before the asset lands: we finalize the video
 * record, thumbnails, and short link here regardless.
 */
router.post('/mux', async (req, res) => {
  if (!verifyMuxSignature(req.rawBody || '', req.headers['mux-signature'])) {
    return res.status(400).json({ error: 'Invalid signature' });
  }

  const event = req.body;

  try {
    if (event.type === 'video.asset.ready') {
      const asset = event.data;
      const playbackId = asset.playback_ids?.[0]?.id;
      const uploadId = asset.upload_id;

      // Match by upload id first (most reliable), then asset id
      let { data: videoRow } = await supabase
        .from('videos')
        .select('id, short_code, mux_playback_id')
        .or(`mux_upload_id.eq.${uploadId},mux_asset_id.eq.${asset.id}`)
        .limit(1)
        .maybeSingle();

      if (videoRow && playbackId) {
        await supabase.from('videos').update({
          mux_asset_id: asset.id,
          mux_playback_id: playbackId,
          duration: asset.duration ? Math.round(asset.duration) : null,
        }).eq('id', videoRow.id);

        await storeThumbnails(supabase, videoRow.id, playbackId);

        if (videoRow.short_code) {
          await kvPut(
            `v_${videoRow.short_code}`,
            `https://autofilm.io/autofilm-player.html?code=${videoRow.short_code}&playback_id=${playbackId}`
          ).catch(e => console.warn('[webhooks] KV write failed:', e.message));
        }

        console.log(`[webhooks] Mux asset ready — finalized video ${videoRow.id}`);
      }
    }

    if (event.type === 'video.asset.errored') {
      console.error(`[webhooks] Mux asset errored: ${event.data?.id}`, event.data?.errors);
    }

    res.json({ received: true });
  } catch (err) {
    console.error('[webhooks] Mux handler error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/webhooks/sendgrid
 * SendGrid Event Webhook — open/click tracking flows back into
 * email_deliveries and the parent video record.
 */
router.post('/sendgrid', async (req, res) => {
  try {
    const events = Array.isArray(req.body) ? req.body : [];

    for (const evt of events) {
      const messageId = (evt.sg_message_id || '').split('.')[0];
      if (!messageId) continue;

      if (evt.event === 'open') {
        const { data: delivery } = await supabase
          .from('email_deliveries')
          .update({ status: 'opened', opened_at: new Date(evt.timestamp * 1000).toISOString() })
          .eq('provider_id', messageId)
          .select('video_id')
          .maybeSingle();

        if (delivery?.video_id) {
          await supabase.from('videos')
            .update({ email_opened_at: new Date(evt.timestamp * 1000).toISOString() })
            .eq('id', delivery.video_id)
            .is('email_opened_at', null);
        }
      }

      if (evt.event === 'click') {
        await supabase.from('email_deliveries')
          .update({ status: 'clicked', clicked_at: new Date(evt.timestamp * 1000).toISOString() })
          .eq('provider_id', messageId);
      }

      if (evt.event === 'bounce' || evt.event === 'dropped') {
        await supabase.from('email_deliveries')
          .update({ status: 'bounced' })
          .eq('provider_id', messageId);
      }
    }

    res.json({ received: true });
  } catch (err) {
    console.error('[webhooks] SendGrid handler error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

export default router;
