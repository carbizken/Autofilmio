// Vehicle Passport helpers — the write-side glue between the existing
// MPI flow and the passport spine (migration 010).
//
// Principles (see passport architecture report):
//   - vehicles is the global spine: one row per physical car, UUID PK,
//     VIN as a unique nullable attribute (17-char check, merged_into dedupe).
//   - vehicle_events is the append-only ledger; current-state tables are
//     caches. Findings inserts/updates write the ledger via DB trigger.
//   - Passport wiring must NEVER fail or delay RO creation: everything
//     here is fire-and-forget-safe (attachPassport never throws).

import { supabase } from './supabase.js';
import { parseVehicleString } from './vehicleImage.js';
import { getThumbnails } from './thumbnail.js';
import { kvPut } from './cloudflare.js';
import { newPassportCode } from './shortcode.js';

const CF_WORKER_URL = process.env.CF_WORKER_URL || 'https://links.autofilm.io';

/**
 * Normalize a raw VIN: uppercase + trim. Returns null unless the result
 * passes the same 17-char shape check the vehicles table enforces.
 */
export function normalizeVin(vin) {
  if (!vin || typeof vin !== 'string') return null;
  const v = vin.trim().toUpperCase();
  return v.length === 17 ? v : null;
}

/** Normalized 10-digit US phone (matches customers.phone convention). */
export function phone10(phone) {
  if (!phone) return null;
  let d = String(phone).replace(/\D/g, '');
  if (d.length === 11 && d.startsWith('1')) d = d.slice(1);
  return d.length === 10 ? d : null;
}

/** E.164 form for customer_identities.phone_e164. */
export function toE164(phone) {
  const d = phone10(phone);
  return d ? `+1${d}` : null;
}

/** Lowercased/trimmed email, or null. */
function normEmail(email) {
  const e = typeof email === 'string' ? email.trim().toLowerCase() : '';
  return e || null;
}

/**
 * Follow the merged_into chain to the canonical vehicles row.
 * Bounded hop count so a bad merge cycle can't loop forever.
 */
export async function resolveVehicle(vehicleId) {
  let id = vehicleId;
  for (let hop = 0; hop < 5; hop++) {
    const { data: vehicle, error } = await supabase
      .from('vehicles')
      .select('*')
      .eq('id', id)
      .single();
    if (error || !vehicle) return null;
    if (!vehicle.merged_into) return vehicle;
    id = vehicle.merged_into;
  }
  return null;
}

/**
 * Find the global vehicles row for a VIN — or create it.
 *
 * - VIN is normalized (upper/trim) and must be exactly 17 chars; anything
 *   else is treated as "no VIN" and the row is keyed on nothing, carrying
 *   only display_name from the free-text vehicle string (flagged, not rejected).
 * - Best-effort year/make/model parse from "2025 Honda Accord Sport".
 * - If mileage is present, an odometer_readings row is inserted (every
 *   mileage observation is ledgered, NMVTIS-style).
 *
 * Returns the vehicles row, or null on failure (never throws).
 */
export async function findOrCreateVehicle({ vin, vehicle, mileage, rooftop_id, inspection_id } = {}) {
  try {
    const vinNorm = normalizeVin(vin);
    let vehicleRow = null;

    // 1. Lookup by normalized VIN (the only reliable identity key).
    if (vinNorm) {
      const { data: existing } = await supabase
        .from('vehicles')
        .select('*')
        .eq('vin_normalized', vinNorm)
        .maybeSingle();
      if (existing) {
        vehicleRow = existing.merged_into
          ? await resolveVehicle(existing.id)
          : existing;
      }
    }

    // 2. Create if missing. Without a VIN we cannot safely match on the
    //    free-text vehicle string (two "2022 Honda Civic"s are two cars),
    //    so a no-VIN inspection always gets its own draft vehicle row —
    //    merged later when a VIN is captured.
    if (!vehicleRow) {
      const parsed = parseVehicleString(vehicle);
      const insert = {
        vin: vinNorm,
        year: parsed ? parseInt(parsed.year) : null,
        make: parsed?.make || null,
        model: parsed?.model || null,
        display_name: vehicle || null,
        decode_source: 'manual',
        decoded_at: parsed ? new Date().toISOString() : null,
      };

      const { data: created, error: insErr } = await supabase
        .from('vehicles')
        .insert(insert)
        .select()
        .single();

      if (insErr) {
        // Unique-VIN race: another request created it first — re-select.
        if (insErr.code === '23505' && vinNorm) {
          const { data: raced } = await supabase
            .from('vehicles')
            .select('*')
            .eq('vin_normalized', vinNorm)
            .maybeSingle();
          vehicleRow = raced || null;
        }
        if (!vehicleRow) throw insErr;
      } else {
        vehicleRow = created;
        console.log(`[passport] Created vehicle ${vehicleRow.id} (${vinNorm || vehicle || 'unidentified'})`);
      }
    }

    // 3. Ledger the mileage observation.
    const miles = mileage != null ? parseInt(mileage) : NaN;
    if (vehicleRow && Number.isFinite(miles) && miles > 0) {
      const { error: odoErr } = await supabase.from('odometer_readings').insert({
        vehicle_id: vehicleRow.id,
        miles,
        source_inspection_id: inspection_id || null,
      });
      if (odoErr) console.error('[passport] Odometer insert failed (non-fatal):', odoErr.message);
      recordEvent(vehicleRow.id, {
        event_type: 'odometer_reading',
        rooftop_id,
        actor_type: 'system',
        subject_table: 'mpi_inspections',
        subject_id: inspection_id || null,
        payload: { miles },
      });
    }

    return vehicleRow;
  } catch (err) {
    console.error('[passport] findOrCreateVehicle failed (non-fatal):', err.message);
    return null;
  }
}

/**
 * Append a row to the vehicle_events ledger. Never throws — a ledger
 * write failure is logged loudly but must not break the calling flow.
 * Returns the inserted event row or null.
 */
export async function recordEvent(vehicleId, {
  event_type, rooftop_id, actor_type = 'system', actor_id,
  subject_table, subject_id, visibility = 'group', payload = {},
} = {}) {
  try {
    if (!vehicleId || !event_type) return null;
    const { data, error } = await supabase
      .from('vehicle_events')
      .insert({
        vehicle_id: vehicleId,
        rooftop_id: rooftop_id || null,
        event_type,
        actor_type,
        actor_id: actor_id || null,
        subject_table: subject_table || null,
        subject_id: subject_id || null,
        visibility,
        payload,
      })
      .select()
      .single();
    if (error) throw error;
    return data;
  } catch (err) {
    console.error(`[passport] recordEvent(${event_type}) failed (non-fatal):`, err.message);
    return null;
  }
}

/**
 * Explode an inspection's items jsonb into findings rows.
 *
 * DUAL-WRITE: items jsonb on mpi_inspections stays exactly as-is — the
 * passport reads findings, legacy surfaces keep reading items.
 * The findings_transition_ledger DB trigger writes one
 * 'finding_recommended' vehicle_events row per insert atomically, so no
 * explicit event insert is needed here.
 *
 * Returns the inserted findings rows ([] on failure — never throws).
 */
export async function explodeFindings(inspection) {
  try {
    if (!inspection?.vehicle_id || !inspection?.rooftop_id) return [];
    const items = Array.isArray(inspection.items) ? inspection.items : [];
    if (items.length === 0) return [];

    const VALID = ['green', 'yellow', 'red'];
    // Optional per-item video timestamps (seconds into the walkaround
    // video) from the tech tool — clip-per-finding capture (migration 013).
    const ts = (v) => {
      const n = Number(v);
      return Number.isFinite(n) && n >= 0 ? n : null;
    };
    const rows = items
      .filter(it => it && (it.name || it.note || it.description))
      .map((it, i) => {
        const severity = VALID.includes(it.status) ? it.status
          : VALID.includes(it.urgency) ? it.urgency
          : 'green';
        const estimate = Number(it.price ?? it.cost ?? NaN);
        const tsStart = ts(it.video_ts_start);
        let tsEnd = ts(it.video_ts_end);
        // An end before (or without) a start is meaningless — drop it.
        if (tsEnd !== null && (tsStart === null || tsEnd <= tsStart)) tsEnd = null;
        return {
          vehicle_id: inspection.vehicle_id,
          inspection_id: inspection.id,
          rooftop_id: inspection.rooftop_id,
          name: it.name || 'Inspection item',
          severity,
          note: it.note || it.description || null,
          estimate: Number.isFinite(estimate) && estimate > 0 ? estimate : null,
          status: 'recommended',
          source_item_index: i,
          video_ts_start: tsStart,
          video_ts_end: tsEnd,
        };
      });

    if (rows.length === 0) return [];

    const { data, error } = await supabase.from('findings').insert(rows).select();
    if (error) throw error;

    console.log(`[passport] Exploded ${data.length} findings for inspection ${inspection.id}`);
    return data || [];
  } catch (err) {
    console.error('[passport] explodeFindings failed (non-fatal):', err.message);
    return [];
  }
}

// Findings still open for a customer decision.
const OPEN_FINDING_STATUSES = ['recommended', 'deferred'];

/**
 * Apply per-item customer decisions to the findings rows of an inspection.
 *
 * dispositions: [{ index?, name?, decision: 'approved'|'declined'|'deferred',
 *                  selected_tier?, selected_tier_price?, deferred_until? }]
 *
 * Matching: source_item_index first (the explodeFindings array position),
 * case-insensitive name fallback. Only open findings (recommended/deferred)
 * transition — approved/completed rows are never flipped back.
 *
 * The findings_transition_ledger DB trigger (migration 010) appends the
 * matching finding_approved / finding_declined / finding_deferred
 * vehicle_events row ATOMICALLY with each status update — no explicit
 * recordEvent here, or the ledger would double-count every transition.
 *
 * Fire-and-forget-safe: never throws, returns the applied transitions
 * ([] on any failure) — a findings write must never break the customer's
 * approval/decline request.
 */
export async function applyFindingDispositions({ inspectionId, dispositions } = {}) {
  try {
    if (!inspectionId || !Array.isArray(dispositions) || dispositions.length === 0) return [];

    const { data: findings, error } = await supabase
      .from('findings')
      .select('id, name, status, source_item_index')
      .eq('inspection_id', inspectionId)
      .is('deleted_at', null);
    if (error) throw error;
    if (!findings || findings.length === 0) return [];

    const byIndex = new Map();
    const byName = new Map();
    for (const f of findings) {
      if (f.source_item_index != null) byIndex.set(f.source_item_index, f);
      const key = typeof f.name === 'string' ? f.name.trim().toLowerCase() : '';
      if (key && !byName.has(key)) byName.set(key, f);
    }

    const VALID = ['approved', 'declined', 'deferred'];
    const applied = [];
    for (const d of dispositions) {
      if (!d || !VALID.includes(d.decision)) continue;

      const idx = Number(d.index ?? d.source_item_index);
      let finding = Number.isInteger(idx) ? byIndex.get(idx) : null;
      if (!finding && typeof d.name === 'string') {
        finding = byName.get(d.name.trim().toLowerCase()) || null;
      }
      if (!finding || !OPEN_FINDING_STATUSES.includes(finding.status)) continue;
      if (finding.status === d.decision) continue; // deferred -> deferred no-op

      const now = new Date().toISOString();
      const update = { status: d.decision };
      if (d.decision === 'approved') update.approved_at = now;
      if (d.decision === 'declined') update.declined_at = now;
      if (d.decision === 'deferred' && typeof d.deferred_until === 'string'
          && /^\d{4}-\d{2}-\d{2}$/.test(d.deferred_until)) {
        update.deferred_until = d.deferred_until;
      }
      if (typeof d.selected_tier === 'string' && d.selected_tier.trim()) {
        update.selected_tier = d.selected_tier.trim().slice(0, 64);
      }
      const tierPrice = Number(d.selected_tier_price);
      if (Number.isFinite(tierPrice) && tierPrice >= 0) {
        update.selected_tier_price = tierPrice;
      }

      const { error: upErr } = await supabase
        .from('findings')
        .update(update)
        .eq('id', finding.id);
      if (upErr) {
        console.error(`[passport] Finding ${finding.id} transition failed (non-fatal):`, upErr.message);
        continue;
      }
      finding.status = d.decision; // keep the local maps honest for duplicate dispositions
      applied.push({
        finding_id: finding.id,
        name: finding.name,
        status: d.decision,
        selected_tier: update.selected_tier || null,
        selected_tier_price: update.selected_tier_price ?? null,
      });
    }

    if (applied.length > 0) {
      console.log(`[passport] Applied ${applied.length} finding disposition(s) for inspection ${inspectionId}`);
    }
    return applied;
  } catch (err) {
    console.error('[passport] applyFindingDispositions failed (non-fatal):', err.message);
    return [];
  }
}

/**
 * Resolve the global customer identity + per-rooftop customers row for
 * an inspection's customer, and keep vehicle_ownerships honest.
 *
 * Identity: customer_identities keyed on E.164 phone (the only reliable
 * cross-rooftop key); email is the fallback when no usable phone exists.
 *
 * Ownership policy (conservative — never guess a transfer):
 *   - No current owner            -> insert one (source 'mpi').
 *   - Same customer row           -> nothing to do.
 *   - Different row, SAME phone   -> same human seen via another rooftop:
 *                                    keep the current owner untouched.
 *   - Phones not comparable       -> keep the current owner untouched.
 *   - Different row, phone DIFFERS-> a new inspection is asserting a new
 *                                    owner: end the old span
 *                                    (ended_reason 'transfer'), insert the
 *                                    new one + ownership_transfer event.
 *
 * Never throws — ownership wiring must never break inspection creation.
 * Returns the current ownership row (or null).
 */
export async function resolveOwnership({ vehicleId, inspection } = {}) {
  try {
    if (!vehicleId || !inspection?.rooftop_id) return null;

    const e164 = toE164(inspection.customer_phone);
    const p10 = phone10(inspection.customer_phone);
    const email = normEmail(inspection.customer_email);
    if (!e164 && !email) return null; // nothing identifiable — no ownership claim

    // ── 1. Global identity (E.164 first, email fallback) ──────────
    let identity = null;
    if (e164) {
      const { data, error } = await supabase
        .from('customer_identities')
        .select('id, merged_into')
        .eq('phone_e164', e164)
        .maybeSingle();
      if (error) throw error;
      identity = data || null;
    }
    if (!identity && !e164 && email) {
      const { data, error } = await supabase
        .from('customer_identities')
        .select('id, merged_into')
        .eq('email', email)
        .order('created_at', { ascending: true })
        .limit(1);
      if (error) throw error;
      identity = data?.[0] || null;
    }
    // Follow merge chain to the canonical identity (bounded).
    for (let hop = 0; identity?.merged_into && hop < 5; hop++) {
      const { data } = await supabase
        .from('customer_identities')
        .select('id, merged_into')
        .eq('id', identity.merged_into)
        .maybeSingle();
      if (!data) break;
      identity = data;
    }
    if (!identity) {
      const { data: created, error: idErr } = await supabase
        .from('customer_identities')
        .insert({
          phone_e164: e164,
          email,
          name_latest: inspection.customer_name || null,
        })
        .select('id, merged_into')
        .single();
      if (idErr) {
        // Unique-phone race: another request created it first — re-select.
        if (idErr.code === '23505' && e164) {
          const { data: raced } = await supabase
            .from('customer_identities')
            .select('id, merged_into')
            .eq('phone_e164', e164)
            .maybeSingle();
          identity = raced || null;
        }
        if (!identity) throw idErr;
      } else {
        identity = created;
        console.log(`[passport] Created identity ${identity.id} (${e164 || email})`);
      }
    }

    // ── 2. Per-rooftop customers row (PII stays store-private) ────
    let customer = null;
    {
      let q = supabase
        .from('customers')
        .select('id, identity_id, phone, email')
        .eq('rooftop_id', inspection.rooftop_id);
      q = p10 ? q.eq('phone', p10) : q.eq('email', email);
      const { data, error } = await q.limit(1);
      if (error) throw error;
      customer = data?.[0] || null;
    }
    if (customer) {
      if (!customer.identity_id) {
        const { error: linkErr } = await supabase
          .from('customers')
          .update({ identity_id: identity.id })
          .eq('id', customer.id);
        if (linkErr) console.error('[passport] identity link failed (non-fatal):', linkErr.message);
      }
    } else {
      const { data: created, error: custErr } = await supabase
        .from('customers')
        .insert({
          rooftop_id: inspection.rooftop_id,
          phone: p10,
          email,
          name: inspection.customer_name || null,
          identity_id: identity.id,
          source_product: 'autofilm',
        })
        .select('id, identity_id, phone, email')
        .single();
      if (custErr) {
        // unique(rooftop_id, phone) race — re-select the winner.
        if (custErr.code === '23505' && p10) {
          const { data: raced } = await supabase
            .from('customers')
            .select('id, identity_id, phone, email')
            .eq('rooftop_id', inspection.rooftop_id)
            .eq('phone', p10)
            .maybeSingle();
          customer = raced || null;
        }
        if (!customer) throw custErr;
      } else {
        customer = created;
      }
    }

    // ── 3. Ownership span ──────────────────────────────────────────
    const { data: current, error: ownErr } = await supabase
      .from('vehicle_ownerships')
      .select('id, customer_id, started_at, customers(phone, email)')
      .eq('vehicle_id', vehicleId)
      .is('ended_at', null)
      .maybeSingle();
    if (ownErr) throw ownErr;

    const insertOwnership = async () => {
      const { data: own, error } = await supabase
        .from('vehicle_ownerships')
        .insert({
          vehicle_id: vehicleId,
          customer_id: customer.id,
          rooftop_id: inspection.rooftop_id,
          source: 'mpi',
        })
        .select('id, customer_id, started_at')
        .single();
      if (error) {
        // one_current_owner unique index race — someone else won; keep theirs.
        if (error.code === '23505') return null;
        throw error;
      }
      return own;
    };

    if (!current) {
      const own = await insertOwnership();
      if (own) console.log(`[passport] Ownership started: vehicle ${vehicleId} -> customer ${customer.id}`);
      return own;
    }

    if (current.customer_id === customer.id) return current;

    const curPhone = phone10(current.customers?.phone);
    const phonesDiffer = p10 && curPhone && p10 !== curPhone;
    if (!phonesDiffer) {
      // Same phone via another rooftop's customer row, or not comparable
      // (a missing phone is not evidence of a transfer) — keep current.
      return current;
    }

    // A new inspection asserts a new owner: end the old span, start the new.
    const { error: endErr } = await supabase
      .from('vehicle_ownerships')
      .update({ ended_at: new Date().toISOString(), ended_reason: 'transfer' })
      .eq('id', current.id)
      .is('ended_at', null);
    if (endErr) throw endErr;

    const own = await insertOwnership();
    if (own) {
      console.log(`[passport] Ownership transfer: vehicle ${vehicleId} -> customer ${customer.id}`);
      await recordEvent(vehicleId, {
        event_type: 'ownership_transfer',
        rooftop_id: inspection.rooftop_id,
        actor_type: 'system',
        subject_table: 'vehicle_ownerships',
        subject_id: own.id,
        payload: {
          previous_customer_id: current.customer_id,
          new_customer_id: customer.id,
          source_inspection_id: inspection.id || null,
        },
      });
    }
    return own;
  } catch (err) {
    console.error('[passport] resolveOwnership failed (non-fatal):', err.message);
    return null;
  }
}

/**
 * Fire-and-forget: attach a just-encoded MPI video to the passport as
 * evidence media. Called from the Mux video.asset.ready webhook — one
 * vehicle_media row (kind 'mpi_video') + one video_attached ledger event.
 *
 * Idempotent: Mux retries webhooks, so an existing media row for the
 * same playback id short-circuits. Never throws, never blocks the
 * webhook response.
 */
export function attachInspectionMedia({ videoId, muxAssetId, muxPlaybackId, duration } = {}) {
  (async () => {
    if (!videoId || !muxPlaybackId) return;

    const { data: video, error: vidErr } = await supabase
      .from('videos')
      .select('id, type, vehicle_id, rooftop_id')
      .eq('id', videoId)
      .maybeSingle();
    if (vidErr) throw vidErr;
    if (!video || video.type !== 'mpi') return;

    const { data: inspection, error: inspErr } = await supabase
      .from('mpi_inspections')
      .select('id, vehicle_id, rooftop_id')
      .eq('video_id', video.id)
      .maybeSingle();
    if (inspErr) throw inspErr;

    // attachPassport links vehicle_id async at creation; by encode time
    // it is almost always set — check both rows before giving up.
    const vehicleId = video.vehicle_id || inspection?.vehicle_id || null;
    const rooftopId = video.rooftop_id || inspection?.rooftop_id || null;
    if (!vehicleId || !rooftopId) {
      console.log(`[passport] No vehicle linked yet for video ${video.id} — media not attached`);
      return;
    }

    // Idempotency guard: one media row per Mux playback id.
    const { data: existing, error: exErr } = await supabase
      .from('vehicle_media')
      .select('id')
      .eq('vehicle_id', vehicleId)
      .eq('mux_playback_id', muxPlaybackId)
      .limit(1);
    if (exErr) throw exErr;
    if (existing && existing.length > 0) return;

    const thumbs = getThumbnails(muxPlaybackId);
    const durationS = Number(duration);
    const { data: media, error: insErr } = await supabase
      .from('vehicle_media')
      .insert({
        vehicle_id: vehicleId,
        inspection_id: inspection?.id || null,
        rooftop_id: rooftopId,
        kind: 'mpi_video',
        mux_asset_id: muxAssetId || null,
        mux_playback_id: muxPlaybackId,
        duration_s: Number.isFinite(durationS) ? Math.round(durationS) : null,
        thumbnail_url: thumbs?.static || null,
      })
      .select()
      .single();
    if (insErr) throw insErr;

    await recordEvent(vehicleId, {
      event_type: 'video_attached',
      rooftop_id: rooftopId,
      actor_type: 'system',
      subject_table: 'vehicle_media',
      subject_id: media.id,
      payload: {
        kind: 'mpi_video',
        inspection_id: inspection?.id || null,
        duration_s: media.duration_s,
      },
    });

    console.log(`[passport] Media ${media.id} attached to vehicle ${vehicleId} (inspection ${inspection?.id || 'n/a'})`);
  })().catch(err => console.error('[passport] attachInspectionMedia failed (non-fatal):', err.message));
}

/**
 * Lazily mint (or fetch) the STABLE per-vehicle passport short link.
 *
 * - passport_code (nanoid 10, migration 014) lives on the canonical
 *   vehicles row and never rotates — video short_codes belong to one
 *   send, this code belongs to the car.
 * - KV: p_<code> -> passport page URL, served by the same CF worker as
 *   the v_ video links (links.autofilm.io/p/<code>). The KV write is
 *   fire-and-forget and re-issued on every ensure, so a failed write
 *   self-heals on the next passport access.
 *
 * Returns { code, short_url, page_url } or null. Never throws.
 */
export async function ensurePassportCode(vehicleId) {
  try {
    const vehicle = await resolveVehicle(vehicleId);
    if (!vehicle) return null;

    let code = vehicle.passport_code || null;
    if (!code) {
      // Guarded update: only claim the code if still unset, so a
      // concurrent mint can't rotate an already-issued code.
      const candidate = newPassportCode();
      const { data: claimed, error: upErr } = await supabase
        .from('vehicles')
        .update({ passport_code: candidate })
        .eq('id', vehicle.id)
        .is('passport_code', null)
        .select('passport_code')
        .maybeSingle();
      if (upErr) throw upErr;
      code = claimed?.passport_code || null;
      if (!code) {
        // Lost the race — read the winner's code.
        const { data: fresh, error: selErr } = await supabase
          .from('vehicles')
          .select('passport_code')
          .eq('id', vehicle.id)
          .single();
        if (selErr) throw selErr;
        code = fresh?.passport_code || null;
      } else {
        console.log(`[passport] Minted passport code ${code} for vehicle ${vehicle.id}`);
      }
    }
    if (!code) return null;

    const pageUrl = `https://autofilm.io/autofilm-passport.html?code=${code}`;
    // Fire-and-forget: a hung CF API must never block a passport view.
    kvPut(`p_${code}`, pageUrl)
      .catch(e => console.warn('[passport] KV write failed (non-fatal):', e.message));

    return { code, short_url: `${CF_WORKER_URL}/p/${code}`, page_url: pageUrl };
  } catch (err) {
    console.error('[passport] ensurePassportCode failed (non-fatal):', err.message);
    return null;
  }
}

/**
 * Fire-and-forget: wire a just-created inspection into the passport.
 * findOrCreateVehicle + vehicle_id on the inspection/video rows +
 * explodeFindings + inspection_created event. Follows the
 * attachVehicleImage pattern — never awaited by the caller, never
 * throws, never delays or fails RO creation.
 */
export function attachPassport({ inspection, videoId, rep_id }) {
  (async () => {
    const vehicleRow = await findOrCreateVehicle({
      vin: inspection.vin,
      vehicle: inspection.vehicle,
      mileage: inspection.mileage,
      rooftop_id: inspection.rooftop_id,
      inspection_id: inspection.id,
    });
    if (!vehicleRow) return;

    const updates = [
      supabase.from('mpi_inspections').update({ vehicle_id: vehicleRow.id }).eq('id', inspection.id),
    ];
    if (videoId) {
      updates.push(supabase.from('videos').update({ vehicle_id: vehicleRow.id }).eq('id', videoId));
    }
    const results = await Promise.allSettled(updates);
    for (const r of results) {
      if (r.status === 'fulfilled' && r.value?.error) {
        console.error('[passport] vehicle_id link failed (non-fatal):', r.value.error.message);
      }
    }

    await recordEvent(vehicleRow.id, {
      event_type: 'inspection_created',
      rooftop_id: inspection.rooftop_id,
      actor_type: 'rep',
      actor_id: rep_id || inspection.rep_id || null,
      subject_table: 'mpi_inspections',
      subject_id: inspection.id,
      payload: {
        ro_number: inspection.ro_number || null,
        vehicle: inspection.vehicle || null,
        mileage: inspection.mileage || null,
        item_count: Array.isArray(inspection.items) ? inspection.items.length : 0,
      },
    });

    await explodeFindings({ ...inspection, vehicle_id: vehicleRow.id });

    // Identity + ownership: resolve/create the global customer identity
    // (E.164 phone, email fallback) and keep the vehicle's ownership span
    // honest (conservative transfer policy — see resolveOwnership).
    await resolveOwnership({ vehicleId: vehicleRow.id, inspection });
  })().catch(err => console.error('[passport] attachPassport failed (non-fatal):', err.message));
}
