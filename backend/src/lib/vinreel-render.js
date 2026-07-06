/**
 * VIN Reel Server-Side Video Renderer
 *
 * Generates a 15-30 second vehicle showcase video from:
 *   - Inventory photos (Ken Burns pan/zoom effect)
 *   - AI-generated voiceover script (Claude)
 *   - Text-to-speech audio (Google Cloud TTS or ElevenLabs)
 *   - Background music track
 *
 * Pipeline:
 *   1. Fetch vehicle photos from inventory or external source
 *   2. Generate AI script via Claude
 *   3. Generate TTS audio from script
 *   4. Compose video: photos with Ken Burns + text overlays + audio
 *   5. Upload to Mux for streaming
 *   6. Store in Supabase as type='vin_reel'
 *
 * Dependencies: ffmpeg (system), node-fetch
 * For production: run in a background worker queue (Bull/BullMQ)
 */

import { execSync, exec } from 'child_process';
import { writeFile, unlink, mkdir } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';
import { defaultUploadSettings } from './mux.js';

const TMP = join(tmpdir(), 'autofilm-reels');

/**
 * Detected once at module load. Render's native Node runtime usually
 * ships ffmpeg, but never assume — routes check this flag and return
 * 503 instead of failing mid-job when it's missing.
 */
export const ffmpegAvailable = (() => {
  try {
    execSync('ffmpeg -version', { stdio: 'ignore' });
    return true;
  } catch {
    console.warn('[vinreel-render] ffmpeg not found on this host — VIN Reel rendering disabled');
    return false;
  }
})();

/**
 * Render a VIN Reel video from photos and script.
 *
 * @param {object} opts
 * @param {string[]} opts.photos       - Array of photo URLs (at least 3)
 * @param {string}   opts.script       - Voiceover script text
 * @param {string}   opts.vehicleName  - e.g. "2025 Honda Accord Sport"
 * @param {string}   opts.dealerName   - Dealership name
 * @param {string}   opts.price        - e.g. "$32,490"
 * @param {string}   opts.brandColor   - Hex color for text overlays
 * @param {string}   opts.style        - 'cinematic' | 'quick' | 'detailed'
 * @returns {string} Path to rendered MP4 file
 */
export async function renderVinReel(opts) {
  const {
    photos = [],
    script = '',
    vehicleName = 'Vehicle',
    dealerName = '',
    price = '',
    brandColor = '#D94F00',
    style = 'cinematic',
  } = opts;

  if (!ffmpegAvailable) {
    throw new Error('ffmpeg is not available on this deployment');
  }

  const jobId = randomUUID().slice(0, 8);
  const workDir = join(TMP, jobId);

  if (!existsSync(TMP)) await mkdir(TMP, { recursive: true });
  await mkdir(workDir, { recursive: true });

  const duration = style === 'quick' ? 15 : style === 'detailed' ? 45 : 30;
  const photoDuration = Math.max(3, Math.floor(duration / Math.max(photos.length, 1)));

  try {
    // 1. Download photos
    console.log(`[vinreel-render] ${jobId}: Downloading ${photos.length} photos...`);
    const localPhotos = [];
    for (let i = 0; i < photos.length; i++) {
      const ext = photos[i].match(/\.(jpg|jpeg|png|webp)/i)?.[1] || 'jpg';
      const filename = `photo_${String(i).padStart(2, '0')}.${ext}`;
      const filepath = join(workDir, filename);

      try {
        const res = await fetch(photos[i], { signal: AbortSignal.timeout(15000) });
        if (res.ok) {
          const buf = Buffer.from(await res.arrayBuffer());
          await writeFile(filepath, buf);
          localPhotos.push(filepath);
        }
      } catch (e) {
        console.warn(`[vinreel-render] ${jobId}: Failed to download photo ${i}: ${e.message}`);
      }
    }

    if (localPhotos.length === 0) {
      throw new Error('No photos could be downloaded');
    }

    // 2. Generate TTS audio
    console.log(`[vinreel-render] ${jobId}: Generating TTS audio...`);
    const audioPath = join(workDir, 'voiceover.mp3');
    await generateTTS(script, audioPath);

    // 3. Generate background music placeholder
    // In production: use a licensed music library or generate ambient with AI
    const musicPath = join(workDir, 'music.mp3');
    await generateSilentAudio(musicPath, duration);

    // 4. Build FFmpeg filter complex for Ken Burns effect
    console.log(`[vinreel-render] ${jobId}: Composing video with FFmpeg...`);
    const outputPath = join(workDir, 'reel.mp4');
    await composeVideo({
      photos: localPhotos,
      audioPath,
      musicPath,
      outputPath,
      photoDuration,
      vehicleName,
      dealerName,
      price,
      brandColor,
      totalDuration: duration,
    });

    console.log(`[vinreel-render] ${jobId}: Render complete → ${outputPath}`);
    return outputPath;

  } catch (err) {
    console.error(`[vinreel-render] ${jobId}: Error — ${err.message}`);
    // Don't leave orphan temp dirs behind on failure
    await cleanupRender(workDir);
    throw err;
  }
}

/**
 * Generate TTS audio from script text.
 * Uses ElevenLabs API if available, otherwise Google Cloud TTS.
 * Falls back to silent audio if neither is configured.
 */
async function generateTTS(text, outputPath) {
  // ElevenLabs (preferred — more natural voice)
  if (process.env.ELEVENLABS_API_KEY) {
    try {
      const voiceId = process.env.ELEVENLABS_VOICE_ID || '21m00Tcm4TlvDq8ikWAM'; // Rachel
      const res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`, {
        method: 'POST',
        headers: {
          'xi-api-key': process.env.ELEVENLABS_API_KEY,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          text,
          model_id: 'eleven_turbo_v2_5',
          voice_settings: {
            stability: 0.6,
            similarity_boost: 0.8,
            style: 0.3,
          },
        }),
        signal: AbortSignal.timeout(30000),
      });

      if (res.ok) {
        const buf = Buffer.from(await res.arrayBuffer());
        await writeFile(outputPath, buf);
        console.log('[vinreel-render] TTS: ElevenLabs');
        return;
      }
    } catch (e) {
      console.warn('[vinreel-render] ElevenLabs TTS failed:', e.message);
    }
  }

  // Google Cloud TTS
  if (process.env.GOOGLE_TTS_API_KEY) {
    try {
      const res = await fetch(`https://texttospeech.googleapis.com/v1/text:synthesize?key=${process.env.GOOGLE_TTS_API_KEY}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          input: { text },
          voice: { languageCode: 'en-US', name: 'en-US-Neural2-J', ssmlGender: 'MALE' },
          audioConfig: { audioEncoding: 'MP3', speakingRate: 1.0, pitch: 0 },
        }),
        signal: AbortSignal.timeout(30000),
      });

      if (res.ok) {
        const data = await res.json();
        const buf = Buffer.from(data.audioContent, 'base64');
        await writeFile(outputPath, buf);
        console.log('[vinreel-render] TTS: Google Cloud');
        return;
      }
    } catch (e) {
      console.warn('[vinreel-render] Google TTS failed:', e.message);
    }
  }

  // Fallback: silent audio (video will have no voiceover)
  console.log('[vinreel-render] TTS: None available, using silent audio');
  await generateSilentAudio(outputPath, 30);
}

/**
 * Generate a silent audio file of given duration.
 */
async function generateSilentAudio(outputPath, durationSecs) {
  try {
    execSync(`ffmpeg -y -f lavfi -i anullsrc=r=44100:cl=stereo -t ${durationSecs} -q:a 9 "${outputPath}" 2>/dev/null`);
  } catch {
    // If ffmpeg isn't available, create an empty file
    await writeFile(outputPath, Buffer.alloc(0));
  }
}

/**
 * Compose the final video with FFmpeg.
 *
 * Creates a slideshow with Ken Burns (pan/zoom) effect on each photo,
 * overlays vehicle name text, mixes voiceover + background music.
 */
async function composeVideo(opts) {
  const {
    photos, audioPath, musicPath, outputPath,
    photoDuration, vehicleName, dealerName, price,
    brandColor, totalDuration,
  } = opts;

  // Build FFmpeg input list and filter complex
  const inputs = photos.map(p => `-loop 1 -t ${photoDuration} -i "${p}"`).join(' ');
  const audioInput = `-i "${audioPath}"`;

  // Ken Burns filter for each photo: slow zoom in + slight pan
  const filters = [];
  const concatInputs = [];

  photos.forEach((_, i) => {
    // Alternate between zoom-in and zoom-out with pan
    const isEven = i % 2 === 0;
    const zoom = isEven
      ? `zoompan=z='min(zoom+0.0008,1.25)':d=${photoDuration * 25}:s=1280x720:fps=25`
      : `zoompan=z='if(eq(on,1),1.25,max(zoom-0.0008,1))':d=${photoDuration * 25}:s=1280x720:fps=25`;

    filters.push(`[${i}:v]scale=1280:720:force_original_aspect_ratio=increase,crop=1280:720,${zoom},setsar=1[v${i}]`);
    concatInputs.push(`[v${i}]`);
  });

  // Concat all video streams
  const concatFilter = `${concatInputs.join('')}concat=n=${photos.length}:v=1:a=0[slideshow]`;
  filters.push(concatFilter);

  // Add text overlay: vehicle name at bottom
  const escapedName = vehicleName.replace(/'/g, "\\'").replace(/:/g, "\\:");
  const escapedDealer = dealerName.replace(/'/g, "\\'").replace(/:/g, "\\:");
  const textFilter = `[slideshow]drawtext=text='${escapedName}':fontcolor=white:fontsize=28:x=(w-text_w)/2:y=h-80:box=1:boxcolor=black@0.5:boxborderw=8,drawtext=text='${escapedDealer}':fontcolor=white@0.7:fontsize=16:x=(w-text_w)/2:y=h-45:box=1:boxcolor=black@0.3:boxborderw=6[final]`;
  filters.push(textFilter);

  const filterComplex = filters.join(';');
  const audioIdx = photos.length;

  const cmd = `ffmpeg -y ${inputs} ${audioInput} -filter_complex "${filterComplex}" -map "[final]" -map ${audioIdx}:a -c:v libx264 -preset fast -crf 23 -c:a aac -b:a 128k -shortest -movflags +faststart "${outputPath}" 2>/dev/null`;

  return new Promise((resolve, reject) => {
    exec(cmd, { timeout: 120000 }, (err, stdout, stderr) => {
      if (err) {
        // Fallback: simple concat without Ken Burns if filter fails
        console.warn('[vinreel-render] Complex render failed, trying simple concat...');
        const simpleCmd = `ffmpeg -y ${inputs} -filter_complex "${concatInputs.join('')}concat=n=${photos.length}:v=1:a=0[v]" -map "[v]" -c:v libx264 -preset fast -crf 23 -movflags +faststart "${outputPath}" 2>/dev/null`;
        exec(simpleCmd, { timeout: 60000 }, (err2) => {
          if (err2) reject(new Error('FFmpeg render failed'));
          else resolve();
        });
      } else {
        resolve();
      }
    });
  });
}

/**
 * Upload a rendered video file to Mux.
 *
 * @param {import('@mux/mux-node').Video} muxVideo - Mux video API
 * @param {string} filePath - Path to the rendered MP4
 * @returns {object} - { assetId, playbackId }
 */
export async function uploadToMux(muxVideo, filePath) {
  // Create a direct upload
  const upload = await muxVideo.uploads.create({
    cors_origin: '*',
    new_asset_settings: defaultUploadSettings({ encoding_tier: 'smart' }),
  });

  // Read file and upload
  const { readFile } = await import('fs/promises');
  const fileBuffer = await readFile(filePath);

  const res = await fetch(upload.url, {
    method: 'PUT',
    headers: { 'Content-Type': 'video/mp4' },
    body: fileBuffer,
    signal: AbortSignal.timeout(120000),
  });

  if (!res.ok) {
    throw new Error(`Mux upload failed: ${res.status}`);
  }

  console.log(`[vinreel-render] Uploaded to Mux — upload ID: ${upload.id}`);

  return {
    uploadId: upload.id,
    assetId: upload.asset_id || null,
  };
}

/**
 * Clean up temporary files for a render job.
 */
export async function cleanupRender(workDir) {
  try {
    const { rm } = await import('fs/promises');
    await rm(workDir, { recursive: true, force: true });
  } catch {
    // Best effort cleanup
  }
}
