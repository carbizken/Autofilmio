// Vehicle value snapshot writer — the missing write side of the
// vehicle_value_snapshots table the passport payload already reads
// (routes/passport.js fetchPassportData). Follows the lib/passport.js
// principles: fire-and-forget-safe (never throws), and every snapshot
// appends a 'value_snapshot' row to the vehicle_events ledger.
//
// AUTOCURB HOOK — where this belongs when a live path exists:
// no appraisal/valuation currently flows through this backend (the only
// AutoCurb integrations are the SSO handoff in routes/auth.js and the
// entitlements bundle). When AutoCurb appraisal data lands here (webhook
// or suite handoff), call
//   captureValueSnapshot(vehicleId, { source: 'autocurb', value, value_low, value_high, odometer })
// from that path without awaiting it — it can never throw or block.
// Until then the only writer is POST /api/passport/:vehicle_id/value-snapshots
// (routes/passport.js).

import { supabase } from './supabase.js';
import { recordEvent } from './passport.js';

// Matches the vehicle_value_snapshots.source comment in migration 010.
export const VALUE_SOURCES = ['autocurb', 'manual', 'kbb'];

/** numeric(10,2)-safe non-negative money value, or null. */
function money(v) {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? Math.round(n * 100) / 100 : null;
}

/**
 * Capture a point-in-time value snapshot for a vehicle:
 * one vehicle_value_snapshots row + one 'value_snapshot' ledger event.
 *
 * A snapshot with no usable value at all is refused (it says nothing),
 * as is an unknown source. Returns the inserted row, or null on any
 * failure — NEVER throws, so callers may fire-and-forget (no await)
 * or await and check for null.
 */
export async function captureValueSnapshot(vehicleId, {
  source, value, value_low, value_high, odometer,
  rooftop_id, actor_type = 'system', actor_id,
} = {}) {
  try {
    if (!vehicleId || !VALUE_SOURCES.includes(source)) return null;

    const val = money(value);
    const low = money(value_low);
    const high = money(value_high);
    if (val == null && low == null && high == null) return null;

    const miles = odometer != null ? parseInt(odometer, 10) : NaN;

    const { data: snapshot, error } = await supabase
      .from('vehicle_value_snapshots')
      .insert({
        vehicle_id: vehicleId,
        source,
        value: val,
        value_low: low,
        value_high: high,
        odometer: Number.isFinite(miles) && miles > 0 ? miles : null,
      })
      .select()
      .single();
    if (error) throw error;

    await recordEvent(vehicleId, {
      event_type: 'value_snapshot',
      rooftop_id: rooftop_id || null,
      actor_type,
      actor_id: actor_id || null,
      subject_table: 'vehicle_value_snapshots',
      subject_id: snapshot.id,
      payload: {
        source,
        value: snapshot.value,
        value_low: snapshot.value_low,
        value_high: snapshot.value_high,
        odometer: snapshot.odometer,
      },
    });

    console.log(`[passport] Value snapshot ${snapshot.id} (${source}) captured for vehicle ${vehicleId}`);
    return snapshot;
  } catch (err) {
    console.error('[passport] captureValueSnapshot failed (non-fatal):', err.message);
    return null;
  }
}
