import express from 'express';
import { nanoid } from 'nanoid';
import { supabase } from '../lib/supabase.js';
import { video } from '../lib/mux.js';
import { getThumbnails } from '../lib/thumbnail.js';
import { syncVideoEvent } from '../lib/crm.js';

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
router.post('/', async (req, res) => {
  try {
    const { vin, rooftop_id, rep_id, style = 'cinematic' } = req.body;

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
    const shortCode = nanoid(8);

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
        short_code: shortCode,
        type: 'vin_reel',
        vin,
        vehicle: vehicleName,
        stock_number: vehicle.stock_number || null,
      })
      .select()
      .single();

    if (insertErr) throw insertErr;

    console.log(`[vin-reels] Created reel ${shortCode} for ${vehicleName}`);

    // 4. CRM sync (async, non-blocking)
    syncVideoEvent(rooftop_id, {
      action: 'video_sent',
      video_id: videoRow.id,
      short_code: shortCode,
    }).catch(err => console.error('[vin-reels] CRM sync error:', err.message));

    res.json({
      success: true,
      video_id: videoRow.id,
      short_code: shortCode,
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

export default router;
