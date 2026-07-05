import express from 'express';
import multer from 'multer';
import { shortCode } from '../lib/shortcode.js';
import { requireAuth } from '../lib/auth.js';
import { video } from '../lib/mux.js';
import { supabase } from '../lib/supabase.js';
import { kvPut } from '../lib/cloudflare.js';
import { storeThumbnails } from '../lib/thumbnail.js';

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 150 * 1024 * 1024 } }); // 150MB — legacy path only; use /create-url

const CF_WORKER_URL = process.env.CF_WORKER_URL || 'https://links.autofilm.io';

/**
 * POST /api/upload/create-url  — PREFERRED PATH
 * Returns a Mux direct-upload URL; the browser PUTs the file straight to
 * Mux (no server buffering), and the Mux webhook finalizes the video row.
 * Returns: { upload_id, upload_url, short_code, short_url, video_id }
 */
router.post('/create-url', requireAuth(), async (req, res) => {
  try {
    const rep_id = req.rep.id;
    const rooftop_id = req.rep.rooftop_id;

    const muxUpload = await video.uploads.create({
      cors_origin: '*',
      new_asset_settings: {
        playback_policy: ['public'],
        mp4_support: 'standard',
      },
    });

    const short_code = shortCode();
    const { data: videoRow, error: dbErr } = await supabase.from('videos').insert({
      rep_id,
      rooftop_id,
      mux_upload_id: muxUpload.id,
      short_code,
    }).select('id').single();
    if (dbErr) throw new Error(`Supabase insert failed: ${dbErr.message}`);

    console.log(`[upload] Direct-upload URL issued — ${short_code}`);
    res.json({
      upload_id: muxUpload.id,
      upload_url: muxUpload.url,
      short_code,
      short_url: `${CF_WORKER_URL}/v/${short_code}`,
      video_id: videoRow.id,
    });
  } catch (err) {
    console.error('[upload] create-url error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/upload/status/:short_code
 * Poll after a direct upload: ready once the Mux webhook has landed.
 */
router.get('/status/:short_code', requireAuth(), async (req, res) => {
  const { data } = await supabase
    .from('videos')
    .select('id, mux_playback_id, thumbnail_url')
    .eq('short_code', req.params.short_code)
    .eq('rooftop_id', req.rep.rooftop_id)
    .maybeSingle();
  if (!data) return res.status(404).json({ error: 'Not found' });
  res.json({ ready: !!data.mux_playback_id, playback_id: data.mux_playback_id, video_id: data.id });
});

/**
 * POST /api/upload — LEGACY multipart path (kept for compatibility)
 * Body: multipart/form-data { video: File, rep_id, rooftop_id }
 * Returns: { playback_id, short_code, short_url, asset_id }
 */
router.post('/', requireAuth(), upload.single('video'), async (req, res) => {
  try {
    const rep_id = req.rep.id;
    const rooftop_id = req.rep.rooftop_id;
    const file = req.file;

    if (!file) return res.status(400).json({ error: 'No video file provided' });

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

    const short_code = shortCode();
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
