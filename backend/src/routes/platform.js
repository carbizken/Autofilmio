/**
 * AutoFilm Platform Operations API — vendor-side (AutoFilm internal).
 *
 * Powers autofilm-admin.html: cross-rooftop account health, MRR estimates,
 * trial pipeline, and churn-risk flags. This is NOT tenant-scoped — it reads
 * every rooftop — so access is locked to platform operators:
 *
 *   requireAuth()  → valid Supabase session + rep record
 *   AND rep.role === 'admin'
 *   AND rep.email is in the PLATFORM_ADMIN_EMAILS env allowlist
 *
 * If PLATFORM_ADMIN_EMAILS is missing or empty, every route 403s (fail closed).
 */

import express from 'express';
import { supabase } from '../lib/supabase.js';
import { requireAuth } from '../lib/auth.js';

const router = express.Router();

const DAY_MS = 86_400_000;
const SEND_WINDOW_DAYS = 30;      // "videos_30d" aggregation window
const LOOKBACK_DAYS = 60;         // how far back we look for last_send_at
const CHURN_SILENT_DAYS = 14;     // active sub + no sends this long = churn risk
const PLAN_MRR = { standard: 299, bundle: 599 };

// ── Platform-operator allowlist (fail closed) ───────────────
const PLATFORM_ADMIN_EMAILS = (process.env.PLATFORM_ADMIN_EMAILS || '')
  .split(',')
  .map((e) => e.trim().toLowerCase())
  .filter(Boolean);

if (PLATFORM_ADMIN_EMAILS.length === 0) {
  console.warn('[platform] PLATFORM_ADMIN_EMAILS is not set — all /api/platform routes will return 403 (fail closed)');
}

function requirePlatformOperator() {
  return (req, res, next) => {
    const email = (req.rep?.email || '').toLowerCase();
    const allowed =
      req.rep?.role === 'admin' &&
      PLATFORM_ADMIN_EMAILS.length > 0 &&
      PLATFORM_ADMIN_EMAILS.includes(email);

    if (!allowed) {
      return res.status(403).json({ error: 'Platform operator access required' });
    }
    next();
  };
}

router.use(requireAuth(), requirePlatformOperator());

// ── Helpers ──────────────────────────────────────────────────

function mrrEstimate(rooftop) {
  // Only a live paid subscription counts toward MRR.
  return rooftop.subscription_status === 'active' ? (PLAN_MRR[rooftop.plan] || 0) : 0;
}

function pipelineEstimate(rooftop) {
  // Trials are $0 MRR but represent pipeline if they convert.
  return rooftop.subscription_status === 'trialing' ? (PLAN_MRR[rooftop.plan] || 0) : 0;
}

/**
 * Fetch and aggregate the whole platform in 3 queries (no N+1):
 *   1. all rooftops   2. all reps   3. all sends in the last 60 days
 * Returns the per-account rows used by /accounts and /kpis.
 */
async function loadAccounts() {
  const now = Date.now();
  const since60 = new Date(now - LOOKBACK_DAYS * DAY_MS).toISOString();
  const since30 = now - SEND_WINDOW_DAYS * DAY_MS;

  const [rooftopsQ, repsQ, videosQ] = await Promise.all([
    supabase
      .from('rooftops')
      .select('id, name, dealer_group, plan, subscription_status, trial_ends_at, active, created_at')
      .order('created_at', { ascending: true })
      .limit(5000),
    supabase
      .from('reps')
      .select('id, rooftop_id, active')
      .limit(50000),
    // One platform-wide sends query — every rooftop is in scope here,
    // so a time filter alone is equivalent to .in(rooftop_ids) and avoids
    // an oversized query string.
    supabase
      .from('videos')
      .select('rooftop_id, sent_at, max_watch_pct')
      .gte('sent_at', since60)
      .limit(100000),
  ]);
  if (rooftopsQ.error) throw rooftopsQ.error;
  if (repsQ.error) throw repsQ.error;
  if (videosQ.error) throw videosQ.error;

  // Active reps per rooftop
  const repCount = new Map();
  for (const r of repsQ.data || []) {
    if (!r.active || !r.rooftop_id) continue;
    repCount.set(r.rooftop_id, (repCount.get(r.rooftop_id) || 0) + 1);
  }

  // Send stats per rooftop
  const sendStats = new Map();
  for (const v of videosQ.data || []) {
    if (!v.rooftop_id || !v.sent_at) continue;
    let s = sendStats.get(v.rooftop_id);
    if (!s) {
      s = { videos_30d: 0, watched_30d: 0, last_send_at: null, last_send_ts: 0 };
      sendStats.set(v.rooftop_id, s);
    }
    const ts = new Date(v.sent_at).getTime();
    if (ts >= since30) {
      s.videos_30d += 1;
      if ((v.max_watch_pct || 0) > 0) s.watched_30d += 1;
    }
    if (ts > s.last_send_ts) {
      s.last_send_ts = ts;
      s.last_send_at = v.sent_at;
    }
  }

  return (rooftopsQ.data || []).map((r) => {
    const s = sendStats.get(r.id) || { videos_30d: 0, watched_30d: 0, last_send_at: null, last_send_ts: 0 };
    const silentMs = s.last_send_ts ? now - s.last_send_ts : Infinity;
    return {
      id: r.id,
      name: r.name,
      dealer_group: r.dealer_group,
      plan: r.plan,
      subscription_status: r.subscription_status || 'none',
      trial_ends_at: r.trial_ends_at,
      active: r.active,
      created_at: r.created_at,
      rep_count: repCount.get(r.id) || 0,
      videos_30d: s.videos_30d,
      watched_30d: s.watched_30d,
      // null = no sends inside the 60-day lookback
      last_send_at: s.last_send_at,
      mrr_estimate: mrrEstimate(r),
      pipeline_estimate: pipelineEstimate(r),
      churn_risk: r.subscription_status === 'active' && silentMs > CHURN_SILENT_DAYS * DAY_MS,
    };
  });
}

// ── ROUTES ───────────────────────────────────────────────────

/**
 * GET /api/platform/accounts
 * Every rooftop with rep counts, 30-day send stats, MRR estimate,
 * and churn-risk flag. 3 DB queries total regardless of account count.
 */
router.get('/accounts', async (req, res) => {
  try {
    const accounts = await loadAccounts();
    res.json({
      accounts,
      meta: {
        send_window_days: SEND_WINDOW_DAYS,
        last_send_lookback_days: LOOKBACK_DAYS,
        churn_silent_days: CHURN_SILENT_DAYS,
      },
    });
  } catch (err) {
    console.error('[platform] Accounts error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/platform/kpis
 * Platform-wide totals derived from the same aggregation.
 */
router.get('/kpis', async (req, res) => {
  try {
    const accounts = await loadAccounts();

    let mrr = 0, pipeline = 0, activeCount = 0, trials = 0, pastDue = 0,
      churnRisk = 0, sent30 = 0, watched30 = 0;

    for (const a of accounts) {
      mrr += a.mrr_estimate;
      pipeline += a.pipeline_estimate;
      if (a.subscription_status === 'active') activeCount += 1;
      if (a.subscription_status === 'trialing') trials += 1;
      if (a.subscription_status === 'past_due') pastDue += 1;
      if (a.churn_risk) churnRisk += 1;
      sent30 += a.videos_30d;
      watched30 += a.watched_30d;
    }

    res.json({
      kpis: {
        accounts_total: accounts.length,
        accounts_active: activeCount,
        trials,
        past_due: pastDue,
        mrr,
        pipeline,
        churn_risk: churnRisk,
        videos_30d: sent30,
        // % of 30d sends with any watch activity
        watch_rate_30d: sent30 ? Math.round((watched30 / sent30) * 100) : 0,
        generated_at: new Date().toISOString(),
      },
    });
  } catch (err) {
    console.error('[platform] KPIs error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/platform/account/:id
 * One rooftop in detail: summary + rep roster (with contact info and
 * per-rep 30d sends) + 10 most recent sends.
 */
router.get('/account/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const now = Date.now();
    const since30 = new Date(now - SEND_WINDOW_DAYS * DAY_MS).toISOString();

    const [rooftopQ, repsQ, sends30Q, recentQ] = await Promise.all([
      supabase
        .from('rooftops')
        .select('id, name, dealer_group, plan, subscription_status, trial_ends_at, current_period_end, active, created_at')
        .eq('id', id)
        .maybeSingle(),
      supabase
        .from('reps')
        .select('id, name, nickname, email, phone, role, department, active, photo_url')
        .eq('rooftop_id', id)
        .order('name')
        .limit(500),
      supabase
        .from('videos')
        .select('rep_id, sent_at, max_watch_pct')
        .eq('rooftop_id', id)
        .gte('sent_at', since30)
        .limit(20000),
      supabase
        .from('videos')
        .select('id, short_code, customer_name, vehicle, sent_at, max_watch_pct, reps(name)')
        .eq('rooftop_id', id)
        .not('sent_at', 'is', null)
        .order('sent_at', { ascending: false })
        .limit(10),
    ]);
    if (rooftopQ.error) throw rooftopQ.error;
    if (!rooftopQ.data) return res.status(404).json({ error: 'Account not found' });
    if (repsQ.error) throw repsQ.error;
    if (sends30Q.error) throw sends30Q.error;
    if (recentQ.error) throw recentQ.error;

    const rooftop = rooftopQ.data;
    const sends30 = sends30Q.data || [];
    const recent = recentQ.data || [];

    // Per-rep 30d sends
    const perRep = new Map();
    let watched30 = 0;
    for (const v of sends30) {
      perRep.set(v.rep_id, (perRep.get(v.rep_id) || 0) + 1);
      if ((v.max_watch_pct || 0) > 0) watched30 += 1;
    }

    const lastSendAt = recent[0]?.sent_at || null;
    const silentMs = lastSendAt ? now - new Date(lastSendAt).getTime() : Infinity;

    res.json({
      account: {
        id: rooftop.id,
        name: rooftop.name,
        dealer_group: rooftop.dealer_group,
        plan: rooftop.plan,
        subscription_status: rooftop.subscription_status || 'none',
        trial_ends_at: rooftop.trial_ends_at,
        current_period_end: rooftop.current_period_end,
        active: rooftop.active,
        created_at: rooftop.created_at,
        rep_count: (repsQ.data || []).filter((r) => r.active).length,
        videos_30d: sends30.length,
        watched_30d: watched30,
        last_send_at: lastSendAt,
        mrr_estimate: mrrEstimate(rooftop),
        pipeline_estimate: pipelineEstimate(rooftop),
        churn_risk: rooftop.subscription_status === 'active' && silentMs > CHURN_SILENT_DAYS * DAY_MS,
      },
      reps: (repsQ.data || []).map((r) => ({
        id: r.id,
        name: r.name,
        nickname: r.nickname,
        email: r.email,
        phone: r.phone,
        role: r.role,
        department: r.department,
        active: r.active,
        photo_url: r.photo_url,
        videos_30d: perRep.get(r.id) || 0,
      })),
      recent_sends: recent.map((v) => ({
        id: v.id,
        short_code: v.short_code,
        customer_name: v.customer_name,
        vehicle: v.vehicle,
        sent_at: v.sent_at,
        max_watch_pct: v.max_watch_pct || 0,
        rep_name: v.reps?.name || null,
      })),
    });
  } catch (err) {
    console.error('[platform] Account detail error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

export default router;
