// Unit tests for the pricing render/validation logic in
// routes/pricingConfig.js: toRenderBlock's LIFETIME_OFFERS_ENABLED
// render-time kill switch, and validateConfig's guardrails.
//
// pricingConfig.js transitively imports the env-guarded supabase client,
// so stub the env BEFORE the dynamic import.
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.SUPABASE_URL ||= 'http://localhost:54321';
process.env.SUPABASE_SERVICE_KEY ||= 'test-service-key';

const { toRenderBlock, validateConfig, PRICING_MODES } =
  await import('../src/routes/pricingConfig.js');

// toRenderBlock reads the kill switch at call time — set/restore it
// around each call so tests can't leak state into each other.
function withLifetimeFlag(value, fn) {
  const prev = process.env.LIFETIME_OFFERS_ENABLED;
  if (value === undefined) delete process.env.LIFETIME_OFFERS_ENABLED;
  else process.env.LIFETIME_OFFERS_ENABLED = value;
  try {
    return fn();
  } finally {
    if (prev === undefined) delete process.env.LIFETIME_OFFERS_ENABLED;
    else process.env.LIFETIME_OFFERS_ENABLED = prev;
  }
}

const LIFETIME_CFG = {
  mode: 'tier_plus_lifetime',
  tier_names: ['Good', 'Better', 'Best'],
  category_overrides: { brakes: 'tier_plus_lifetime', tires: 'one_price' },
  lifetime_enabled: true,
  lifetime_disclosure: 'Lifetime brake pad guarantee: covers the original retail purchaser, parts only, service at this dealership, non-transferable.',
  general_disclosure: 'Estimates exclude tax and shop fees.',
  financing_enabled: true,
  financing_provider: 'Sunbit',
  financing_min_amount: '250',
  financing_disclosure: 'Subject to credit approval.',
};

// ── toRenderBlock: kill switch OFF ─────────────────────────────────

test('flag off: tier_plus_lifetime mode downgrades to three_tier', () => {
  withLifetimeFlag('false', () => {
    assert.equal(toRenderBlock(LIFETIME_CFG).mode, 'three_tier');
  });
});

test('flag unset behaves as off', () => {
  withLifetimeFlag(undefined, () => {
    const block = toRenderBlock(LIFETIME_CFG);
    assert.equal(block.mode, 'three_tier');
    assert.equal(block.lifetime.enabled, false);
  });
});

test('flag off: category_overrides downgrade too, other modes untouched', () => {
  withLifetimeFlag('false', () => {
    assert.deepEqual(toRenderBlock(LIFETIME_CFG).category_overrides, {
      brakes: 'three_tier',
      tires: 'one_price',
    });
  });
});

test('flag off: lifetime is disabled and its disclosure is nulled', () => {
  withLifetimeFlag('false', () => {
    const { lifetime } = toRenderBlock(LIFETIME_CFG);
    assert.equal(lifetime.enabled, false);
    assert.equal(lifetime.disclosure, null);
  });
});

test('flag off: lifetime_enabled alone (mode three_tier) is also suppressed', () => {
  withLifetimeFlag('false', () => {
    const { lifetime, mode } = toRenderBlock({ ...LIFETIME_CFG, mode: 'three_tier' });
    assert.equal(mode, 'three_tier');
    assert.equal(lifetime.enabled, false);
    assert.equal(lifetime.disclosure, null);
  });
});

test('flag off: financing and general disclosure pass through untouched', () => {
  withLifetimeFlag('false', () => {
    const block = toRenderBlock(LIFETIME_CFG);
    assert.deepEqual(block.financing, {
      enabled: true,
      provider: 'Sunbit',
      min_amount: 250,
      disclosure: 'Subject to credit approval.',
    });
    assert.equal(block.general_disclosure, 'Estimates exclude tax and shop fees.');
  });
});

// ── toRenderBlock: kill switch ON ──────────────────────────────────

test('flag on: mode and category_overrides pass through', () => {
  withLifetimeFlag('true', () => {
    const block = toRenderBlock(LIFETIME_CFG);
    assert.equal(block.mode, 'tier_plus_lifetime');
    assert.deepEqual(block.category_overrides, {
      brakes: 'tier_plus_lifetime',
      tires: 'one_price',
    });
  });
});

test('flag on: lifetime is enabled with its disclosure', () => {
  withLifetimeFlag('true', () => {
    const { lifetime } = toRenderBlock(LIFETIME_CFG);
    assert.equal(lifetime.enabled, true);
    assert.equal(lifetime.disclosure, LIFETIME_CFG.lifetime_disclosure);
  });
});

test('flag on: mode tier_plus_lifetime implies lifetime.enabled even with lifetime_enabled false', () => {
  withLifetimeFlag('true', () => {
    const { lifetime } = toRenderBlock({ ...LIFETIME_CFG, lifetime_enabled: false });
    assert.equal(lifetime.enabled, true);
  });
});

test('flag on: a plain one_price config still renders lifetime disabled', () => {
  withLifetimeFlag('true', () => {
    const { lifetime, mode } = toRenderBlock({
      mode: 'one_price', tier_names: ['A', 'B', 'C'],
      category_overrides: {}, lifetime_enabled: false,
    });
    assert.equal(mode, 'one_price');
    assert.equal(lifetime.enabled, false);
  });
});

// ── toRenderBlock: defaults ────────────────────────────────────────

test('a null config renders the one_price defaults', () => {
  withLifetimeFlag('false', () => {
    const block = toRenderBlock(null);
    assert.equal(block.mode, 'one_price');
    assert.deepEqual(block.tier_names, ['Good', 'Better', 'Best']);
    assert.deepEqual(block.category_overrides, {});
    assert.equal(block.lifetime.enabled, false);
    assert.equal(block.financing.enabled, false);
  });
});

test('non-array tier_names fall back to the defaults', () => {
  withLifetimeFlag('false', () => {
    const block = toRenderBlock({ mode: 'one_price', tier_names: 'Good,Better,Best' });
    assert.deepEqual(block.tier_names, ['Good', 'Better', 'Best']);
  });
});

// ── validateConfig ─────────────────────────────────────────────────

const VALID_CFG = {
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
};

test('a valid config returns null', () => {
  assert.equal(validateConfig(VALID_CFG), null);
});

test('an unknown mode is rejected', () => {
  const err = validateConfig({ ...VALID_CFG, mode: 'four_tier' });
  assert.match(err, /mode must be one of/);
  for (const mode of PRICING_MODES) {
    if (mode === 'tier_plus_lifetime') continue; // needs a disclosure, tested below
    assert.equal(validateConfig({ ...VALID_CFG, mode }), null);
  }
});

test('tier_names must be exactly 3 non-empty strings of ≤20 chars', () => {
  const bad = [
    ['Good', 'Better'],                    // too few
    ['Good', 'Better', 'Best', 'Ultra'],   // too many
    ['Good', '', 'Best'],                  // empty
    ['Good', '   ', 'Best'],               // whitespace only
    ['Good', 'Better', 'x'.repeat(21)],    // too long
    ['Good', 42, 'Best'],                  // non-string
    'Good,Better,Best',                    // not an array
  ];
  for (const tier_names of bad) {
    assert.match(validateConfig({ ...VALID_CFG, tier_names }), /tier_names must be exactly 3/);
  }
  assert.equal(validateConfig({ ...VALID_CFG, tier_names: ['A', 'B', 'x'.repeat(20)] }), null);
});

test('category_overrides must map category → known mode', () => {
  assert.match(
    validateConfig({ ...VALID_CFG, category_overrides: ['three_tier'] }),
    /category_overrides must be an object/
  );
  assert.match(
    validateConfig({ ...VALID_CFG, category_overrides: { brakes: 'free' } }),
    /category_overrides\.brakes/
  );
  assert.equal(
    validateConfig({ ...VALID_CFG, category_overrides: { brakes: 'three_tier' } }),
    null
  );
  // null overrides are allowed (treated as none)
  assert.equal(validateConfig({ ...VALID_CFG, category_overrides: null }), null);
});

test('lifetime in play requires a ≥50 char disclosure — mode or flag', () => {
  const longDisclosure = 'Covers the original purchaser, parts only, at this dealership, non-transferable, see full terms.';
  // mode implies lifetime
  assert.match(
    validateConfig({ ...VALID_CFG, mode: 'tier_plus_lifetime' }),
    /lifetime_disclosure is required/
  );
  // flag implies lifetime
  assert.match(
    validateConfig({ ...VALID_CFG, lifetime_enabled: true, lifetime_disclosure: 'too short' }),
    /lifetime_disclosure is required/
  );
  // 49 chars is still too short
  assert.match(
    validateConfig({ ...VALID_CFG, lifetime_enabled: true, lifetime_disclosure: 'x'.repeat(49) }),
    /lifetime_disclosure is required/
  );
  // ≥50 chars passes both paths
  assert.equal(
    validateConfig({ ...VALID_CFG, mode: 'tier_plus_lifetime', lifetime_disclosure: longDisclosure }),
    null
  );
  assert.equal(
    validateConfig({ ...VALID_CFG, lifetime_enabled: true, lifetime_disclosure: 'x'.repeat(50) }),
    null
  );
});

test('financing_enabled requires a disclosure', () => {
  assert.match(
    validateConfig({ ...VALID_CFG, financing_enabled: true }),
    /financing_disclosure is required/
  );
  assert.equal(
    validateConfig({ ...VALID_CFG, financing_enabled: true, financing_disclosure: 'Subject to credit approval.' }),
    null
  );
});

test('financing_min_amount must be a non-negative number when present', () => {
  assert.match(validateConfig({ ...VALID_CFG, financing_min_amount: -1 }), /financing_min_amount/);
  assert.match(validateConfig({ ...VALID_CFG, financing_min_amount: 'lots' }), /financing_min_amount/);
  assert.equal(validateConfig({ ...VALID_CFG, financing_min_amount: 0 }), null);
  assert.equal(validateConfig({ ...VALID_CFG, financing_min_amount: '250' }), null);
});
