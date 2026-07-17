import express from 'express';
import { requireAuth } from '../lib/auth.js';
import { supabase } from '../lib/supabase.js';
import { resolveVehicle, recordEvent, ensurePassportCode } from '../lib/passport.js';

const router = express.Router();

// Findings still open for action on the passport surfaces.
const OPEN_STATUSES = ['recommended', 'deferred'];

/**
 * Fetch every passport section for a vehicle in parallel.
 * One truth, two densities: both the dealer and public variants read
 * this same composed data and differ only in what they redact/render.
 */
async function fetchPassportData(vehicleId) {
  const [ownership, findings, timeline, documents, values, reminders, odometer] =
    await Promise.all([
      supabase
        .from('vehicle_ownerships')
        .select('id, customer_id, rooftop_id, source, started_at, customers(id, name, phone, email, rooftop_id)')
        .eq('vehicle_id', vehicleId)
        .is('ended_at', null)
        .maybeSingle(),
      supabase
        .from('findings')
        .select('*')
        .eq('vehicle_id', vehicleId)
        .is('deleted_at', null)
        .order('created_at', { ascending: false }),
      supabase
        .from('vehicle_events')
        .select('*')
        .eq('vehicle_id', vehicleId)
        .order('id', { ascending: false })
        .limit(100),
      supabase
        .from('vehicle_documents')
        .select('id, rooftop_id, inspection_id, doc_type, title, storage_path, sha256, amount, issued_at, visibility, created_at')
        .eq('vehicle_id', vehicleId)
        .is('deleted_at', null)
        .order('issued_at', { ascending: false }),
      supabase
        .from('vehicle_value_snapshots')
        .select('id, source, value_low, value, value_high, odometer, captured_at')
        .eq('vehicle_id', vehicleId)
        .order('captured_at', { ascending: false })
        .limit(24),
      supabase
        .from('vehicle_reminders')
        .select('id, rooftop_id, customer_id, finding_id, kind, due_at, due_miles, status, created_at')
        .eq('vehicle_id', vehicleId)
        .in('status', ['scheduled', 'sent'])
        .order('due_at', { ascending: true }),
      supabase
        .from('odometer_readings')
        .select('miles, reading_at, anomalous')
        .eq('vehicle_id', vehicleId)
        .order('reading_at', { ascending: false })
        .limit(1),
    ]);

  for (const r of [ownership, findings, timeline, documents, values, reminders, odometer]) {
    if (r.error) throw r.error;
  }

  return {
    ownership: ownership.data || null,
    findings: findings.data || [],
    timeline: timeline.data || [],
    documents: documents.data || [],
    values: values.data || [],
    reminders: reminders.data || [],
    latestOdometer: odometer.data?.[0] || null,
  };
}

/**
 * Tenant/group gate for the dealer passport surface: a rep may view a
 * vehicle only when their own rooftop has touched it (events, findings,
 * or an observed ownership), or when a rooftop in the same dealer_group
 * has. Any other vehicle is indistinguishable from "not found".
 */
async function rooftopMayViewVehicle(vehicleId, myRooftopId) {
  const [ev, fi, own] = await Promise.all([
    supabase.from('vehicle_events').select('rooftop_id').eq('vehicle_id', vehicleId).not('rooftop_id', 'is', null),
    supabase.from('findings').select('rooftop_id').eq('vehicle_id', vehicleId),
    supabase.from('vehicle_ownerships').select('rooftop_id').eq('vehicle_id', vehicleId),
  ]);
  for (const r of [ev, fi, own]) {
    if (r.error) throw r.error;
  }

  const touched = new Set(
    [...(ev.data || []), ...(fi.data || []), ...(own.data || [])]
      .map(r => r.rooftop_id)
      .filter(Boolean)
  );
  if (touched.has(myRooftopId)) return true;
  if (touched.size === 0) return false;

  // Group-shared mechanical truth: any touching rooftop in my dealer group.
  const { data: myRooftop, error: rtErr } = await supabase
    .from('rooftops')
    .select('dealer_group')
    .eq('id', myRooftopId)
    .single();
  if (rtErr) throw rtErr;
  if (!myRooftop?.dealer_group) return false;

  const { data: groupmates, error: grpErr } = await supabase
    .from('rooftops')
    .select('id')
    .eq('dealer_group', myRooftop.dealer_group)
    .in('id', [...touched]);
  if (grpErr) throw grpErr;

  return (groupmates || []).length > 0;
}

/** Normalized 10-digit US phone (matches customers.phone convention). */
function phone10(phone) {
  if (!phone) return null;
  let d = String(phone).replace(/\D/g, '');
  if (d.length === 11 && d.startsWith('1')) d = d.slice(1);
  return d.length === 10 ? d : null;
}

/** Lowercased/trimmed email, or null. */
function normEmail(email) {
  const e = typeof email === 'string' ? email.trim().toLowerCase() : '';
  return e || null;
}

/**
 * Health is DERIVED, never authored: score = 100 - 20/red - 5/yellow
 * across open findings, clamped to [0, 100].
 */
function deriveHealth(findings) {
  const open = findings.filter(f => OPEN_STATUSES.includes(f.status));
  const red = open.filter(f => f.severity === 'red').length;
  const yellow = open.filter(f => f.severity === 'yellow').length;
  const green = open.filter(f => f.severity === 'green').length;
  return {
    score: Math.max(0, Math.min(100, 100 - red * 20 - yellow * 5)),
    red,
    yellow,
    green,
    open_count: open.length,
  };
}

function vehicleSummary(vehicle, latestOdometer) {
  return {
    id: vehicle.id,
    vin: vehicle.vin,
    year: vehicle.year,
    make: vehicle.make,
    model: vehicle.model,
    trim: vehicle.trim,
    display_name: vehicle.display_name,
    image_url: vehicle.image_url,
    miles: latestOdometer?.miles ?? null,
    miles_as_of: latestOdometer?.reading_at ?? null,
    created_at: vehicle.created_at,
  };
}

/**
 * Compose the CUSTOMER-SAFE passport payload — shared by the code-gated
 * per-video public variant and the stable /by-code/:code link.
 *
 * - Estimates are visible only for inspection ids in ownInspectionIds
 *   (the requesting customer's own quotes); everything else is redacted.
 * - Rooftop-private events/documents never reach the customer surface;
 *   event actor ids stay internal.
 * - ownerName is the only PII that renders, and callers pass only what
 *   the requester already knows about themselves (or null).
 */
/**
 * Whitelist of ledger payload keys that may reach the UNAUTHENTICATED
 * customer surfaces. Payloads carry capability tokens and internal
 * identifiers — a video short_code plus the event's subject_id
 * (inspection id) is exactly the credential pair for the public
 * /api/mpi view/approve/decline endpoints, and ro_number / customer
 * ids are dealer-internal. Anything not listed here is stripped.
 */
const PUBLIC_PAYLOAD_KEYS = new Set([
  // findings trigger (finding_recommended / finding_<status>)
  'name', 'severity', 'old_status', 'new_status', 'supersedes_finding_id',
  // inspection_created / inspection_sent
  'vehicle', 'mileage', 'item_count', 'via',
  // video_attached / odometer
  'kind', 'duration_s', 'miles',
  // reminder events (rooftop-visibility today, safe if that ever changes)
  'finding_id', 'finding_name', 'due_at', 'due_miles',
]);

/** Strip a ledger event payload down to customer-safe keys. */
function publicEventPayload(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return {};
  return Object.fromEntries(
    Object.entries(payload).filter(([k]) => PUBLIC_PAYLOAD_KEYS.has(k))
  );
}

function customerSafePayload(vehicle, data, { ownInspectionIds = new Set(), ownerName = null } = {}) {
  const customerFinding = (f) => ({
    id: f.id,
    inspection_id: f.inspection_id,
    name: f.name,
    severity: f.severity,
    note: f.note,
    measurements: f.measurements,
    status: f.status,
    estimate: ownInspectionIds.has(f.inspection_id) ? f.estimate : null,
    approved_at: f.approved_at,
    deferred_until: f.deferred_until,
    completed_at: f.completed_at,
    supersedes_finding_id: f.supersedes_finding_id,
    created_at: f.created_at,
  });

  const findings = data.findings.map(customerFinding);
  const openFindings = findings.filter(f => OPEN_STATUSES.includes(f.status));

  const timeline = data.timeline
    .filter(e => e.visibility !== 'rooftop')
    .map(e => ({
      id: e.id,
      event_type: e.event_type,
      occurred_at: e.occurred_at,
      subject_table: e.subject_table,
      subject_id: e.subject_id,
      payload: publicEventPayload(e.payload),
    }));
  const documents = data.documents
    .filter(d => d.visibility === 'customer')
    .map(({ rooftop_id, ...doc }) => doc);

  const owner = data.ownership
    ? { name: ownerName, since: data.ownership.started_at }
    : null;

  return {
    vehicle: vehicleSummary(vehicle, data.latestOdometer),
    owner,
    health: deriveHealth(data.findings),
    open_findings: openFindings,
    timeline,
    documents,
    values: data.values,
    reminders: data.reminders.map(({ customer_id, rooftop_id, ...r }) => r),
  };
}

/**
 * GET /api/passport/by-code/:code
 * The STABLE per-vehicle passport short link target (public, no session).
 * The passport_code itself is the capability token: it is minted lazily
 * (migration 014), handed to the vehicle's current owner, and never
 * rotates. Unlike the per-video public variant there is no customer
 * context, so EVERY estimate is redacted and no owner PII is returned —
 * the strictly customer-safe payload.
 */
router.get('/by-code/:code', async (req, res) => {
  try {
    const { code } = req.params;
    // Same shape the CF worker route matches — reject junk before the DB.
    if (!code || !/^[a-zA-Z0-9]{4,12}$/.test(code)) {
      return res.status(403).json({ error: 'Invalid passport link' });
    }

    const { data: byCode } = await supabase
      .from('vehicles')
      .select('id')
      .eq('passport_code', code)
      .maybeSingle();
    if (!byCode) return res.status(403).json({ error: 'Invalid passport link' });

    // Follow merges: a code minted pre-merge must keep opening the
    // canonical record.
    const vehicle = await resolveVehicle(byCode.id);
    if (!vehicle) return res.status(403).json({ error: 'Invalid passport link' });

    const data = await fetchPassportData(vehicle.id);

    console.log(`[passport] Public view of vehicle ${vehicle.id} via passport code ${code}`);

    res.json(customerSafePayload(vehicle, data));

  } catch (err) {
    console.error('[passport] By-code fetch error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/passport/:vehicle_id
 * The single composed passport payload (B1: one endpoint, one truth —
 * mobile and desktop differ only in how much of it they render).
 *
 * Sharing policy: mechanical truth is group-shared; commercial data
 * (estimates, rooftop-private events/documents, customer PII) is
 * visible only to the owning rooftop.
 */
router.get('/:vehicle_id', requireAuth(), async (req, res) => {
  try {
    const vehicle = await resolveVehicle(req.params.vehicle_id);
    if (!vehicle) return res.status(404).json({ error: 'Vehicle not found' });

    const myRooftop = req.rep.rooftop_id;

    // Tenant/group scoping: only rooftops with a relationship to this
    // vehicle (their own, or via their dealer group) may open its
    // passport — everyone else gets an indistinguishable 404.
    if (!(await rooftopMayViewVehicle(vehicle.id, myRooftop))) {
      return res.status(404).json({ error: 'Vehicle not found' });
    }

    const data = await fetchPassportData(vehicle.id);

    // Customer PII is rooftop-private: only the rooftop that owns the
    // customer relationship sees name/phone/email.
    let owner = null;
    if (data.ownership) {
      const cust = data.ownership.customers;
      const sameRooftop = cust?.rooftop_id === myRooftop;
      owner = {
        customer_id: data.ownership.customer_id,
        since: data.ownership.started_at,
        source: data.ownership.source,
        name: sameRooftop ? cust?.name || null : null,
        phone: sameRooftop ? cust?.phone || null : null,
        email: sameRooftop ? cust?.email || null : null,
      };
    }

    // Estimates are rooftop-private commercial data.
    const redactFinding = (f) => ({
      ...f,
      estimate: f.rooftop_id === myRooftop ? f.estimate : null,
    });

    const findings = data.findings.map(redactFinding);
    const openFindings = findings.filter(f => OPEN_STATUSES.includes(f.status));

    // Rooftop-private events/documents stay inside their rooftop.
    const timeline = data.timeline.filter(
      e => e.visibility !== 'rooftop' || e.rooftop_id === myRooftop
    );
    // Documents: my own rooftop's always; other rooftops' only when
    // explicitly group-shared ('customer' visibility is for the customer
    // surface, not for competing rooftops).
    const documents = data.documents.filter(
      d => d.rooftop_id === myRooftop || d.visibility === 'group'
    );

    // Reminders are the owning rooftop's commercial follow-up pipeline —
    // never shown to other rooftops.
    const reminders = data.reminders.filter(r => r.rooftop_id === myRooftop);

    // Lazily mint (or fetch) the stable per-vehicle short link on first
    // passport access — { code, short_url, page_url } or null, never throws.
    const passportLink = await ensurePassportCode(vehicle.id);

    console.log(`[passport] Composed passport for vehicle ${vehicle.id} (rep ${req.rep.id})`);

    res.json({
      vehicle: vehicleSummary(vehicle, data.latestOdometer),
      owner,
      health: deriveHealth(data.findings),
      open_findings: openFindings,
      timeline,
      documents,
      values: data.values,
      reminders,
      passport_link: passportLink,
    });

  } catch (err) {
    console.error('[passport] Fetch error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/passport/:vehicle_id/public?code=SHORT_CODE
 * Customer-facing passport. No session — like mpi.js /:id/public, the
 * video short_code is the capability token (only the SMS/email recipient
 * knows it), and it must belong to a video linked to THIS vehicle.
 *
 * Customer-safe: no other-owner PII, no rooftop-private commercial data
 * beyond that customer's own quoted/approved amounts.
 */
router.get('/:vehicle_id/public', async (req, res) => {
  try {
    const { code } = req.query;
    if (!code) return res.status(403).json({ error: 'Invalid passport link' });

    const vehicle = await resolveVehicle(req.params.vehicle_id);
    if (!vehicle) return res.status(403).json({ error: 'Invalid passport link' });

    // Capability check: the code must be a video attached to this vehicle.
    const { data: video } = await supabase
      .from('videos')
      .select('id, vehicle_id, customer_name, customer_phone, customer_email, rep_id')
      .eq('short_code', code)
      .maybeSingle();

    if (!video || !video.vehicle_id) {
      return res.status(403).json({ error: 'Invalid passport link' });
    }

    // Compare CANONICAL vehicle ids: after a vehicles merge the video row
    // still holds the pre-merge id, and legitimate links must keep working.
    const videoVehicle = await resolveVehicle(video.vehicle_id);
    if (!videoVehicle || videoVehicle.id !== vehicle.id) {
      return res.status(403).json({ error: 'Invalid passport link' });
    }

    const data = await fetchPassportData(vehicle.id);

    // Ownership transfer revokes old links: when the vehicle has a current
    // owner on record and the video's customer identifiably is NOT that
    // owner (phone/email mismatch), the code no longer opens the passport —
    // the prior owner must not keep reading the new owner's record.
    const currentOwner = data.ownership?.customers;
    if (currentOwner) {
      const vPhone = phone10(video.customer_phone);
      const oPhone = phone10(currentOwner.phone);
      const vEmail = normEmail(video.customer_email);
      const oEmail = normEmail(currentOwner.email);
      const comparable = (vPhone && oPhone) || (vEmail && oEmail);
      const matches =
        (vPhone && oPhone && vPhone === oPhone) ||
        (vEmail && oEmail && vEmail === oEmail);
      if (comparable && !matches) {
        return res.status(403).json({ error: 'Invalid passport link' });
      }
    }

    // The inspections behind THIS customer's video: their own quotes and
    // approved amounts are theirs to see; every other estimate is redacted.
    const { data: ownInspections } = await supabase
      .from('mpi_inspections')
      .select('id')
      .eq('video_id', video.id);
    const ownInspectionIds = new Set((ownInspections || []).map(i => i.id));

    console.log(`[passport] Public view of vehicle ${vehicle.id} via code ${code}`);

    // Customer-safe composition (shared with /by-code/:code). Only THIS
    // customer's own quotes render (estimates gated by ownInspectionIds),
    // and the owner block carries only the recipient's own name (from
    // their video) — never another owner's PII.
    res.json(customerSafePayload(vehicle, data, {
      ownInspectionIds,
      ownerName: video.customer_name || null,
    }));

  } catch (err) {
    console.error('[passport] Public fetch error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/passport/:vehicle_id/findings/:finding_id/followup
 * Schedule a follow-up on a deferred/declined finding: creates a
 * vehicle_reminders row + a reminder_scheduled ledger event.
 *
 * Body: { due_at?: 'YYYY-MM-DD', due_miles?: number, kind?: string }
 */
router.post('/:vehicle_id/findings/:finding_id/followup', requireAuth(), async (req, res) => {
  try {
    const { vehicle_id, finding_id } = req.params;
    const { due_at, due_miles, kind = 'deferred_followup' } = req.body || {};

    const vehicle = await resolveVehicle(vehicle_id);
    if (!vehicle) return res.status(404).json({ error: 'Vehicle not found' });

    const { data: finding } = await supabase
      .from('findings')
      .select('id, vehicle_id, rooftop_id, name, severity, status')
      .eq('id', finding_id)
      .is('deleted_at', null)
      .maybeSingle();

    if (!finding || finding.vehicle_id !== vehicle.id) {
      return res.status(404).json({ error: 'Finding not found' });
    }

    // Tenant isolation: follow-ups are a commercial action — only the
    // rooftop that made the recommendation can schedule one.
    if (finding.rooftop_id !== req.rep.rooftop_id) {
      return res.status(404).json({ error: 'Finding not found' });
    }

    // Attach the current owner so the reminder can be delivered.
    const { data: ownership } = await supabase
      .from('vehicle_ownerships')
      .select('customer_id')
      .eq('vehicle_id', vehicle.id)
      .is('ended_at', null)
      .maybeSingle();

    const { data: reminder, error: remErr } = await supabase
      .from('vehicle_reminders')
      .insert({
        vehicle_id: vehicle.id,
        rooftop_id: req.rep.rooftop_id,
        customer_id: ownership?.customer_id || null,
        finding_id: finding.id,
        kind,
        due_at: due_at || null,
        due_miles: due_miles != null ? parseInt(due_miles) : null,
        status: 'scheduled',
      })
      .select()
      .single();

    if (remErr) throw remErr;

    await recordEvent(vehicle.id, {
      event_type: 'reminder_scheduled',
      rooftop_id: req.rep.rooftop_id,
      actor_type: 'rep',
      actor_id: req.rep.id,
      subject_table: 'vehicle_reminders',
      subject_id: reminder.id,
      visibility: 'rooftop',
      payload: {
        finding_id: finding.id,
        finding_name: finding.name,
        kind,
        due_at: due_at || null,
        due_miles: due_miles != null ? parseInt(due_miles) : null,
      },
    });

    console.log(`[passport] Follow-up scheduled on finding ${finding.id} (vehicle ${vehicle.id})`);

    res.json({ success: true, reminder });

  } catch (err) {
    console.error('[passport] Followup error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

export default router;
