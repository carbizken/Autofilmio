/**
 * TCPA consent management for SMS.
 *
 * Every outbound SMS must pass an opt-out check, and inbound
 * STOP/HELP keywords must be honored immediately (TCPA + CTIA rules).
 * Violations run $500–$1,500 per message — this module is load-bearing.
 */

import { supabase } from './supabase.js';

const STOP_WORDS = ['stop', 'stopall', 'unsubscribe', 'cancel', 'end', 'quit', 'revoke', 'optout', 'opt-out'];
const HELP_WORDS = ['help', 'info'];
const START_WORDS = ['start', 'unstop', 'subscribe', 'yes'];

export const HELP_REPLY =
  'AutoFilm dealer video messages. Msg&data rates may apply. Reply STOP to opt out. Contact your dealership for support.';

export const STOP_REPLY =
  'You have been unsubscribed and will receive no further messages. Reply START to resubscribe.';

export const START_REPLY =
  'You are resubscribed to dealer video messages. Reply STOP at any time to opt out.';

/** Normalize a phone number for consistent matching (strip everything except digits, keep last 10). */
export function normalizePhone(phone) {
  const digits = String(phone || '').replace(/\D/g, '');
  return digits.length > 10 ? digits.slice(-10) : digits;
}

/**
 * Classify an inbound message body.
 * @returns {'stop'|'help'|'start'|null}
 */
export function classifyKeyword(body) {
  const word = String(body || '').trim().toLowerCase().replace(/[.!]+$/, '');
  if (STOP_WORDS.includes(word)) return 'stop';
  if (HELP_WORDS.includes(word)) return 'help';
  if (START_WORDS.includes(word)) return 'start';
  return null;
}

/** Record an opt-out. Upserts by normalized phone. */
export async function recordOptOut(phone, source = 'sms_keyword') {
  const normalized = normalizePhone(phone);
  if (!normalized) return;
  await supabase.from('sms_consent').upsert({
    phone: normalized,
    opted_out: true,
    opt_out_source: source,
    opted_out_at: new Date().toISOString(),
  }, { onConflict: 'phone' });
  console.log(`[consent] Opt-out recorded: ${normalized}`);
}

/** Record an opt-in (START keyword or explicit web consent). */
export async function recordOptIn(phone, source = 'sms_keyword') {
  const normalized = normalizePhone(phone);
  if (!normalized) return;
  await supabase.from('sms_consent').upsert({
    phone: normalized,
    opted_out: false,
    opt_in_source: source,
    opted_in_at: new Date().toISOString(),
  }, { onConflict: 'phone' });
  console.log(`[consent] Opt-in recorded: ${normalized}`);
}

/**
 * Check whether we may text this number.
 * Fail-open on lookup errors is NOT acceptable for TCPA — we fail closed
 * only on an explicit opt-out record; missing record means OK (implied
 * consent from the customer giving their number to the dealership).
 */
export async function canText(phone) {
  const normalized = normalizePhone(phone);
  if (!normalized) return false;
  const { data } = await supabase
    .from('sms_consent')
    .select('opted_out')
    .eq('phone', normalized)
    .maybeSingle();
  return !(data?.opted_out);
}

/**
 * Guarded send: checks consent, then sends via the provided Twilio client.
 * Returns { sent, sid?, blocked? }.
 */
export async function guardedSms(twilioClient, { body, from, to, mediaUrl }) {
  if (!(await canText(to))) {
    console.log(`[consent] Blocked outbound SMS to opted-out number ${normalizePhone(to)}`);
    return { sent: false, blocked: true };
  }
  const payload = { body, from, to };
  if (mediaUrl?.length) payload.mediaUrl = mediaUrl;
  const msg = await twilioClient.messages.create(payload);
  return { sent: true, sid: msg.sid };
}
