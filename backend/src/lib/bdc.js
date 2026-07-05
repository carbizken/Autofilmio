/**
 * AI BDC (Business Development Center) Assistant
 *
 * Watches for new leads via CRM polling or webhook, and auto-responds
 * with a personalized video (avatar or VIN Reel) + text message
 * within 60 seconds. The "speed to lead" engine.
 *
 * Architecture:
 *   - Polling loop checks each rooftop's CRM for new leads every 30s
 *   - When a new lead arrives, triggers the auto-response workflow:
 *     1. Identify the assigned rep (or round-robin to available reps)
 *     2. Generate personalized AI avatar video or VIN Reel
 *     3. Send via SMS + email within 60 seconds
 *     4. Log activity in CRM
 *     5. Push notification to assigned rep
 *
 * This runs as a background process alongside the Express server.
 */

import { supabase } from './supabase.js';
import { generateAvatarScript, generateAvatarVideo, checkVideoStatus } from './avatar.js';
import { twilioClient, TWILIO_FROM } from './twilio.js';
import { guardedSms } from './consent.js';
import { sendVideoEmail } from './email.js';
import { kvPut } from './cloudflare.js';
import { sendPush } from './push.js';
import { syncVideoEvent } from './crm.js';
import { nanoid } from 'nanoid';

const CF_WORKER_URL = process.env.CF_WORKER_URL || 'https://links.autofilm.io';

// Track processed leads to avoid duplicates
const processedLeads = new Set();

/**
 * Start the BDC Assistant background loop.
 * Call this once when the server starts.
 */
export function startBDCAssistant() {
  if (!process.env.HEYGEN_API_KEY) {
    console.log('[bdc] HeyGen not configured — BDC auto-send disabled');
    return;
  }

  console.log('[bdc] AI BDC Assistant started — polling every 30s');

  // Poll for new leads
  setInterval(async () => {
    try {
      await checkForNewLeads();
    } catch (err) {
      console.error('[bdc] Poll error:', err.message);
    }
  }, 30000);
}

/**
 * Check all active rooftops with BDC enabled for new leads.
 */
async function checkForNewLeads() {
  // Get rooftops with active CRM connections and BDC enabled
  const { data: connections } = await supabase
    .from('crm_connections')
    .select('rooftop_id, provider, config')
    .eq('active', true);

  if (!connections?.length) return;

  for (const conn of connections) {
    // Check if BDC auto-respond is enabled for this rooftop
    const bdcEnabled = conn.config?.bdc_enabled;
    if (!bdcEnabled) continue;

    // Check the leads webhook queue (populated by CRM webhook handler)
    const { data: pendingLeads } = await supabase
      .from('bdc_lead_queue')
      .select('*')
      .eq('rooftop_id', conn.rooftop_id)
      .eq('status', 'pending')
      .order('created_at', { ascending: true })
      .limit(5);

    if (!pendingLeads?.length) continue;

    for (const lead of pendingLeads) {
      if (processedLeads.has(lead.id)) continue;
      processedLeads.add(lead.id);

      // Atomic claim: only one worker may take a pending lead. Prevents
      // duplicate customer texts across restarts or multiple instances.
      const { data: claimed } = await supabase
        .from('bdc_lead_queue')
        .update({ status: 'processing' })
        .eq('id', lead.id)
        .eq('status', 'pending')
        .select('id');
      if (!claimed?.length) continue;

      // Process in background (non-blocking)
      processLead(lead, conn).catch(
        err => console.error(`[bdc] Lead ${lead.id} error:`, err.message)
      );
    }
  }
}

/**
 * Process a single new lead: generate + send personalized video.
 */
async function processLead(lead, conn) {
  console.log(`[bdc] Processing lead: ${lead.customer_name} (${lead.customer_phone})`);

  // 1. Find the assigned rep (or round-robin)
  const rep = await assignRep(lead.rooftop_id, lead.assigned_rep_id);
  if (!rep) {
    console.warn(`[bdc] No available rep for rooftop ${lead.rooftop_id}`);
    await markLeadStatus(lead.id, 'no_rep');
    return;
  }

  const repName = rep.nickname || rep.name.split(' ')[0];

  // 2. Get rooftop info
  const { data: rooftop } = await supabase
    .from('rooftops')
    .select('name, brand_color')
    .eq('id', lead.rooftop_id)
    .single();

  const dealerName = rooftop?.name || '';

  // 3. Generate personalized script
  const script = await generateAvatarScript({
    customerName: lead.customer_name,
    repName,
    dealerName,
    vehicle: lead.vehicle,
    scenario: 'welcome',
  });

  // 4. Generate avatar video (or fall back to text-only if no avatar)
  let videoReady = false;
  let shortCode = nanoid(8);
  let videoId = null;

  if (rep.avatar_id) {
    try {
      const result = await generateAvatarVideo({
        avatarId: rep.avatar_id, script, repName,
      });

      // Create video record
      const { data: videoRow } = await supabase
        .from('videos')
        .insert({
          rep_id: rep.id, rooftop_id: lead.rooftop_id,
          short_code: shortCode, type: 'avatar',
          customer_name: lead.customer_name,
          customer_phone: lead.customer_phone,
          customer_email: lead.customer_email,
          vehicle: lead.vehicle,
        })
        .select()
        .single();

      videoId = videoRow?.id;

      // Wait for video to be ready (max 90 seconds)
      for (let i = 0; i < 18; i++) {
        await new Promise(r => setTimeout(r, 5000));
        const status = await checkVideoStatus(result.video_id);
        if (status.status === 'completed' && status.video_url) {
          await supabase.from('videos').update({
            playback_source: 'heygen',
            external_video_url: status.video_url,
            thumbnail_url: status.thumbnail_url,
            duration: status.duration,
          }).eq('id', videoId);

          const playerUrl = `https://autofilm.io/autofilm-player.html?code=${shortCode}&rep=${encodeURIComponent(rep.name)}&dealer=${encodeURIComponent(dealerName)}`;
          await kvPut(`v_${shortCode}`, playerUrl);
          videoReady = true;
          break;
        }
        if (status.status === 'failed') break;
      }
    } catch (err) {
      console.warn(`[bdc] Avatar gen failed, sending text-only: ${err.message}`);
    }
  }

  // 5. Send SMS
  const firstName = lead.customer_name.split(' ')[0];
  const shortUrl = videoReady ? `${CF_WORKER_URL}/v/${shortCode}` : null;

  let smsBody;
  if (videoReady) {
    smsBody = lead.vehicle
      ? `Hey ${firstName}, this is ${repName} at ${dealerName}. I just recorded a quick personal video about the ${lead.vehicle} for you 🎬\n\nWatch it here: ${shortUrl}`
      : `Hey ${firstName}, this is ${repName} at ${dealerName}. I recorded a personal welcome video just for you 🎬\n\nWatch it here: ${shortUrl}`;
  } else {
    smsBody = lead.vehicle
      ? `Hey ${firstName}, this is ${repName} at ${dealerName}. I saw you're interested in the ${lead.vehicle} — great choice! I'd love to help. Call or text me anytime.`
      : `Hey ${firstName}, this is ${repName} at ${dealerName}. Thanks for reaching out! I'd love to help you find the right vehicle. Call or text me anytime.`;
  }

  try {
    const smsResult = await guardedSms(twilioClient, {
      body: smsBody + '\n\nReply STOP to opt out', from: TWILIO_FROM, to: lead.customer_phone,
    });
    if (smsResult.blocked) {
      console.log('[bdc] Lead blocked — customer opted out');
      await markLeadStatus(lead.id, 'opted_out');
      return;
    }
  } catch (err) {
    console.error(`[bdc] SMS failed: ${err.message}`);
  }

  // 6. Send email
  if (lead.customer_email && videoReady) {
    try {
      await sendVideoEmail({
        to: lead.customer_email, customerName: lead.customer_name,
        repName, dealerName, shortUrl, vehicle: lead.vehicle,
        brandColor: rooftop?.brand_color || '#D94F00',
      });
    } catch (err) {
      console.error(`[bdc] Email failed: ${err.message}`);
    }
  }

  // 7. Update video + lead records
  if (videoId) {
    await supabase.from('videos').update({ sent_at: new Date().toISOString() }).eq('id', videoId);
  }
  await markLeadStatus(lead.id, 'sent');

  // 8. Push notification to rep
  if (rep.push_subscription) {
    await sendPush(rep.push_subscription, {
      title: 'New Lead Auto-Responded',
      body: `AI sent ${videoReady ? 'a video' : 'a text'} to ${lead.customer_name}${lead.vehicle ? ` about the ${lead.vehicle}` : ''}`,
      data: { type: 'bdc_auto_send', video_id: videoId, short_code: shortCode },
    });
  }

  // 9. CRM sync
  if (videoId) {
    syncVideoEvent(lead.rooftop_id, {
      action: 'video_sent', video_id: videoId, short_code: shortCode,
      customer_phone: lead.customer_phone, customer_email: lead.customer_email,
    }).catch(() => {});
  }

  const elapsed = Date.now() - new Date(lead.created_at).getTime();
  console.log(`[bdc] Lead responded in ${Math.round(elapsed / 1000)}s: ${lead.customer_name} → ${repName}`);
}

async function assignRep(rooftopId, preferredRepId) {
  // Try preferred rep first
  if (preferredRepId) {
    const { data } = await supabase
      .from('reps')
      .select('id, name, nickname, avatar_id, push_subscription')
      .eq('id', preferredRepId)
      .eq('active', true)
      .single();
    if (data) return data;
  }

  // Round-robin: pick the rep with the fewest videos today
  const { data: reps } = await supabase
    .from('reps')
    .select('id, name, nickname, avatar_id, push_subscription')
    .eq('rooftop_id', rooftopId)
    .eq('active', true)
    .in('department', ['sales', 'bdc']);

  if (!reps?.length) return null;

  // Simple round-robin based on video count
  const today = new Date().toISOString().split('T')[0];
  let minVideos = Infinity;
  let selected = reps[0];

  for (const rep of reps) {
    const { count } = await supabase
      .from('videos')
      .select('id', { count: 'exact', head: true })
      .eq('rep_id', rep.id)
      .gte('sent_at', today);
    if ((count || 0) < minVideos) {
      minVideos = count || 0;
      selected = rep;
    }
  }

  return selected;
}

async function markLeadStatus(leadId, status) {
  await supabase.from('bdc_lead_queue').update({
    status,
    processed_at: new Date().toISOString(),
  }).eq('id', leadId);
}
