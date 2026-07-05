-- ============================================================
-- Migration 004: Stripe billing, TCPA consent, cross-product
-- customer profiles, Mux upload tracking
-- ============================================================

-- ── ROOFTOPS: BILLING FIELDS ────────────────────────────────
alter table rooftops add column if not exists stripe_subscription_id text;
alter table rooftops add column if not exists subscription_status    text default 'none';
  -- 'none' | 'trialing' | 'active' | 'past_due' | 'canceled'
alter table rooftops add column if not exists trial_ends_at          timestamptz;
alter table rooftops add column if not exists current_period_end     timestamptz;

-- ── VIDEOS: MUX UPLOAD TRACKING (webhook correlation) ───────
alter table videos add column if not exists mux_upload_id text;
create index if not exists videos_mux_upload_idx on videos(mux_upload_id);
create index if not exists videos_mux_asset_idx  on videos(mux_asset_id);

-- ── TCPA SMS CONSENT ────────────────────────────────────────
create table if not exists sms_consent (
  phone           text primary key,     -- normalized 10-digit
  opted_out       bool not null default false,
  opt_out_source  text,                 -- 'sms_keyword' | 'manual' | 'complaint'
  opt_in_source   text,                 -- 'sms_keyword' | 'web_form' | 'dealer'
  opted_out_at    timestamptz,
  opted_in_at     timestamptz,
  created_at      timestamptz not null default now()
);
create index if not exists sms_consent_opted_out_idx on sms_consent(opted_out) where opted_out = true;

-- ── CROSS-PRODUCT CUSTOMER PROFILES ─────────────────────────
-- The unified customer identity across AutoFilm, AutoCurb, and
-- AutoLabels. Deduped on normalized phone within a rooftop.
create table if not exists customers (
  id                uuid primary key default gen_random_uuid(),
  rooftop_id        uuid references rooftops(id) on delete cascade,
  phone             text,               -- normalized 10-digit
  email             text,
  name              text,
  -- Cross-product engagement rollup
  videos_received   int not null default 0,
  videos_watched    int not null default 0,
  max_watch_pct     int not null default 0,
  trade_submissions int not null default 0,   -- AutoCurb
  labels_views      int not null default 0,   -- AutoLabels passport views
  lead_score        int not null default 0,   -- computed 0-100
  last_activity_at  timestamptz,
  source_product    text default 'autofilm',  -- which product first saw them
  created_at        timestamptz not null default now(),
  unique(rooftop_id, phone)
);
create index if not exists customers_rooftop_idx on customers(rooftop_id);
create index if not exists customers_phone_idx   on customers(phone);
create index if not exists customers_score_idx   on customers(rooftop_id, lead_score desc);

alter table sms_consent enable row level security;
alter table customers   enable row level security;

-- ── CONVERSATION THREADS RPC (referenced by messaging.js) ───
create or replace function get_conversations(
  p_rooftop_id uuid,
  p_rep_id uuid default null,
  p_limit int default 50
)
returns table (
  customer_phone text,
  customer_name  text,
  last_message   text,
  last_direction text,
  last_at        timestamptz,
  video_id       uuid,
  unread_count   bigint
)
language sql stable as $$
  select distinct on (c.customer_phone)
    c.customer_phone,
    c.customer_name,
    c.body        as last_message,
    c.direction   as last_direction,
    c.created_at  as last_at,
    c.video_id,
    count(*) filter (where c.direction = 'inbound') over (partition by c.customer_phone) as unread_count
  from conversations c
  where c.rooftop_id = p_rooftop_id
    and (p_rep_id is null or c.rep_id = p_rep_id)
  order by c.customer_phone, c.created_at desc
  limit p_limit;
$$;
