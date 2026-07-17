-- ============================================================
-- Migration 010: Vehicle Passport spine
--
-- One global vehicles row per VIN; append-only vehicle_events as
-- the ledger (the actual point of truth); current-state tables
-- (findings, vehicle_ownerships) as caches whose every transition
-- is also written to the ledger. Modeled on NMVTIS / Carfax:
-- VIN-keyed identity, many reporters, history append-only,
-- "current state" always derived, never authored.
--
-- Key decisions locked in here (see passport architecture report):
--   1. Surrogate UUID PK, VIN as unique attribute (+ merged_into dedupe)
--   2. Event-append ledger from day one, UPDATE/DELETE-blocked by
--      trigger (service-role key bypasses RLS, so RLS can't do it)
--   3. Per-finding video linkage (vehicle_media.finding_id + start_seconds)
--   4. Global customer_identities keyed on E.164 phone +
--      time-ranged vehicle_ownerships
--   5. Group-shared mechanical truth / rooftop-private commercial data
--      (visibility columns; RLS policies harden in a later migration)
--   6. No hard deletes + retention as data (deleted_at everywhere,
--      media rows outlive their Mux assets)
-- ============================================================

-- ── APPEND-ONLY GUARD ───────────────────────────────────────
-- Immutability enforced in-database: the backend uses the service
-- key which bypasses RLS, so triggers are the only real guard.
create or replace function forbid_mutation() returns trigger language plpgsql
  as $$ begin raise exception '% is append-only', tg_table_name; end $$;

-- ── CUSTOMER IDENTITIES (global person, cross-rooftop) ──────
-- customers stays per-rooftop (PII private to the store);
-- customer_identities links the same human across rooftops.
create table if not exists customer_identities (
  id          uuid primary key default gen_random_uuid(),
  phone_e164  text unique,                    -- primary match key
  email       text,
  name_latest text,
  merged_into uuid references customer_identities(id),
  created_at  timestamptz not null default now()
);

-- ── VEHICLES — the spine (GLOBAL, one row per physical car) ─
create table if not exists vehicles (
  id             uuid primary key default gen_random_uuid(),
  vin            text unique,           -- nullable: pre-VIN drafts allowed, merged later
  vin_normalized text generated always as (upper(vin)) stored,
  year           int,
  make           text,
  model          text,
  trim           text,
  display_name   text,                  -- fallback from legacy mpi_inspections.vehicle
  image_url      text,
  decode_source  text,                  -- 'nhtsa_vpic' | 'manual' | 'legacy_backfill'
  decoded_at     timestamptz,
  merged_into    uuid references vehicles(id),  -- VIN-typo dedupe, never hard-delete
  created_at     timestamptz not null default now(),
  constraint vin_shape check (vin is null or length(vin) = 17)
);
-- NOTE: no rooftop_id. The car is global; relationships are scoped.

-- ── OWNERSHIP — time-ranged relationship, never a column ────
create table if not exists vehicle_ownerships (
  id           uuid primary key default gen_random_uuid(),
  vehicle_id   uuid not null references vehicles(id),
  customer_id  uuid not null references customers(id),
  rooftop_id   uuid references rooftops(id),   -- where the relationship was observed
  source       text not null default 'mpi',    -- 'mpi' | 'sale' | 'manual' | 'crm'
  started_at   timestamptz not null default now(),
  ended_at     timestamptz,                    -- null = current owner
  ended_reason text                            -- 'transfer' | 'sold' | 'correction'
);
create unique index if not exists one_current_owner on vehicle_ownerships(vehicle_id)
  where ended_at is null;
-- Transfer = UPDATE old row's ended_at + INSERT new row + INSERT ownership_transfer event.
-- New owner's passport starts clean of the PRIOR owner's PII (names, phones, prices);
-- mechanical history (findings, odometer, service events) carries forward.

-- ── VEHICLE EVENTS — the APPEND-ONLY ledger ─────────────────
create table if not exists vehicle_events (
  id           bigint generated always as identity primary key,  -- ordered ledger
  vehicle_id   uuid not null references vehicles(id),
  rooftop_id   uuid references rooftops(id),
  event_type   text not null,
  -- 'inspection_created' | 'inspection_sent' | 'inspection_viewed'
  -- 'finding_recommended' | 'finding_approved' | 'finding_declined'
  -- 'finding_deferred' | 'finding_completed' | 'finding_superseded'
  -- 'video_attached' | 'document_added' | 'value_snapshot'
  -- 'odometer_reading' | 'ownership_transfer' | 'reminder_scheduled'
  -- 'record_corrected'   <- corrections are new events, never edits
  occurred_at  timestamptz not null default now(),
  actor_type   text not null,          -- 'rep' | 'customer' | 'system'
  actor_id     uuid,                   -- reps.id or customers.id
  subject_table text,
  subject_id   uuid,                   -- pointer to findings/media/docs row
  visibility   text not null default 'group',  -- 'group' | 'rooftop' | 'customer'
  payload      jsonb not null default '{}',
  constraint vehicle_events_actor_type_check
    check (actor_type in ('rep', 'customer', 'system')),
  constraint vehicle_events_visibility_check
    check (visibility in ('group', 'rooftop', 'customer'))
);
drop trigger if exists vehicle_events_no_update on vehicle_events;
create trigger vehicle_events_no_update before update or delete
  on vehicle_events for each row execute function forbid_mutation();

-- ── FINDINGS — recommendation lifecycle rows ────────────────
create table if not exists findings (
  id            uuid primary key default gen_random_uuid(),
  vehicle_id    uuid not null references vehicles(id),
  inspection_id uuid references mpi_inspections(id),
  rooftop_id    uuid not null references rooftops(id),
  name          text not null,           -- "Front Brake Pads"
  op_code       text,                    -- canonical service code (evolvable taxonomy)
  severity      text not null,           -- 'green' | 'yellow' | 'red'
  note          text,
  measurements  jsonb default '{}',      -- {"pad_mm": 2, "tread_32nds": 4}
  estimate      numeric(10,2),           -- rooftop-private commercial data
  status        text not null default 'recommended',
  -- 'recommended' -> 'approved' | 'declined' | 'deferred'
  -- 'approved'    -> 'completed'
  -- 'declined'/'deferred' -> 'superseded' (next visit re-recommends via NEW row)
  approved_at   timestamptz,
  declined_at   timestamptz,
  deferred_until date,
  completed_at  timestamptz,
  completed_ro_number text,
  supersedes_finding_id uuid references findings(id),  -- re-recommendation chain
  backfilled    bool not null default false,           -- migrated from items jsonb
  source_item_index int,                               -- pointer into legacy jsonb
  deleted_at    timestamptz,                           -- soft-delete only
  deleted_by    uuid,
  created_at    timestamptz not null default now(),
  constraint findings_severity_check
    check (severity in ('green', 'yellow', 'red')),
  constraint findings_status_check
    check (status in ('recommended', 'approved', 'declined',
                      'deferred', 'completed', 'superseded'))
);
-- "Re-recommended" is NOT a status flip on the old row: the old finding stays
-- 'declined' forever (that history is the upsell engine) and the new visit
-- inserts a fresh finding with supersedes_finding_id -> old. The chain length
-- IS the "recommended 3 times, declined twice" story.

-- Every finding lifecycle transition writes the ledger atomically.
-- Backfilled inserts are skipped: the backfill script synthesizes its
-- own honest visit-level events instead of faking per-item precision.
create or replace function findings_log_transition() returns trigger
language plpgsql as $$
begin
  if tg_op = 'INSERT' then
    if not new.backfilled then
      insert into vehicle_events
        (vehicle_id, rooftop_id, event_type, occurred_at, actor_type,
         subject_table, subject_id, payload)
      values
        (new.vehicle_id, new.rooftop_id, 'finding_recommended', new.created_at,
         'system', 'findings', new.id,
         jsonb_build_object(
           'name', new.name,
           'severity', new.severity,
           'supersedes_finding_id', new.supersedes_finding_id));
    end if;
    return new;
  end if;

  if new.status is distinct from old.status then
    insert into vehicle_events
      (vehicle_id, rooftop_id, event_type, actor_type,
       subject_table, subject_id, payload)
    values
      (new.vehicle_id, new.rooftop_id, 'finding_' || new.status,
       'system', 'findings', new.id,
       jsonb_build_object(
         'name', new.name,
         'severity', new.severity,
         'old_status', old.status,
         'new_status', new.status));
  end if;
  return new;
end $$;
drop trigger if exists findings_transition_ledger on findings;
create trigger findings_transition_ledger after insert or update
  on findings for each row execute function findings_log_transition();

-- ── MEDIA — per-finding video/photo evidence + retention ────
create table if not exists vehicle_media (
  id               uuid primary key default gen_random_uuid(),
  vehicle_id       uuid not null references vehicles(id),
  inspection_id    uuid references mpi_inspections(id),
  finding_id       uuid references findings(id),   -- null = whole-visit walkaround
  rooftop_id       uuid not null references rooftops(id),
  kind             text not null,   -- 'mpi_video' | 'walkaround' | 'photo' | 'delivery'
  mux_asset_id     text,
  mux_playback_id  text,
  start_seconds    int,             -- deep-link offset when one video covers many findings
  end_seconds      int,
  duration_s       int,
  thumbnail_url    text,            -- cached; survives Mux deletion
  retention_policy text not null default 'retain_2y',
  -- 'retain_forever' | 'retain_2y' | 'retain_90d' — per-rooftop default, per-asset override
  retention_expires_at timestamptz,
  storage_state    text not null default 'live',   -- 'live' | 'cold' | 'purged'
  purged_at        timestamptz,
  created_at       timestamptz not null default now(),
  constraint vehicle_media_retention_check
    check (retention_policy in ('retain_forever', 'retain_2y', 'retain_90d')),
  constraint vehicle_media_storage_state_check
    check (storage_state in ('live', 'cold', 'purged'))
);
-- The ROW is permanent even when the Mux asset is purged: the passport still
-- shows "video evidence existed, recorded 2026-03-02, 41s" with thumbnail.
-- Truth != storage.

-- ── DOCUMENTS — invoices, ROs, estimates, warranty (vault) ──
create table if not exists vehicle_documents (
  id            uuid primary key default gen_random_uuid(),
  vehicle_id    uuid not null references vehicles(id),
  rooftop_id    uuid not null references rooftops(id),
  inspection_id uuid references mpi_inspections(id),
  doc_type      text not null,  -- 'invoice' | 'estimate' | 'ro' | 'warranty' | 'recall' | 'other'
  title         text not null,
  storage_path  text not null,  -- Supabase Storage
  sha256        text,           -- tamper-evidence for "point of truth" claim
  amount        numeric(10,2),
  issued_at     date,
  visibility    text not null default 'customer',
  deleted_at    timestamptz,
  created_at    timestamptz not null default now(),
  constraint vehicle_documents_visibility_check
    check (visibility in ('group', 'rooftop', 'customer'))
);

-- ── VALUE SNAPSHOTS — AutoCurb/manual value over time ───────
create table if not exists vehicle_value_snapshots (
  id          uuid primary key default gen_random_uuid(),
  vehicle_id  uuid not null references vehicles(id),
  source      text not null,        -- 'autocurb' | 'manual' | 'kbb'
  value_low   numeric(10,2),
  value       numeric(10,2),
  value_high  numeric(10,2),
  odometer    int,
  captured_at timestamptz not null default now()
);

-- ── ODOMETER READINGS — every mileage observation ───────────
create table if not exists odometer_readings (
  id          uuid primary key default gen_random_uuid(),
  vehicle_id  uuid not null references vehicles(id),
  miles       int not null,
  source_inspection_id uuid references mpi_inspections(id),
  anomalous   bool not null default false,  -- flag rollbacks, never reject (NMVTIS pattern)
  reading_at  timestamptz not null default now()
);

-- ── REMINDERS — deferred-item follow-ups, maintenance due ───
create table if not exists vehicle_reminders (
  id          uuid primary key default gen_random_uuid(),
  vehicle_id  uuid not null references vehicles(id),
  rooftop_id  uuid references rooftops(id),   -- owning rooftop: reminders are its commercial pipeline
  customer_id uuid references customers(id),
  finding_id  uuid references findings(id),   -- deferred-item follow-up
  kind        text not null,   -- 'deferred_followup' | 'maintenance_due' | 'state_inspection'
  due_at      date,
  due_miles   int,
  status      text not null default 'scheduled',  -- 'scheduled'|'sent'|'converted'|'cancelled'
  created_at  timestamptz not null default now(),
  constraint vehicle_reminders_status_check
    check (status in ('scheduled', 'sent', 'converted', 'cancelled'))
);

-- ── WIRING INTO EXISTING TABLES ─────────────────────────────
alter table mpi_inspections add column if not exists vehicle_id uuid references vehicles(id);
alter table videos          add column if not exists vehicle_id uuid references vehicles(id);
alter table customers       add column if not exists identity_id uuid references customer_identities(id);

-- ── INDEXES ─────────────────────────────────────────────────
create index if not exists vehicles_vin_normalized_idx      on vehicles(vin_normalized);
create index if not exists vehicle_ownerships_vehicle_idx   on vehicle_ownerships(vehicle_id);
create index if not exists vehicle_ownerships_customer_idx  on vehicle_ownerships(customer_id);
create index if not exists vehicle_events_vehicle_time_idx  on vehicle_events(vehicle_id, occurred_at desc);
create index if not exists vehicle_events_subject_idx       on vehicle_events(subject_table, subject_id);
create index if not exists findings_vehicle_idx             on findings(vehicle_id);
create index if not exists findings_inspection_idx          on findings(inspection_id);
create index if not exists findings_rooftop_status_idx      on findings(rooftop_id, status);
create index if not exists findings_supersedes_idx          on findings(supersedes_finding_id);
create index if not exists vehicle_media_vehicle_idx        on vehicle_media(vehicle_id);
create index if not exists vehicle_media_finding_idx        on vehicle_media(finding_id);
create index if not exists vehicle_media_retention_idx      on vehicle_media(retention_expires_at)
  where storage_state = 'live';
create index if not exists vehicle_documents_vehicle_idx    on vehicle_documents(vehicle_id);
create index if not exists value_snapshots_vehicle_idx      on vehicle_value_snapshots(vehicle_id, captured_at desc);
create index if not exists odometer_vehicle_idx             on odometer_readings(vehicle_id, reading_at desc);
create index if not exists reminders_vehicle_idx            on vehicle_reminders(vehicle_id);
create index if not exists reminders_rooftop_idx            on vehicle_reminders(rooftop_id);
create index if not exists reminders_due_idx                on vehicle_reminders(status, due_at);
create index if not exists customer_identities_phone_idx    on customer_identities(phone_e164);
create index if not exists mpi_inspections_vehicle_idx      on mpi_inspections(vehicle_id);
create index if not exists videos_vehicle_idx               on videos(vehicle_id);
create index if not exists customers_identity_idx           on customers(identity_id);

-- ── RLS (policies harden in a later migration; service role bypasses) ──
alter table vehicles                enable row level security;
alter table vehicle_ownerships     enable row level security;
alter table vehicle_events         enable row level security;
alter table findings               enable row level security;
alter table vehicle_media          enable row level security;
alter table vehicle_documents      enable row level security;
alter table vehicle_value_snapshots enable row level security;
alter table odometer_readings      enable row level security;
alter table vehicle_reminders      enable row level security;
alter table customer_identities    enable row level security;
