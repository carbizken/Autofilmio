// Unit tests for the pure supersede-matching helpers in lib/passport.js:
// normFindingName, findingNamesMatch, assignSupersedes. These decide
// which still-open prior findings a re-inspection closes as 'superseded'.
//
// passport.js transitively imports the env-guarded supabase client, so
// stub the env BEFORE the dynamic import.
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.SUPABASE_URL ||= 'http://localhost:54321';
process.env.SUPABASE_SERVICE_KEY ||= 'test-service-key';

const { normFindingName, findingNamesMatch, assignSupersedes } =
  await import('../src/lib/passport.js');

// ── normFindingName ────────────────────────────────────────────────

test('normFindingName lowercases and trims', () => {
  assert.equal(normFindingName('  Front Brake Pads  '), 'front brake pads');
});

test('normFindingName returns "" for non-strings', () => {
  assert.equal(normFindingName(null), '');
  assert.equal(normFindingName(undefined), '');
  assert.equal(normFindingName(42), '');
  assert.equal(normFindingName({}), '');
});

// ── findingNamesMatch ──────────────────────────────────────────────

test('exact normalized names match', () => {
  assert.equal(findingNamesMatch('brake pads', 'brake pads'), true);
});

test('containment matches in both directions', () => {
  assert.equal(findingNamesMatch('front brake pads', 'brake pads'), true);
  assert.equal(findingNamesMatch('brake pads', 'front brake pads'), true);
});

test('unrelated names do not match', () => {
  assert.equal(findingNamesMatch('brake pads', 'cabin air filter'), false);
});

test('empty names never match — even against another empty name', () => {
  assert.equal(findingNamesMatch('', 'brake pads'), false);
  assert.equal(findingNamesMatch('brake pads', ''), false);
  assert.equal(findingNamesMatch('', ''), false);
});

// ── assignSupersedes ───────────────────────────────────────────────

// openPrior is newest-first, with `norm` precomputed — exactly the
// shape explodeFindings builds from the findings query.
const prior = (id, name) => ({ id, name, norm: normFindingName(name) });

test('an exact match chains the new row to the prior finding', () => {
  const rows = [{ name: 'Brake Pads' }];
  const openPrior = [prior('f-1', 'Brake Pads')];
  const claimed = assignSupersedes(rows, openPrior);
  assert.equal(rows[0].supersedes_finding_id, 'f-1');
  assert.deepEqual([...claimed], ['f-1']);
});

test('a containment match chains ("Front Brake Pads" supersedes "brake pads")', () => {
  const rows = [{ name: 'Front Brake Pads' }];
  const openPrior = [prior('f-1', 'brake pads')];
  assignSupersedes(rows, openPrior);
  assert.equal(rows[0].supersedes_finding_id, 'f-1');
});

test('no match leaves the row unchained and claims nothing', () => {
  const rows = [{ name: 'Cabin Air Filter' }];
  const openPrior = [prior('f-1', 'brake pads')];
  const claimed = assignSupersedes(rows, openPrior);
  assert.equal('supersedes_finding_id' in rows[0], false);
  assert.equal(claimed.size, 0);
});

test('claim-once: two same-named new rows cannot both claim one prior finding', () => {
  const rows = [{ name: 'Brake Pads' }, { name: 'Brake Pads' }];
  const openPrior = [prior('f-1', 'Brake Pads')];
  const claimed = assignSupersedes(rows, openPrior);
  assert.equal(rows[0].supersedes_finding_id, 'f-1');
  assert.equal('supersedes_finding_id' in rows[1], false);
  assert.equal(claimed.size, 1);
});

test('claim-once: two matching priors are claimed newest-first, one each', () => {
  const rows = [{ name: 'Brake Pads' }, { name: 'Brake Pads' }];
  const openPrior = [prior('f-new', 'Brake Pads'), prior('f-old', 'Brake Pads')];
  const claimed = assignSupersedes(rows, openPrior);
  assert.equal(rows[0].supersedes_finding_id, 'f-new'); // newest first
  assert.equal(rows[1].supersedes_finding_id, 'f-old');
  assert.deepEqual([...claimed].sort(), ['f-new', 'f-old']);
});

test('the first (newest) matching prior wins when several match', () => {
  const rows = [{ name: 'brake pads' }];
  const openPrior = [
    prior('f-3', 'Front Brake Pads'),
    prior('f-2', 'Brake Pads'),
    prior('f-1', 'brake pads'),
  ];
  assignSupersedes(rows, openPrior);
  assert.equal(rows[0].supersedes_finding_id, 'f-3');
});

test('rows with unusable names never match', () => {
  const rows = [{ name: null }, { name: 42 }];
  const openPrior = [prior('f-1', 'brake pads')];
  const claimed = assignSupersedes(rows, openPrior);
  assert.equal(claimed.size, 0);
});

test('empty inputs are safe', () => {
  assert.equal(assignSupersedes([], []).size, 0);
  const rows = [{ name: 'Tires' }];
  assert.equal(assignSupersedes(rows, []).size, 0);
  assert.equal('supersedes_finding_id' in rows[0], false);
});
