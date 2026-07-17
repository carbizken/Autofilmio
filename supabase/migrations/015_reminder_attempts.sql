-- ============================================================
-- Migration 015: Reminder delivery attempts
--
-- The reminder worker (backend/src/lib/reminders.js) retries a
-- failed send on later ticks. attempts + last_attempt_at make the
-- retry state durable, and 'failed' becomes a terminal status once
-- MAX_ATTEMPTS (3) is exhausted — a reminder never spins forever.
-- ============================================================

alter table vehicle_reminders
  add column if not exists attempts int not null default 0,
  add column if not exists last_attempt_at timestamptz;

-- Allow the terminal 'failed' status (migration 010 didn't have it).
alter table vehicle_reminders drop constraint if exists vehicle_reminders_status_check;
alter table vehicle_reminders add constraint vehicle_reminders_status_check
  check (status in ('scheduled', 'sent', 'converted', 'cancelled', 'failed'));
