"use strict";

const {
  getEnvelopeState,
  consumeEnvelope,
  computeGaugeSegments,
  shouldShowLowEnvelopeWarning,
  applyMonthlyRenewal,
  addComplementaryReserve
} = require("../lib/usage-envelope");

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

check("Scenario 1: envelope full", () => {
  const state = getEnvelopeState({ monthly: { remaining: 100 }, reserve: { remaining: 0 } });
  assert(isEqual(computeGaugeSegments(state.monthly.remaining, { capacity: 100 }), ["dark", "dark", "dark", "dark"]), "monthly gauge mismatch");
  assert(shouldShowLowEnvelopeWarning(state) === false, "warning should be false");
});

check("Scenario 2: envelope lightly used", () => {
  const segments = computeGaugeSegments(90, { capacity: 100 });
  assert(isEqual(segments, ["dark", "dark", "dark", "light"]), "expected 3 dark + 1 light");
});

check("Scenario 3: low envelope no reserve", () => {
  const raw = { monthly: { remaining: 10 }, reserve: { remaining: 0 } };
  const warning = shouldShowLowEnvelopeWarning(raw);
  const segments = computeGaugeSegments(10, { capacity: 100, showRedWhenLow: true });
  assert(isEqual(segments, ["red", "empty", "empty", "empty"]), "expected red segment");
  assert(warning === true, "warning should be true");
});

check("Scenario 4: low envelope with reserve", () => {
  const raw = { monthly: { remaining: 10 }, reserve: { remaining: 50 } };
  const warning = shouldShowLowEnvelopeWarning(raw);
  const monthlySegments = computeGaugeSegments(10, { capacity: 100, showRedWhenLow: false });
  const reserveSegments = computeGaugeSegments(50, { capacity: 100 });
  assert(isEqual(monthlySegments, ["light", "empty", "empty", "empty"]), "monthly should stay light, not red");
  assert(isEqual(reserveSegments, ["dark", "dark", "empty", "empty"]), "reserve gauge mismatch");
  assert(warning === false, "warning should be false");
});

check("Scenario 5: envelope empty reserve low", () => {
  const raw = { monthly: { remaining: 0 }, reserve: { remaining: 10 } };
  const warning = shouldShowLowEnvelopeWarning(raw);
  const reserveSegments = computeGaugeSegments(10, { capacity: 100, showRedWhenLow: true });
  assert(isEqual(reserveSegments, ["red", "empty", "empty", "empty"]), "reserve should show red");
  assert(warning === true, "warning should be true");
});

check("Scenario 6: rollover available", () => {
  const state = getEnvelopeState({ rollover: { remaining: 25 }, monthly: { remaining: 100 } });
  assert(state.rollover.remaining === 25, "rollover should be 25");
  assert(isEqual(computeGaugeSegments(state.monthly.remaining, { capacity: 100 }), ["dark", "dark", "dark", "dark"]), "monthly gauge mismatch");
});

check("Scenario 7: consumption order", () => {
  const consumed = consumeEnvelope(
    {
      rollover: { remaining: 25 },
      monthly: { remaining: 100 },
      reserve: { remaining: 50 }
    },
    60
  );
  assert(consumed.breakdown.rollover === 25, "should consume rollover first");
  assert(consumed.breakdown.monthly === 35, "should then consume monthly");
  assert(consumed.breakdown.reserve === 0, "reserve should be untouched");
});

check("Scenario 8: monthly renewal", () => {
  const renewal = applyMonthlyRenewal(
    {
      monthly: { remaining: 40 },
      rollover: { remaining: 0 },
      reserve: { remaining: 80 },
      lastRenewalAt: "2026-01-10T12:00:00.000Z"
    },
    "2026-02-01T00:00:00.000Z"
  );

  assert(renewal.renewed === true, "renewal should occur");
  assert(renewal.state.rollover.remaining === 25, "rollover should cap at 25");
  assert(renewal.state.monthly.remaining === 100, "monthly should reset to 100");
  assert(renewal.state.reserve.remaining === 80, "reserve should persist");
});

check("add complementary reserve caps at 100", () => {
  const state = addComplementaryReserve({ reserve: { remaining: 95 } }, 10);
  assert(state.reserve.remaining === 100, "reserve must be capped to 100");
});

if (failed > 0) {
  console.error(`\nusage-envelope-harness: ${failed} failure(s), ${passed} pass(es).`);
  process.exit(1);
}

console.log(`\nusage-envelope-harness: all ${passed} checks passed.`);
