/**
 * AI Video Avatar System for AutoFilm
 *
 * Integrates with HeyGen API to:
 *   1. Create a personalized avatar from rep's training video + voice
 *   2. Generate on-demand personalized videos (no recording needed)
 *   3. Auto-send welcome videos to new leads within 60 seconds
 *
 * HeyGen API docs: https://docs.heygen.com
 *
 * Env: HEYGEN_API_KEY
 */

import { supabase } from './supabase.js';

const HEYGEN_API = 'https://api.heygen.com';

/**
 * Create a personalized avatar for a rep.
 * Rep uploads a 2-minute training video; HeyGen creates a digital twin.
 *
 * @param {string} repId - Rep UUID
 * @param {string} trainingVideoUrl - URL to the rep's training video
 * @param {string} repName - Rep's display name
 * @returns {object} - { avatar_id, status }
 */
export async function createAvatar(repId, trainingVideoUrl, repName) {
  if (!process.env.HEYGEN_API_KEY) {
    throw new Error('HEYGEN_API_KEY not configured');
  }

  // 1. Create talking photo avatar from video
  const res = await fetch(`${HEYGEN_API}/v2/avatars`, {
    method: 'POST',
    headers: {
      'X-Api-Key': process.env.HEYGEN_API_KEY,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      name: `AutoFilm - ${repName}`,
      training_video_url: trainingVideoUrl,
      avatar_type: 'talking_photo',
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`HeyGen avatar creation failed: ${err}`);
  }

  const data = await res.json();
  const avatarId = data.data?.avatar_id;

  // Store avatar ID on the rep record
  await supabase
    .from('reps')
    .update({ avatar_id: avatarId })
    .eq('id', repId);

  console.log(`[avatar] Created avatar ${avatarId} for rep ${repId}`);

  return { avatar_id: avatarId, status: data.data?.status || 'processing' };
}

/**
 * Generate a personalized video using the rep's AI avatar.
 *
 * @param {object} opts
 * @param {string} opts.avatarId    - HeyGen avatar ID
 * @param {string} opts.script      - What the avatar should say
 * @param {string} opts.repName     - For logging
 * @param {string} opts.background  - Background URL or color (optional)
 * @returns {object} - { video_id, status, estimated_duration }
 */
export async function generateAvatarVideo(opts) {
  const { avatarId, script, repName, background } = opts;

  if (!process.env.HEYGEN_API_KEY) {
    throw new Error('HEYGEN_API_KEY not configured');
  }

  const payload = {
    video_inputs: [{
      character: {
        type: 'avatar',
        avatar_id: avatarId,
        avatar_style: 'normal',
      },
      voice: {
        type: 'text',
        input_text: script,
        voice_id: null, // Uses the avatar's cloned voice
      },
      background: background
        ? { type: 'image', value: background }
        : { type: 'color', value: '#111116' },
    }],
    dimension: { width: 1280, height: 720 },
    aspect_ratio: '16:9',
  };

  const res = await fetch(`${HEYGEN_API}/v2/video/generate`, {
    method: 'POST',
    headers: {
      'X-Api-Key': process.env.HEYGEN_API_KEY,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`HeyGen video generation failed: ${err}`);
  }

  const data = await res.json();
  console.log(`[avatar] Video generation started for ${repName}: ${data.data?.video_id}`);

  return {
    video_id: data.data?.video_id,
    status: data.data?.status || 'processing',
  };
}

/**
 * Check the status of a HeyGen video generation job.
 *
 * @param {string} videoId - HeyGen video ID
 * @returns {object} - { status, video_url, duration, thumbnail_url }
 */
export async function checkVideoStatus(videoId) {
  if (!process.env.HEYGEN_API_KEY) {
    throw new Error('HEYGEN_API_KEY not configured');
  }

  const res = await fetch(`${HEYGEN_API}/v1/video_status.get?video_id=${videoId}`, {
    headers: { 'X-Api-Key': process.env.HEYGEN_API_KEY },
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`HeyGen status check failed: ${err}`);
  }

  const data = await res.json();
  return {
    status: data.data?.status,
    video_url: data.data?.video_url,
    duration: data.data?.duration,
    thumbnail_url: data.data?.thumbnail_url,
  };
}

/**
 * Generate a personalized script for an avatar video.
 * Uses Claude to craft natural, automotive-specific messaging.
 *
 * @param {object} opts
 * @param {string} opts.customerName
 * @param {string} opts.repName
 * @param {string} opts.dealerName
 * @param {string} opts.vehicle - (optional)
 * @param {string} opts.scenario - 'welcome' | 'follow_up' | 'inventory' | 'service_reminder'
 * @returns {string} Script text
 */
export async function generateAvatarScript(opts) {
  const { customerName, repName, dealerName, vehicle, scenario = 'welcome' } = opts;

  if (!process.env.ANTHROPIC_API_KEY) {
    return getTemplateAvatarScript(opts);
  }

  const scenarios = {
    welcome: `Write a 15-second warm welcome video script from ${repName} at ${dealerName} to a new lead named ${customerName}.${vehicle ? ` They're interested in the ${vehicle}.` : ''} Be friendly, personal, mention you're here to help, and invite them to call or text.`,
    follow_up: `Write a 10-second follow-up video script from ${repName} at ${dealerName} to ${customerName} who hasn't responded.${vehicle ? ` They were looking at the ${vehicle}.` : ''} Be casual, not pushy, mention you sent a video earlier.`,
    inventory: `Write a 20-second video script from ${repName} at ${dealerName} showcasing the ${vehicle || 'new arrivals'}. Highlight 2-3 features and invite ${customerName} to schedule a test drive.`,
    service_reminder: `Write a 10-second friendly reminder script from ${repName} at ${dealerName} to ${customerName} about their upcoming service appointment.${vehicle ? ` Their ${vehicle} is due.` : ''}`,
  };

  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 200,
        messages: [{ role: 'user', content: `${scenarios[scenario] || scenarios.welcome}\n\nRequirements:\n- Natural, conversational tone\n- First person (the rep is speaking)\n- No hashtags or emojis\n- Return ONLY the spoken script, no stage directions` }],
      }),
    });

    const data = await res.json();
    return data.content?.[0]?.text || getTemplateAvatarScript(opts);
  } catch (err) {
    console.error('[avatar] Script gen error:', err.message);
    return getTemplateAvatarScript(opts);
  }
}

function getTemplateAvatarScript(opts) {
  const { customerName, repName, dealerName, vehicle, scenario } = opts;
  const first = (customerName || 'there').split(' ')[0];

  const templates = {
    welcome: `Hey ${first}, this is ${repName} from ${dealerName}. ${vehicle ? `I saw you were checking out the ${vehicle} — great choice. ` : ''}I'd love to help you out personally. Give me a call or shoot me a text anytime. Looking forward to connecting with you.`,
    follow_up: `Hey ${first}, it's ${repName} from ${dealerName} again. Just wanted to check in and see if you had any questions${vehicle ? ` about the ${vehicle}` : ''}. I'm here whenever you're ready. No pressure at all.`,
    inventory: `${first}, check this out — the ${vehicle || 'latest arrivals'} just hit our lot at ${dealerName}. This one's got everything you want. Come take it for a spin — I think you'll love it.`,
    service_reminder: `Hey ${first}, this is ${repName} at ${dealerName}. Just a friendly reminder you've got a service appointment coming up${vehicle ? ` for your ${vehicle}` : ''}. We'll take great care of it. See you soon.`,
  };

  return templates[scenario] || templates.welcome;
}
