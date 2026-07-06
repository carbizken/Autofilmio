-- ============================================================
-- Migration 007: full customer-interaction tracking + precise
-- (to-the-second) watch time.
--
-- Two gaps this closes:
--   1. Player CTA/interaction events (trade tap, appointment booked,
--      reply recorded, call started, CTA clicks) were fired client-side
--      but never persisted — every non-watch interaction was dropped.
--   2. We tracked furthest playback *position*, not actual *seconds
--      watched*. A re-watch or a skip wasn't reflected. engaged_seconds
--      counts real time-on-video, incremented per second while playing.
-- ============================================================

-- ── WATCH_EVENTS: one row per heartbeat OR discrete interaction ──
-- event_type: 'heartbeat' (a watch ping) | 'trade_tap' | 'appt_booked'
--   | 'reply' | 'call' | 'cta_click' | 'play' | 'complete' | ...
alter table watch_events add column if not exists event_type      text not null default 'heartbeat';
alter table watch_events add column if not exists engaged_seconds  int;   -- cumulative seconds actually watched this session
alter table watch_events add column if not exists meta             jsonb; -- event-specific detail (cta label, target url, ...)

-- Timeline reads: every interaction for a video, newest first.
create index if not exists watch_events_video_time_idx
  on watch_events (video_id, created_at desc);
-- Non-heartbeat interactions only (small, hot for the activity feed).
create index if not exists watch_events_interactions_idx
  on watch_events (video_id, created_at desc)
  where event_type <> 'heartbeat';

-- ── VIDEOS: to-the-second watch totals ─────────────────────
alter table videos add column if not exists engaged_seconds int not null default 0; -- best single-session seconds watched
alter table videos add column if not exists play_count      int not null default 0; -- number of times playback started
alter table videos add column if not exists completed_at    timestamptz;            -- first time watched to ~100%

-- Convenience: seconds watched vs. total duration is engaged_seconds / duration.
