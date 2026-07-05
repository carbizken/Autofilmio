import express from 'express';
import { randomUUID } from 'crypto';
import { shortCode as genCode } from '../lib/shortcode.js';
import { requireAuth } from '../lib/auth.js';
import { supabase } from '../lib/supabase.js';
import { video, defaultUploadSettings } from '../lib/mux.js';
import { syncVideoEvent } from '../lib/crm.js';
import { renderVinReel, uploadToMux, cleanupRender, ffmpegAvailable } from '../lib/vinreel-render.js';

const router = express.Router();

// ── Render concurrency guard ─────────────────────────────────
// ffmpeg is CPU-bound and this service runs on a single Render
// instance (see render.yaml). Allow at most 2 simultaneous renders;
// interactive requests beyond that get a 429, background bulk jobs
// wait for a free slot.
const MAX_CONCURRENT_RENDERS = 2;
let activeRenders = 0;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Look up a vehicle by VIN: local inventory first, NHTSA decode fallback.
 * Returns null when neither source knows the VIN.
 */
async function lookupVehicle(rooftop_id, vin) {
  const { data: invItem } = await supabase
    .from('inventory')
    .select('*')
    .eq('rooftop_id', rooftop_id)
    .eq('vin', vin)
    .single();

  if (invItem) return invItem;

  const nhtsaRes = await fetch(
    `https://vpic.nhtsa.dot.gov/api/vehicles/decodevinvaluesextended/${vin}?format=json`
  );
  const nhtsaData = await nhtsaRes.json();
  const r = nhtsaData.Results?.[0];

  if (!r?.Make) return null;

  return {
    vin,
    year: parseInt(r.ModelYear) || null,
    make: r.Make,
    model: r.Model,
    trim: r.Trim,
    body_style: r.BodyClass,
    engine: `${r.DisplacementL || ''}L ${r.EngineConfiguration || ''} ${r.EngineCylinders || ''}cyl`.trim(),
    drivetrain: r.DriveType,
    photos: [],
    features: [],
  };
}

function vehicleDisplayName(v) {
  return `${v.year || ''} ${v.make || ''} ${v.model || ''} ${v.trim || ''}`.trim();
}

/**
 * POST /api/vin-reels
 * Auto-generate a vehicle showcase video from VIN data.
 *
 * Body: {
 *   vin: string,
 *   style?: 'cinematic' | 'quick' | 'detailed'  (default: 'cinematic')
 * }
 *
 * This is the client-render path: returns a Mux direct-upload URL the
 * frontend can PUT a rendered reel to, plus the AI script and photos.
 * For fully automated server-side rendering use POST /render instead.
 */
router.post('/', requireAuth(), async (req, res) => {
  try {
    const { vin, style = 'cinematic' } = req.body;
    const rooftop_id = req.rep.rooftop_id;
    const rep_id = req.rep.id;

    if (!vin) return res.status(400).json({ error: 'vin required' });
    if (!rooftop_id) return res.status(400).json({ error: 'rooftop_id required' });
    if (!rep_id) return res.status(400).json({ error: 'rep_id required' });

    const vehicle = await lookupVehicle(rooftop_id, vin);
    if (!vehicle) {
      return res.status(404).json({ error: 'Vehicle not found for VIN: ' + vin });
    }

    const vehicleName = vehicleDisplayName(vehicle);

    // Generate AI script via Claude
    const script = await generateVinReelScript(vehicle, style);

    // Create the reel as a video record with a Mux direct-upload URL —
    // the frontend uploads the rendered reel and the Mux webhook
    // finalizes mux_playback_id.
    const code = genCode();
    const upload = await video.uploads.create({
      cors_origin: '*',
      new_asset_settings: defaultUploadSettings({ encoding_tier: 'smart' }),
    });

    const { data: videoRow, error: insertErr } = await supabase
      .from('videos')
      .insert({
        rep_id,
        rooftop_id,
        mux_asset_id: upload.asset_id || null,
        mux_upload_id: upload.id,
        short_code: code,
        type: 'vin_reel',
        vin,
        vehicle: vehicleName,
        stock_number: vehicle.stock_number || null,
      })
      .select()
      .single();

    if (insertErr) throw insertErr;

    console.log(`[vin-reels] Created reel ${code} for ${vehicleName}`);

    // CRM sync (async, non-blocking)
    syncVideoEvent(rooftop_id, {
      action: 'video_sent',
      video_id: videoRow.id,
      short_code: code,
    }).catch(err => console.error('[vin-reels] CRM sync error:', err.message));

    res.json({
      success: true,
      video_id: videoRow.id,
      short_code: code,
      upload_url: upload.url,
      upload_id: upload.id,
      vehicle: vehicleName,
      script,
      photos: vehicle.photos || [],
      features: vehicle.features || [],
    });

  } catch (err) {
    console.error('[vin-reels] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/vin-reels/decode/:vin
 * Quick VIN decode for the frontend — returns vehicle info + photos.
 */
router.get('/decode/:vin', async (req, res) => {
  try {
    const { vin } = req.params;
    const rooftop_id = req.query.rooftop_id;

    // Check local inventory first
    if (rooftop_id) {
      const { data: invItem } = await supabase
        .from('inventory')
        .select('*')
        .eq('rooftop_id', rooftop_id)
        .eq('vin', vin)
        .single();

      if (invItem) {
        return res.json({ source: 'inventory', vehicle: invItem });
      }
    }

    // Fallback to NHTSA
    const nhtsaRes = await fetch(
      `https://vpic.nhtsa.dot.gov/api/vehicles/decodevinvaluesextended/${vin}?format=json`
    );
    const data = await nhtsaRes.json();
    const r = data.Results?.[0];

    if (!r?.Make) {
      return res.status(404).json({ error: 'VIN not found' });
    }

    res.json({
      source: 'nhtsa',
      vehicle: {
        vin,
        year: parseInt(r.ModelYear) || null,
        make: r.Make,
        model: r.Model,
        trim: r.Trim,
        body_style: r.BodyClass,
        engine: `${r.DisplacementL || ''}L ${r.EngineConfiguration || ''} ${r.EngineCylinders || ''}cyl`.trim(),
        drivetrain: r.DriveType,
        msrp: r.BasePrice ? parseFloat(r.BasePrice) : null,
      },
    });
  } catch (err) {
    console.error('[vin-reels] Decode error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * Generate an AI script for a VIN Reel using Claude.
 */
async function generateVinReelScript(vehicle, style) {
  if (!process.env.ANTHROPIC_API_KEY) {
    return getTemplateScript(vehicle, style);
  }

  try {
    const vehicleName = `${vehicle.year || ''} ${vehicle.make || ''} ${vehicle.model || ''} ${vehicle.trim || ''}`.trim();
    const features = (vehicle.features || []).join(', ');

    const prompt = `Write a ${style === 'quick' ? '15-second' : style === 'detailed' ? '45-second' : '30-second'} video voiceover script for a car dealership VIN Reel showcasing the ${vehicleName}.

Vehicle details:
- Body style: ${vehicle.body_style || 'N/A'}
- Engine: ${vehicle.engine || 'N/A'}
- Drivetrain: ${vehicle.drivetrain || 'N/A'}
- Exterior: ${vehicle.exterior_color || 'N/A'}
- MSRP: ${vehicle.msrp ? '$' + vehicle.msrp.toLocaleString() : 'N/A'}
${features ? `- Key features: ${features}` : ''}

Requirements:
- Engaging, professional automotive tone
- Highlight 3-4 standout features
- End with a clear call to action ("Schedule your test drive" or similar)
- No hashtags or social media language
- Return ONLY the script text, no stage directions`;

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 300,
        messages: [{ role: 'user', content: prompt }],
      }),
    });

    const data = await response.json();
    return data.content?.[0]?.text || getTemplateScript(vehicle, style);
  } catch (err) {
    console.error('[vin-reels] AI script error:', err.message);
    return getTemplateScript(vehicle, style);
  }
}

/**
 * Fallback template script when AI is unavailable.
 */
function getTemplateScript(vehicle, style) {
  const name = `${vehicle.year || ''} ${vehicle.make || ''} ${vehicle.model || ''}`.trim();
  return `Introducing the ${name}. ${vehicle.engine ? `Powered by a ${vehicle.engine}, ` : ''}this ${vehicle.body_style || 'vehicle'} delivers the perfect combination of style, performance, and value. ${vehicle.features?.length ? `Equipped with ${vehicle.features.slice(0, 3).join(', ')}.` : ''} Come see it in person — schedule your test drive today.`;
}

/**
 * Background render job for one reel row (already inserted with
 * render_status='rendering'). Never throws — success updates the row
 * to 'ready' + Mux ids, failure updates it to 'failed' + render_error,
 * so no reel is ever orphaned mid-state.
 */
async function runRenderJob(reel, vehicle, cfg) {
  const { style, dealerName, brandColor } = cfg;
  activeRenders++;
  let outputPath = null;
  try {
    const vehicleName = reel.vehicle || vehicleDisplayName(vehicle);
    console.log(`[vin-reels] Render job ${reel.id} started — ${vehicleName} (${activeRenders}/${MAX_CONCURRENT_RENDERS} slots)`);

    const script = await generateVinReelScript(vehicle, style);

    outputPath = await renderVinReel({
      photos: cfg.photos,
      script,
      vehicleName,
      dealerName: dealerName || '',
      price: vehicle.sale_price ? `$${vehicle.sale_price.toLocaleString()}` : '',
      brandColor: brandColor || '#D94F00',
      style,
    });

    // uploadToMux uses defaultUploadSettings({ encoding_tier: 'smart' });
    // the Mux webhook fills mux_playback_id when the asset is ready.
    const { uploadId, assetId } = await uploadToMux(video, outputPath);

    const { error: upErr } = await supabase
      .from('videos')
      .update({
        mux_asset_id: assetId,
        mux_upload_id: uploadId,
        render_status: 'ready',
        render_error: null,
      })
      .eq('id', reel.id);
    if (upErr) throw new Error(`Status update failed: ${upErr.message}`);

    // CRM sync (non-blocking)
    syncVideoEvent(reel.rooftop_id, {
      action: 'video_sent',
      video_id: reel.id,
      short_code: reel.short_code,
    }).catch(err => console.error('[vin-reels] CRM sync error:', err.message));

    console.log(`[vin-reels] Render job ${reel.id} complete — ${reel.short_code}`);
  } catch (err) {
    console.error(`[vin-reels] Render job ${reel.id} failed:`, err.message);
    const { error: failErr } = await supabase
      .from('videos')
      .update({
        render_status: 'failed',
        render_error: String(err.message || err).slice(0, 500),
      })
      .eq('id', reel.id);
    if (failErr) console.error(`[vin-reels] Could not mark reel ${reel.id} failed:`, failErr.message);
  } finally {
    activeRenders--;
    if (outputPath) cleanupRender(outputPath.replace(/\/[^/]+$/, '')).catch(() => {});
  }
}

/**
 * POST /api/vin-reels/render
 * Full server-side render: photos → Ken Burns video + TTS voiceover.
 * Async job model: validates, inserts the reel row as 'rendering',
 * returns 202 immediately, and renders in the background. Poll
 * GET /status/:reel_id for completion.
 *
 * Body: {
 *   vin: string,
 *   style?: 'cinematic' | 'quick' | 'detailed',
 *   photos?: string[]   // optional photo URLs (used when inventory has none)
 * }
 *
 * Returns: 202 { reel_id, short_code, status: 'rendering' }
 */
router.post('/render', requireAuth(), async (req, res) => {
  try {
    if (!ffmpegAvailable) {
      return res.status(503).json({ error: 'Rendering unavailable on this deployment' });
    }

    const { vin, style = 'cinematic', photos: bodyPhotos } = req.body;
    const rooftop_id = req.rep.rooftop_id;
    const rep_id = req.rep.id;

    if (!vin) return res.status(400).json({ error: 'vin required' });

    if (activeRenders >= MAX_CONCURRENT_RENDERS) {
      return res.status(429).json({ error: 'Render queue is full — try again in a minute' });
    }

    // 1. Get vehicle data + photos
    const vehicle = await lookupVehicle(rooftop_id, vin);
    if (!vehicle) return res.status(404).json({ error: 'Vehicle not found' });

    const requestPhotos = Array.isArray(bodyPhotos) ? bodyPhotos : [];
    const photos = (requestPhotos.length ? requestPhotos : (vehicle.photos || []))
      .filter(u => typeof u === 'string' && /^https?:\/\//i.test(u))
      .slice(0, 30);

    if (photos.length === 0) {
      return res.status(400).json({ error: 'No photos available for this vehicle. Add photos to inventory or provide photo URLs.' });
    }

    const vehicleName = vehicleDisplayName(vehicle);

    // 2. Get dealer info
    const { data: rooftop } = await supabase
      .from('rooftops')
      .select('name, brand_color')
      .eq('id', rooftop_id)
      .single();

    // 3. Insert the reel row up front so the job is trackable
    const code = genCode();
    const { data: reelRow, error: insertErr } = await supabase
      .from('videos')
      .insert({
        rep_id: rep_id || null,
        rooftop_id,
        short_code: code,
        type: 'vin_reel',
        vin,
        vehicle: vehicleName,
        stock_number: vehicle.stock_number || null,
        render_status: 'rendering',
      })
      .select('id, short_code, rooftop_id, vehicle')
      .single();

    if (insertErr) throw insertErr;

    // 4. Respond immediately — render happens in the background
    res.status(202).json({
      reel_id: reelRow.id,
      short_code: code,
      vehicle: vehicleName,
      status: 'rendering',
    });

    // 5. Fire-and-forget background render (fully caught inside)
    runRenderJob(reelRow, vehicle, {
      style,
      photos,
      dealerName: rooftop?.name || '',
      brandColor: rooftop?.brand_color || '#D94F00',
    });

  } catch (err) {
    console.error('[vin-reels] Render error:', err.message);
    if (!res.headersSent) res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/vin-reels/status/:reel_id
 * Poll a render job. Mirrors the /api/upload/status pattern.
 *
 * Returns: {
 *   reel_id, status: 'rendering' | 'ready' | 'failed' | 'pending',
 *   playback_id?, short_code, vehicle, error?
 * }
 * Note: status becomes 'ready' when the render + Mux upload finish;
 * playback_id lands slightly later via the Mux webhook.
 */
router.get('/status/:reel_id', requireAuth(), async (req, res) => {
  const { data } = await supabase
    .from('videos')
    .select('id, short_code, vehicle, render_status, render_error, mux_playback_id')
    .eq('id', req.params.reel_id)
    .eq('rooftop_id', req.rep.rooftop_id)
    .eq('type', 'vin_reel')
    .maybeSingle();

  if (!data) return res.status(404).json({ error: 'Reel not found' });

  res.json({
    reel_id: data.id,
    status: data.render_status || (data.mux_playback_id ? 'ready' : 'pending'),
    playback_id: data.mux_playback_id || null,
    short_code: data.short_code,
    vehicle: data.vehicle,
    error: data.render_status === 'failed' ? (data.render_error || 'Render failed') : null,
  });
});

/**
 * POST /api/vin-reels/bulk-render
 * Render VIN Reels for inventory vehicles that don't have one yet.
 * Rows are inserted as 'rendering' up front, the response is a 202
 * with the reel ids, and renders run sequentially in the background
 * (ffmpeg is CPU-bound — never parallel here).
 *
 * Body: { style?, limit? }  (limit capped at 20 per batch)
 * Returns: 202 { job_id, queued, skipped, reels: [{ reel_id, vin, short_code }] }
 */
router.post('/bulk-render', requireAuth(), async (req, res) => {
  try {
    if (!ffmpegAvailable) {
      return res.status(503).json({ error: 'Rendering unavailable on this deployment' });
    }

    const { style = 'cinematic' } = req.body;
    const MAX_BATCH = 20;
    const limit = Math.min(Math.max(parseInt(req.body.limit) || MAX_BATCH, 1), MAX_BATCH);
    const rooftop_id = req.rep.rooftop_id;
    const rep_id = req.rep.id;

    // Get vehicles with photos that don't already have a vin_reel
    const { data: vehicles, error } = await supabase
      .from('inventory')
      .select('*')
      .eq('rooftop_id', rooftop_id)
      .eq('status', 'available')
      .not('photos', 'eq', '[]')
      .limit(MAX_BATCH * 3); // headroom for the existing-reel filter below

    if (error) throw error;

    const { data: existingReels } = await supabase
      .from('videos')
      .select('vin')
      .eq('rooftop_id', rooftop_id)
      .eq('type', 'vin_reel');

    const existingVins = new Set((existingReels || []).map(r => r.vin));
    const toRender = (vehicles || [])
      .filter(v => v.photos?.length > 0 && !existingVins.has(v.vin))
      .slice(0, limit);

    if (toRender.length === 0) {
      return res.json({ success: true, job_id: null, queued: 0, skipped: (vehicles || []).length, reels: [] });
    }

    const jobId = randomUUID().slice(0, 8);

    // Insert all reel rows up front as 'rendering' — trackable, no orphans
    const rows = toRender.map(v => ({
      rep_id: rep_id || null,
      rooftop_id,
      short_code: genCode(),
      type: 'vin_reel',
      vin: v.vin,
      vehicle: vehicleDisplayName(v),
      stock_number: v.stock_number || null,
      render_status: 'rendering',
    }));

    const { data: inserted, error: insertErr } = await supabase
      .from('videos')
      .insert(rows)
      .select('id, short_code, vin, vehicle, rooftop_id');
    if (insertErr) throw insertErr;

    const { data: rooftop } = await supabase
      .from('rooftops')
      .select('name, brand_color')
      .eq('id', rooftop_id)
      .single();

    console.log(`[vin-reels] Bulk ${jobId}: ${inserted.length} reels queued for ${rooftop_id}`);

    res.status(202).json({
      success: true,
      job_id: jobId,
      queued: inserted.length,
      skipped: (vehicles || []).length - toRender.length,
      reels: inserted.map(r => ({ reel_id: r.id, vin: r.vin, short_code: r.short_code, vehicle: r.vehicle })),
      status: 'rendering',
      message: `Rendering ${inserted.length} VIN Reels in background`,
    });

    // Background: strictly sequential, respecting the global slot limit
    (async () => {
      let done = 0;
      for (const reel of inserted) {
        const v = toRender.find(x => x.vin === reel.vin);
        if (!v) continue;
        while (activeRenders >= MAX_CONCURRENT_RENDERS) await sleep(5000);
        await runRenderJob(reel, v, {
          style,
          photos: (v.photos || []).filter(u => typeof u === 'string' && /^https?:\/\//i.test(u)).slice(0, 30),
          dealerName: rooftop?.name || '',
          brandColor: rooftop?.brand_color || '#D94F00',
        });
        done++;
        console.log(`[vin-reels] Bulk ${jobId}: ${done}/${inserted.length} processed`);
      }
      console.log(`[vin-reels] Bulk ${jobId}: complete`);
    })().catch(e => console.error(`[vin-reels] Bulk ${jobId}: loop error:`, e.message));

  } catch (err) {
    console.error('[vin-reels] Bulk render error:', err.message);
    if (!res.headersSent) res.status(500).json({ error: err.message });
  }
});

export default router;
