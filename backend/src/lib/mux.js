import Mux from '@mux/mux-node';

if (!process.env.MUX_TOKEN_ID || !process.env.MUX_TOKEN_SECRET) {
  throw new Error('Missing MUX_TOKEN_ID or MUX_TOKEN_SECRET');
}

export const mux = new Mux({
  tokenId: process.env.MUX_TOKEN_ID,
  tokenSecret: process.env.MUX_TOKEN_SECRET,
});

export const { video } = mux;

/**
 * Default `new_asset_settings` for every Mux asset AutoFilm creates.
 * `inputs[].generated_subtitles` turns on Mux auto-generated English
 * captions for the uploaded video (REST field:
 * new_asset_settings.inputs[].generated_subtitles) — the tracks then
 * appear automatically in the HLS manifest for the player.
 * Pass `overrides` for per-route tweaks (spread last, so they win).
 */
export function defaultUploadSettings(overrides = {}) {
  return {
    playback_policy: ['public'],
    mp4_support: 'standard',
    inputs: [
      {
        generated_subtitles: [
          { name: 'English CC', language_code: 'en' },
        ],
      },
    ],
    ...overrides,
  };
}
