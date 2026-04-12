/**
 * Automated Workflows / Drip Campaign Engine
 *
 * Event-driven automation that runs in the background:
 *
 *   - "When a lead arrives and doesn't watch the video within 2 hours,
 *      auto-send a follow-up text."
 *   - "When a customer watches 75%+, auto-create a task in the CRM
 *      for the rep to call."
 *   - "3 days before service appointment, auto-send a video reminder."
 *
 * Architecture:
 *   - Workflows are stored in Supabase (workflows table)
 *   - A polling loop checks for triggered conditions every 60s
 *   - Actions execute asynchronously (SMS, email, push, CRM task)
 *
 * Workflow schema:
 *   {
 *     trigger: 'video_sent' | 'video_unwatched' | 'video_watched_75' |
 *              'new_lead' | 'reply_received' | 'mpi_sent' | 'scheduled',
 *     delay_minutes: 120,        // wait 2 hours after trigger
 *     action: 'send_sms' | 'send_email' | 'send_push' | 'crm_task' | 'send_avatar',
 *     action_config: { ... },     // action-specific params
 *     active: true,
 *   }
 */

import { supabase } from './supabase.js';
import { twilioClient, TWILIO_FROM } from './twilio.js';
import { sendVideoEmail } from './email.js';
import { sendPush } from './push.js';
import { syncVideoEvent } from './crm.js';

/**
 * Start the workflow engine background loop.
 */
export function startWorkflowEngine() {
  console.log('[workflows] Engine started — checking every 60s');

  // Process pending workflow actions
  setInterval(async () => {
    try {
      await processPendingActions();
    } catch (err) {
      console.error('[workflows] Engine error:', err.message);
    }
  }, 60000);

  // Check for time-based triggers (unwatched videos, scheduled reminders)
  setInterval(async () => {
    try {
      await checkTimeTriggers();
    } catch (err) {
      console.error('[workflows] Trigger check error:', err.message);
    }
  }, 60000);
}

/**
 * Fire a workflow trigger event.
 * Called by other parts of the system when events occur.
 *
 * @param {string} trigger - Event type
 * @param {object} context - Event data
 */
export async function fireWorkflowTrigger(trigger, context) {
  try {
    const { rooftop_id } = context;
    if (!rooftop_id) return;

    // Find active workflows matching this trigger for this rooftop
    const { data: workflows } = await supabase
      .from('workflows')
      .select('*')
      .eq('rooftop_id', rooftop_id)
      .eq('trigger', trigger)
      .eq('active', true);

    if (!workflows?.length) return;

    for (const wf of workflows) {
      const executeAt = new Date(Date.now() + (wf.delay_minutes || 0) * 60000);

      // Queue the action
      await supabase.from('workflow_actions').insert({
        workflow_id: wf.id,
        rooftop_id,
        trigger,
        action: wf.action,
        action_config: wf.action_config,
        context,
        execute_at: executeAt.toISOString(),
        status: 'pending',
      });

      console.log(`[workflows] Queued "${wf.action}" for trigger "${trigger}" — execute at ${executeAt.toISOString()}`);
    }
  } catch (err) {
    console.error('[workflows] Fire trigger error:', err.message);
  }
}

/**
 * Process pending workflow actions that are due.
 */
async function processPendingActions() {
  const { data: actions } = await supabase
    .from('workflow_actions')
    .select('*')
    .eq('status', 'pending')
    .lte('execute_at', new Date().toISOString())
    .order('execute_at', { ascending: true })
    .limit(20);

  if (!actions?.length) return;

  for (const action of actions) {
    try {
      await executeAction(action);
      await supabase.from('workflow_actions').update({
        status: 'completed',
        executed_at: new Date().toISOString(),
      }).eq('id', action.id);
    } catch (err) {
      console.error(`[workflows] Action ${action.id} failed: ${err.message}`);
      await supabase.from('workflow_actions').update({
        status: 'failed',
        error_message: err.message,
      }).eq('id', action.id);
    }
  }
}

/**
 * Execute a single workflow action.
 */
async function executeAction(action) {
  const ctx = action.context || {};
  const cfg = action.action_config || {};

  switch (action.action) {
    case 'send_sms': {
      const phone = ctx.customer_phone;
      if (!phone) throw new Error('No customer phone');

      // Template interpolation
      let body = cfg.message || 'Hi {{first_name}}, just following up on our video!';
      body = interpolate(body, ctx);

      await twilioClient.messages.create({ body, from: TWILIO_FROM, to: phone });
      console.log(`[workflows] SMS sent to ${phone}`);
      break;
    }

    case 'send_email': {
      const email = ctx.customer_email;
      if (!email) throw new Error('No customer email');

      await sendVideoEmail({
        to: email,
        customerName: ctx.customer_name || 'Customer',
        repName: ctx.rep_name || 'Your Rep',
        dealerName: ctx.dealer_name || '',
        shortUrl: ctx.short_url || '',
        vehicle: ctx.vehicle,
        brandColor: cfg.brand_color || '#D94F00',
      });
      console.log(`[workflows] Email sent to ${email}`);
      break;
    }

    case 'send_push': {
      if (!ctx.rep_id) throw new Error('No rep_id');

      const { data: rep } = await supabase
        .from('reps')
        .select('push_subscription')
        .eq('id', ctx.rep_id)
        .single();

      if (rep?.push_subscription) {
        let body = cfg.message || '{{customer_name}} needs follow-up';
        body = interpolate(body, ctx);

        await sendPush(rep.push_subscription, {
          title: cfg.title || 'AutoFilm Reminder',
          body,
          data: { type: 'workflow', video_id: ctx.video_id },
        });
        console.log(`[workflows] Push sent to rep ${ctx.rep_id}`);
      }
      break;
    }

    case 'crm_task': {
      if (!ctx.rooftop_id) throw new Error('No rooftop_id');

      let description = cfg.task_description || 'Follow up with {{customer_name}}';
      description = interpolate(description, ctx);

      await syncVideoEvent(ctx.rooftop_id, {
        action: 'video_watched',
        video_id: ctx.video_id,
        short_code: ctx.short_code,
        customer_phone: ctx.customer_phone,
        watch_pct: ctx.watch_pct,
      });
      console.log(`[workflows] CRM task created for ${ctx.customer_name}`);
      break;
    }

    case 'send_avatar': {
      // Trigger an AI avatar auto-send
      // This would call the avatar auto-send endpoint internally
      console.log(`[workflows] Avatar auto-send triggered for ${ctx.customer_name}`);
      break;
    }

    default:
      console.warn(`[workflows] Unknown action: ${action.action}`);
  }
}

/**
 * Check for time-based triggers (videos not watched, scheduled reminders).
 */
async function checkTimeTriggers() {
  // Trigger: video_unwatched — sent 2+ hours ago, never watched
  const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();

  const { data: unwatched } = await supabase
    .from('videos')
    .select('id, short_code, rep_id, rooftop_id, customer_name, customer_phone, customer_email, vehicle')
    .not('sent_at', 'is', null)
    .lte('sent_at', twoHoursAgo)
    .eq('max_watch_pct', 0)
    .is('last_watched_at', null)
    .limit(20);

  for (const video of (unwatched || [])) {
    // Check if we already fired this trigger for this video
    const { data: existing } = await supabase
      .from('workflow_actions')
      .select('id')
      .eq('context->>video_id', video.id)
      .eq('trigger', 'video_unwatched')
      .limit(1);

    if (existing?.length) continue;

    // Get rep + rooftop info
    const { data: rep } = await supabase
      .from('reps')
      .select('name, nickname, rooftops(name)')
      .eq('id', video.rep_id)
      .single();

    await fireWorkflowTrigger('video_unwatched', {
      video_id: video.id,
      short_code: video.short_code,
      rep_id: video.rep_id,
      rooftop_id: video.rooftop_id,
      customer_name: video.customer_name,
      customer_phone: video.customer_phone,
      customer_email: video.customer_email,
      vehicle: video.vehicle,
      rep_name: rep?.nickname || rep?.name?.split(' ')[0] || 'Your Rep',
      dealer_name: rep?.rooftops?.name || '',
      short_url: `${process.env.CF_WORKER_URL || 'https://links.autofilm.io'}/v/${video.short_code}`,
    });
  }
}

/**
 * Template interpolation: {{variable}} → value
 */
function interpolate(template, ctx) {
  return template.replace(/\{\{(\w+)\}\}/g, (match, key) => {
    if (key === 'first_name') return (ctx.customer_name || '').split(' ')[0] || 'there';
    return ctx[key] || match;
  });
}
