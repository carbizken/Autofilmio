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

/**
 * Normalize a raw VIN: uppercase + trim. Returns null unless the result
 * passes the same 17-char shape check the vehicles table enforces.
 */
export function normalizeVin(vin) {
  if (!vin || typeof vin !== 'string') return null;
  const v = vin.trim().toUpperCase();
  return v.length === 17 ? v : null;
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
    const rows = items
      .filter(it => it && (it.name || it.note || it.description))
      .map((it, i) => {
        const severity = VALID.includes(it.status) ? it.status
          : VALID.includes(it.urgency) ? it.urgency
          : 'green';
        const estimate = Number(it.price ?? it.cost ?? NaN);
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
  })().catch(err => console.error('[passport] attachPassport failed (non-fatal):', err.message));
}
