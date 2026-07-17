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
import { attachPassport, applyFindingDispositions, recordEvent, ensurePassportCode } from '../lib/passport.js';
import { getPricingRenderBlock } from './pricingConfig.js';

const router = express.Router();

const CF_WORKER_URL = process.env.CF_WORKER_URL || 'https://links.autofilm.io';

const DECISIONS = new Set(['approved', 'declined', 'deferred']);

/** Sanitized per-item tier selection from customer-controlled input. */
function cleanTier(src) {
  const tier = typeof src?.selected_tier === 'string' ? src.selected_tier.trim().slice(0, 64) : '';
  const price = Number(src?.selected_tier_price ?? src?.tier_price);
  return {
    selected_tier: tier || null,
    selected_tier_price: Number.isFinite(price) && price >= 0 ? price : null,
  };
}

/**
 * Normalize customer-controlled per-item decisions to a safe, uniform shape:
 *   [{ index, name, decision, selected_tier, selected_tier_price, deferred_until }]
 *
 * Prefers the explicit `dispositions` array (the forward contract); falls
 * back to the legacy `approved_items` shape (strings or { name, ... }),
 * where every listed item means "approved". Entries with no usable
 * index/name or an unknown decision are dropped — this feeds unauthenticated
 * input into the findings lifecycle and the compliance archive.
 */
function normalizeDispositions({ dispositions, approved_items }) {
  const out = [];
  const push = (raw, decision) => {
    if (!DECISIONS.has(decision)) return;
    const idx = Number(raw?.index ?? raw?.source_item_index);
    const index = Number.isInteger(idx) && idx >= 0 ? idx : null;
    const rawName = typeof raw === 'string' ? raw : raw?.name;
    const name = typeof rawName === 'string' && rawName.trim() ? rawName.trim() : null;
    if (index === null && !name) return;
    const deferred_until =
      typeof raw?.deferred_until === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(raw.deferred_until)
        ? raw.deferred_until
        : null;
    out.push({ index, name, decision, deferred_until, ...cleanTier(typeof raw === 'object' ? raw : {}) });
  };

  if (Array.isArray(dispositions)) {
    for (const d of dispositions) {
      if (d && typeof d === 'object') push(d, d.decision);
    }
    return out;
  }
  if (Array.isArray(approved_items)) {
    for (const it of approved_items) push(it, 'approved');
  }
  return out;
}

/** Match a normalized disposition to the SERVER-SIDE item it refers to. */
function matchServerItem(serverItems, d) {
  if (d.index !== null && d.index < serverItems.length && serverItems[d.index]) {
    return serverItems[d.index];
  }
  if (!d.name) return null;
  const key = d.name.toLowerCase();
  return serverItems.find(it => typeof it?.name === 'string' && it.name.trim().toLowerCase() === key) || null;
}

/**
 * Append the immutable approval snapshot (research §4/§5, CA BAR retention).
 * approval_renders is append-only (migration 011) — this row is the legal
 * proof of exactly what the customer saw and chose. One retry on failure;
 * a final failure is a compliance incident and is logged as loudly as this
 * process can log, with the full payload so it can be replayed by hand.
 */
async function writeApprovalRender(inspectionId, payload) {
  for (let attempt = 1; attempt <= 2; attempt++) {
    const { error } = await supabase
      .from('approval_renders')
      .insert({ inspection_id: inspectionId, rendered_payload: payload });
    if (!error) {
      console.log(`[mpi] Approval render archived for inspection ${inspectionId}`);
      return true;
    }
    console.error(`[mpi] Approval archive attempt ${attempt}/2 failed for inspection ${inspectionId}:`, error.message);
  }
  console.error(
    `[mpi] ARCHIVE WRITE FAILED — compliance: approval_renders insert lost for inspection ${inspectionId}. ` +
    `Manual replay payload follows:`,
    JSON.stringify(payload)
  );
  return false;
}

/**
 * POST /api/mpi
 * Create a new MPI inspection with video.
 *
 * Body: {
 *   rep_id, rooftop_id, customer_name, customer_phone, customer_email?,
 *   ro_number?, vin?, vehicle?, mileage?,
 *   items: [{ name, status, note,
 *             video_ts_start?, video_ts_end? }],  // optional seconds into the
 *                                                 // walkaround video — persisted
 *                                                 // onto findings for
 *                                                 // clip-per-finding deep links
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

    // Passport ledger (fire-and-forget, recordEvent never throws).
    // vehicle_id can be null if attachPassport is still racing this
    // request — best-effort, never blocks the send.
    if (inspection.vehicle_id) {
      recordEvent(inspection.vehicle_id, {
        event_type: 'inspection_sent',
        rooftop_id: inspection.rooftop_id,
        actor_type: 'rep',
        actor_id: inspection.rep_id || null,
        subject_table: 'mpi_inspections',
        subject_id: inspection.id,
        payload: { via, short_code: shortCode, ro_number: inspection.ro_number || null },
      });

      // Lazily mint the vehicle's STABLE passport short link on first
      // send (fire-and-forget — ensurePassportCode never throws, and the
      // link is also minted on first passport access).
      ensurePassportCode(inspection.vehicle_id);
    }

    res.json({ success: true, short_url: shortUrl, ...results });

  } catch (err) {
    console.error('[mpi] Send error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/mpi/:id/approve
 * Customer approves the recommended service.
 *
 * Body: {
 *   code,                        // capability token (video short_code)
 *   approved_amount,
 *   approved_items?: [{ name, price, urgency, status,
 *                       index?, selected_tier?, selected_tier_price? }],
 *   dispositions?:   [{ index?, name?,
 *                       decision: 'approved'|'declined'|'deferred',
 *                       selected_tier?, selected_tier_price?,
 *                       deferred_until? }]   // forward contract: mixed per-item decisions
 * }
 * When `dispositions` is present it wins; otherwise every approved_items
 * entry is treated as decision:'approved' (legacy contract, unchanged).
 * Matching findings rows transition (status + approved_at/declined_at +
 * selected_tier) and the DB trigger ledgers finding_approved /
 * finding_declined / finding_deferred vehicle_events atomically.
 */
router.post('/:id/approve', async (req, res) => {
  try {
    const { id } = req.params;
    const { approved_amount, approved_items, dispositions, code } = req.body;

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

    // Per-item customer decisions, sanitized. Forward contract is the
    // dispositions array (mixed approve/decline/defer + tier picks);
    // legacy approved_items still means "everything listed = approved".
    const serverItems = Array.isArray(data.items) ? data.items : [];
    const decisions = normalizeDispositions({ dispositions, approved_items });

    // Findings lifecycle (fire-and-forget, never blocks the approval):
    // flip the matching findings rows; the findings_transition_ledger
    // trigger appends the finding_approved / finding_declined /
    // finding_deferred vehicle_events row atomically with each update.
    applyFindingDispositions({ inspectionId: id, dispositions: decisions });

    // Immutable approval archive (research §4/§5, CA BAR retention):
    // capture exactly what was offered AS RENDERED at approval time —
    // items, the pricing presentation config, the disclosures shown,
    // per-item selected tiers, and the approved amount. approval_renders
    // is append-only (migration 011). Fire-and-forget: archiving must
    // never fail or delay the approval, but a lost archive is a
    // compliance incident — writeApprovalRender retries once and logs
    // loudly on final failure.
    // approved_items/dispositions are customer-controlled jsonb: never
    // archive them verbatim. Archive the SERVER-SIDE item objects the
    // customer selected (matched by index, then name, against data.items)
    // with only the sanitized tier choice merged in — arbitrary payloads
    // can't reach the legal record.
    const approvedItemsArchive = decisions
      .filter(d => d.decision === 'approved')
      .map(d => {
        const item = matchServerItem(serverItems, d);
        if (!item) return null;
        return {
          ...item,
          ...(d.selected_tier ? { selected_tier: d.selected_tier } : {}),
          ...(d.selected_tier_price !== null ? { selected_tier_price: d.selected_tier_price } : {}),
        };
      })
      .filter(Boolean);

    (async () => {
      const pricing = await getPricingRenderBlock(data.rooftop_id);
      await writeApprovalRender(id, {
        items: serverItems,
        approved_items: approvedItemsArchive.length > 0 ? approvedItemsArchive : null,
        dispositions: decisions.length > 0 ? decisions : null,
        approved_amount: approvedAmount ?? data.total_estimate ?? 0,
        pricing,
        disclosures: {
          general: pricing.general_disclosure,
          lifetime: pricing.lifetime.disclosure,
          financing: pricing.financing.disclosure,
        },
        approved_at: data.approved_at,
      });
    })().catch(err =>
      console.error(`[mpi] ARCHIVE WRITE FAILED — compliance: unexpected archive error for inspection ${id}:`, err.message)
    );

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
 * POST /api/mpi/:id/decline
 * Customer declines (or defers) recommended service. Code-gated like
 * /:id/approve — the video short_code is the capability token.
 *
 * Body: {
 *   code,
 *   dispositions?:   [{ index?, name?, decision: 'declined'|'deferred',
 *                       deferred_until? }],   // per-item decline/defer
 *   declined_items?: [ 'name' | { name, index? } ],  // shorthand: all declined
 *   reason?: string
 * }
 * With no per-item list, the WHOLE inspection is declined: every item's
 * finding transitions to declined and the inspection status becomes
 * 'declined' (unless already approved). Approve decisions are ignored
 * here — a decline endpoint must never approve work.
 */
router.post('/:id/decline', async (req, res) => {
  try {
    const { id } = req.params;
    const { code, dispositions, declined_items, reason } = req.body || {};

    // Customer-facing endpoint: no session, so the video short_code acts
    // as the capability token (only the SMS recipient knows it).
    const { data: inspection } = await supabase
      .from('mpi_inspections')
      .select('id, status, items, rep_id, rooftop_id, video_id, customer_name, vehicle, videos(short_code)')
      .eq('id', id)
      .single();
    if (!inspection || inspection.videos?.short_code !== code) {
      return res.status(403).json({ error: 'Invalid inspection link' });
    }

    const serverItems = Array.isArray(inspection.items) ? inspection.items : [];

    // Per-item decisions — approvals are stripped on this route.
    let decisions = normalizeDispositions({
      dispositions,
      approved_items: null,
    }).filter(d => d.decision !== 'approved');

    if (decisions.length === 0 && Array.isArray(declined_items)) {
      decisions = normalizeDispositions({
        dispositions: declined_items
          .map(it => (typeof it === 'string' ? { name: it } : it))
          .filter(it => it && typeof it === 'object')
          .map(it => ({ ...it, decision: 'declined' })),
      });
    }

    // A per-item list that matched nothing must NOT escalate to a full
    // decline — only the total absence of a list means "decline all".
    const explicitList = Array.isArray(dispositions) || Array.isArray(declined_items);
    if (explicitList && decisions.length === 0) {
      return res.status(400).json({ error: 'No valid items to decline' });
    }

    // No per-item list = full decline of every recommended item.
    const fullDecline = !explicitList;
    if (fullDecline) {
      decisions = serverItems.map((it, i) => ({
        index: i,
        name: typeof it?.name === 'string' ? it.name : null,
        decision: 'declined',
        deferred_until: null,
        selected_tier: null,
        selected_tier_price: null,
      }));
    }

    if (fullDecline && inspection.status !== 'approved') {
      const { error: upErr } = await supabase
        .from('mpi_inspections')
        .update({ status: 'declined' })
        .eq('id', id);
      if (upErr) throw upErr;
    }

    console.log(`[mpi] Inspection ${id} decline — ${fullDecline ? 'all items' : decisions.length + ' item(s)'}${reason ? ` (reason: ${String(reason).slice(0, 200)})` : ''}`);

    // Findings lifecycle (fire-and-forget): the DB trigger ledgers
    // finding_declined / finding_deferred vehicle_events atomically.
    applyFindingDispositions({ inspectionId: id, dispositions: decisions });

    // Notify the service advisor — a decline is a follow-up opportunity.
    const { data: advisor } = await supabase
      .from('reps')
      .select('push_subscription')
      .eq('id', inspection.rep_id)
      .single();
    if (advisor?.push_subscription) {
      sendPush(advisor.push_subscription, {
        title: 'Service declined',
        body: `${inspection.customer_name || 'Customer'} declined ${fullDecline ? 'the recommended work' : `${decisions.length} item(s)`}${inspection.vehicle ? ` — ${inspection.vehicle}` : ''}`,
        data: { type: 'mpi_declined', inspection_id: id },
      }).catch(() => {});
    }

    res.json({
      success: true,
      declined: decisions.filter(d => d.decision === 'declined').length,
      deferred: decisions.filter(d => d.decision === 'deferred').length,
      full_decline: fullDecline,
    });

  } catch (err) {
    console.error('[mpi] Decline error:', err.message);
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
      .select('id, rooftop_id, vehicle_id, status, customer_name, vehicle, vehicle_image_url, mileage, ro_number, items, total_estimate, approved_amount, approved_at, videos(short_code, mux_playback_id, reps(name, nickname, title, photo_url, rooftops(name)))')
      .eq('id', id)
      .single();

    if (!inspection || inspection.videos?.short_code !== code) {
      return res.status(403).json({ error: 'Invalid inspection link' });
    }

    // Passport ledger: first customer open = one inspection_viewed event
    // (fire-and-forget — must never delay or fail the page load).
    if (inspection.vehicle_id) {
      (async () => {
        const { data: prior, error: priorErr } = await supabase
          .from('vehicle_events')
          .select('id')
          .eq('event_type', 'inspection_viewed')
          .eq('subject_table', 'mpi_inspections')
          .eq('subject_id', inspection.id)
          .limit(1);
        if (priorErr) throw priorErr;
        if (!prior || prior.length === 0) {
          await recordEvent(inspection.vehicle_id, {
            event_type: 'inspection_viewed',
            rooftop_id: inspection.rooftop_id,
            actor_type: 'customer',
            subject_table: 'mpi_inspections',
            subject_id: inspection.id,
            payload: { short_code: code },
          });
          console.log(`[mpi] First public view ledgered for inspection ${inspection.id}`);
        }
      })().catch(err => console.error('[mpi] inspection_viewed ledger error (non-fatal):', err.message));
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
