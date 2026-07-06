-- ============================================================
-- Migration 008: AutoCurb → AutoFilm suite SSO handoff.
--
-- Separate Supabase projects / separate logins. When an AutoCurb dealer
-- switches into AutoFilm, AutoCurb signs a short-lived HS256 JWT (shared
-- AUTOCURB_JWT_SECRET); AutoFilm verifies it and provisions/looks up the
-- rooftop keyed to the AutoCurb tenant id, so we never duplicate a dealer.
-- ============================================================

alter table rooftops add column if not exists autocurb_tenant_id text;

-- One AutoFilm rooftop per AutoCurb tenant (nulls allowed for direct signups).
create unique index if not exists rooftops_autocurb_tenant_idx
  on rooftops (autocurb_tenant_id)
  where autocurb_tenant_id is not null;
