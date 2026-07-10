'use strict';

const {
  getEnvelopeState,
  consumeEnvelope,
  computeGaugeSegments,
  shouldShowLowEnvelopeWarning,
  applyMonthlyRenewal,
  addComplementaryReserve
} = require('../lib/usage-envelope');

let passed = 0;
let failed = 0;

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function check(label, fn) {
  try {
    fn();
    passed += 1;
    console.log(`[PASS] ${label}`);
  } catch (err) {
    failed += 1;
    console.error(`[FAIL] ${label}: ${err.message}`);
  }
}

function isEqual(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

check('Scenario 1: envelope full', () => {
  const state = getEnvelopeState({
    monthly: { remaining: 12 },
    reserve: { remaining: 0 }
  });
  assert(
    isEqual(computeGaugeSegments(state.monthly.remaining, { capacity: 12 }), [
      'dark',
      'dark',
      'dark',
      'dark'
    ]),
    'monthly gauge mismatch'
  );
  assert(
    shouldShowLowEnvelopeWarning(state) === false,
    'warning should be false'
  );
});

check('Scenario 2: envelope lightly used', () => {
  const segments = computeGaugeSegments(10, { capacity: 12 });
  assert(
    isEqual(segments, ['dark', 'dark', 'dark', 'empty']),
    'expected 3 dark + 1 empty'
  );
});

check('Scenario 3: low envelope no reserve', () => {
  const raw = { monthly: { remaining: 1 }, reserve: { remaining: 0 } };
  const warning = shouldShowLowEnvelopeWarning(raw);
  const segments = computeGaugeSegments(1, {
    capacity: 12,
    showRedWhenLow: true
  });
  assert(
    isEqual(segments, ['red', 'empty', 'empty', 'empty']),
    'expected red segment'
  );
  assert(warning === true, 'warning should be true');
});

check('Scenario 4: low envelope with reserve', () => {
  const raw = { monthly: { remaining: 1 }, reserve: { remaining: 50 } };
  const warning = shouldShowLowEnvelopeWarning(raw);
  const monthlySegments = computeGaugeSegments(1, {
    capacity: 12,
    showRedWhenLow: false
  });
  const reserveSegments = computeGaugeSegments(50, { capacity: 100 });
  assert(
    isEqual(monthlySegments, ['light', 'empty', 'empty', 'empty']),
    'monthly should stay light, not red'
  );
  assert(
    isEqual(reserveSegments, ['dark', 'dark', 'empty', 'empty']),
    'reserve gauge mismatch'
  );
  assert(warning === false, 'warning should be false');
});

check('Scenario 5: envelope empty reserve low', () => {
  const raw = { monthly: { remaining: 0 }, reserve: { remaining: 1 } };
  const warning = shouldShowLowEnvelopeWarning(raw);
  const reserveSegments = computeGaugeSegments(1, {
    capacity: 12,
    showRedWhenLow: true
  });
  assert(
    isEqual(reserveSegments, ['red', 'empty', 'empty', 'empty']),
    'reserve should show red'
  );
  assert(warning === true, 'warning should be true');
});

check('Scenario 6: rollover available', () => {
  const state = getEnvelopeState({
    rollover: { remaining: 3 },
    monthly: { remaining: 12 }
  });
  assert(state.rollover.remaining === 3, 'rollover should be 3');
  assert(
    isEqual(computeGaugeSegments(state.monthly.remaining, { capacity: 12 }), [
      'dark',
      'dark',
      'dark',
      'dark'
    ]),
    'monthly gauge mismatch'
  );
});

check('Scenario 7: consumption order', () => {
  const consumed = consumeEnvelope(
    {
      rollover: { remaining: 3 },
      monthly: { remaining: 12 },
      reserve: { remaining: 50 }
    },
    10
  );
  assert(consumed.breakdown.rollover === 3, 'should consume rollover first');
  assert(consumed.breakdown.monthly === 7, 'should then consume monthly');
  assert(consumed.breakdown.reserve === 0, 'reserve should be untouched');
});

check('Scenario 8: monthly renewal', () => {
  const renewal = applyMonthlyRenewal(
    {
      monthly: { remaining: 2 },
      rollover: { remaining: 0 },
      reserve: { remaining: 8 },
      lastRenewalAt: '2026-01-10T12:00:00.000Z'
    },
    '2026-02-01T00:00:00.000Z'
  );

  assert(renewal.renewed === true, 'renewal should occur');
  assert(renewal.state.rollover.remaining === 2, 'rollover should keep leftover up to 3');
  assert(renewal.state.monthly.remaining === 12, 'monthly should reset to 12');
  assert(renewal.state.reserve.remaining === 8, 'reserve should persist');
});

check('add complementary reserve caps at 12', () => {
  const state = addComplementaryReserve({ reserve: { remaining: 10 } }, 10);
  assert(state.reserve.remaining === 12, 'reserve must be capped to 12');
});

if (failed > 0) {
  console.error(
    `\nusage-envelope-harness: ${failed} failure(s), ${passed} pass(es).`
  );
  process.exit(1);
}

console.log(`\nusage-envelope-harness: all ${passed} checks passed.`);
