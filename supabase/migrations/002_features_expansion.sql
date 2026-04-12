-- ============================================================
-- AutoFilm Feature Expansion Migration
-- Adds: tenant fields, MPI inspections, video replies,
--        email delivery tracking, CRM sync, dashboard stats
-- ============================================================

-- ── ROOFTOP TENANT EXPANSION ────────────────────────────────
alter table rooftops add column if not exists website_url        text;
alter table rooftops add column if not exists logo_url           text;
alter table rooftops add column if not exists brand_color        text default '#D94F00';
alter table rooftops add column if not exists brand_color_2      text;
alter table rooftops add column if not exists phone              text;
alter table rooftops add column if not exists address            text;
alter table rooftops add column if not exists city               text;
alter table rooftops add column if not exists state              text;
alter table rooftops add column if not exists zip                text;
alter table rooftops add column if not exists tenant_source      text default 'autofilm'; -- 'autofilm' | 'autocurb'
alter table rooftops add column if not exists external_tenant_id text; -- autocurb tenant id when bundled
alter table rooftops add column if not exists inventory_feed_url text;
alter table rooftops add column if not exists scraped_at         timestamptz;
alter table rooftops add column if not exists onboarded          bool not null default false;

-- ── REPS EXPANSION ──────────────────────────────────────────
alter table reps add column if not exists role      text not null default 'sales'; -- 'sales' | 'service' | 'bdc' | 'manager' | 'admin'
alter table reps add column if not exists department text not null default 'sales'; -- 'sales' | 'service' | 'parts' | 'bdc'
alter table reps add column if not exists phone     text;
alter table reps add column if not exists active    bool not null default true;

-- ── VIDEOS EXPANSION ────────────────────────────────────────
alter table videos add column if not exists type           text not null default 'personal'; -- 'personal' | 'mpi' | 'walkaround' | 'vin_reel' | 'reply'
alter table videos add column if not exists customer_email text;
alter table videos add column if not exists vin            text;
alter table videos add column if not exists stock_number   text;
alter table videos add column if not exists thumbnail_url  text;  -- animated GIF thumbnail
alter table videos add column if not exists thumbnail_gif  text;  -- animated GIF URL from Mux
alter table videos add column if not exists duration       int;   -- seconds
alter table videos add column if not exists parent_video_id uuid references videos(id); -- for reply chains
alter table videos add column if not exists email_sent_at  timestamptz;
alter table videos add column if not exists email_opened_at timestamptz;

-- ── MPI INSPECTIONS ─────────────────────────────────────────
create table if not exists mpi_inspections (
  id                uuid primary key default gen_random_uuid(),
  video_id          uuid references videos(id) on delete cascade,
  rep_id            uuid references reps(id) on delete cascade,   -- service advisor
  rooftop_id        uuid references rooftops(id) on delete cascade,
  customer_name     text not null,
  customer_phone    text,
  customer_email    text,
  ro_number         text,                                         -- repair order number
  vin               text,
  vehicle           text,                                         -- year make model
  mileage           int,
  -- Color-coded inspection items (green/yellow/red)
  items             jsonb not null default '[]',
  -- e.g. [{ "name":"Brake Pads","status":"red","note":"2mm remaining" }]
  total_estimate    numeric(10,2) default 0,
  approved_amount   numeric(10,2),
  approved_at       timestamptz,
  sent_at           timestamptz,
  status            text not null default 'draft', -- 'draft' | 'sent' | 'viewed' | 'approved' | 'declined'
  created_at        timestamptz not null default now()
);

-- ── VIDEO REPLIES ───────────────────────────────────────────
create table if not exists video_replies (
  id                uuid primary key default gen_random_uuid(),
  parent_video_id   uuid references videos(id) on delete cascade,
  mux_asset_id      text,
  mux_playback_id   text,
  customer_name     text,
  customer_phone    text,
  duration          int,
  thumbnail_url     text,
  created_at        timestamptz not null default now()
);

-- ── EMAIL DELIVERY LOG ──────────────────────────────────────
create table if not exists email_deliveries (
  id                uuid primary key default gen_random_uuid(),
  video_id          uuid references videos(id) on delete cascade,
  to_email          text not null,
  subject           text,
  template          text default 'video_share',
  status            text not null default 'sent',   -- 'sent' | 'delivered' | 'opened' | 'clicked' | 'bounced'
  provider_id       text,                            -- SendGrid message ID
  opened_at         timestamptz,
  clicked_at        timestamptz,
  created_at        timestamptz not null default now()
);

-- ── CRM SYNC LOG ────────────────────────────────────────────
create table if not exists crm_sync_log (
  id                uuid primary key default gen_random_uuid(),
  rooftop_id        uuid references rooftops(id) on delete cascade,
  crm_provider      text not null, -- 'elead' | 'vinsolutions' | 'dealersocket' | 'hubspot' | 'salesforce'
  action            text not null, -- 'video_sent' | 'video_watched' | 'reply_received' | 'mpi_approved'
  video_id          uuid references videos(id),
  crm_record_id     text,          -- CRM-side record ID
  payload           jsonb,
  status            text not null default 'pending', -- 'pending' | 'synced' | 'failed'
  error_message     text,
  created_at        timestamptz not null default now()
);

-- ── CRM CONNECTIONS (per rooftop) ───────────────────────────
create table if not exists crm_connections (
  id                uuid primary key default gen_random_uuid(),
  rooftop_id        uuid references rooftops(id) on delete cascade,
  provider          text not null, -- 'elead' | 'vinsolutions' | 'dealersocket' | 'hubspot' | 'salesforce'
  api_key           text,
  api_secret        text,
  dealer_id         text,          -- provider-specific dealer identifier
  endpoint_url      text,
  config            jsonb default '{}',
  active            bool not null default true,
  last_sync_at      timestamptz,
  created_at        timestamptz not null default now(),
  unique(rooftop_id, provider)
);

-- ── INVENTORY (for VIN Reels) ───────────────────────────────
create table if not exists inventory (
  id                uuid primary key default gen_random_uuid(),
  rooftop_id        uuid references rooftops(id) on delete cascade,
  vin               text not null,
  stock_number      text,
  year              int,
  make              text,
  model             text,
  trim              text,
  exterior_color    text,
  interior_color    text,
  msrp              numeric(10,2),
  sale_price        numeric(10,2),
  mileage           int,
  body_style        text,
  engine            text,
  transmission      text,
  drivetrain        text,
  photos            jsonb default '[]',  -- array of photo URLs
  features          jsonb default '[]',  -- array of feature strings
  status            text default 'available', -- 'available' | 'sold' | 'pending'
  source            text default 'manual',    -- 'manual' | 'feed' | 'scraper'
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  unique(rooftop_id, vin)
);

-- ── WEBSITE OVERLAY CONFIG ──────────────────────────────────
create table if not exists overlay_configs (
  id                uuid primary key default gen_random_uuid(),
  rooftop_id        uuid references rooftops(id) on delete cascade,
  rep_id            uuid references reps(id),
  video_id          uuid references videos(id),
  position          text default 'bottom-right', -- 'bottom-right' | 'bottom-left'
  trigger_delay     int default 3,               -- seconds before showing
  pages             jsonb default '["*"]',       -- URL patterns to show on
  cta_text          text default 'Watch Video',
  active            bool not null default true,
  created_at        timestamptz not null default now()
);

-- ── INDEXES ─────────────────────────────────────────────────
create index if not exists mpi_inspections_rep_id_idx     on mpi_inspections(rep_id);
create index if not exists mpi_inspections_rooftop_idx    on mpi_inspections(rooftop_id);
create index if not exists mpi_inspections_status_idx     on mpi_inspections(status);
create index if not exists video_replies_parent_idx       on video_replies(parent_video_id);
create index if not exists email_deliveries_video_idx     on email_deliveries(video_id);
create index if not exists crm_sync_log_rooftop_idx       on crm_sync_log(rooftop_id);
create index if not exists crm_connections_rooftop_idx    on crm_connections(rooftop_id);
create index if not exists inventory_rooftop_idx          on inventory(rooftop_id);
create index if not exists inventory_vin_idx              on inventory(vin);
create index if not exists overlay_configs_rooftop_idx    on overlay_configs(rooftop_id);
create index if not exists videos_type_idx                on videos(type);
create index if not exists videos_vin_idx                 on videos(vin);

-- ── RLS ─────────────────────────────────────────────────────
alter table mpi_inspections  enable row level security;
alter table video_replies    enable row level security;
alter table email_deliveries enable row level security;
alter table crm_sync_log    enable row level security;
alter table crm_connections  enable row level security;
alter table inventory        enable row level security;
alter table overlay_configs  enable row level security;

-- ── DASHBOARD VIEWS ─────────────────────────────────────────

-- Team performance dashboard view
create or replace view team_dashboard as
  select
    r.id as rep_id,
    r.name as rep_name,
    r.department,
    r.role,
    r.rooftop_id,
    r.photo_url,
    r.active,
    count(v.id)                                           as total_videos,
    count(v.id) filter (where v.sent_at is not null)      as videos_sent,
    count(v.id) filter (where v.type = 'mpi')             as mpi_videos,
    count(v.id) filter (where v.type = 'vin_reel')        as vin_reels,
    count(v.id) filter (
      where v.sent_at >= now() - interval '7 days')       as videos_this_week,
    count(v.id) filter (
      where v.sent_at >= now() - interval '30 days')      as videos_this_month,
    avg(v.max_watch_pct)                                  as avg_watch_pct,
    count(v.id) filter (where v.max_watch_pct >= 75)      as hot_leads,
    count(v.id) filter (where v.max_watch_pct >= 25)      as engaged_views,
    max(v.sent_at)                                        as last_sent_at,
    count(distinct vr.id)                                 as replies_received
  from reps r
  left join videos v on v.rep_id = r.id
  left join video_replies vr on vr.parent_video_id = v.id
  group by r.id, r.name, r.department, r.role, r.rooftop_id, r.photo_url, r.active;

-- Rooftop-level KPIs
create or replace view rooftop_kpis as
  select
    rt.id as rooftop_id,
    rt.name as rooftop_name,
    count(distinct r.id)                                  as total_reps,
    count(distinct r.id) filter (where r.active)          as active_reps,
    count(v.id)                                           as total_videos,
    count(v.id) filter (
      where v.sent_at >= now() - interval '30 days')      as videos_this_month,
    avg(v.max_watch_pct)                                  as avg_watch_pct,
    count(v.id) filter (where v.max_watch_pct >= 75)      as total_hot_leads,
    count(distinct m.id)                                  as total_inspections,
    count(distinct m.id) filter (
      where m.status = 'approved')                        as approved_inspections,
    coalesce(sum(m.approved_amount) filter (
      where m.status = 'approved'), 0)                    as total_approved_revenue
  from rooftops rt
  left join reps r on r.rooftop_id = rt.id
  left join videos v on v.rooftop_id = rt.id
  left join mpi_inspections m on m.rooftop_id = rt.id
  group by rt.id, rt.name;
