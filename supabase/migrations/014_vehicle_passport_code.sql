-- ============================================================
-- Migration 014: Stable per-vehicle passport short code
--
-- One permanent, shareable short link per vehicle:
--   https://links.autofilm.io/p/<passport_code>
-- The code is generated lazily (first passport access or first
-- inspection send) and never rotates — video short_codes belong
-- to a single send, the passport_code belongs to the CAR.
-- ============================================================

alter table vehicles
  add column if not exists passport_code text unique;
