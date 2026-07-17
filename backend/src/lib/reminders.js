/**
 * Reminder delivery worker — closes the loop on vehicle_reminders.
 *
 * Reps schedule follow-ups on deferred/declined findings
 * (POST /api/passport/:vehicle_id/findings/:finding_id/followup) and the
 * rows sat in 'scheduled' forever. This worker wakes hourly, picks up
 * reminders that have come due, and texts the customer a deep link to
 * the vehicle's passport, anchored to the specific finding.
 *
 * A reminder comes due two ways:
 *   - due_at:    calendar date has arrived (date-based pass)
 *   - due_miles: the vehicle's latest odometer_readings row has reached
 *     due_miles (mileage-based pass, for due_at-null rows — "follow up
 *     at 45k miles"). No reading yet = not due; the row just waits.
 * Both passes share the exact same delivery path (deliverReminder), so
 * consent, claiming, and attempt bounding are identical.
 *
 * Delivery rules:
 *   - Consent first: every send goes through guardedSms (TCPA opt-out
 *     check). A blocked number cancels the reminder — never retried.
 *   - Retries are durable AND bounded: the row is claimed (attempts +
 *     last_attempt_at, migration 015) BEFORE the SMS goes out, so a
 *     crash or failed status write after the send can never re-text a
 *     customer more than MAX_ATTEMPTS times total. After MAX_ATTEMPTS
 *     failed sends the reminder goes terminal ('failed').
 *   - Every successful send writes a 'reminder_sent' vehicle_events
 *     ledger row (rooftop visibility — reminders are the rooftop's
 *     commercial pipeline).
 *   - One reminder failing must never stall the batch: each row is
 *     processed in its own try/catch.
 *
 * Enabled only when REMINDERS_ENABLED=true (safe deploy default: off).
 */

import { supabase } from './supabase.js';
import { twilioClient, TWILIO_FROM } from './twilio.js';
import { guardedSms } from './consent.js';
import { ensurePassportCode, resolveVehicle, recordEvent, toE164 } from './passport.js';

const DEFAULT_INTERVAL_MS = 60 * 60 * 1000; // hourly
const BATCH_SIZE = 25;
const MAX_ATTEMPTS = 3;
// Mileage pass page cap: dueness can't be expressed in the query (it
// needs a per-vehicle odometer lookup), so not-yet-due rows stay
// 'scheduled' and would starve newer rows if we only ever read the
// first page. Walk up to this many pages per tick instead.
const MAX_MILEAGE_PAGES = 20;

/**
 * Start the background loop. Runs one tick shortly after boot (so a
 * deploy doesn't wait an hour to drain due reminders), then every
 * REMINDER_WORKER_INTERVAL_MS (default hourly).
 */
export function startReminderWorker() {
  const intervalMs = parseInt(process.env.REMINDER_WORKER_INTERVAL_MS) || DEFAULT_INTERVAL_MS;
  console.log(`[reminders] Worker started — checking every ${Math.round(intervalMs / 1000)}s`);

  const tick = async () => {
    try {
      await processDueReminders();
    } catch (err) {
      console.error('[reminders] Tick error:', err.message);
    }
  };

  setTimeout(tick, 15_000).unref?.();
  setInterval(tick, intervalMs);
}

/**
 * One pass: pick up to BATCH_SIZE scheduled reminders whose due_at has
 * arrived (date pass) plus up to BATCH_SIZE whose due_miles has been
 * reached (mileage pass), and deliver each. Exported for tests /
 * manual drains.
 */
export async function processDueReminders() {
  const today = new Date().toISOString().slice(0, 10);

  const { data: due, error } = await supabase
    .from('vehicle_reminders')
    .select('*')
    .eq('status', 'scheduled')
    .lte('due_at', today)
    .lt('attempts', MAX_ATTEMPTS)
    .order('due_at', { ascending: true })
    .limit(BATCH_SIZE);

  if (error) {
    console.error('[reminders] Due query failed:', error.message);
  } else if (due?.length) {
    console.log(`[reminders] ${due.length} reminder(s) due`);
    for (const reminder of due) {
      try {
        await deliverReminder(reminder);
      } catch (err) {
        console.error(`[reminders] Reminder ${reminder.id} delivery error:`, err.message);
        await recordAttemptFailure(reminder, err.message);
      }
    }
  }

  await processMileageDueReminders();
}

/**
 * Mileage pass: scheduled reminders with due_miles set and NO due_at
 * (date-carrying rows already ride the date pass — never double-pick).
 * A reminder is due once the vehicle's latest odometer reading has
 * reached due_miles; vehicles with no reading yet simply aren't due.
 * Pages through ALL scheduled mileage rows (created_at keyset cursor,
 * capped at MAX_MILEAGE_PAGES) — not-yet-due rows stay 'scheduled', so
 * a single first-page read would let 25 old not-due rows starve newer
 * due ones forever. Delivery goes through the same deliverReminder
 * path, so claiming, consent, and MAX_ATTEMPTS bounding are identical
 * to the date pass.
 */
async function processMileageDueReminders() {
  let dueCount = 0;
  let cursor = null; // created_at keyset cursor — offset pagination would skip rows as delivered ones leave the 'scheduled' set

  for (let page = 0; page < MAX_MILEAGE_PAGES; page++) {
    let query = supabase
      .from('vehicle_reminders')
      .select('*')
      .eq('status', 'scheduled')
      .is('due_at', null)
      .not('due_miles', 'is', null)
      .lt('attempts', MAX_ATTEMPTS)
      .order('created_at', { ascending: true })
      .limit(BATCH_SIZE);
    if (cursor) query = query.gt('created_at', cursor);

    const { data: scheduled, error } = await query;
    if (error) {
      console.error('[reminders] Mileage-due query failed:', error.message);
      break;
    }
    if (!scheduled?.length) break;
    cursor = scheduled[scheduled.length - 1].created_at;

    for (const reminder of scheduled) {
      try {
        const miles = await latestOdometerMiles(reminder.vehicle_id);
        if (miles == null || miles < reminder.due_miles) continue; // not due yet — just waits

        dueCount++;
        console.log(`[reminders] Reminder ${reminder.id} mileage-due (${miles} >= ${reminder.due_miles} mi)`);
        await deliverReminder(reminder);
      } catch (err) {
        console.error(`[reminders] Reminder ${reminder.id} delivery error:`, err.message);
        await recordAttemptFailure(reminder, err.message);
      }
    }

    if (scheduled.length < BATCH_SIZE) break; // drained
  }

  if (dueCount) console.log(`[reminders] ${dueCount} mileage-based reminder(s) delivered this tick`);
}

/**
 * Latest odometer reading for a vehicle (odometer_readings is the only
 * mileage source in this schema — vehicles carries no cached miles).
 * Returns miles as a number, or null when no reading exists.
 */
async function latestOdometerMiles(vehicleId) {
  const { data, error } = await supabase
    .from('odometer_readings')
    .select('miles')
    .eq('vehicle_id', vehicleId)
    .order('reading_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return data?.miles ?? null;
}

/**
 * Deliver one reminder end-to-end. The row is atomically claimed
 * (attempts bumped) BEFORE the SMS goes out; post-claim send failures
 * are finalized here, pre-claim failures throw to the caller which
 * routes them through recordAttemptFailure.
 */
async function deliverReminder(reminder) {
  const vehicle = await resolveVehicle(reminder.vehicle_id);
  if (!vehicle) {
    await recordAttemptFailure(reminder, 'vehicle not found');
    return;
  }

  // The finding this follow-up is about (may be null for maintenance_due etc.)
  let finding = null;
  if (reminder.finding_id) {
    const { data } = await supabase
      .from('findings')
      .select('id, name, inspection_id')
      .eq('id', reminder.finding_id)
      .maybeSingle();
    finding = data || null;
  }

  const { phone, customerName } = await resolveRecipient(reminder, vehicle, finding);
  if (!phone) {
    // No deliverable phone yet (ownership may attach later) — count the
    // attempt so the reminder eventually goes terminal instead of spinning.
    await recordAttemptFailure(reminder, 'no customer phone');
    return;
  }

  // Stable per-vehicle passport link, anchored to the finding.
  const passport = await ensurePassportCode(vehicle.id);
  if (!passport?.short_url) {
    await recordAttemptFailure(reminder, 'passport code unavailable');
    return;
  }
  const link = finding ? `${passport.short_url}#finding-${finding.id}` : passport.short_url;

  const dealerName = await rooftopName(reminder.rooftop_id);
  const body = buildSmsBody({ customerName, dealerName, vehicle, finding, link });

  // CLAIM the row BEFORE sending: bump attempts while the row is still
  // 'scheduled' at the attempt count we read. Zero rows updated means
  // another worker/tick already claimed it — skip, never double-text.
  // This makes the send→mark ordering crash-safe: if the process dies
  // (or the mark-sent update fails) after guardedSms, the attempt is
  // already counted, so re-sends are bounded by MAX_ATTEMPTS instead of
  // repeating forever.
  const attempt = (reminder.attempts || 0) + 1;
  const { data: claimed, error: claimErr } = await supabase
    .from('vehicle_reminders')
    .update({ attempts: attempt, last_attempt_at: new Date().toISOString() })
    .eq('id', reminder.id)
    .eq('status', 'scheduled')
    .eq('attempts', reminder.attempts || 0)
    .select('id');
  if (claimErr) throw claimErr;
  if (!claimed?.length) {
    console.log(`[reminders] Reminder ${reminder.id} already claimed elsewhere — skipping`);
    return;
  }
  reminder.attempts = attempt;

  let result;
  try {
    result = await guardedSms(twilioClient, {
      body,
      from: TWILIO_FROM,
      to: phone,
    });
  } catch (err) {
    // The claim above already counted this attempt — finalize the
    // failure here (terminal 'failed' once exhausted) rather than
    // letting the caller's recordAttemptFailure double-bump it.
    console.error(`[reminders] Reminder ${reminder.id} send failed:`, err.message);
    await finalizeClaimedFailure(reminder, err.message);
    return;
  }

  if (result.blocked) {
    // Opted-out number: cancel — retrying would be a TCPA violation.
    console.log(`[reminders] Reminder ${reminder.id} cancelled — recipient opted out`);
    const { error: cancelErr } = await supabase
      .from('vehicle_reminders')
      .update({ status: 'cancelled', last_attempt_at: new Date().toISOString() })
      .eq('id', reminder.id)
      .eq('status', 'scheduled');
    if (cancelErr) {
      // Row stays 'scheduled' but the claim counted the attempt, so the
      // retry is bounded — and guardedSms will block it again anyway.
      console.error(`[reminders] Failed to cancel opted-out reminder ${reminder.id}:`, cancelErr.message);
    }
    return;
  }

  const { error: sentErr } = await supabase
    .from('vehicle_reminders')
    .update({
      status: 'sent',
      last_attempt_at: new Date().toISOString(),
    })
    .eq('id', reminder.id)
    .eq('status', 'scheduled');
  if (sentErr) {
    // SMS went out but the row still says 'scheduled'. The claim already
    // bumped attempts, so any re-send is capped at MAX_ATTEMPTS.
    console.error(`[reminders] Reminder ${reminder.id} sent but status update failed:`, sentErr.message);
  }

  // Ledger the send (fire-and-forget-safe — recordEvent never throws).
  await recordEvent(vehicle.id, {
    event_type: 'reminder_sent',
    rooftop_id: reminder.rooftop_id,
    actor_type: 'system',
    subject_table: 'vehicle_reminders',
    subject_id: reminder.id,
    visibility: 'rooftop',
    payload: {
      kind: reminder.kind,
      finding_id: finding?.id || null,
      finding_name: finding?.name || null,
      sms_sid: result.sid || null,
    },
  });

  console.log(`[reminders] Reminder ${reminder.id} sent (vehicle ${vehicle.id}, sid ${result.sid})`);
}

/**
 * Find who to text: the reminder's attached customer first, then the
 * vehicle's current owner (vehicle_ownerships -> customers ->
 * customer_identities), then the originating inspection's phone.
 * Returns { phone: E.164 | null, customerName }.
 */
async function resolveRecipient(reminder, vehicle, finding) {
  // 1. Customer attached at schedule time.
  if (reminder.customer_id) {
    const { data: customer } = await supabase
      .from('customers')
      .select('id, name, phone, identity_id, customer_identities(phone_e164, name_latest)')
      .eq('id', reminder.customer_id)
      .maybeSingle();
    const phone = toE164(customer?.phone) || customer?.customer_identities?.phone_e164 || null;
    if (phone) return { phone, customerName: customer?.name || customer?.customer_identities?.name_latest || null };
  }

  // 2. Current owner via the ownership span.
  const { data: ownership } = await supabase
    .from('vehicle_ownerships')
    .select('customer_id, customers(id, name, phone, customer_identities(phone_e164, name_latest))')
    .eq('vehicle_id', vehicle.id)
    .is('ended_at', null)
    .maybeSingle();
  const owner = ownership?.customers;
  if (owner) {
    const phone = toE164(owner.phone) || owner.customer_identities?.phone_e164 || null;
    if (phone) return { phone, customerName: owner.name || owner.customer_identities?.name_latest || null };
  }

  // 3. Fallback: the inspection that produced the finding.
  if (finding?.inspection_id) {
    const { data: inspection } = await supabase
      .from('mpi_inspections')
      .select('customer_name, customer_phone')
      .eq('id', finding.inspection_id)
      .maybeSingle();
    const phone = toE164(inspection?.customer_phone);
    if (phone) return { phone, customerName: inspection?.customer_name || null };
  }

  return { phone: null, customerName: null };
}

/** Rooftop display name for the SMS signature (never throws). */
async function rooftopName(rooftopId) {
  if (!rooftopId) return 'your dealership';
  const { data } = await supabase
    .from('rooftops')
    .select('name')
    .eq('id', rooftopId)
    .maybeSingle();
  return data?.name || 'your dealership';
}

function vehicleLabel(vehicle) {
  if (vehicle.display_name) return vehicle.display_name;
  const parts = [vehicle.year, vehicle.make, vehicle.model].filter(Boolean);
  return parts.length ? parts.join(' ') : 'vehicle';
}

function buildSmsBody({ customerName, dealerName, vehicle, finding, link }) {
  const first = (customerName || '').trim().split(/\s+/)[0] || 'there';
  const label = vehicleLabel(vehicle);
  const what = finding?.name
    ? `the ${finding.name} we recommended is now due`
    : `your ${label} is due for service`;
  return `Hi ${first}, this is ${dealerName}. A quick reminder about your ${label}: ${what}. ` +
    `See the details and video on your vehicle report: ${link}`;
}

/**
 * Finalize a send failure on a row we already CLAIMED (attempts and
 * last_attempt_at were bumped by the claim): only flip to terminal
 * 'failed' once MAX_ATTEMPTS is exhausted — never double-count the
 * attempt. Never throws.
 */
async function finalizeClaimedFailure(reminder, reason) {
  const attempts = reminder.attempts || 0;
  try {
    if (attempts >= MAX_ATTEMPTS) {
      const { error } = await supabase
        .from('vehicle_reminders')
        .update({ status: 'failed' })
        .eq('id', reminder.id)
        .eq('status', 'scheduled');
      if (error) throw error;
    }
    console.warn(`[reminders] Reminder ${reminder.id} attempt ${attempts}/${MAX_ATTEMPTS} failed (${reason})${attempts >= MAX_ATTEMPTS ? ' — giving up' : ''}`);
  } catch (err) {
    console.error(`[reminders] Failed to finalize attempt for ${reminder.id}:`, err.message);
  }
}

/**
 * Bump attempts / last_attempt_at; flip to terminal 'failed' once
 * MAX_ATTEMPTS is exhausted. Never throws. For UNCLAIMED rows only
 * (pre-claim failures) — claimed rows go through finalizeClaimedFailure.
 */
async function recordAttemptFailure(reminder, reason) {
  try {
    const attempts = (reminder.attempts || 0) + 1;
    const update = { attempts, last_attempt_at: new Date().toISOString() };
    if (attempts >= MAX_ATTEMPTS) update.status = 'failed';

    const { error } = await supabase
      .from('vehicle_reminders')
      .update(update)
      .eq('id', reminder.id)
      .eq('status', 'scheduled');
    if (error) throw error;

    console.warn(`[reminders] Reminder ${reminder.id} attempt ${attempts}/${MAX_ATTEMPTS} failed (${reason})${update.status === 'failed' ? ' — giving up' : ''}`);
  } catch (err) {
    console.error(`[reminders] Failed to record attempt for ${reminder.id}:`, err.message);
  }
}
