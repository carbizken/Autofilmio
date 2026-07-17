-- ============================================================
-- Migration 013: Per-finding video timestamps
--
-- The tech tool can send an optional per-item timestamp map on
-- inspection creation (items[i].video_ts_start / video_ts_end,
-- seconds into the walkaround video). Persisted onto findings so
-- clip-per-finding capture works: the passport can deep-link the
-- exact seconds of video evidence behind each recommendation
-- (complements vehicle_media.start_seconds for dedicated clips).
-- ============================================================

alter table findings
  add column if not exists video_ts_start numeric,
  add column if not exists video_ts_end numeric;
