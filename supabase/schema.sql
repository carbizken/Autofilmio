-- AutoFilm — Supabase Schema
-- Run this in the Supabase SQL editor: supabase.com/dashboard/project/_/sql
-- Creates all tables, indexes, and Row Level Security policies

-- ============================================================
-- TABLES
-- ============================================================

create table if not exists rooftops (
  id               uuid primary key default gen_random_uuid(),
  name             text not null,
  dealer_group     text,
  plan             text not null default 'standard',  -- standard | branded | enterprise
  stripe_customer_id text,
  active           bool not null default true,
  created_at       timestamptz not null default now()
);

create table if not exists reps (
  id               uuid primary key default gen_random_uuid(),
  rooftop_id       uuid references rooftops(id) on delete cascade,
  name             text not null,
  nickname         text,
  title            text default 'Sales Consultant',
  email            text unique not null,
  photo_url        text,
  push_subscription jsonb,  -- Web Push subscription object for notifications
  onboarded        bool not null default false,
  created_at       timestamptz not null default now()
);

create table if not exists videos (
  id               uuid primary key default gen_random_uuid(),
  rep_id           uuid references reps(id) on delete cascade,
  rooftop_id       uuid references rooftops(id) on delete cascade,
  mux_asset_id     text,
  mux_playback_id  text,
  customer_name    text,
  customer_phone   text,
  vehicle          text,
  short_code       text unique not null,
  sent_at          timestamptz,
  last_watched_at  timestamptz,
  max_watch_pct    int not null default 0,
  created_at       timestamptz not null default now()
);

create table if not exists watch_events (
  id               uuid primary key default gen_random_uuid(),
  video_id         uuid references videos(id) on delete cascade,
  watch_pct        int not null default 0,
  watch_seconds    int not null default 0,
  ip               text,
  user_agent       text,
  created_at       timestamptz not null default now()
);

-- ============================================================
-- INDEXES
-- ============================================================

create index if not exists videos_short_code_idx    on videos(short_code);
create index if not exists videos_rep_id_idx        on videos(rep_id);
create index if not exists videos_rooftop_id_idx    on videos(rooftop_id);
create index if not exists videos_sent_at_idx       on videos(sent_at desc);
create index if not exists watch_events_video_id_idx on watch_events(video_id);
create index if not exists watch_events_created_idx  on watch_events(created_at desc);
create index if not exists reps_rooftop_id_idx      on reps(rooftop_id);
create index if not exists reps_email_idx           on reps(email);

-- ============================================================
-- ROW LEVEL SECURITY
-- ============================================================

alter table rooftops    enable row level security;
alter table reps        enable row level security;
alter table videos      enable row level security;
alter table watch_events enable row level security;

-- Reps can read/write their own rooftop's data
-- Service role (backend) bypasses RLS entirely

create policy "Reps read own rooftop"
  on rooftops for select
  using (id in (
    select rooftop_id from reps where email = auth.jwt()->>'email'
  ));

create policy "Reps read own data"
  on reps for select
  using (email = auth.jwt()->>'email' or rooftop_id in (
    select rooftop_id from reps where email = auth.jwt()->>'email'
  ));

create policy "Reps update own profile"
  on reps for update
  using (email = auth.jwt()->>'email');

create policy "Reps read own videos"
  on videos for select
  using (rooftop_id in (
    select rooftop_id from reps where email = auth.jwt()->>'email'
  ));

create policy "Watch events readable by rep's rooftop"
  on watch_events for select
  using (video_id in (
    select v.id from videos v
    join reps r on r.rooftop_id = v.rooftop_id
    where r.email = auth.jwt()->>'email'
  ));

-- ============================================================
-- HELPER VIEWS
-- ============================================================

-- Video stats per rep (used in Command leaderboard)
create or replace view rep_stats as
  select
    r.id as rep_id,
    r.name as rep_name,
    r.rooftop_id,
    count(v.id)                           as videos_sent,
    count(v.id) filter (where v.sent_at is not null) as sms_sent,
    avg(v.max_watch_pct)                  as avg_watch_pct,
    count(v.id) filter (where v.max_watch_pct >= 75) as hot_leads,
    max(v.sent_at)                        as last_sent_at
  from reps r
  left join videos v on v.rep_id = r.id
  group by r.id, r.name, r.rooftop_id;
