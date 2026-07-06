import express from 'express';
import { supabase } from '../lib/supabase.js';
import { requireAuth, requireRole } from '../lib/auth.js';

const router = express.Router();

/**
 * POST /api/distribute
 * Distribute a video to YouTube, Facebook, or dealer VDP.
 *
 * Body: {
 *   video_id: string,
 *   platforms: ['youtube', 'facebook', 'instagram', 'vdp'],
 *   title?: string,
 *   description?: string,
 *   tags?: string[]
 * }
 */
router.post('/', requireAuth(), async (req, res) => {
  try {
    const { video_id, platforms = [], title, description, tags } = req.body;
    if (!video_id) return res.status(400).json({ error: 'video_id required' });
    if (!platforms.length) return res.status(400).json({ error: 'At least one platform required' });

    // Get video info
    const { data: video, error } = await supabase
      .from('videos')
      .select('*, reps(name, rooftops(name))')
      .eq('id', video_id)
      .single();

    if (error || !video) return res.status(404).json({ error: 'Video not found' });

    // Tenant isolation: a rep may only distribute videos from their rooftop
    if (video.rooftop_id !== req.rep.rooftop_id) {
      return res.status(404).json({ error: 'Video not found' });
    }

    const jobs = [];

    for (const platform of platforms) {
      // Create distribution job
      const { data: job, error: jobErr } = await supabase
        .from('distribution_jobs')
        .insert({
          video_id,
          rooftop_id: video.rooftop_id,
          platform,
          status: 'pending',
        })
        .select()
        .single();

      if (jobErr) throw jobErr;
      jobs.push(job);

      // Process in background
      processDistribution(job.id, video, platform, { title, description, tags })
        .catch(err => console.error(`[distribute] ${platform} error:`, err.message));
    }

    res.json({ success: true, jobs: jobs.map(j => ({ id: j.id, platform: j.platform, status: j.status })) });

  } catch (err) {
    console.error('[distribute] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/distribute/status?video_id=<uuid>
 * Check distribution status for a video.
 */
router.get('/status', requireAuth(), async (req, res) => {
  try {
    const { video_id } = req.query;
    if (!video_id) return res.status(400).json({ error: 'video_id required' });

    const { data, error } = await supabase
      .from('distribution_jobs')
      .select('*')
      .eq('video_id', video_id)
      .eq('rooftop_id', req.rep.rooftop_id)
      .order('created_at', { ascending: false });

    if (error) throw error;
    res.json({ distributions: data || [] });

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * Process a single distribution job.
 */
async function processDistribution(jobId, video, platform, meta) {
  const videoUrl = video.mux_playback_id
    ? `https://stream.mux.com/${video.mux_playback_id}.m3u8`
    : null;

  if (!videoUrl) {
    await updateJob(jobId, 'failed', null, null, 'No video URL available');
    return;
  }

  const vehicleName = video.vehicle || 'Vehicle Video';
  const dealerName = video.reps?.rooftops?.name || '';
  const defaultTitle = meta.title || `${vehicleName} | ${dealerName}`;
  const defaultDesc = meta.description || `Check out the ${vehicleName} at ${dealerName}. Personal video from ${video.reps?.name || 'our team'}.`;

  await updateJob(jobId, 'uploading');

  try {
    switch (platform) {
      case 'youtube':
        await distributeYouTube(jobId, videoUrl, defaultTitle, defaultDesc, meta.tags);
        break;
      case 'facebook':
        await distributeFacebook(jobId, videoUrl, defaultTitle, defaultDesc);
        break;
      case 'instagram':
        await distributeInstagram(jobId, videoUrl, defaultDesc);
        break;
      case 'vdp':
        await distributeVDP(jobId, video);
        break;
      default:
        await updateJob(jobId, 'failed', null, null, `Unknown platform: ${platform}`);
    }
  } catch (err) {
    await updateJob(jobId, 'failed', null, null, err.message);
  }
}

async function distributeYouTube(jobId, videoUrl, title, description, tags) {
  if (!process.env.YOUTUBE_API_KEY) {
    await updateJob(jobId, 'failed', null, null, 'YOUTUBE_API_KEY not configured');
    return;
  }

  // YouTube Data API v3 upload
  // In production: use OAuth2 token from the dealer's YouTube channel
  const res = await fetch('https://www.googleapis.com/upload/youtube/v3/videos?part=snippet,status&uploadType=resumable', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${process.env.YOUTUBE_OAUTH_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      snippet: {
        title,
        description,
        tags: tags || ['automotive', 'dealership', 'autofilm'],
        categoryId: '2', // Autos & Vehicles
      },
      status: {
        privacyStatus: 'public',
        selfDeclaredMadeForKids: false,
      },
    }),
    signal: AbortSignal.timeout(30000),
  });

  if (res.ok) {
    const data = await res.json();
    await updateJob(jobId, 'published', data.id, `https://youtube.com/watch?v=${data.id}`);
    console.log(`[distribute] YouTube published: ${data.id}`);
  } else {
    const err = await res.text();
    await updateJob(jobId, 'failed', null, null, `YouTube upload failed: ${err}`);
  }
}

async function distributeFacebook(jobId, videoUrl, title, description) {
  if (!process.env.FACEBOOK_PAGE_TOKEN) {
    await updateJob(jobId, 'failed', null, null, 'FACEBOOK_PAGE_TOKEN not configured');
    return;
  }

  const pageId = process.env.FACEBOOK_PAGE_ID;
  const res = await fetch(`https://graph.facebook.com/v19.0/${pageId}/videos`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${process.env.FACEBOOK_PAGE_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      file_url: videoUrl,
      title,
      description,
    }),
    signal: AbortSignal.timeout(30000),
  });

  if (res.ok) {
    const data = await res.json();
    await updateJob(jobId, 'published', data.id, `https://facebook.com/${pageId}/videos/${data.id}`);
    console.log(`[distribute] Facebook published: ${data.id}`);
  } else {
    const err = await res.text();
    await updateJob(jobId, 'failed', null, null, `Facebook upload failed: ${err}`);
  }
}

async function distributeInstagram(jobId, videoUrl, description) {
  // Instagram Reels via Graph API
  await updateJob(jobId, 'failed', null, null, 'Instagram distribution coming soon');
}

async function distributeVDP(jobId, video) {
  // Inject video into dealer's Vehicle Detail Page
  // This depends on the dealer's website platform (DealerInspire, Dealer.com, etc.)
  await updateJob(jobId, 'published', video.short_code,
    `https://autofilm.io/autofilm-player.html?code=${video.short_code}`);
  console.log(`[distribute] VDP embed ready: ${video.short_code}`);
}

async function updateJob(jobId, status, platformVideoId, platformUrl, errorMessage) {
  const update = { status };
  if (platformVideoId) update.platform_video_id = platformVideoId;
  if (platformUrl) update.platform_url = platformUrl;
  if (errorMessage) update.error_message = errorMessage;

  await supabase.from('distribution_jobs').update(update).eq('id', jobId);
}

export default router;
