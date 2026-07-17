-- ============================================================
-- Migration 011: Per-rooftop pricing & financing configuration
--
--   rooftop_pricing_configs — the live config (one row per rooftop)
--   pricing_config_history  — append-only snapshot per version,
--                             written automatically by trigger
--   approval_renders        — immutable archive of exactly what the
--                             customer saw when approving an MPI
--
-- History and renders reuse the forbid_mutation() append-only
-- trigger pattern from 010_vehicle_passport.sql: posted rows are
-- never edited; corrections are new rows.
-- ============================================================

-- Defensive re-create so this migration also runs standalone.
create or replace function forbid_mutation() returns trigger language plpgsql
  as $$ begin raise exception '% is append-only', tg_table_name; end $$;

-- ── LIVE PRICING CONFIG (one per rooftop) ───────────────────
create table if not exists rooftop_pricing_configs (
  id                   uuid primary key default gen_random_uuid(),
  rooftop_id           uuid unique references rooftops(id),
  mode                 text not null default 'one_price'
    check (mode in ('one_price', 'three_tier', 'tier_plus_lifetime')),
  tier_names           jsonb default '["Good","Better","Best"]',
  category_overrides   jsonb default '{}',   -- per service category: mode/tier overrides
  lifetime_enabled     bool default false,
  lifetime_disclosure  text,
  general_disclosure   text,
  financing_enabled    bool default false,
  financing_provider   text,
  financing_min_amount numeric(10,2),
  financing_disclosure text,
  version              int default 1,
  updated_by           uuid,                 -- reps.id of last editor
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now()
);

-- ── CONFIG HISTORY — append-only snapshot per version ───────
create table if not exists pricing_config_history (
  id         uuid primary key default gen_random_uuid(),
  config_id  uuid not null references rooftop_pricing_configs(id),
  rooftop_id uuid references rooftops(id),
  version    int not null,
  config     jsonb not null,       -- full snapshot of the config at this version
  updated_by uuid,
  created_at timestamptz not null default now(),
  unique (config_id, version)
);
drop trigger if exists pricing_config_history_no_update on pricing_config_history;
create trigger pricing_config_history_no_update before update or delete
  on pricing_config_history for each row execute function forbid_mutation();

-- Every insert/update of the live config bumps version, stamps
-- updated_at (BEFORE), then writes the matching history snapshot
-- (AFTER, once the config row exists for the FK) — atomically,
-- both inside the same statement's transaction.
create or replace function pricing_config_bump_version() returns trigger
language plpgsql as $$
begin
  new.version    := coalesce(old.version, 0) + 1;
  new.updated_at := now();
  return new;
end $$;
drop trigger if exists rooftop_pricing_configs_version on rooftop_pricing_configs;
create trigger rooftop_pricing_configs_version before update
  on rooftop_pricing_configs for each row execute function pricing_config_bump_version();

create or replace function pricing_config_snapshot() returns trigger
language plpgsql as $$
begin
  insert into pricing_config_history (config_id, rooftop_id, version, config, updated_by)
  values (
    new.id,
    new.rooftop_id,
    new.version,
    to_jsonb(new) - 'created_at' - 'updated_at',
    new.updated_by
  );
  return new;
end $$;
drop trigger if exists rooftop_pricing_configs_snapshot on rooftop_pricing_configs;
create trigger rooftop_pricing_configs_snapshot after insert or update
  on rooftop_pricing_configs for each row execute function pricing_config_snapshot();

-- ── APPROVAL RENDERS — what the customer actually saw ───────
-- Immutable archive of the exact payload (findings, prices, tiers,
-- disclosures) rendered to the customer at approval time. If pricing
-- config changes later, this row is the proof of what was offered.
create table if not exists approval_renders (
  id               uuid primary key default gen_random_uuid(),
  inspection_id    uuid not null references mpi_inspections(id),
  rendered_payload jsonb not null,
  rendered_at      timestamptz not null default now()
);
drop trigger if exists approval_renders_no_update on approval_renders;
create trigger approval_renders_no_update before update or delete
  on approval_renders for each row execute function forbid_mutation();

-- ── INDEXES ─────────────────────────────────────────────────
create index if not exists pricing_history_config_idx  on pricing_config_history(config_id, version desc);
create index if not exists pricing_history_rooftop_idx on pricing_config_history(rooftop_id);
create index if not exists approval_renders_inspection_idx on approval_renders(inspection_id, rendered_at desc);

-- ── RLS (service role bypasses; policies harden later) ──────
alter table rooftop_pricing_configs enable row level security;
alter table pricing_config_history  enable row level security;
alter table approval_renders        enable row level security;
