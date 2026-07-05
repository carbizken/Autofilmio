-- ============================================================
-- Migration 006: VIN Reel server-render job tracking
--
-- VIN Reels render asynchronously (ffmpeg on the API instance).
-- POST /api/vin-reels/render returns 202 immediately; the row
-- tracks the background job so GET /status/:reel_id can report:
--   render_status: 'rendering' | 'ready' | 'failed'
--                  (null = not a server-rendered video)
--   render_error:  failure message when render_status = 'failed'
-- ============================================================

alter table videos add column if not exists render_status text;
alter table videos add column if not exists render_error  text;

-- Only server-rendered reels carry a status — keep the index partial.
create index if not exists videos_render_status_idx
  on videos (render_status)
  where render_status is not null;
