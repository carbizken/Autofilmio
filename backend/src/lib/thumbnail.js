/**
 * Animated thumbnail generation from Mux.
 * Mux provides animated GIF and static thumbnail URLs from any playback ID.
 * We use these for email previews, SMS rich cards, and dashboard thumbnails.
 */

const MUX_IMAGE_BASE = 'https://image.mux.com';

/**
 * Generate all thumbnail variants for a Mux playback ID.
 * @param {string} playbackId - Mux playback ID
 * @returns {object} - { animated, static, poster, storyboard }
 */
export function getThumbnails(playbackId) {
  if (!playbackId) return null;

  return {
    // Animated GIF — 3-second loop, perfect for email previews
    animated: `${MUX_IMAGE_BASE}/${playbackId}/animated.gif?width=560&fps=15&start=1&end=4`,

    // Small animated GIF — for SMS rich previews & dashboard cards
    animatedSmall: `${MUX_IMAGE_BASE}/${playbackId}/animated.gif?width=320&fps=10&start=1&end=3`,

    // Static thumbnail — first-frame poster
    static: `${MUX_IMAGE_BASE}/${playbackId}/thumbnail.jpg?width=560&height=315&fit_mode=smartcrop`,

    // Poster — larger, for player page og:image
    poster: `${MUX_IMAGE_BASE}/${playbackId}/thumbnail.jpg?width=1200&height=630&fit_mode=smartcrop`,

    // Storyboard — filmstrip for seek preview
    storyboard: `${MUX_IMAGE_BASE}/${playbackId}/storyboard.vtt`,
  };
}

/**
 * Store thumbnail URLs on the video record in Supabase.
 * @param {import('@supabase/supabase-js').SupabaseClient} supabase
 * @param {string} videoId - video UUID
 * @param {string} playbackId - Mux playback ID
 */
export async function storeThumbnails(supabase, videoId, playbackId) {
  const thumbs = getThumbnails(playbackId);
  if (!thumbs) return;

  const { error } = await supabase
    .from('videos')
    .update({
      thumbnail_url: thumbs.static,
      thumbnail_gif: thumbs.animated,
    })
    .eq('id', videoId);

  if (error) {
    console.error('[thumbnail] Failed to store thumbnails:', error.message);
  } else {
    console.log(`[thumbnail] Stored for video ${videoId}`);
  }

  return thumbs;
}
