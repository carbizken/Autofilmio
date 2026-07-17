// Vehicle stock-image lookup — resolves a VIN or year/make/model to a
// studio-style stock photo URL (white background, shadow underneath)
// for the customer MPI header and Passport card.
//
// Pluggable providers, selected by VEHICLE_IMAGE_PROVIDER:
//   marketcheck (default) — MarketCheck listings API, needs MARKETCHECK_API_KEY
//   evox                  — EVOX stock imagery, needs EVOX_API_KEY (stub until keys arrive)
//   none                  — disabled, always resolves null
//
// Lookups NEVER throw and NEVER block callers on failure: any provider
// error, timeout, or missing key resolves to null so RO creation is
// unaffected. Results (including nulls) are cached in-memory for 24h.

const PROVIDER = (process.env.VEHICLE_IMAGE_PROVIDER || 'marketcheck').toLowerCase();
const TIMEOUT_MS = parseInt(process.env.VEHICLE_IMAGE_TIMEOUT_MS || '8000');
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

const cache = new Map(); // key → { url, expires }

function cacheGet(key) {
  const hit = cache.get(key);
  if (!hit) return undefined;
  if (Date.now() > hit.expires) { cache.delete(key); return undefined; }
  return hit.url;
}

function cacheSet(key, url) {
  // Cap the map so a VIN-scan burst can't grow it unbounded
  if (cache.size > 5000) cache.clear();
  cache.set(key, { url, expires: Date.now() + CACHE_TTL_MS });
}

async function fetchWithTimeout(url, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Parse a free-text vehicle string ("2025 Honda Accord Sport") into
 * { year, make, model } best-effort. Returns null if unparseable.
 */
export function parseVehicleString(vehicle) {
  if (!vehicle || typeof vehicle !== 'string') return null;
  const m = vehicle.trim().match(/^(\d{4})\s+(\S+)\s+(.+)$/);
  if (!m) return null;
  return { year: m[1], make: m[2], model: m[3] };
}

// --- MarketCheck ------------------------------------------------------------

async function marketcheckLookup({ vin, year, make, model }) {
  const key = process.env.MARKETCHECK_API_KEY;
  if (!key) {
    console.log('[vehicle-image] MARKETCHECK_API_KEY not set — skipping lookup');
    return null;
  }

  const base = 'https://mc-api.marketcheck.com/v2';
  let url;
  if (vin) {
    // Active + historical listings for this exact VIN — best photo match
    url = `${base}/search/car/active?api_key=${key}&vin=${encodeURIComponent(vin)}&rows=1&include_relevant_links=false`;
  } else if (year && make && model) {
    url = `${base}/search/car/active?api_key=${key}&year=${encodeURIComponent(year)}&make=${encodeURIComponent(make)}&model=${encodeURIComponent(model)}&rows=1&photo_links=true`;
  } else {
    return null;
  }

  const resp = await fetchWithTimeout(url);
  if (!resp.ok) {
    console.log(`[vehicle-image] MarketCheck ${resp.status} for ${vin || `${year} ${make} ${model}`}`);
    return null;
  }
  const data = await resp.json();
  const listing = data?.listings?.[0];
  const photo =
    listing?.media?.photo_links?.[0] ||
    listing?.build?.photo_links?.[0] ||
    null;
  return photo || null;
}

// --- EVOX (stub — preferred long-term: true studio shots, white bg + floor shadow)

async function evoxLookup({ vin, year, make, model }) {
  const key = process.env.EVOX_API_KEY;
  if (!key) {
    console.log('[vehicle-image] EVOX_API_KEY not set — skipping lookup');
    return null;
  }
  // TODO: wire EVOX vehicle imagery API once account/keys are provisioned.
  // EVOX resolves year/make/model (or VIN via decode) → studio PNGs with
  // transparent/white background and baked-in floor shadow.
  console.log('[vehicle-image] EVOX provider not yet implemented');
  return null;
}

// --- Public API ---------------------------------------------------------------

/**
 * Resolve a stock image URL for a vehicle. Accepts { vin, vehicle } or
 * { vin, year, make, model }. Resolves to a URL string or null — never throws.
 */
export async function getVehicleImage({ vin, vehicle, year, make, model } = {}) {
  try {
    if (PROVIDER === 'none') return null;

    if (!year && vehicle) {
      const parsed = parseVehicleString(vehicle);
      if (parsed) ({ year, make, model } = parsed);
    }
    if (!vin && !(year && make && model)) return null;

    const cacheKey = vin
      ? `vin:${vin.toUpperCase()}`
      : `ymm:${year}:${make}:${model}`.toLowerCase();
    const cached = cacheGet(cacheKey);
    if (cached !== undefined) return cached;

    let url = null;
    if (PROVIDER === 'evox') {
      url = await evoxLookup({ vin, year, make, model });
    } else {
      url = await marketcheckLookup({ vin, year, make, model });
      // VIN miss → fall back to year/make/model class photo
      if (!url && vin && year && make && model) {
        url = await marketcheckLookup({ year, make, model });
      }
    }

    cacheSet(cacheKey, url);
    if (url) console.log(`[vehicle-image] Resolved ${vin || `${year} ${make} ${model}`} → ${url.slice(0, 80)}`);
    return url;
  } catch (err) {
    console.error('[vehicle-image] Lookup failed (non-fatal):', err.message);
    return null;
  }
}

/**
 * Fire-and-forget: resolve an image for a just-created inspection and
 * persist it. Never awaited by the caller, never throws.
 */
export function attachVehicleImage(supabase, { inspectionId, videoId, vin, vehicle }) {
  getVehicleImage({ vin, vehicle })
    .then(async (url) => {
      if (!url) return;
      const updates = [];
      if (inspectionId) {
        updates.push(
          supabase.from('mpi_inspections').update({ vehicle_image_url: url }).eq('id', inspectionId)
        );
      }
      if (videoId) {
        updates.push(
          supabase.from('videos').update({ vehicle_image_url: url }).eq('id', videoId)
        );
      }
      const results = await Promise.allSettled(updates);
      for (const r of results) {
        if (r.status === 'fulfilled' && r.value?.error) {
          console.error('[vehicle-image] Persist failed (non-fatal):', r.value.error.message);
        }
      }
    })
    .catch((err) => console.error('[vehicle-image] Attach failed (non-fatal):', err.message));
}
