import express from 'express';
import { requireAuth, requireRole } from '../lib/auth.js';
import { supabase } from '../lib/supabase.js';

const router = express.Router();

// The three presentation presets (research §5: preset-with-overrides,
// never a free-form pricing builder).
export const PRICING_MODES = ['one_price', 'three_tier', 'tier_plus_lifetime'];

// What a rooftop gets before it has ever touched the config screen.
// One-Price is the verified universal MPI pattern and the safe default.
const DEFAULT_CONFIG = {
  mode: 'one_price',
  tier_names: ['Good', 'Better', 'Best'],
  category_overrides: {},
  lifetime_enabled: false,
  lifetime_disclosure: null,
  general_disclosure: null,
  financing_enabled: false,
  financing_provider: null,
  financing_min_amount: null,
  financing_disclosure: null,
  version: 0,
};

// The only fields a dealer may edit. rooftop_id / version / updated_by
// are never taken from the body — tenant comes from the session, and
// versioning is owned by the DB triggers in migration 011.
const EDITABLE_FIELDS = [
  'mode', 'tier_names', 'category_overrides',
  'lifetime_enabled', 'lifetime_disclosure', 'general_disclosure',
  'financing_enabled', 'financing_provider', 'financing_min_amount',
  'financing_disclosure',
];

/**
 * Guardrails (research §5): returns an error string, or null when valid.
 * Validates the MERGED config so a partial PUT can never sneak an
 * invalid combination past the checks (e.g. enabling lifetime while a
 * previous request left the disclosure blank).
 */
function validateConfig(cfg) {
  if (!PRICING_MODES.includes(cfg.mode)) {
    return `mode must be one of: ${PRICING_MODES.join(', ')}`;
  }

  if (
    !Array.isArray(cfg.tier_names) ||
    cfg.tier_names.length !== 3 ||
    cfg.tier_names.some(t => typeof t !== 'string' || !t.trim() || t.length > 20)
  ) {
    return 'tier_names must be exactly 3 non-empty strings of 20 characters or fewer';
  }

  if (cfg.category_overrides != null) {
    if (typeof cfg.category_overrides !== 'object' || Array.isArray(cfg.category_overrides)) {
      return 'category_overrides must be an object mapping category → mode, e.g. {"brakes":"three_tier"}';
    }
    for (const [category, mode] of Object.entries(cfg.category_overrides)) {
      if (!PRICING_MODES.includes(mode)) {
        return `category_overrides.${category}: "${mode}" is not a valid mode (${PRICING_MODES.join(', ')})`;
      }
    }
  }

  // Legal guardrail (research §4): a lifetime offer may NEVER be
  // renderable without its disclosure. Publish is blocked, not warned.
  const lifetimeInPlay = cfg.mode === 'tier_plus_lifetime' || !!cfg.lifetime_enabled;
  if (lifetimeInPlay) {
    const disclosure = (cfg.lifetime_disclosure || '').trim();
    if (disclosure.length < 50) {
      return 'lifetime_disclosure is required when lifetime offers are enabled (mode tier_plus_lifetime or lifetime_enabled): provide at least 50 characters covering whose life, parts vs labor, where service must occur, and transferability';
    }
  }

  if (cfg.financing_enabled && !(cfg.financing_disclosure || '').trim()) {
    return 'financing_disclosure is required when financing_enabled is true';
  }

  if (cfg.financing_min_amount != null) {
    const n = Number(cfg.financing_min_amount);
    if (!Number.isFinite(n) || n < 0) {
      return 'financing_min_amount must be a non-negative number';
    }
  }

  return null;
}

/**
 * Reduce a config row to the customer-render shape used by the MPI
 * player payload and the approval archive. Lifetime counts as enabled
 * whenever the preset implies it, so the player never has to reason
 * about mode vs flag.
 */
export function toRenderBlock(cfg) {
  const c = cfg || DEFAULT_CONFIG;
  return {
    mode: c.mode || 'one_price',
    tier_names: Array.isArray(c.tier_names) ? c.tier_names : DEFAULT_CONFIG.tier_names,
    category_overrides: c.category_overrides || {},
    lifetime: {
      enabled: c.mode === 'tier_plus_lifetime' || !!c.lifetime_enabled,
      disclosure: c.lifetime_disclosure || null,
    },
    financing: {
      enabled: !!c.financing_enabled,
      provider: c.financing_provider || null,
      min_amount: c.financing_min_amount != null ? Number(c.financing_min_amount) : null,
      disclosure: c.financing_disclosure || null,
    },
    general_disclosure: c.general_disclosure || null,
  };
}

/**
 * Fetch a rooftop's pricing config reduced to render fields.
 * NEVER throws — customer-facing callers (public MPI payload, approval
 * archive) must degrade to the one_price defaults, not fail.
 */
export async function getPricingRenderBlock(rooftopId) {
  try {
    if (!rooftopId) return toRenderBlock(DEFAULT_CONFIG);
    const { data, error } = await supabase
      .from('rooftop_pricing_configs')
      .select('*')
      .eq('rooftop_id', rooftopId)
      .maybeSingle();
    if (error) throw error;
    return toRenderBlock(data || DEFAULT_CONFIG);
  } catch (err) {
    console.error('[pricing] Render block fell back to one_price defaults:', err.message);
    return toRenderBlock(DEFAULT_CONFIG);
  }
}

/**
 * GET /api/pricing-config
 * The authenticated rep's rooftop config, or the one_price defaults if
 * the rooftop has never saved one (version 0 = "defaults, never saved").
 */
router.get('/', requireAuth(), async (req, res) => {
  try {
    const rooftop_id = req.rep.rooftop_id;

    const { data, error } = await supabase
      .from('rooftop_pricing_configs')
      .select('*')
      .eq('rooftop_id', rooftop_id)
      .maybeSingle();

    if (error) throw error;

    res.json({ config: data || { ...DEFAULT_CONFIG, rooftop_id } });

  } catch (err) {
    console.error('[pricing] Fetch error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * PUT /api/pricing-config
 * Upsert the rooftop's pricing/financing config. Partial bodies are
 * merged over the current row (or the defaults), then the merged result
 * is validated as a whole. Tenant is derived from the authenticated rep,
 * never trusted from the body.
 *
 * Versioning + history: migration 011's triggers bump `version` and
 * snapshot every saved version into pricing_config_history atomically
 * with this write — the route does not (and must not) duplicate that.
 */
router.put('/', requireAuth(), requireRole('admin', 'manager'), async (req, res) => {
  try {
    const rooftop_id = req.rep.rooftop_id;
    const body = req.body || {};

    const { data: existing, error: fetchErr } = await supabase
      .from('rooftop_pricing_configs')
      .select('*')
      .eq('rooftop_id', rooftop_id)
      .maybeSingle();

    if (fetchErr) throw fetchErr;

    // Merge: defaults ← current row ← only the editable fields present
    // in the body.
    const merged = { ...DEFAULT_CONFIG };
    for (const field of EDITABLE_FIELDS) {
      if (existing && existing[field] !== undefined && existing[field] !== null) {
        merged[field] = existing[field];
      }
      if (Object.prototype.hasOwnProperty.call(body, field)) {
        merged[field] = body[field];
      }
    }

    const invalid = validateConfig(merged);
    if (invalid) return res.status(400).json({ error: invalid });

    const row = { rooftop_id, updated_by: req.rep.id };
    for (const field of EDITABLE_FIELDS) row[field] = merged[field];
    if (row.financing_min_amount != null) {
      row.financing_min_amount = Number(row.financing_min_amount);
    }

    const { data: saved, error: saveErr } = await supabase
      .from('rooftop_pricing_configs')
      .upsert(row, { onConflict: 'rooftop_id' })
      .select()
      .single();

    if (saveErr) throw saveErr;

    console.log(`[pricing] Rooftop ${rooftop_id} config saved — mode=${saved.mode} v${saved.version} by rep ${req.rep.id}`);

    res.json({ success: true, config: saved });

  } catch (err) {
    console.error('[pricing] Save error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

export default router;
