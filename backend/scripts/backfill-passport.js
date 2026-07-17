// ============================================================
// backfill-passport.js — one-time (idempotent, re-runnable)
// migration of legacy mpi_inspections silos into the Vehicle
// Passport spine created by 010_vehicle_passport.sql.
//
//   1. Normalize VINs (upper/trim; 17-char check)
//   2. Create vehicles (dedup by VIN, decode_source='legacy_backfill')
//   3. Link mpi_inspections.vehicle_id
//   4. Explode items jsonb -> findings (backfilled=true, honest
//      visit-level status mapping — no fake per-item precision)
//   5. Synthesize vehicle_events ledger from existing timestamps
//      (payload.backfilled=true) + odometer_readings from mileage
//   6. Ownership: customer_identities by E.164 phone, link the
//      per-rooftop customers row, time-ranged vehicle_ownerships
//
// Usage:
//   node backend/scripts/backfill-passport.js [--dry-run]
//
// Safe to re-run: every step checks for its own prior output and
// skips. Conflicts (overlapping ownership) are flagged for manual
// review, never guessed. Nothing is deleted, ever.
// ============================================================

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, '../.env') });
dotenv.config(); // fallback: cwd .env

// Dynamic import so dotenv runs before supabase.js validates env.
const { supabase } = await import('../src/lib/supabase.js');

const DRY_RUN = process.argv.includes('--dry-run');
const log = (...args) => console.log('[passport]', ...args);

if (DRY_RUN) log('DRY RUN — no writes will be made');

// ── Helpers ─────────────────────────────────────────────────

/** upper/trim; returns null unless it passes the 17-char shape check. */
function normalizeVin(vin) {
  if (!vin || typeof vin !== 'string') return null;
  const v = vin.trim().toUpperCase();
  return v.length === 17 ? v : null;
}

/** Best-effort "2021 Honda Accord Sport" -> { year, make, model }. */
function parseVehicleText(text) {
  if (!text || typeof text !== 'string') return {};
  const m = text.trim().match(/^((?:19|20)\d{2})\s+(\w+)\s+(.+)$/);
  if (!m) return {};
  return { year: parseInt(m[1], 10), make: m[2], model: m[3] };
}

/** Normalized 10-digit US phone (matches customers.phone convention). */
function phone10(phone) {
  if (!phone) return null;
  let d = String(phone).replace(/\D/g, '');
  if (d.length === 11 && d.startsWith('1')) d = d.slice(1);
  return d.length === 10 ? d : null;
}

/** E.164 form for customer_identities.phone_e164. */
function toE164(phone) {
  const d = phone10(phone);
  return d ? `+1${d}` : null;
}

async function insertRow(table, row, label) {
  if (DRY_RUN) {
    log(`(dry-run) insert ${table}:`, label || JSON.stringify(row).slice(0, 120));
    return { ...row, id: row.id || `dry-${table}-${Math.random().toString(36).slice(2, 10)}` };
  }
  const { data, error } = await supabase.from(table).insert(row).select().single();
  if (error) throw new Error(`insert ${table} failed: ${error.message}`);
  return data;
}

async function updateRow(table, id, patch, label) {
  if (DRY_RUN) {
    log(`(dry-run) update ${table} ${id}:`, label || JSON.stringify(patch).slice(0, 120));
    return;
  }
  const { error } = await supabase.from(table).update(patch).eq('id', id);
  if (error) throw new Error(`update ${table} ${id} failed: ${error.message}`);
}

/** Page through every mpi_inspections row. */
async function fetchAllInspections() {
  const rows = [];
  const PAGE = 1000;
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase
      .from('mpi_inspections')
      .select('id, rooftop_id, vin, vehicle, mileage, items, status, approved_amount, approved_at, sent_at, created_at, customer_name, customer_phone, customer_email, vehicle_id, vehicle_image_url')
      .order('created_at', { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) throw new Error(`fetch mpi_inspections failed: ${error.message}`);
    rows.push(...(data || []));
    if (!data || data.length < PAGE) break;
  }
  return rows;
}

// ── Step 1+2: vehicles from VINs ────────────────────────────

async function resolveVehicleForVin(vin, inspections) {
  const { data: existing, error } = await supabase
    .from('vehicles')
    .select('id, vin')
    .eq('vin', vin)
    .maybeSingle();
  if (error) throw new Error(`lookup vehicle ${vin} failed: ${error.message}`);
  if (existing) return { vehicle: existing, created: false };

  // Seed identity fields from the most recent inspection of this VIN.
  const latest = inspections[inspections.length - 1];
  const parsed = parseVehicleText(latest.vehicle);
  const vehicle = await insertRow('vehicles', {
    vin,
    year: parsed.year || null,
    make: parsed.make || null,
    model: parsed.model || null,
    display_name: latest.vehicle || null,
    image_url: latest.vehicle_image_url || null,
    decode_source: 'legacy_backfill',
  }, `vehicle VIN ${vin}`);
  return { vehicle, created: true };
}

// ── Step 4: explode items jsonb -> findings ─────────────────

// Legacy approval was INSPECTION-level (approved_amount, no per-item
// record). Honest mapping: on approved inspections mark red/yellow
// items 'approved'; on declined inspections 'declined'; everything
// else 'recommended'. Green items carry no recommendation to act on,
// so they always stay 'recommended'. All rows backfilled=true — the
// UI renders these as "recorded at visit level", not per-item truth.
function mapItemStatus(itemSeverity, inspectionStatus) {
  if (itemSeverity !== 'red' && itemSeverity !== 'yellow') return 'recommended';
  if (inspectionStatus === 'approved') return 'approved';
  if (inspectionStatus === 'declined') return 'declined';
  return 'recommended';
}

async function backfillFindings(insp, vehicleId) {
  const items = Array.isArray(insp.items) ? insp.items : [];
  if (items.length === 0) return 0;

  if (!DRY_RUN) {
    const { data: already, error } = await supabase
      .from('findings')
      .select('id')
      .eq('inspection_id', insp.id)
      .eq('backfilled', true)
      .limit(1);
    if (error) throw new Error(`findings check failed: ${error.message}`);
    if (already && already.length > 0) return 0; // idempotent skip
  }

  const severities = new Set(['green', 'yellow', 'red']);
  const rows = items
    .map((item, i) => ({ item, i }))
    .filter(({ item }) => item && item.name)
    .map(({ item, i }) => {
      const severity = severities.has(item.status) ? item.status : 'yellow';
      const status = mapItemStatus(severity, insp.status);
      return {
        vehicle_id: vehicleId,
        inspection_id: insp.id,
        rooftop_id: insp.rooftop_id,
        name: String(item.name),
        severity,
        note: item.note || null,
        estimate: item.estimate ?? item.price ?? null,
        status,
        approved_at: status === 'approved' ? insp.approved_at : null,
        // declined_at stays null: legacy data has no per-item decline
        // timestamp and we do not fake precision we never captured.
        backfilled: true,
        source_item_index: i,
        created_at: insp.created_at,
      };
    });
  if (rows.length === 0) return 0;

  if (DRY_RUN) {
    log(`(dry-run) insert ${rows.length} findings for inspection ${insp.id}`);
    return rows.length;
  }
  const { error } = await supabase.from('findings').insert(rows);
  if (error) throw new Error(`insert findings for ${insp.id} failed: ${error.message}`);
  return rows.length;
}

// ── Step 5: synthesize the ledger + odometer readings ───────

async function backfillEvents(insp, vehicleId) {
  if (!DRY_RUN) {
    const { data: already, error } = await supabase
      .from('vehicle_events')
      .select('id')
      .eq('subject_table', 'mpi_inspections')
      .eq('subject_id', insp.id)
      .limit(1);
    if (error) throw new Error(`events check failed: ${error.message}`);
    if (already && already.length > 0) return 0; // idempotent skip
  }

  const base = {
    vehicle_id: vehicleId,
    rooftop_id: insp.rooftop_id,
    actor_type: 'system',
    subject_table: 'mpi_inspections',
    subject_id: insp.id,
    payload: { backfilled: true },
  };
  const events = [];
  if (insp.created_at) events.push({ ...base, event_type: 'inspection_created', occurred_at: insp.created_at });
  if (insp.sent_at) events.push({ ...base, event_type: 'inspection_sent', occurred_at: insp.sent_at });
  if (insp.approved_at) {
    events.push({
      ...base,
      event_type: 'inspection_approved',
      occurred_at: insp.approved_at,
      payload: { backfilled: true, approved_amount: insp.approved_amount },
    });
  }
  if (events.length === 0) return 0;

  if (DRY_RUN) {
    log(`(dry-run) insert ${events.length} vehicle_events for inspection ${insp.id}`);
    return events.length;
  }
  const { error } = await supabase.from('vehicle_events').insert(events);
  if (error) throw new Error(`insert events for ${insp.id} failed: ${error.message}`);
  return events.length;
}

async function backfillOdometer(insp, vehicleId) {
  if (!insp.mileage) return 0;
  if (!DRY_RUN) {
    const { data: already, error } = await supabase
      .from('odometer_readings')
      .select('id')
      .eq('source_inspection_id', insp.id)
      .limit(1);
    if (error) throw new Error(`odometer check failed: ${error.message}`);
    if (already && already.length > 0) return 0;
  }
  await insertRow('odometer_readings', {
    vehicle_id: vehicleId,
    miles: insp.mileage,
    source_inspection_id: insp.id,
    reading_at: insp.created_at,
  }, `odometer ${insp.mileage} mi (inspection ${insp.id})`);
  return 1;
}

// ── Step 6: identities + ownership ──────────────────────────

async function resolveIdentity(e164, insp) {
  const { data: existing, error } = await supabase
    .from('customer_identities')
    .select('id')
    .eq('phone_e164', e164)
    .maybeSingle();
  if (error) throw new Error(`identity lookup ${e164} failed: ${error.message}`);
  if (existing) return existing;
  return insertRow('customer_identities', {
    phone_e164: e164,
    email: insp.customer_email || null,
    name_latest: insp.customer_name || null,
  }, `identity ${e164}`);
}

async function resolveCustomer(insp, identityId) {
  const p10 = phone10(insp.customer_phone);
  const { data: existing, error } = await supabase
    .from('customers')
    .select('id, identity_id')
    .eq('rooftop_id', insp.rooftop_id)
    .eq('phone', p10)
    .maybeSingle();
  if (error) throw new Error(`customer lookup failed: ${error.message}`);
  if (existing) {
    if (!existing.identity_id) {
      await updateRow('customers', existing.id, { identity_id: identityId }, 'link identity');
    }
    return existing;
  }
  // Inspection captured a phone that never reached customers — create
  // the per-rooftop row so the ownership FK has a real target.
  return insertRow('customers', {
    rooftop_id: insp.rooftop_id,
    phone: p10,
    email: insp.customer_email || null,
    name: insp.customer_name || null,
    identity_id: identityId,
    source_product: 'autofilm',
  }, `customer ${p10} @ rooftop ${insp.rooftop_id}`);
}

/**
 * For one vehicle: group its inspections by normalized phone into
 * time-ordered ownership spans. Sequential phones = sequential owners
 * (prior span ended_at = next span started_at, ended_reason 'transfer').
 * Interleaved phones (A, B, A again) = overlapping conflict — flagged
 * for manual review, not guessed.
 */
async function backfillOwnership(vehicleId, inspections) {
  const withPhone = inspections.filter((i) => toE164(i.customer_phone));
  if (withPhone.length === 0) return { created: 0, flagged: false };

  // Build ordered spans of consecutive same-phone usage.
  const spans = [];
  for (const insp of withPhone) {
    const e164 = toE164(insp.customer_phone);
    const last = spans[spans.length - 1];
    if (last && last.e164 === e164) {
      last.lastSeen = insp.created_at;
      last.inspections.push(insp);
    } else {
      spans.push({ e164, firstSeen: insp.created_at, lastSeen: insp.created_at, inspections: [insp] });
    }
  }

  // Interleaving check: a phone that appears in two non-adjacent spans.
  const seen = new Set();
  let flagged = false;
  for (const span of spans) {
    if (seen.has(span.e164)) flagged = true;
    seen.add(span.e164);
  }
  if (flagged) {
    log(`MANUAL REVIEW: vehicle ${vehicleId} has interleaved customer phones across visits — ownership not synthesized`);
    return { created: 0, flagged: true };
  }

  let created = 0;
  for (let s = 0; s < spans.length; s++) {
    const span = spans[s];
    const insp = span.inspections[0];
    const identity = await resolveIdentity(span.e164, insp);
    const customer = await resolveCustomer(insp, identity.id);

    if (!DRY_RUN) {
      const { data: already, error } = await supabase
        .from('vehicle_ownerships')
        .select('id')
        .eq('vehicle_id', vehicleId)
        .eq('customer_id', customer.id)
        .limit(1);
      if (error) throw new Error(`ownership check failed: ${error.message}`);
      if (already && already.length > 0) continue; // idempotent skip
    }

    const isLast = s === spans.length - 1;
    await insertRow('vehicle_ownerships', {
      vehicle_id: vehicleId,
      customer_id: customer.id,
      rooftop_id: insp.rooftop_id,
      source: 'mpi',
      started_at: span.firstSeen,
      ended_at: isLast ? null : spans[s + 1].firstSeen,
      ended_reason: isLast ? null : 'transfer',
    }, `ownership ${span.e164} on vehicle ${vehicleId}`);
    created++;

    if (!isLast && !DRY_RUN) {
      // Ledger the transfer at the moment the next owner appears.
      const { error } = await supabase.from('vehicle_events').insert({
        vehicle_id: vehicleId,
        rooftop_id: insp.rooftop_id,
        event_type: 'ownership_transfer',
        occurred_at: spans[s + 1].firstSeen,
        actor_type: 'system',
        subject_table: 'vehicle_ownerships',
        payload: { backfilled: true },
      });
      if (error) throw new Error(`transfer event failed: ${error.message}`);
    }
  }
  return { created, flagged: false };
}

// ── Main ────────────────────────────────────────────────────

async function main() {
  log('Fetching mpi_inspections...');
  const inspections = await fetchAllInspections();
  log(`${inspections.length} inspections found`);

  const stats = {
    vehiclesCreated: 0, inspectionsLinked: 0, invalidVin: 0, noVin: 0,
    findings: 0, events: 0, odometer: 0, ownerships: 0, flaggedVehicles: 0,
  };

  // Group by valid normalized VIN; handle invalid/missing separately.
  const byVin = new Map();
  const invalidVin = [];
  for (const insp of inspections) {
    const vin = normalizeVin(insp.vin);
    if (vin) {
      if (!byVin.has(vin)) byVin.set(vin, []);
      byVin.get(vin).push(insp);
    } else if (insp.vin && String(insp.vin).trim()) {
      invalidVin.push(insp); // present but malformed — flagged, not rejected
    } else {
      stats.noVin++; // stays unlinked until a VIN is captured (UI nudge)
    }
  }
  log(`${byVin.size} distinct VINs, ${invalidVin.length} malformed VINs, ${stats.noVin} without VIN`);

  // Steps 2-6 per VIN group.
  for (const [vin, group] of byVin) {
    const { vehicle, created } = await resolveVehicleForVin(vin, group);
    if (created) stats.vehiclesCreated++;

    for (const insp of group) {
      if (!insp.vehicle_id) {
        await updateRow('mpi_inspections', insp.id, { vehicle_id: vehicle.id }, `link VIN ${vin}`);
        insp.vehicle_id = vehicle.id;
        stats.inspectionsLinked++;
      }
      stats.findings += await backfillFindings(insp, vehicle.id);
      stats.events += await backfillEvents(insp, vehicle.id);
      stats.odometer += await backfillOdometer(insp, vehicle.id);
    }

    const { created: owns, flagged } = await backfillOwnership(vehicle.id, group);
    stats.ownerships += owns;
    if (flagged) stats.flaggedVehicles++;
  }

  // Malformed-but-present VINs: vehicle row with vin=null, display_name
  // from legacy text, linked to its inspection only. Flagged in the log.
  for (const insp of invalidVin) {
    stats.invalidVin++;
    if (insp.vehicle_id) continue; // already handled on a prior run
    log(`FLAG: inspection ${insp.id} has malformed VIN "${insp.vin}" — creating null-VIN vehicle from "${insp.vehicle || 'unknown'}"`);
    const parsed = parseVehicleText(insp.vehicle);
    const vehicle = await insertRow('vehicles', {
      vin: null,
      year: parsed.year || null,
      make: parsed.make || null,
      model: parsed.model || null,
      display_name: insp.vehicle || null,
      image_url: insp.vehicle_image_url || null,
      decode_source: 'legacy_backfill',
    }, `null-VIN vehicle for inspection ${insp.id}`);
    stats.vehiclesCreated++;
    await updateRow('mpi_inspections', insp.id, { vehicle_id: vehicle.id }, 'link malformed-VIN inspection');
    insp.vehicle_id = vehicle.id;
    stats.inspectionsLinked++;
    stats.findings += await backfillFindings(insp, vehicle.id);
    stats.events += await backfillEvents(insp, vehicle.id);
    stats.odometer += await backfillOdometer(insp, vehicle.id);
    const { created: owns, flagged } = await backfillOwnership(vehicle.id, [insp]);
    stats.ownerships += owns;
    if (flagged) stats.flaggedVehicles++;
  }

  log('Done.', JSON.stringify(stats));
  // NOTE: supersedes_finding_id is chained forward-only from migration
  // day — historical cross-visit chains are NOT synthesized here
  // (name-matching free-text items is guesswork; a later data-quality
  // pass can propose links for human confirmation).
}

main().catch((err) => {
  console.error('[passport] Backfill failed:', err.message);
  process.exit(1);
});
