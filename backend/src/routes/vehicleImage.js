import express from 'express';
import { requireAuth } from '../lib/auth.js';
import { supabase } from '../lib/supabase.js';
import { getVehicleImage } from '../lib/vehicleImage.js';

const router = express.Router();

/**
 * GET /api/vehicle-image?vin=...        (or ?year=&make=&model= or ?vehicle=)
 * Resolve a stock photo URL for a vehicle. Used by the rep app to preview
 * the image while an RO is being written up.
 */
router.get('/', requireAuth(), async (req, res) => {
  try {
    const { vin, vehicle, year, make, model } = req.query;
    if (!vin && !vehicle && !(year && make && model)) {
      return res.status(400).json({ error: 'vin, vehicle, or year+make+model required' });
    }
    const image_url = await getVehicleImage({ vin, vehicle, year, make, model });
    res.json({ image_url }); // null = no image found; frontend keeps its placeholder
  } catch (err) {
    console.error('[vehicle-image] Route error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/vehicle-image/backfill
 * Backfill vehicle_image_url on this rooftop's existing inspections that
 * are missing one. Body: { limit? } (default 25, max 100).
 */
router.post('/backfill', requireAuth(), async (req, res) => {
  try {
    const rooftopId = req.rep.rooftop_id;
    const limit = Math.min(parseInt(req.body?.limit) || 25, 100);

    const { data: rows, error } = await supabase
      .from('mpi_inspections')
      .select('id, vin, vehicle')
      .eq('rooftop_id', rooftopId)
      .is('vehicle_image_url', null)
      .order('created_at', { ascending: false })
      .limit(limit);

    if (error) throw error;

    let updated = 0;
    for (const row of rows || []) {
      const url = await getVehicleImage({ vin: row.vin, vehicle: row.vehicle });
      if (!url) continue;
      const { error: upErr } = await supabase
        .from('mpi_inspections')
        .update({ vehicle_image_url: url })
        .eq('id', row.id);
      if (!upErr) updated++;
    }

    console.log(`[vehicle-image] Backfill: ${updated}/${rows?.length || 0} inspections updated for rooftop ${rooftopId}`);
    res.json({ success: true, scanned: rows?.length || 0, updated });
  } catch (err) {
    console.error('[vehicle-image] Backfill error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

export default router;
