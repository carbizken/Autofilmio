// Unit tests for the pure findings-lifecycle logic in routes/mpi.js:
// cleanTier, normalizeDispositions, matchServerItem. These sanitize
// unauthenticated customer input before it reaches the findings rows
// and the append-only approval archive.
//
// The route module transitively imports env-guarded clients (supabase,
// mux, twilio), so stub the env BEFORE the dynamic import.
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.SUPABASE_URL ||= 'http://localhost:54321';
process.env.SUPABASE_SERVICE_KEY ||= 'test-service-key';
process.env.MUX_TOKEN_ID ||= 'test-mux-token-id';
process.env.MUX_TOKEN_SECRET ||= 'test-mux-token-secret';
process.env.TWILIO_ACCOUNT_SID ||= 'ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx';
process.env.TWILIO_AUTH_TOKEN ||= 'test-twilio-auth-token';

const { cleanTier, normalizeDispositions, matchServerItem } =
  await import('../src/routes/mpi.js');

// ── cleanTier ──────────────────────────────────────────────────────

test('cleanTier trims the tier name and keeps a valid price', () => {
  const out = cleanTier({ selected_tier: '  Best  ', selected_tier_price: 129.99 });
  assert.deepEqual(out, { selected_tier: 'Best', selected_tier_price: 129.99 });
});

test('cleanTier caps the tier name at 64 characters', () => {
  const out = cleanTier({ selected_tier: 'x'.repeat(200) });
  assert.equal(out.selected_tier.length, 64);
});

test('cleanTier nulls a non-string or empty tier', () => {
  assert.equal(cleanTier({ selected_tier: 42 }).selected_tier, null);
  assert.equal(cleanTier({ selected_tier: '   ' }).selected_tier, null);
  assert.equal(cleanTier({}).selected_tier, null);
  assert.equal(cleanTier(undefined).selected_tier, null);
});

test('cleanTier rejects negative, NaN, and non-finite prices', () => {
  assert.equal(cleanTier({ selected_tier_price: -5 }).selected_tier_price, null);
  assert.equal(cleanTier({ selected_tier_price: 'abc' }).selected_tier_price, null);
  assert.equal(cleanTier({ selected_tier_price: Infinity }).selected_tier_price, null);
  assert.equal(cleanTier({ selected_tier_price: 0 }).selected_tier_price, 0);
});

test('cleanTier falls back to legacy tier_price when selected_tier_price is absent', () => {
  assert.equal(cleanTier({ tier_price: 88 }).selected_tier_price, 88);
  // selected_tier_price wins when both are present
  assert.equal(cleanTier({ selected_tier_price: 10, tier_price: 88 }).selected_tier_price, 10);
});

// ── normalizeDispositions ──────────────────────────────────────────

test('legacy approved_items strings become approved decisions keyed by name', () => {
  const out = normalizeDispositions({ approved_items: ['Brake Pads', '  Oil Change  '] });
  assert.equal(out.length, 2);
  assert.deepEqual(out[0], {
    index: null, name: 'Brake Pads', decision: 'approved',
    deferred_until: null, selected_tier: null, selected_tier_price: null,
  });
  assert.equal(out[1].name, 'Oil Change'); // trimmed
  assert.equal(out[1].decision, 'approved');
});

test('legacy approved_items objects carry index and sanitized tier', () => {
  const out = normalizeDispositions({
    approved_items: [{ index: 2, name: 'Cabin Filter', selected_tier: 'Best', selected_tier_price: 59 }],
  });
  assert.equal(out.length, 1);
  assert.deepEqual(out[0], {
    index: 2, name: 'Cabin Filter', decision: 'approved',
    deferred_until: null, selected_tier: 'Best', selected_tier_price: 59,
  });
});

test('an explicit dispositions array wins over approved_items — even when empty', () => {
  const out = normalizeDispositions({
    dispositions: [],
    approved_items: ['Brake Pads'],
  });
  assert.deepEqual(out, []);
});

test('unknown decisions are dropped', () => {
  const out = normalizeDispositions({
    dispositions: [
      { index: 0, decision: 'approved' },
      { index: 1, decision: 'shredded' },
      { index: 2, decision: 'DECLINED' }, // case-sensitive contract
      { index: 3 },                        // no decision at all
      { index: 4, decision: 'deferred' },
    ],
  });
  assert.deepEqual(out.map(d => [d.index, d.decision]), [[0, 'approved'], [4, 'deferred']]);
});

test('entries with no usable index or name are dropped', () => {
  const out = normalizeDispositions({
    dispositions: [
      { decision: 'approved' },                       // nothing to match on
      { index: -1, decision: 'approved' },            // negative index, no name
      { index: 1.5, decision: 'approved' },           // non-integer index, no name
      { index: 'x', name: '   ', decision: 'approved' }, // blank name
      null,                                            // not an object
      { name: 'Tires', decision: 'approved' },        // valid via name
    ],
  });
  assert.equal(out.length, 1);
  assert.deepEqual([out[0].index, out[0].name], [null, 'Tires']);
});

test('a bad index with a good name keeps the name and nulls the index', () => {
  const out = normalizeDispositions({
    dispositions: [{ index: -3, name: 'Wipers', decision: 'declined' }],
  });
  assert.deepEqual([out[0].index, out[0].name], [null, 'Wipers']);
});

test('legacy source_item_index is honored as the index', () => {
  const out = normalizeDispositions({
    dispositions: [{ source_item_index: 3, decision: 'approved' }],
  });
  assert.equal(out[0].index, 3);
});

test('deferred_until keeps strict YYYY-MM-DD and nulls anything else', () => {
  const out = normalizeDispositions({
    dispositions: [
      { index: 0, decision: 'deferred', deferred_until: '2026-09-01' },
      { index: 1, decision: 'deferred', deferred_until: '2026/09/01' },
      { index: 2, decision: 'deferred', deferred_until: 'September 1' },
      { index: 3, decision: 'deferred', deferred_until: 20260901 },
      { index: 4, decision: 'deferred' },
    ],
  });
  assert.deepEqual(out.map(d => d.deferred_until), ['2026-09-01', null, null, null, null]);
});

// ── matchServerItem ────────────────────────────────────────────────

const serverItems = [
  { name: 'Front Brake Pads', price: 289 },
  { name: 'Oil Change', price: 79 },
  { name: 'Cabin Air Filter', price: 49 },
];

test('index match wins even when the name points at a different item', () => {
  const item = matchServerItem(serverItems, { index: 1, name: 'Cabin Air Filter' });
  assert.equal(item.name, 'Oil Change');
});

test('an out-of-bounds index falls through to name matching', () => {
  const item = matchServerItem(serverItems, { index: 99, name: 'oil change' });
  assert.equal(item.name, 'Oil Change');
});

test('name matching is case-insensitive against trimmed server names', () => {
  const item = matchServerItem(
    [{ name: '  Front Brake Pads  ' }],
    { index: null, name: 'front brake pads' }
  );
  assert.equal(item.name, '  Front Brake Pads  ');
});

test('no index and no name → null', () => {
  assert.equal(matchServerItem(serverItems, { index: null, name: null }), null);
});

test('a name that matches nothing → null', () => {
  assert.equal(matchServerItem(serverItems, { index: null, name: 'Flux Capacitor' }), null);
});

test('server items without a string name are skipped safely', () => {
  const items = [{ price: 1 }, { name: 42 }, null, { name: 'Tires' }];
  const item = matchServerItem(items, { index: null, name: 'tires' });
  assert.equal(item.name, 'Tires');
});
