import express from 'express';
import multer from 'multer';
import { nanoid } from 'nanoid';
import { video } from '../lib/mux.js';
import { supabase } from '../lib/supabase.js';
import { kvPut } from '../lib/cloudflare.js';
import { storeThumbnails } from '../lib/thumbnail.js';

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 500 * 1024 * 1024 } }); // 500MB

const CF_WORKER_URL = process.env.CF_WORKER_URL || 'https://links.autofilm.io';

/**
 * POST /api/upload
 * Body: multipart/form-data { video: File, rep_id, rooftop_id }
 * Returns: { playback_id, short_code, short_url, asset_id }
 */
router.post('/', upload.single('video'), async (req, res) => {
  try {
    const { rep_id, rooftop_id } = req.body;
    const file = req.file;

    if (!file) return res.status(400).json({ error: 'No video file provided' });
    if (!rep_id) return res.status(400).json({ error: 'rep_id required' });
    if (!rooftop_id) return res.status(400).json({ error: 'rooftop_id required' });

    // 0. Validate the rep exists and belongs to this rooftop
    const { data: rep, error: repErr } = await supabase
      .from('reps')
      .select('id, rooftop_id, active')
      .eq('id', rep_id)
      .single();

    if (repErr || !rep) return res.status(404).json({ error: 'Rep not found: ' + rep_id });
    if (rep.rooftop_id !== rooftop_id) return res.status(403).json({ error: 'Rep does not belong to this rooftop' });
    if (rep.active === false) return res.status(403).json({ error: 'Rep account is deactivated' });

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
    const putRes = await fetch(uploadResponse.url, {
      method: 'PUT',
      body: file.buffer,
      headers: { 'Content-Type': file.mimetype || 'video/mp4' },
    });
    if (!putRes.ok) throw new Error(`Mux PUT failed: ${putRes.status}`);

    // 3. Poll for asset ready (max 60s). The Mux webhook (/api/webhooks/mux)
    //    finalizes thumbnails if the asset lands after we time out.
    let asset;
    for (let i = 0; i < 24; i++) {
      await new Promise(r => setTimeout(r, 2500));
      const u = await video.uploads.retrieve(uploadResponse.id);
      if (u.asset_id) {
        asset = await video.assets.retrieve(u.asset_id);
        if (asset.status === 'ready') break;
      }
    }

    const short_code = nanoid(8).toUpperCase();
    const playback_id = asset?.playback_ids?.[0]?.id || null;
    const ready = asset?.status === 'ready';

    // 4. Insert video record — even if the asset isn't ready yet the webhook
    //    will fill in mux_playback_id when Mux fires video.asset.ready.
    const { data: videoRow, error: dbErr } = await supabase.from('videos').insert({
      rep_id,
      rooftop_id,
      mux_asset_id: asset?.id || null,
      mux_upload_id: uploadResponse.id,
      mux_playback_id: playback_id,
      short_code,
    }).select('id').single();

    if (dbErr) throw new Error(`Supabase insert failed: ${dbErr.message}`);

    // 5. Register the short link + thumbnails right away when ready
    const short_url = `${CF_WORKER_URL}/v/${short_code}`;
    if (ready && playback_id) {
      kvPut(`v_${short_code}`, `https://autofilm.io/autofilm-player.html?code=${short_code}&playback_id=${playback_id}`)
        .catch(e => console.warn('[upload] KV write failed:', e.message));
      storeThumbnails(supabase, videoRow.id, playback_id)
        .catch(e => console.warn('[upload] Thumbnail store failed:', e.message));
    }

    console.log(`[upload] Done — playback_id: ${playback_id}, short_code: ${short_code}, ready: ${ready}`);

    res.json({ playback_id, short_code, short_url, asset_id: asset?.id || null, processing: !ready });

  } catch (err) {
    console.error('[upload] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

export default router;
