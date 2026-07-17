import express from 'express';
import { shortCode } from '../lib/shortcode.js';
import { requireAuth } from '../lib/auth.js';
import { guardedSms } from '../lib/consent.js';
import { sendPush } from '../lib/push.js';
import { supabase } from '../lib/supabase.js';
import { video, defaultUploadSettings } from '../lib/mux.js';
import { twilioClient, TWILIO_FROM } from '../lib/twilio.js';
import { sendVideoEmail } from '../lib/email.js';
import { kvPut } from '../lib/cloudflare.js';
import { storeThumbnails } from '../lib/thumbnail.js';
import { syncVideoEvent } from '../lib/crm.js';
import { attachVehicleImage } from '../lib/vehicleImage.js';
import { attachPassport } from '../lib/passport.js';
import { getPricingRenderBlock } from './pricingConfig.js';

const router = express.Router();

const CF_WORKER_URL = process.env.CF_WORKER_URL || 'https://links.autofilm.io';

/**
 * POST /api/mpi
 * Create a new MPI inspection with video.
 *
 * Body: {
 *   rep_id, rooftop_id, customer_name, customer_phone, customer_email?,
 *   ro_number?, vin?, vehicle?, mileage?,
 *   items: [{ name, status, note }],
 *   total_estimate?
 * }
 */
router.post('/', requireAuth(), async (req, res) => {
  try {
    const {
      rep_id, customer_name, customer_phone, customer_email,
      ro_number, vin, vehicle, mileage, items, total_estimate,
    } = req.body;

    // Tenant is derived from the authenticated rep, never trusted from the
    // body — otherwise a rep could plant an inspection under another rooftop.
    const rooftop_id = req.rep.rooftop_id;

    if (!rep_id) return res.status(400).json({ error: 'rep_id required' });
    if (!customer_name) return res.status(400).json({ error: 'customer_name required' });

    // rep_id lands on the videos/mpi_inspections rows AND as actor_id in
    // the append-only vehicle_events ledger — it must be a real rep of
    // the caller's rooftop, never an arbitrary UUID from the body.
    const { data: repRow, error: repErr } = await supabase
      .from('reps')
      .select('id')
      .eq('id', rep_id)
      .eq('rooftop_id', rooftop_id)
      .maybeSingle();
    if (repErr) throw repErr;
    if (!repRow) {
      return res.status(400).json({ error: 'rep_id does not belong to your rooftop' });
    }

    // 1. Create Mux upload for the inspection video
    const upload = await video.uploads.create({
      cors_origin: '*',
      new_asset_settings: defaultUploadSettings({ encoding_tier: 'smart' }),
    });

    // 2. Create the video record
    const code = shortCode();
    const { data: videoRow, error: vidErr } = await supabase
      .from('videos')
      .insert({
        rep_id,
        rooftop_id,
        mux_asset_id: upload.asset_id || null,
        mux_upload_id: upload.id,
        short_code: code,
        type: 'mpi',
        customer_name,
        customer_phone,
        customer_email,
        vin,
        vehicle,
      })
      .select()
      .single();

    if (vidErr) throw vidErr;

    // 3. Create the MPI inspection record
    const { data: inspection, error: mpiErr } = await supabase
      .from('mpi_inspections')
      .insert({
        video_id: videoRow.id,
        rep_id,
        rooftop_id,
        customer_name,
        customer_phone,
        customer_email,
        ro_number,
        vin,
        vehicle,
        mileage: mileage ? parseInt(mileage) : null,
        items: items || [],
        total_estimate: total_estimate || 0,
        status: 'draft',
      })
      .select()
      .single();

    if (mpiErr) throw mpiErr;

    console.log(`[mpi] Created inspection ${inspection.id} for RO# ${ro_number || 'N/A'}`);

    // Fire-and-forget: resolve a stock photo for this vehicle and persist it.
    // Must never delay or fail RO creation — the frontend falls back to its
    // placeholder until vehicle_image_url lands.
    attachVehicleImage(supabase, {
      inspectionId: inspection.id,
      videoId: videoRow.id,
      vin,
      vehicle,
    });

    // Fire-and-forget: wire this visit into the Vehicle Passport —
    // find/create the global vehicles row, link vehicle_id on the
    // inspection + video, explode items jsonb into findings rows
    // (DUAL-WRITE: items stays untouched), and ledger the
    // inspection_created event. Must never fail or delay RO creation.
    attachPassport({ inspection, videoId: videoRow.id, rep_id });

    res.json({
      success: true,
      inspection_id: inspection.id,
      video_id: videoRow.id,
      short_code: code,
      upload_url: upload.url,
      upload_id: upload.id,
    });

  } catch (err) {
    console.error('[mpi] Create error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/mpi/:id/send
 * Send the MPI video to the customer via SMS and/or email.
 */
router.post('/:id/send', requireAuth(), async (req, res) => {
  try {
    const { id } = req.params;
    const { via = 'sms' } = req.body; // 'sms' | 'email' | 'both'

    // Fetch inspection + video + rep
    const { data: inspection, error } = await supabase
      .from('mpi_inspections')
      .select('*, videos(*, reps(name, nickname, rooftops(name)))')
      .eq('id', id)
      .single();

    if (error || !inspection) {
      return res.status(404).json({ error: 'Inspection not found' });
    }

    // Tenant isolation: a rep may only send inspections from their own rooftop
    if (inspection.rooftop_id !== req.rep.rooftop_id) {
      return res.status(404).json({ error: 'Inspection not found' });
    }

    const videoRow = inspection.videos;
    const rep = videoRow?.reps;
    const dealerName = rep?.rooftops?.name || 'Your Dealer';
    const repName = rep?.nickname || rep?.name?.split(' ')[0] || 'Your Service Advisor';
    const shortCode = videoRow.short_code;
    const shortUrl = `${CF_WORKER_URL}/v/${shortCode}`;

    // Customer-facing MPI approval page (video + line items + approve)
    const params = new URLSearchParams({
      id: inspection.id,
      code: shortCode,
    });

    const playerUrl = `https://autofilm.io/autofilm-mpi.html?${params.toString()}`;
    await kvPut(`v_${shortCode}`, playerUrl);

    const results = {};

    // Send SMS
    if (via === 'sms' || via === 'both') {
      if (inspection.customer_phone) {
        const redCount = (inspection.items || []).filter(i => i.status === 'red').length;
        const yellowCount = (inspection.items || []).filter(i => i.status === 'yellow').length;

        let smsBody = `Hi ${inspection.customer_name.split(' ')[0]}, ${repName} at ${dealerName} has your vehicle inspection ready.\n\n`;
        if (redCount > 0) smsBody += `${redCount} item${redCount > 1 ? 's' : ''} need${redCount === 1 ? 's' : ''} attention. `;
        if (yellowCount > 0) smsBody += `${yellowCount} to monitor. `;
        smsBody += `\n\nWatch the video walkthrough: ${shortUrl}\n\nReply STOP to opt out`;

        const smsResult = await guardedSms(twilioClient, {
          body: smsBody,
          from: TWILIO_FROM,
          to: inspection.customer_phone,
        });
        if (smsResult.blocked) {
          return res.status(403).json({ error: 'Customer has opted out of SMS.' });
        }

        results.sms_sid = smsResult.sid;
        console.log(`[mpi] SMS sent for inspection ${id} — SID: ${smsResult.sid}`);
      }
    }

    // Send Email
    if (via === 'email' || via === 'both') {
      if (inspection.customer_email) {
        const emailResult = await sendVideoEmail({
          to: inspection.customer_email,
          customerName: inspection.customer_name,
          repName,
          dealerName,
          shortUrl,
          vehicle: inspection.vehicle,
          thumbnailUrl: videoRow.thumbnail_gif,
          brandColor: '#D94F00',
        });

        results.email_message_id = emailResult.messageId;
      }
    }

    // Update inspection status
    await supabase.from('mpi_inspections').update({
      status: 'sent',
      sent_at: new Date().toISOString(),
    }).eq('id', id);

    // Update video sent_at
    await supabase.from('videos').update({
      sent_at: new Date().toISOString(),
      customer_email: inspection.customer_email,
    }).eq('id', videoRow.id);

    // CRM sync (async)
    syncVideoEvent(inspection.rooftop_id, {
      action: 'video_sent',
      video_id: videoRow.id,
      short_code: shortCode,
      customer_phone: inspection.customer_phone,
      customer_email: inspection.customer_email,
    }).catch(err => console.error('[mpi] CRM sync error:', err.message));

    res.json({ success: true, short_url: shortUrl, ...results });

  } catch (err) {
    console.error('[mpi] Send error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/mpi/:id/approve
 * Customer approves the recommended service.
 */
router.post('/:id/approve', async (req, res) => {
  try {
    const { id } = req.params;
    const { approved_amount, approved_items, code } = req.body;

    // Customer-facing endpoint: no session, so the video short_code acts
    // as the capability token (only the SMS recipient knows it).
    const { data: check } = await supabase
      .from('mpi_inspections')
      .select('id, videos(short_code)')
      .eq('id', id)
      .single();
    if (!check || check.videos?.short_code !== code) {
      return res.status(403).json({ error: 'Invalid approval link' });
    }

    // This is an unauthenticated, customer-facing endpoint: coerce and
    // validate everything before it reaches the DB or the append-only
    // approval archive. approved_amount must be a finite, non-negative
    // number — anything else is treated as absent.
    const amt = Number(approved_amount);
    const approvedAmount = Number.isFinite(amt) && amt >= 0 ? amt : null;

    const { data, error } = await supabase
      .from('mpi_inspections')
      .update({
        status: 'approved',
        approved_amount: approvedAmount,
        approved_at: new Date().toISOString(),
      })
      .eq('id', id)
      .select('*, videos(rep_id, rooftop_id, short_code)')
      .single();

    if (error) throw error;

    console.log(`[mpi] Inspection ${id} approved — $${approvedAmount || 0}`);

    // Immutable approval archive (research §4/§5, CA BAR retention):
    // capture exactly what was offered at approval time — items, the
    // pricing presentation config, the disclosures shown, and the
    // approved amount. approval_renders is append-only (migration 011).
    // Fire-and-forget: archiving must never fail or delay the approval.
    // approved_items is customer-controlled jsonb: never archive it
    // verbatim. Archive the SERVER-SIDE item objects the customer
    // selected, matched by name against data.items — arbitrary payloads
    // can't reach the legal record.
    const serverItems = Array.isArray(data.items) ? data.items : [];
    let approvedItemsArchive = null;
    if (Array.isArray(approved_items)) {
      const requestedNames = new Set(
        approved_items
          .map(it => (typeof it === 'string' ? it : it?.name))
          .filter(n => typeof n === 'string')
      );
      const matched = serverItems.filter(it => it?.name && requestedNames.has(it.name));
      approvedItemsArchive = matched.length > 0 ? matched : null;
    }

    (async () => {
      const pricing = await getPricingRenderBlock(data.rooftop_id);
      const { error: archErr } = await supabase
        .from('approval_renders')
        .insert({
          inspection_id: id,
          rendered_payload: {
            items: serverItems,
            approved_items: approvedItemsArchive,
            approved_amount: approvedAmount ?? data.total_estimate ?? 0,
            pricing,
            disclosures: {
              general: pricing.general_disclosure,
              lifetime: pricing.lifetime.disclosure,
              financing: pricing.financing.disclosure,
            },
            approved_at: data.approved_at,
          },
        });
      if (archErr) throw archErr;
      console.log(`[mpi] Approval render archived for inspection ${id}`);
    })().catch(err => console.error('[mpi] Approval archive error:', err.message));

    // Notify the service advisor immediately — approved work is money waiting
    const { data: advisor } = await supabase
      .from('reps')
      .select('push_subscription, name')
      .eq('id', data.rep_id)
      .single();
    if (advisor?.push_subscription) {
      sendPush(advisor.push_subscription, {
        title: '✅ Service approved',
        body: `${data.customer_name || 'Customer'} approved $${(approvedAmount ?? data.total_estimate ?? 0).toLocaleString()} in recommended work`,
        data: { type: 'mpi_approved', inspection_id: id },
      }).catch(() => {});
    }

    // CRM sync (async)
    if (data.videos) {
      syncVideoEvent(data.rooftop_id, {
        action: 'mpi_approved',
        video_id: data.video_id,
        short_code: data.videos.short_code,
        customer_phone: data.customer_phone,
      }).catch(err => console.error('[mpi] CRM sync error:', err.message));
    }

    res.json({ success: true, inspection: data });

  } catch (err) {
    console.error('[mpi] Approve error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/mpi/:id/public?code=SHORT_CODE
 * Customer-facing inspection details for the MPI approval page.
 * No auth — like /:id/approve, the video short_code is the capability
 * token (only the SMS/email recipient knows it).
 */
router.get('/:id/public', async (req, res) => {
  try {
    const { id } = req.params;
    const { code } = req.query;

    if (!code) return res.status(403).json({ error: 'Invalid inspection link' });

    const { data: inspection } = await supabase
      .from('mpi_inspections')
      .select('id, rooftop_id, status, customer_name, vehicle, vehicle_image_url, mileage, ro_number, items, total_estimate, approved_amount, approved_at, videos(short_code, mux_playback_id, reps(name, nickname, title, photo_url, rooftops(name)))')
      .eq('id', id)
      .single();

    if (!inspection || inspection.videos?.short_code !== code) {
      return res.status(403).json({ error: 'Invalid inspection link' });
    }

    const rep = inspection.videos?.reps;
    const playbackId = inspection.videos?.mux_playback_id || null;

    // Rooftop pricing presentation config, reduced to render fields.
    // Never throws — defaults to one_price when the rooftop has no row.
    const pricing = await getPricingRenderBlock(inspection.rooftop_id);

    console.log(`[mpi] Public view of inspection ${id}`);

    res.json({
      inspection: {
        id: inspection.id,
        status: inspection.status,
        customer_name: inspection.customer_name,
        vehicle: inspection.vehicle,
        vehicle_image_url: inspection.vehicle_image_url || null,
        mileage: inspection.mileage,
        ro_number: inspection.ro_number,
        total_estimate: inspection.total_estimate || 0,
        approved_amount: inspection.approved_amount,
        approved_at: inspection.approved_at,
        // Items pass through unchanged — the server does not synthesize
        // tier options. Per-item tier data comes later from the RO side:
        // the frontend renders tier columns from item.tiers jsonb IF an
        // item carries it; otherwise the item renders per pricing.mode.
        items: (inspection.items || []).map(it => ({
          name: it.name || '',
          description: it.description || it.note || '',
          price: Number(it.price ?? it.cost ?? 0) || 0,
          urgency: it.urgency || it.status || 'green',
          status: it.status || it.urgency || 'green',
          ...(it.tiers ? { tiers: it.tiers } : {}),
        })),
      },
      pricing,
      advisor: {
        name: rep?.nickname || rep?.name || 'Your Service Advisor',
        title: rep?.title || 'Service Advisor',
        photo_url: rep?.photo_url || null,
      },
      dealership: rep?.rooftops?.name || 'Your Dealer',
      video: {
        mux_playback_id: playbackId,
        playback_url: playbackId ? `https://stream.mux.com/${playbackId}.m3u8` : null,
      },
    });

  } catch (err) {
    console.error('[mpi] Public fetch error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/mpi/list?rooftop_id=<uuid>&status=<status>
 * List MPI inspections for a rooftop.
 */
router.get('/list', requireAuth(), async (req, res) => {
  try {
    const rooftop_id = req.rep.rooftop_id;
    const { status, limit = 50 } = req.query;

    let query = supabase
      .from('mpi_inspections')
      .select('*, reps(name, photo_url)')
      .eq('rooftop_id', rooftop_id)
      .order('created_at', { ascending: false })
      .limit(parseInt(limit));

    if (status) query = query.eq('status', status);

    const { data, error } = await query;
    if (error) throw error;

    res.json({ inspections: data || [] });

  } catch (err) {
    console.error('[mpi] List error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

export default router;
