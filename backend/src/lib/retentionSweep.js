/**
 * Retention sweep — enforces vehicle_media retention as data (gap 9).
 *
 * Migration 010 gave every media row a retention_policy
 * ('retain_forever' | 'retain_2y' | 'retain_90d'), retention_expires_at,
 * and a storage_state lifecycle ('live' | 'cold' | 'purged'). Nothing
 * ever acted on it: expired assets stayed 'live' forever. This worker
 * wakes daily and marks expired rows purged.
 *
 * Design rules (locked in by the passport architecture):
 *   - The ROW is permanent — truth != storage. The sweep only flips
 *     storage_state and stamps purged_at; the passport keeps showing
 *     "video evidence existed" with the cached thumbnail.
 *   - LOG-ONLY FIRST PASS: this deliberately does NOT call the Mux
 *     delete API yet. It logs the mux_asset_id list each tick so the
 *     purge set can be audited before real deletion is wired in
 *     (follow-up: iterate the logged ids through mux.video.assets.delete).
 *   - 'retain_forever' rows are never touched (their expires_at is null,
 *     and the query also excludes the policy explicitly).
 *   - Guarded update: rows are re-matched on storage_state='live' so a
 *     concurrent flip is never clobbered.
 *
 * Enabled only when RETENTION_SWEEP_ENABLED=true (safe deploy default: off).
 */

import { supabase } from './supabase.js';

const DEFAULT_INTERVAL_MS = 24 * 60 * 60 * 1000; // daily
const BATCH_SIZE = 200;
const MAX_BATCHES_PER_TICK = 25; // hard cap: 5k rows/tick, backlog drains across days

// Policy → retention duration. Keep in sync with the
// vehicle_media_retention_check constraint (migration 010).
const POLICY_DURATION_MS = {
  retain_90d: 90 * 24 * 60 * 60 * 1000,
  retain_2y: 2 * 365 * 24 * 60 * 60 * 1000,
  retain_forever: null,
};

/**
 * Compute retention_expires_at for a policy: created_at + policy
 * duration, as an ISO string. 'retain_forever' (or an unknown policy —
 * fail open, never accidentally expire) returns null. Used by the media
 * writer so every new row carries its expiry from birth.
 */
export function retentionExpiresAt(policy = 'retain_2y', createdAt = new Date()) {
  const durationMs = POLICY_DURATION_MS[policy];
  if (durationMs == null) return null;
  return new Date(new Date(createdAt).getTime() + durationMs).toISOString();
}

/**
 * Start the background loop. Runs one tick shortly after boot (so a
 * deploy doesn't wait a day to drain an expired backlog), then every
 * RETENTION_SWEEP_INTERVAL_MS (default daily).
 */
export function startRetentionSweep() {
  const intervalMs = parseInt(process.env.RETENTION_SWEEP_INTERVAL_MS) || DEFAULT_INTERVAL_MS;
  console.log(`[retention] Sweep started — checking every ${Math.round(intervalMs / 1000)}s (log-only: Mux assets are NOT deleted)`);

  const tick = async () => {
    try {
      await sweepExpiredMedia();
    } catch (err) {
      console.error('[retention] Tick error:', err.message);
    }
  };

  setTimeout(tick, 30_000).unref?.();
  setInterval(tick, intervalMs);
}

/**
 * One pass: find vehicle_media rows whose retention window has closed
 * (retention_expires_at < now, storage_state still 'live') and mark
 * them purged. Batched so one huge backlog can't wedge a tick.
 * Exported for tests / manual drains.
 */
export async function sweepExpiredMedia() {
  let totalPurged = 0;
  const muxAssetIds = [];

  for (let batch = 0; batch < MAX_BATCHES_PER_TICK; batch++) {
    const nowIso = new Date().toISOString();

    const { data: expired, error } = await supabase
      .from('vehicle_media')
      .select('id, vehicle_id, mux_asset_id, mux_playback_id, retention_policy, retention_expires_at')
      .eq('storage_state', 'live')
      .neq('retention_policy', 'retain_forever')
      .lt('retention_expires_at', nowIso)
      .order('retention_expires_at', { ascending: true })
      .limit(BATCH_SIZE);

    if (error) {
      console.error('[retention] Expired query failed:', error.message);
      return;
    }
    if (!expired?.length) break;

    // Guarded flip: re-match on storage_state='live' so a row another
    // process already moved (cold/purged) is never clobbered.
    const ids = expired.map(m => m.id);
    const { data: purged, error: updateErr } = await supabase
      .from('vehicle_media')
      .update({ storage_state: 'purged', purged_at: nowIso })
      .in('id', ids)
      .eq('storage_state', 'live')
      .select('id, mux_asset_id');

    if (updateErr) {
      console.error('[retention] Purge update failed:', updateErr.message);
      return;
    }

    totalPurged += purged?.length || 0;
    for (const row of purged || []) {
      if (row.mux_asset_id) muxAssetIds.push(row.mux_asset_id);
    }

    if (expired.length < BATCH_SIZE) break; // drained
  }

  if (!totalPurged) return;

  console.log(`[retention] Marked ${totalPurged} media row(s) purged`);
  // LOG-ONLY FIRST PASS — these Mux assets are the actual-deletion
  // worklist. Deliberately NOT calling the Mux delete API yet; wire
  // mux.video.assets.delete over this list once the purge set is audited.
  if (muxAssetIds.length) {
    console.log(`[retention] Mux assets pending actual deletion (${muxAssetIds.length}, log-only — no Mux delete call made): ${muxAssetIds.join(', ')}`);
  }
}
