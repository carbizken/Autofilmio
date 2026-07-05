/**
 * Workflow management API — CRUD for the drip/automation engine.
 *
 * The engine (lib/workflows.js) already runs: fireWorkflowTrigger()
 * queues rows into workflow_actions, a 60s loop claims + executes them.
 * This router is the missing management surface on top of the
 * `workflows` table the engine reads.
 *
 * ── What the engine actually supports ────────────────────────────
 *
 * Triggers fired anywhere in the codebase:
 *   video_sent        routes/send.js   — right after the SMS goes out
 *   video_watched_75  routes/ping.js   — first time watch crosses 75%
 *   video_unwatched   lib/workflows.js — sent 2+ hours ago, never opened
 *
 * Actions this API exposes (engine executeAction cases):
 *   sms   → 'send_sms'   — templated body, ALWAYS via guardedSms (consent)
 *   email → 'send_email' — standard AutoFilm video email layout
 *                          (sendVideoEmail — the step template is NOT used;
 *                          needs customer_email + short_url in context, so
 *                          it is only offered on the video_unwatched trigger)
 *
 * Template placeholders ({{var}} syntax — exactly what interpolate()
 * in lib/workflows.js substitutes; anything else is rejected here so a
 * literal "{{foo}}" never reaches a customer):
 *   {{first_name}}      derived from customer_name
 *   {{customer_name}} {{customer_phone}} {{vehicle}} {{rep_name}}
 *   {{short_code}}
 *   {{dealer_name}} {{short_url}}   — video_sent + video_unwatched only
 *   {{customer_email}}              — video_unwatched + video_watched_75 only
 *   {{watch_pct}}                   — video_watched_75 only
 *
 * ── Storage model ────────────────────────────────────────────────
 * One `workflows` row per workflow. Multi-step definitions live in
 * action_config.steps = [{ delay_minutes, action, message }] which
 * fireWorkflowTrigger expands into one workflow_action per step.
 * Top-level trigger/delay_minutes/action stay populated (first step)
 * for backward compatibility with legacy single-action rows.
 */

import express from 'express';
import { supabase } from '../lib/supabase.js';
import { requireAuth, requireRole } from '../lib/auth.js';

const router = express.Router();

// Everything here is tenant-scoped config — auth on all routes,
// and the rooftop always comes from the authenticated rep.
router.use(requireAuth());

// ── Engine capabilities (keep in sync with lib/workflows.js) ─────

const TRIGGERS = {
  video_sent: {
    label: 'Video sent',
    placeholders: ['first_name', 'customer_name', 'customer_phone', 'vehicle',
      'rep_name', 'dealer_name', 'short_url', 'short_code'],
    actions: ['sms'], // context has no customer_email → email would always fail
  },
  video_unwatched: {
    label: 'Not watched (2h after send)',
    placeholders: ['first_name', 'customer_name', 'customer_phone', 'customer_email',
      'vehicle', 'rep_name', 'dealer_name', 'short_url', 'short_code'],
    actions: ['sms', 'email'],
  },
  video_watched_75: {
    label: 'Watched 75%+',
    placeholders: ['first_name', 'customer_name', 'customer_phone', 'customer_email',
      'vehicle', 'rep_name', 'watch_pct', 'short_code'],
    actions: ['sms'], // context has no short_url → video email would have a dead CTA
  },
};

const API_TO_ENGINE = { sms: 'send_sms', email: 'send_email' };
const ENGINE_TO_API = { send_sms: 'sms', send_email: 'email', send_push: 'push', crm_task: 'crm_task', send_avatar: 'avatar' };

const MAX_STEPS = 10;
const MAX_DELAY_MINUTES = 60 * 24 * 30; // 30 days
const MAX_TEMPLATE_LENGTH = 1600;       // Twilio long-message ceiling

// ── Validation ───────────────────────────────────────────────────

/**
 * Validate { name, trigger, steps } and return normalized engine steps.
 * Returns { error } or { steps: [{ delay_minutes, action, message }] }.
 */
function validateDefinition({ name, trigger, steps }) {
  if (!name || typeof name !== 'string' || !name.trim() || name.length > 120) {
    return { error: 'name is required (max 120 chars)' };
  }

  const trig = TRIGGERS[trigger];
  if (!trig) {
    return { error: `Unknown trigger "${trigger}". Supported: ${Object.keys(TRIGGERS).join(', ')}` };
  }

  if (!Array.isArray(steps) || !steps.length) {
    return { error: 'steps must be a non-empty array' };
  }
  if (steps.length > MAX_STEPS) {
    return { error: `Too many steps (max ${MAX_STEPS})` };
  }

  const normalized = [];
  for (let i = 0; i < steps.length; i++) {
    const s = steps[i] || {};
    const n = i + 1;

    const delay = Number(s.delay_minutes);
    if (!Number.isInteger(delay) || delay < 0 || delay > MAX_DELAY_MINUTES) {
      return { error: `Step ${n}: delay_minutes must be an integer 0–${MAX_DELAY_MINUTES}` };
    }

    if (!trig.actions.includes(s.action)) {
      return { error: `Step ${n}: action "${s.action}" is not supported for trigger "${trigger}" (allowed: ${trig.actions.join(', ')})` };
    }

    const template = typeof s.template === 'string' ? s.template.trim() : '';
    if (s.action === 'sms') {
      if (!template) return { error: `Step ${n}: SMS steps need a message template` };
      if (template.length > MAX_TEMPLATE_LENGTH) {
        return { error: `Step ${n}: template too long (max ${MAX_TEMPLATE_LENGTH} chars)` };
      }
      // Only allow placeholders the engine will actually have in context
      // for this trigger — anything else would reach the customer literally.
      const bad = [...template.matchAll(/\{\{(\w+)\}\}/g)]
        .map(m => m[1])
        .filter(k => !trig.placeholders.includes(k));
      if (bad.length) {
        return { error: `Step ${n}: unknown placeholder(s) ${bad.map(k => `{{${k}}}`).join(', ')} — available for this trigger: ${trig.placeholders.map(k => `{{${k}}}`).join(', ')}` };
      }
    }

    normalized.push({
      delay_minutes: delay,
      action: API_TO_ENGINE[s.action],
      // Engine's send_sms reads action_config.message. Email uses the
      // standard video email layout; message kept for display only.
      message: template,
    });
  }

  return { steps: normalized };
}

/** Row → API shape (steps back in API vocabulary). */
function serialize(wf, stats = {}) {
  const raw = Array.isArray(wf.action_config?.steps) && wf.action_config.steps.length
    ? wf.action_config.steps
    : [{ delay_minutes: wf.delay_minutes || 0, action: wf.action, message: wf.action_config?.message || '' }];

  return {
    id: wf.id,
    name: wf.name,
    description: wf.description || null,
    trigger: wf.trigger,
    trigger_label: TRIGGERS[wf.trigger]?.label || wf.trigger,
    enabled: !!wf.active,
    steps: raw.map(s => ({
      delay_minutes: s.delay_minutes || 0,
      action: ENGINE_TO_API[s.action] || s.action,
      template: s.message || '',
    })),
    executions_30d: stats.completed || 0,
    pending_actions: stats.pending || 0,
    created_at: wf.created_at,
  };
}

/** Fetch a workflow, enforcing rooftop ownership. */
async function findOwned(id, rooftopId) {
  const { data, error } = await supabase
    .from('workflows')
    .select('*')
    .eq('id', id)
    .eq('rooftop_id', rooftopId)
    .maybeSingle();
  if (error) throw error;
  return data;
}

/** Cancel queued-but-unexecuted actions for a workflow. */
async function cancelPendingActions(workflowId) {
  const { data, error } = await supabase
    .from('workflow_actions')
    .update({ status: 'cancelled' })
    .eq('workflow_id', workflowId)
    .eq('status', 'pending')
    .select('id');
  if (error) throw error;
  return data?.length || 0;
}

// ── Routes ───────────────────────────────────────────────────────

/**
 * GET /api/workflows
 * List this rooftop's workflows with step summaries, enabled state,
 * and 30-day execution counts from the workflow_actions queue.
 */
router.get('/', async (req, res) => {
  try {
    const rooftop_id = req.rep.rooftop_id;

    const { data: workflows, error } = await supabase
      .from('workflows')
      .select('*')
      .eq('rooftop_id', rooftop_id)
      .order('created_at', { ascending: false });
    if (error) throw error;

    // 30d stats in one query, bucketed in memory.
    const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    const { data: actions } = await supabase
      .from('workflow_actions')
      .select('workflow_id, status')
      .eq('rooftop_id', rooftop_id)
      .gte('created_at', since)
      .limit(5000);

    const stats = {};
    for (const a of (actions || [])) {
      if (!a.workflow_id) continue;
      const s = (stats[a.workflow_id] ||= { completed: 0, pending: 0 });
      if (a.status === 'completed') s.completed++;
      else if (a.status === 'pending') s.pending++;
    }

    res.json({ workflows: (workflows || []).map(wf => serialize(wf, stats[wf.id])) });
  } catch (err) {
    console.error('[workflows] List error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/workflows  (admin/manager)
 * Create a workflow: { name, trigger, steps: [{ delay_minutes, action, template }] }
 */
router.post('/', requireRole('admin', 'manager'), async (req, res) => {
  try {
    const { name, trigger, steps, description } = req.body || {};

    const v = validateDefinition({ name, trigger, steps });
    if (v.error) return res.status(400).json({ error: v.error });

    const { data: wf, error } = await supabase
      .from('workflows')
      .insert({
        rooftop_id: req.rep.rooftop_id,
        name: name.trim(),
        description: typeof description === 'string' ? description.slice(0, 500) : null,
        trigger,
        // First step mirrored to the legacy top-level columns; the engine
        // executes from action_config.steps when present.
        delay_minutes: v.steps[0].delay_minutes,
        action: v.steps[0].action,
        action_config: { steps: v.steps },
        active: true,
      })
      .select('*')
      .single();
    if (error) throw error;

    console.log(`[workflows] Created "${wf.name}" (${trigger}, ${v.steps.length} step(s)) for rooftop ${req.rep.rooftop_id}`);
    res.status(201).json({ workflow: serialize(wf) });
  } catch (err) {
    console.error('[workflows] Create error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * PUT /api/workflows/:id  (admin/manager)
 * Update name / trigger / steps / enabled. Ownership enforced by rooftop.
 * Disabling also cancels any already-queued pending actions.
 */
router.put('/:id', requireRole('admin', 'manager'), async (req, res) => {
  try {
    const existing = await findOwned(req.params.id, req.rep.rooftop_id);
    if (!existing) return res.status(404).json({ error: 'Workflow not found' });

    const { name, trigger, steps, enabled, description } = req.body || {};
    const update = {};

    // If steps or trigger change, re-validate the whole definition
    // (placeholder availability depends on the trigger).
    if (steps !== undefined || trigger !== undefined) {
      const nextTrigger = trigger !== undefined ? trigger : existing.trigger;
      const nextSteps = steps !== undefined
        ? steps
        : serialize(existing).steps; // re-validate existing steps against a new trigger
      const v = validateDefinition({
        name: name !== undefined ? name : existing.name,
        trigger: nextTrigger,
        steps: nextSteps,
      });
      if (v.error) return res.status(400).json({ error: v.error });
      update.trigger = nextTrigger;
      update.delay_minutes = v.steps[0].delay_minutes;
      update.action = v.steps[0].action;
      update.action_config = { steps: v.steps };
    }

    if (name !== undefined) {
      if (typeof name !== 'string' || !name.trim() || name.length > 120) {
        return res.status(400).json({ error: 'name is required (max 120 chars)' });
      }
      update.name = name.trim();
    }
    if (description !== undefined) {
      update.description = typeof description === 'string' ? description.slice(0, 500) : null;
    }
    if (enabled !== undefined) update.active = !!enabled;

    if (!Object.keys(update).length) {
      return res.status(400).json({ error: 'Nothing to update' });
    }

    const { data: wf, error } = await supabase
      .from('workflows')
      .update(update)
      .eq('id', existing.id)
      .eq('rooftop_id', req.rep.rooftop_id)
      .select('*')
      .single();
    if (error) throw error;

    // Turning a workflow off should stop messages already in the queue.
    if (enabled === false) {
      const n = await cancelPendingActions(existing.id);
      if (n) console.log(`[workflows] Disabled "${wf.name}" — cancelled ${n} pending action(s)`);
    }

    console.log(`[workflows] Updated "${wf.name}" (${wf.id})`);
    res.json({ workflow: serialize(wf) });
  } catch (err) {
    console.error('[workflows] Update error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * DELETE /api/workflows/:id  (admin/manager)
 * Cancels pending queued actions, then deletes the row
 * (workflow_actions.workflow_id is ON DELETE CASCADE).
 */
router.delete('/:id', requireRole('admin', 'manager'), async (req, res) => {
  try {
    const existing = await findOwned(req.params.id, req.rep.rooftop_id);
    if (!existing) return res.status(404).json({ error: 'Workflow not found' });

    const cancelled = await cancelPendingActions(existing.id);

    const { error } = await supabase
      .from('workflows')
      .delete()
      .eq('id', existing.id)
      .eq('rooftop_id', req.rep.rooftop_id);
    if (error) throw error;

    console.log(`[workflows] Deleted "${existing.name}" (${existing.id}) — cancelled ${cancelled} pending action(s)`);
    res.json({ success: true, cancelled_pending: cancelled });
  } catch (err) {
    console.error('[workflows] Delete error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

export default router;
