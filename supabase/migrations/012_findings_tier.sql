-- ============================================================
-- Migration 012: Selected tier on findings
--
-- When a rooftop presents tiered pricing (three_tier /
-- tier_plus_lifetime, migration 011), the customer's approval
-- carries WHICH tier they picked per item. That choice is part of
-- the finding's lifecycle record (and is also frozen into the
-- approval_renders snapshot at approval time).
-- ============================================================

alter table findings
  add column if not exists selected_tier text,
  add column if not exists selected_tier_price numeric(10,2);
