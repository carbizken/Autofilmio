-- ============================================================
-- Migration 003: Auth, BDC, Messaging, Workflows
-- ============================================================

-- ── REPS: ADD AVATAR FIELD ──────────────────────────────────
alter table reps add column if not exists avatar_id text;  -- HeyGen avatar ID

-- ── BDC LEAD QUEUE ──────────────────────────────────────────
create table if not exists bdc_lead_queue (
  id                uuid primary key default gen_random_uuid(),
  rooftop_id        uuid references rooftops(id) on delete cascade,
  assigned_rep_id   uuid references reps(id),
  customer_name     text not null,
  customer_phone    text,
  customer_email    text,
  vehicle           text,
  source            text,          -- 'crm_webhook' | 'manual' | 'website'
  crm_lead_id       text,          -- external CRM lead ID
  status            text not null default 'pending', -- 'pending' | 'sent' | 'no_rep' | 'failed'
  processed_at      timestamptz,
  created_at        timestamptz not null default now()
);

-- ── CONVERSATIONS (two-way texting) ─────────────────────────
create table if not exists conversations (
  id                uuid primary key default gen_random_uuid(),
  video_id          uuid references videos(id),
  rep_id            uuid references reps(id),
  rooftop_id        uuid references rooftops(id) on delete cascade,
  customer_phone    text not null,
  customer_name     text,
  direction         text not null,  -- 'inbound' | 'outbound'
  body              text,
  media_urls        jsonb,
  provider_sid      text,           -- Twilio message SID
  channel           text default 'sms', -- 'sms' | 'rcs' | 'email'
  status            text default 'sent', -- 'sent' | 'delivered' | 'read' | 'failed'
  created_at        timestamptz not null default now()
);

-- ── WORKFLOWS ───────────────────────────────────────────────
create table if not exists workflows (
  id                uuid primary key default gen_random_uuid(),
  rooftop_id        uuid references rooftops(id) on delete cascade,
  name              text not null,
  description       text,
  trigger           text not null,  -- 'video_sent' | 'video_unwatched' | 'video_watched_75' | 'new_lead' | 'reply_received' | 'mpi_sent' | 'scheduled'
  delay_minutes     int not null default 0,
  action            text not null,  -- 'send_sms' | 'send_email' | 'send_push' | 'crm_task' | 'send_avatar'
  action_config     jsonb not null default '{}',
  active            bool not null default true,
  created_at        timestamptz not null default now()
);

-- ── WORKFLOW ACTIONS (execution queue) ──────────────────────
create table if not exists workflow_actions (
  id                uuid primary key default gen_random_uuid(),
  workflow_id       uuid references workflows(id) on delete cascade,
  rooftop_id        uuid references rooftops(id) on delete cascade,
  trigger           text not null,
  action            text not null,
  action_config     jsonb,
  context           jsonb,          -- event data that triggered this
  execute_at        timestamptz not null,
  status            text not null default 'pending', -- 'pending' | 'completed' | 'failed'
  executed_at       timestamptz,
  error_message     text,
  created_at        timestamptz not null default now()
);

-- ── YOUTUBE/SOCIAL DISTRIBUTION ─────────────────────────────
create table if not exists distribution_jobs (
  id                uuid primary key default gen_random_uuid(),
  video_id          uuid references videos(id) on delete cascade,
  rooftop_id        uuid references rooftops(id) on delete cascade,
  platform          text not null,  -- 'youtube' | 'facebook' | 'instagram' | 'vdp'
  platform_video_id text,           -- YouTube video ID, FB post ID, etc.
  platform_url      text,           -- URL to the published content
  status            text not null default 'pending', -- 'pending' | 'uploading' | 'published' | 'failed'
  error_message     text,
  created_at        timestamptz not null default now()
);

-- ── INDEXES ─────────────────────────────────────────────────
create index if not exists bdc_queue_rooftop_idx     on bdc_lead_queue(rooftop_id);
create index if not exists bdc_queue_status_idx      on bdc_lead_queue(status);
create index if not exists conversations_phone_idx   on conversations(customer_phone);
create index if not exists conversations_rooftop_idx on conversations(rooftop_id);
create index if not exists conversations_video_idx   on conversations(video_id);
create index if not exists workflows_rooftop_idx     on workflows(rooftop_id);
create index if not exists workflows_trigger_idx     on workflows(trigger);
create index if not exists wf_actions_status_idx     on workflow_actions(status, execute_at);
create index if not exists wf_actions_rooftop_idx    on workflow_actions(rooftop_id);
create index if not exists dist_jobs_video_idx       on distribution_jobs(video_id);

-- ── RLS ─────────────────────────────────────────────────────
alter table bdc_lead_queue    enable row level security;
alter table conversations     enable row level security;
alter table workflows         enable row level security;
alter table workflow_actions  enable row level security;
alter table distribution_jobs enable row level security;
