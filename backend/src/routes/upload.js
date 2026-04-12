import express from 'express';
import multer from 'multer';
import { nanoid } from 'nanoid';
import { video } from '../lib/mux.js';
import { supabase } from '../lib/supabase.js';

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 500 * 1024 * 1024 } }); // 500MB

/**
 * POST /api/upload
 * Body: multipart/form-data { video: File, rep_id, rooftop_id }
 * Returns: { playback_id, short_code, asset_id }
 */
router.post('/', upload.single('video'), async (req, res) => {
  try {
    const { rep_id, rooftop_id } = req.body;
    const file = req.file;

    if (!file) return res.status(400).json({ error: 'No video file provided' });
    if (!rep_id) return res.status(400).json({ error: 'rep_id required' });
    if (!rooftop_id) return res.status(400).json({ error: 'rooftop_id required' });

    console.log(`[upload] Starting upload for rep ${rep_id}, ${file.size} bytes`);

    // 1. Create Mux direct upload
    const uploadResponse = await video.uploads.create({
      new_asset_settings: {
        playback_policy: ['public'],
        mp4_support: 'standard',
      },
      cors_origin: '*',
    });

    // 2. Upload video to Mux
    await fetch(uploadResponse.url, {
      method: 'PUT',
      body: file.buffer,
      headers: { 'Content-Type': file.mimetype || 'video/mp4' },
    });

    // 3. Poll for asset ready (max 60s)
    let asset;
    for (let i = 0; i < 24; i++) {
      await new Promise(r => setTimeout(r, 2500));
      const upload = await video.uploads.retrieve(uploadResponse.id);
      if (upload.asset_id) {
        asset = await video.assets.retrieve(upload.asset_id);
        if (asset.status === 'ready') break;
      }
    }

    if (!asset || asset.status !== 'ready') {
      return res.status(500).json({ error: 'Mux asset not ready in time. Check Mux dashboard.' });
    }

    const playback_id = asset.playback_ids?.[0]?.id;
    const short_code = nanoid(8).toUpperCase();

    // 4. Insert video record into Supabase
    const { error: dbErr } = await supabase.from('videos').insert({
      rep_id,
      rooftop_id,
      mux_asset_id: asset.id,
      mux_playback_id: playback_id,
      short_code,
    });

    if (dbErr) throw new Error(`Supabase insert failed: ${dbErr.message}`);

    console.log(`[upload] Done — playback_id: ${playback_id}, short_code: ${short_code}`);

    res.json({ playback_id, short_code, asset_id: asset.id });

  } catch (err) {
    console.error('[upload] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

export default router;
