import express from 'express';
import { supabase } from '../lib/supabase.js';
import { requireAuth } from '../lib/auth.js';
import { sendRichVideoMessage } from '../lib/rcs.js';
import { twilioClient, TWILIO_FROM, verifyTwilioSignature } from '../lib/twilio.js';
import { sendPush } from '../lib/push.js';
import {
  classifyKeyword, recordOptOut, recordOptIn, guardedSms,
  STOP_REPLY, HELP_REPLY, START_REPLY,
} from '../lib/consent.js';

const router = express.Router();

function twiml(message) {
  return message
    ? `<Response><Message>${message}</Message></Response>`
    : '<Response></Response>';
}

// ── TWO-WAY TEXTING ─────────────────────────────────────────

/**
 * POST /api/messaging/webhook/inbound
 * Twilio webhook for inbound SMS/RCS messages.
 * Twilio POSTs here when a customer replies to an AutoFilm message.
 */
router.post('/webhook/inbound', express.urlencoded({ extended: true }), verifyTwilioSignature(), async (req, res) => {
  try {
    const { From, To, Body, MessageSid, NumMedia } = req.body;

    console.log(`[messaging] Inbound from ${From}: "${Body}"`);

    // TCPA/CTIA keyword handling — must be honored before anything else
    const keyword = classifyKeyword(Body);
    if (keyword === 'stop') {
      await recordOptOut(From);
      return res.type('text/xml').send(twiml(STOP_REPLY));
    }
    if (keyword === 'help') {
      return res.type('text/xml').send(twiml(HELP_REPLY));
    }
    if (keyword === 'start') {
      await recordOptIn(From);
      return res.type('text/xml').send(twiml(START_REPLY));
    }

    // Find the video/conversation this relates to
    const { data: video } = await supabase
      .from('videos')
      .select('id, short_code, rep_id, rooftop_id, customer_name, customer_phone, vehicle, reps(name, push_subscription)')
      .eq('customer_phone', From)
      .order('sent_at', { ascending: false })
      .limit(1)
      .single();

    // Store the inbound message
    const { data: msg } = await supabase
      .from('conversations')
      .insert({
        video_id: video?.id || null,
        rep_id: video?.rep_id || null,
        rooftop_id: video?.rooftop_id || null,
        customer_phone: From,
        customer_name: video?.customer_name || null,
        direction: 'inbound',
        body: Body,
        media_urls: NumMedia > 0 ? extractMediaUrls(req.body, NumMedia) : null,
        provider_sid: MessageSid,
        channel: 'sms',
      })
      .select()
      .single();

    // Send push notification to the rep
    if (video?.reps?.push_subscription) {
      const customerFirst = (video.customer_name || From).split(' ')[0];
      await sendPush(video.reps.push_subscription, {
        title: `Reply from ${customerFirst}`,
        body: Body.length > 80 ? Body.slice(0, 77) + '...' : Body,
        icon: '/icon-192.png',
        data: {
          type: 'inbound_sms',
          video_id: video.id,
          customer_phone: From,
        },
      });
    }

    // Respond with empty TwiML (don't auto-reply)
    res.type('text/xml').send('<Response></Response>');

  } catch (err) {
    console.error('[messaging] Inbound webhook error:', err.message);
    res.type('text/xml').send('<Response></Response>');
  }
});

/**
 * POST /api/messaging/send
 * Rep sends a text message to a customer (outbound).
 * Body: { customer_phone, body, video_id? }
 */
router.post('/send', requireAuth(), async (req, res) => {
  try {
    const { customer_phone, body, video_id } = req.body;
    if (!customer_phone || !body) {
      return res.status(400).json({ error: 'customer_phone and body required' });
    }

    // Send via Twilio with TCPA consent guard
    const result = await guardedSms(twilioClient, {
      body, from: TWILIO_FROM, to: customer_phone,
    });

    if (result.blocked) {
      return res.status(403).json({ error: 'Customer has opted out of SMS. Message not sent.' });
    }

    // Store in conversation
    await supabase.from('conversations').insert({
      video_id: video_id || null,
      rep_id: req.rep.id,
      rooftop_id: req.rep.rooftop_id,
      customer_phone,
      direction: 'outbound',
      body,
      provider_sid: result.sid,
      channel: 'sms',
    });

    console.log(`[messaging] Outbound to ${customer_phone}: ${result.sid}`);
    res.json({ success: true, sid: result.sid });

  } catch (err) {
    console.error('[messaging] Send error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/messaging/thread?customer_phone=...
 * Get conversation thread with a customer.
 */
router.get('/thread', requireAuth(), async (req, res) => {
  try {
    const { customer_phone, video_id, limit = 50 } = req.query;
    if (!customer_phone && !video_id) {
      return res.status(400).json({ error: 'customer_phone or video_id required' });
    }

    let query = supabase
      .from('conversations')
      .select('*')
      .eq('rooftop_id', req.rep.rooftop_id)
      .order('created_at', { ascending: true })
      .limit(parseInt(limit));

    if (customer_phone) query = query.eq('customer_phone', customer_phone);
    if (video_id) query = query.eq('video_id', video_id);

    const { data, error } = await query;
    if (error) throw error;

    res.json({ messages: data || [] });

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/messaging/conversations
 * List all active conversation threads for the rep/rooftop.
 */
router.get('/conversations', requireAuth(), async (req, res) => {
  try {
    // Get the latest message per customer phone
    const { data, error } = await supabase
      .rpc('get_conversations', {
        p_rooftop_id: req.rep.rooftop_id,
        p_rep_id: req.rep.role === 'admin' ? null : req.rep.id,
        p_limit: 50,
      });

    // Fallback if RPC doesn't exist yet
    if (error) {
      const { data: msgs } = await supabase
        .from('conversations')
        .select('customer_phone, customer_name, direction, body, created_at, video_id')
        .eq('rooftop_id', req.rep.rooftop_id)
        .order('created_at', { ascending: false })
        .limit(200);

      // Group by customer_phone, take latest
      const threads = new Map();
      for (const m of (msgs || [])) {
        if (!threads.has(m.customer_phone)) {
          threads.set(m.customer_phone, {
            customer_phone: m.customer_phone,
            customer_name: m.customer_name,
            last_message: m.body,
            last_direction: m.direction,
            last_at: m.created_at,
            video_id: m.video_id,
          });
        }
      }

      return res.json({ conversations: Array.from(threads.values()) });
    }

    res.json({ conversations: data || [] });

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/messaging/webhook/status
 * Twilio status callback for message delivery/read receipts.
 */
router.post('/webhook/status', express.urlencoded({ extended: true }), verifyTwilioSignature(), async (req, res) => {
  try {
    const { MessageSid, MessageStatus } = req.body;
    // Update conversation record with delivery status
    if (MessageSid && MessageStatus) {
      await supabase
        .from('conversations')
        .update({ status: MessageStatus })
        .eq('provider_sid', MessageSid);
    }
  } catch (err) {
    console.error('[messaging] Status webhook error:', err.message);
  }
  res.sendStatus(200);
});

function extractMediaUrls(body, count) {
  const urls = [];
  for (let i = 0; i < parseInt(count); i++) {
    if (body[`MediaUrl${i}`]) urls.push(body[`MediaUrl${i}`]);
  }
  return urls.length > 0 ? urls : null;
}

export default router;
