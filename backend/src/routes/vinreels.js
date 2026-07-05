import express from 'express';
import { randomUUID } from 'crypto';
import { shortCode as genCode } from '../lib/shortcode.js';
import { requireAuth } from '../lib/auth.js';
import { supabase } from '../lib/supabase.js';
import { video } from '../lib/mux.js';
import { getThumbnails } from '../lib/thumbnail.js';
import { syncVideoEvent } from '../lib/crm.js';
import { renderVinReel, uploadToMux, cleanupRender } from '../lib/vinreel-render.js';

const router = express.Router();

/**
 * POST /api/vin-reels
 * Auto-generate a vehicle showcase video from VIN data.
 *
 * Body: {
 *   vin: string,
 *   rooftop_id: string,
 *   rep_id: string,
 *   style?: 'cinematic' | 'quick' | 'detailed'  (default: 'cinematic')
 * }
 *
 * Steps:
 *   1. Look up vehicle in inventory table (or fetch from NHTSA)
 *   2. Gather photos from inventory record
 *   3. Generate AI script via Claude API
 *   4. Create Mux asset from photo slideshow with audio
 *   5. Store as a 'vin_reel' type video
 */
router.post('/', requireAuth(), async (req, res) => {
  try {
    const { vin, style = 'cinematic' } = req.body;
    const rooftop_id = req.rep.rooftop_id;
    const rep_id = req.rep.id;

    if (!vin) return res.status(400).json({ error: 'vin required' });
    if (!rooftop_id) return res.status(400).json({ error: 'rooftop_id required' });
    if (!rep_id) return res.status(400).json({ error: 'rep_id required' });

    // 1. Look up vehicle in local inventory
    let vehicle = null;
    const { data: invItem } = await supabase
      .from('inventory')
      .select('*')
      .eq('rooftop_id', rooftop_id)
      .eq('vin', vin)
      .single();

    if (invItem) {
      vehicle = invItem;
    } else {
      // Fallback: decode VIN via NHTSA
      const nhtsaRes = await fetch(
        `https://vpic.nhtsa.dot.gov/api/vehicles/decodevinvaluesextended/${vin}?format=json`
      );
      const nhtsaData = await nhtsaRes.json();
      const result = nhtsaData.Results?.[0];

      if (result?.Make) {
        vehicle = {
          vin,
          year: parseInt(result.ModelYear) || null,
          make: result.Make,
          model: result.Model,
          trim: result.Trim,
          body_style: result.BodyClass,
          engine: `${result.DisplacementL}L ${result.EngineConfiguration} ${result.EngineCylinders}cyl`,
          drivetrain: result.DriveType,
          photos: [],
          features: [],
        };
      }
    }

    if (!vehicle) {
      return res.status(404).json({ error: 'Vehicle not found for VIN: ' + vin });
    }

    const vehicleName = `${vehicle.year || ''} ${vehicle.make || ''} ${vehicle.model || ''} ${vehicle.trim || ''}`.trim();

    // 2. Generate AI script via Claude
    const script = await generateVinReelScript(vehicle, style);

    // 3. Create the reel as a video record
    const code = genCode();

    // Create a Mux asset. In production this would be a rendered slideshow
    // with TTS voiceover. For now we create an upload URL that the frontend
    // can use to upload the rendered reel (or the backend renders server-side).
    const upload = await video.uploads.create({
      cors_origin: '*',
      new_asset_settings: {
        playback_policy: ['public'],
        encoding_tier: 'smart',
      },
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

    // 4. CRM sync (async, non-blocking)
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
 * POST /api/vin-reels/render
 * Full server-side render: photos → Ken Burns video + TTS voiceover + music.
 * No recording needed from the rep — completely automated.
 *
 * Body: {
 *   vin: string,
 *   rooftop_id: string,
 *   rep_id: string,
 *   style?: 'cinematic' | 'quick' | 'detailed'
 * }
 */
router.post('/render', requireAuth(), async (req, res) => {
  try {
    const { vin, style = 'cinematic' } = req.body;
    const rooftop_id = req.rep.rooftop_id;
    const rep_id = req.rep.id;

    if (!vin) return res.status(400).json({ error: 'vin required' });

    // 1. Get vehicle data + photos
    let vehicle = null;
    const { data: invItem } = await supabase
      .from('inventory')
      .select('*')
      .eq('rooftop_id', rooftop_id)
      .eq('vin', vin)
      .single();

    if (invItem) {
      vehicle = invItem;
    } else {
      const nhtsaRes = await fetch(
        `https://vpic.nhtsa.dot.gov/api/vehicles/decodevinvaluesextended/${vin}?format=json`
      );
      const nhtsaData = await nhtsaRes.json();
      const r = nhtsaData.Results?.[0];
      if (r?.Make) {
        vehicle = {
          vin, year: parseInt(r.ModelYear) || null, make: r.Make,
          model: r.Model, trim: r.Trim, body_style: r.BodyClass,
          engine: `${r.DisplacementL || ''}L ${r.EngineConfiguration || ''}`.trim(),
          drivetrain: r.DriveType, photos: [], features: [],
        };
      }
    }

    if (!vehicle) return res.status(404).json({ error: 'Vehicle not found' });

    const photos = vehicle.photos || [];
    if (photos.length === 0) {
      return res.status(400).json({ error: 'No photos available for this vehicle. Add photos to inventory first.' });
    }

    const vehicleName = `${vehicle.year || ''} ${vehicle.make || ''} ${vehicle.model || ''} ${vehicle.trim || ''}`.trim();

    // 2. Get dealer info
    const { data: rooftop } = await supabase
      .from('rooftops')
      .select('name, brand_color')
      .eq('id', rooftop_id)
      .single();

    // 3. Generate AI script
    const script = await generateVinReelScript(vehicle, style);

    // 4. Render the video server-side
    console.log(`[vin-reels] Starting server-side render for ${vehicleName}...`);

    const outputPath = await renderVinReel({
      photos,
      script,
      vehicleName,
      dealerName: rooftop?.name || '',
      price: vehicle.sale_price ? `$${vehicle.sale_price.toLocaleString()}` : '',
      brandColor: rooftop?.brand_color || '#D94F00',
      style,
    });

    // 5. Upload to Mux
    const { uploadId, assetId } = await uploadToMux(video, outputPath);

    // 6. Create video record
    const code = genCode();
    const { data: videoRow, error: insertErr } = await supabase
      .from('videos')
      .insert({
        rep_id: rep_id || null,
        rooftop_id,
        mux_asset_id: assetId,
        mux_upload_id: uploadId,
        short_code: code,
        type: 'vin_reel',
        vin,
        vehicle: vehicleName,
        stock_number: vehicle.stock_number || null,
      })
      .select()
      .single();

    if (insertErr) throw insertErr;

    // 7. Cleanup temp files
    cleanupRender(outputPath.replace(/\/[^/]+$/, '')).catch(() => {});

    // 8. CRM sync
    syncVideoEvent(rooftop_id, {
      action: 'video_sent',
      video_id: videoRow.id,
      short_code: code,
    }).catch(err => console.error('[vin-reels] CRM sync error:', err.message));

    console.log(`[vin-reels] Server render complete: ${code} for ${vehicleName}`);

    res.json({
      success: true,
      video_id: videoRow.id,
      short_code: code,
      vehicle: vehicleName,
      script,
      rendered: true,
    });

  } catch (err) {
    console.error('[vin-reels] Render error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/vin-reels/bulk-render
 * Render VIN Reels for all vehicles in a rooftop's inventory.
 * Returns immediately with a job ID; renders in background.
 *
 * Body: { rooftop_id, rep_id?, style?, limit? }
 */
router.post('/bulk-render', requireAuth(), async (req, res) => {
  try {
    const { style = 'cinematic', limit = 50 } = req.body;
    const rooftop_id = req.rep.rooftop_id;
    const rep_id = req.rep.id;

    // Get vehicles with photos that don't already have a vin_reel
    const { data: vehicles, error } = await supabase
      .from('inventory')
      .select('vin, year, make, model, trim, photos')
      .eq('rooftop_id', rooftop_id)
      .eq('status', 'available')
      .not('photos', 'eq', '[]')
      .limit(parseInt(limit));

    if (error) throw error;

    // Filter out vehicles that already have vin_reels
    const { data: existingReels } = await supabase
      .from('videos')
      .select('vin')
      .eq('rooftop_id', rooftop_id)
      .eq('type', 'vin_reel');

    const existingVins = new Set((existingReels || []).map(r => r.vin));
    const toRender = (vehicles || []).filter(v => v.photos?.length > 0 && !existingVins.has(v.vin));

    console.log(`[vin-reels] Bulk render: ${toRender.length} vehicles queued for ${rooftop_id}`);

    // Start rendering in background (non-blocking)
    const jobId = randomUUID().slice(0, 8);

    // Process sequentially in background to avoid overloading FFmpeg
    (async () => {
      let rendered = 0;
      for (const v of toRender) {
        try {
          const vehicleName = `${v.year || ''} ${v.make || ''} ${v.model || ''} ${v.trim || ''}`.trim();
          const script = await generateVinReelScript(v, style);

          const outputPath = await renderVinReel({
            photos: v.photos,
            script,
            vehicleName,
            style,
          });

          const { assetId, uploadId: upId } = await uploadToMux(video, outputPath);
          const bulkCode = genCode();

          await supabase.from('videos').insert({
            rep_id: rep_id || null,
            rooftop_id,
            mux_asset_id: assetId,
            mux_upload_id: upId,
            short_code: bulkCode,
            type: 'vin_reel',
            vin: v.vin,
            vehicle: vehicleName,
          });

          cleanupRender(outputPath.replace(/\/[^/]+$/, '')).catch(() => {});
          rendered++;
          console.log(`[vin-reels] Bulk ${jobId}: ${rendered}/${toRender.length} — ${vehicleName}`);
        } catch (e) {
          console.error(`[vin-reels] Bulk ${jobId}: Failed ${v.vin} — ${e.message}`);
        }
      }
      console.log(`[vin-reels] Bulk ${jobId}: Complete — ${rendered}/${toRender.length} rendered`);
    })();

    res.json({
      success: true,
      job_id: jobId,
      queued: toRender.length,
      skipped: (vehicles || []).length - toRender.length,
      message: `Rendering ${toRender.length} VIN Reels in background`,
    });

  } catch (err) {
    console.error('[vin-reels] Bulk render error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

export default router;
