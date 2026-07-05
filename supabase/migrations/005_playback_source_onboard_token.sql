-- ============================================================
-- Migration 005: playback source for non-Mux videos, onboarding
-- capability token, reply upload tracking, job-claim columns
-- ============================================================

-- ── VIDEOS: NON-MUX PLAYBACK (HeyGen avatar output) ────────
alter table videos add column if not exists playback_source    text not null default 'mux';
  -- 'mux' | 'heygen'
alter table videos add column if not exists external_video_url text;

-- ── VIDEO REPLIES: MUX WEBHOOK CORRELATION ──────────────────
alter table video_replies add column if not exists mux_upload_id text;
create index if not exists video_replies_upload_idx on video_replies(mux_upload_id);

-- ── ROOFTOPS: ONE-TIME ONBOARDING CAPABILITY TOKEN ──────────
alter table rooftops add column if not exists onboard_token text;

-- ── JOB CLAIM OBSERVABILITY ─────────────────────────────────
alter table workflow_actions add column if not exists claimed_at timestamptz;
alter table bdc_lead_queue  add column if not exists claimed_at timestamptz;

-- ── HOT-PATH INDEX for the unwatched-video trigger scan ─────
create index if not exists videos_unwatched_scan_idx
  on videos (sent_at)
  where max_watch_pct = 0 and last_watched_at is null;
