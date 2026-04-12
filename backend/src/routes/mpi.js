import express from 'express';
import { nanoid } from 'nanoid';
import { supabase } from '../lib/supabase.js';
import { video } from '../lib/mux.js';
import { twilioClient, TWILIO_FROM } from '../lib/twilio.js';
import { sendVideoEmail } from '../lib/email.js';
import { kvPut } from '../lib/cloudflare.js';
import { storeThumbnails } from '../lib/thumbnail.js';
import { syncVideoEvent } from '../lib/crm.js';

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
router.post('/', async (req, res) => {
  try {
    const {
      rep_id, rooftop_id, customer_name, customer_phone, customer_email,
      ro_number, vin, vehicle, mileage, items, total_estimate,
    } = req.body;

    if (!rep_id) return res.status(400).json({ error: 'rep_id required' });
    if (!rooftop_id) return res.status(400).json({ error: 'rooftop_id required' });
    if (!customer_name) return res.status(400).json({ error: 'customer_name required' });

    // 1. Create Mux upload for the inspection video
    const upload = await video.uploads.create({
      cors_origin: '*',
      new_asset_settings: {
        playback_policy: ['public'],
        encoding_tier: 'smart',
      },
    });

    // 2. Create the video record
    const shortCode = nanoid(8);
    const { data: videoRow, error: vidErr } = await supabase
      .from('videos')
      .insert({
        rep_id,
        rooftop_id,
        mux_asset_id: upload.asset_id || null,
        short_code: shortCode,
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

    res.json({
      success: true,
      inspection_id: inspection.id,
      video_id: videoRow.id,
      short_code: shortCode,
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
router.post('/:id/send', async (req, res) => {
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

    const videoRow = inspection.videos;
    const rep = videoRow?.reps;
    const dealerName = rep?.rooftops?.name || 'Your Dealer';
    const repName = rep?.nickname || rep?.name?.split(' ')[0] || 'Your Service Advisor';
    const shortCode = videoRow.short_code;
    const shortUrl = `${CF_WORKER_URL}/v/${shortCode}`;

    // Build player URL for MPI
    const params = new URLSearchParams({
      rep: rep?.name || '',
      rep_display: repName,
      title: 'Service Advisor',
      dealer: dealerName,
      code: shortCode,
      customer: inspection.customer_name,
      mode: 'service',
    });

    if (videoRow.mux_playback_id) params.set('playback_id', videoRow.mux_playback_id);
    if (inspection.vehicle) params.set('vehicle', inspection.vehicle);
    if (inspection.ro_number) params.set('ro', inspection.ro_number);

    const playerUrl = `https://autofilm.io/autofilm-player.html?${params.toString()}`;
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
        smsBody += `\n\nWatch the video walkthrough: ${shortUrl}`;

        const msg = await twilioClient.messages.create({
          body: smsBody,
          from: TWILIO_FROM,
          to: inspection.customer_phone,
        });

        results.sms_sid = msg.sid;
        console.log(`[mpi] SMS sent for inspection ${id} — SID: ${msg.sid}`);
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
    const { approved_amount, approved_items } = req.body;

    const { data, error } = await supabase
      .from('mpi_inspections')
      .update({
        status: 'approved',
        approved_amount: approved_amount || null,
        approved_at: new Date().toISOString(),
      })
      .eq('id', id)
      .select('*, videos(rep_id, rooftop_id, short_code)')
      .single();

    if (error) throw error;

    console.log(`[mpi] Inspection ${id} approved — $${approved_amount || 0}`);

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
 * GET /api/mpi/list?rooftop_id=<uuid>&status=<status>
 * List MPI inspections for a rooftop.
 */
router.get('/list', async (req, res) => {
  try {
    const { rooftop_id, status, limit = 50 } = req.query;
    if (!rooftop_id) return res.status(400).json({ error: 'rooftop_id required' });

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
