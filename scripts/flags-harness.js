"use strict";

// ─── flags harness — pure deterministic, no server required ──────────────────
// Exercises every normalisation/clamping function in lib/flags.js.
// These functions sanitise all data entering and exiting the pipeline;
// a silent regression here can corrupt every other harness and every live turn.

const {
  clampDependencyRiskScore,
  clampExplorationDirectivityLevel,
  computeExplorationDirectivityLevel,
  detectClosureIntent,
  normalizeAllianceState,
  normalizeDischargeState,
  normalizeConversationState,
  normalizeConsecutiveNonExplorationTurns,
  normalizeDependencyRiskLevel,
  normalizeEngagementLevel,
  normalizeExplorationRelanceWindow,
  normalizeExternalSupportMode,
  normalizeFlags,
  normalizeAttentionWindow,
  normalizeSessionFlags,
  normalizeStagnationTurns,
  normalizeAffiliationWindow,
  registerExplorationRelance
} = require("../lib/flags");

const {
  computeAffiliationTurnScore,
  computeAffiliationEstablished
} = require("../lib/pipeline");

let passed = 0;
let failed = 0;

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function check(label, fn) {
  try {
    fn();
    passed++;
    console.log(`[PASS] ${label}`);
  } catch (err) {
    failed++;
    console.error(`[FAIL] ${label}: ${err.message}`);
  }
}

function deepEqual(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

// ─── normalizeFlags ───────────────────────────────────────────────────────────

check("normalizeFlags: null → {}", () => {
  assert(deepEqual(normalizeFlags(null), {}), "expected {}");
});
check("normalizeFlags: undefined → {}", () => {
  assert(deepEqual(normalizeFlags(undefined), {}), "expected {}");
});
check("normalizeFlags: array → {}", () => {
  assert(deepEqual(normalizeFlags([1, 2]), {}), "expected {} for array input");
});
check("normalizeFlags: string → {}", () => {
  assert(deepEqual(normalizeFlags("bad"), {}), "expected {} for string input");
});
check("normalizeFlags: valid object passthrough", () => {
  const obj = { foo: "bar" };
  assert(deepEqual(normalizeFlags(obj), obj), "expected passthrough of plain object");
});

// ─── clampExplorationDirectivityLevel ────────────────────────────────────────

check("clamp: 0 → 0", () => assert(clampExplorationDirectivityLevel(0) === 0));
check("clamp: 4 → 4", () => assert(clampExplorationDirectivityLevel(4) === 4));
check("clamp: -1 → 0", () => assert(clampExplorationDirectivityLevel(-1) === 0));
check("clamp: 5 → 4", () => assert(clampExplorationDirectivityLevel(5) === 4));
check("clamp: 2.5 (non-integer) → 0", () => assert(clampExplorationDirectivityLevel(2.5) === 0));
check("clamp: null → 0", () => assert(clampExplorationDirectivityLevel(null) === 0));
check("clamp: 'bad' → 0", () => assert(clampExplorationDirectivityLevel("bad") === 0));
check("clamp: '3' (numeric string) → 3 (Number() coerces)", () => assert(clampExplorationDirectivityLevel("3") === 3, "numeric string '3' is coerced via Number() to 3"));

// ─── computeExplorationDirectivityLevel ──────────────────────────────────────

check("compute: [] → 0", () => assert(computeExplorationDirectivityLevel([]) === 0));
check("compute: [false,false,false,false] → 0", () => assert(computeExplorationDirectivityLevel([false, false, false, false]) === 0));
check("compute: [true,false,false,false] → 1", () => assert(computeExplorationDirectivityLevel([true, false, false, false]) === 1));
check("compute: [true,true,true,true] → 4", () => assert(computeExplorationDirectivityLevel([true, true, true, true]) === 4));
check("compute: [true,true,true,true,true] capped at 4", () => assert(computeExplorationDirectivityLevel([true, true, true, true, true]) === 4));

// ─── normalizeExplorationRelanceWindow ───────────────────────────────────────

check("window: non-array → []", () => {
  assert(deepEqual(normalizeExplorationRelanceWindow("bad"), []), "expected []");
});
check("window: filters non-booleans", () => {
  assert(deepEqual(normalizeExplorationRelanceWindow([true, 1, false, null, true]), [true, false, true]), "expected only booleans");
});
check("window: slices to last 4", () => {
  assert(deepEqual(normalizeExplorationRelanceWindow([true, true, false, false, true]), [true, false, false, true]), "expected last 4");
});
check("window: [true,true] → [true,true]", () => {
  assert(deepEqual(normalizeExplorationRelanceWindow([true, true]), [true, true]));
});

// ─── normalizeDischargeState ────────────────────────────────────────────────────

check("dischargeState: null → {wasDischarge:false}", () => {
  assert(deepEqual(normalizeDischargeState(null), { wasDischarge: false }));
});
check("dischargeState: array → {wasDischarge:false}", () => {
  assert(deepEqual(normalizeDischargeState([]), { wasDischarge: false }));
});
check("dischargeState: {wasDischarge:true} → {wasDischarge:true}", () => {
  assert(deepEqual(normalizeDischargeState({ wasDischarge: true }), { wasDischarge: true }));
});
check("dischargeState: {wasDischarge:'yes'} → {wasDischarge:false}", () => {
  assert(deepEqual(normalizeDischargeState({ wasDischarge: "yes" }), { wasDischarge: false }));
});

// ─── normalizeConversationState ───────────────────────────────────────────────

const VALID_EXTENDED_STATES = [
  "exploration_open", "exploration_restrained", "info_pure", "info_features",
  "info_psychoeducation", "stabilization", "alliance_rupture", "closure",
  "discharge_regulated", "discharge_dysregulated", "n1_crisis", "n2_crisis"
];
for (const s of VALID_EXTENDED_STATES) {
  check(`conversationState: '${s}' → '${s}'`, () => assert(normalizeConversationState(s) === s));
}
check("conversationState: unknown → 'exploration_open' (safe default)", () => assert(normalizeConversationState("bad") === "exploration_open"));
check("conversationState: null → 'exploration_open'", () => assert(normalizeConversationState(null) === "exploration_open"));

// ─── normalizeConsecutiveNonExplorationTurns ──────────────────────────────────

check("consecutiveTurns: 0 → 0", () => assert(normalizeConsecutiveNonExplorationTurns(0) === 0));
check("consecutiveTurns: 5 → 5", () => assert(normalizeConsecutiveNonExplorationTurns(5) === 5));
check("consecutiveTurns: -1 → 0", () => assert(normalizeConsecutiveNonExplorationTurns(-1) === 0));
check("consecutiveTurns: 2.5 → 0 (non-integer)", () => assert(normalizeConsecutiveNonExplorationTurns(2.5) === 0));
check("consecutiveTurns: 'bad' → 0", () => assert(normalizeConsecutiveNonExplorationTurns("bad") === 0));

// ─── normalizeAllianceState ───────────────────────────────────────────────────

check("allianceSignal: 'good' → 'good'", () => assert(normalizeAllianceState("good") === "good"));
check("allianceSignal: 'fragile' → 'fragile'", () => assert(normalizeAllianceState("fragile") === "fragile"));
check("allianceSignal: 'rupture' → 'rupture'", () => assert(normalizeAllianceState("rupture") === "rupture"));
check("allianceSignal: null → 'good'", () => assert(normalizeAllianceState(null) === "good"));
check("allianceSignal: unknown → 'good'", () => assert(normalizeAllianceState("broken") === "good"));

// ─── normalizeEngagementLevel ─────────────────────────────────────────────────

check("engagementLevel: 'active' → 'active'", () => assert(normalizeEngagementLevel("active") === "active"));
check("engagementLevel: 'passive' → 'passive'", () => assert(normalizeEngagementLevel("passive") === "passive"));
check("engagementLevel: 'withdrawn' → 'withdrawn'", () => assert(normalizeEngagementLevel("withdrawn") === "withdrawn"));
check("engagementLevel: null → 'active'", () => assert(normalizeEngagementLevel(null) === "active"));
check("engagementLevel: unknown → 'active'", () => assert(normalizeEngagementLevel("bad") === "active"));

// ─── normalizeStagnationTurns ─────────────────────────────────────────────────

check("stagnationTurns: 0 → 0", () => assert(normalizeStagnationTurns(0) === 0));
check("stagnationTurns: 3 → 3", () => assert(normalizeStagnationTurns(3) === 3));
check("stagnationTurns: -1 → 0", () => assert(normalizeStagnationTurns(-1) === 0));
check("stagnationTurns: 'bad' → 0", () => assert(normalizeStagnationTurns("bad") === 0));

// ─── normalizeAttentionWindow ─────────────────────────────────────────────────

check("attentionWindow: 'open' → 'open'", () => assert(normalizeAttentionWindow("open") === "open"));
check("attentionWindow: 'narrowed' → 'narrowed'", () => assert(normalizeAttentionWindow("narrowed") === "narrowed"));
check("attentionWindow: 'overloaded' → 'overloaded'", () => assert(normalizeAttentionWindow("overloaded") === "overloaded"));
check("attentionWindow: null → 'open'", () => assert(normalizeAttentionWindow(null) === "open"));
check("attentionWindow: unknown → 'open'", () => assert(normalizeAttentionWindow("bad") === "open"));

// ─── clampDependencyRiskScore ─────────────────────────────────────────────────

check("depRiskScore: 0 → 0", () => assert(clampDependencyRiskScore(0) === 0));
check("depRiskScore: 100 → 100", () => assert(clampDependencyRiskScore(100) === 100));
check("depRiskScore: -5 → 0", () => assert(clampDependencyRiskScore(-5) === 0));
check("depRiskScore: 105 → 100", () => assert(clampDependencyRiskScore(105) === 100));
check("depRiskScore: 42.7 → 43 (rounds)", () => assert(clampDependencyRiskScore(42.7) === 43));
check("depRiskScore: NaN → 0", () => assert(clampDependencyRiskScore(NaN) === 0));
check("depRiskScore: 'bad' → 0", () => assert(clampDependencyRiskScore("bad") === 0));

// ─── normalizeDependencyRiskLevel ─────────────────────────────────────────────

check("depRiskLevel: 'low' → 'low'", () => assert(normalizeDependencyRiskLevel("low") === "low"));
check("depRiskLevel: 'medium' → 'medium'", () => assert(normalizeDependencyRiskLevel("medium") === "medium"));
check("depRiskLevel: 'high' → 'high'", () => assert(normalizeDependencyRiskLevel("high") === "high"));
check("depRiskLevel: null → 'low'", () => assert(normalizeDependencyRiskLevel(null) === "low"));
check("depRiskLevel: unknown → 'low'", () => assert(normalizeDependencyRiskLevel("extreme") === "low"));

// ─── normalizeExternalSupportMode ────────────────────────────────────────────

check("externalSupportMode: 'none' → 'none'", () => assert(normalizeExternalSupportMode("none") === "none"));
check("externalSupportMode: 'discovery_validation' → 'discovery_validation'", () => assert(normalizeExternalSupportMode("discovery_validation") === "discovery_validation"));
check("externalSupportMode: 'overreliance' → 'overreliance'", () => assert(normalizeExternalSupportMode("overreliance") === "overreliance"));
check("externalSupportMode: null → 'none'", () => assert(normalizeExternalSupportMode(null) === "none"));
check("externalSupportMode: unknown → 'none'", () => assert(normalizeExternalSupportMode("bad") === "none"));

// ─── normalizeSessionFlags ────────────────────────────────────────────────────

check("sessionFlags: null input → stable defaults", () => {
  const out = normalizeSessionFlags(null);
  assert(out.acuteCrisis === false, "acuteCrisis default false");
  assert(out.closureIntent === false, "closureIntent default false");
  assert(typeof out.explorationDirectivityLevel === "number", "explorationDirectivityLevel is number");
  assert(Array.isArray(out.explorationRelanceWindow), "explorationRelanceWindow is array");
  assert(out.conversationState === "exploration_open", `conversationState default exploration_open, got ${out.conversationState}`);
});

check("sessionFlags: explicit directivity preserved", () => {
  const out = normalizeSessionFlags({ explorationDirectivityLevel: 3 });
  assert(out.explorationDirectivityLevel === 3,
    `expected 3, got ${out.explorationDirectivityLevel}`);
});

check("sessionFlags: out-of-range directivity clamped", () => {
  const out = normalizeSessionFlags({ explorationDirectivityLevel: 99 });
  assert(out.explorationDirectivityLevel === 4,
    `expected 4, got ${out.explorationDirectivityLevel}`);
});

check("sessionFlags: explicit relance window with no explicit level → compute from window", () => {
  const window = [true, true, false, false];
  const out = normalizeSessionFlags({ explorationRelanceWindow: window });
  assert(out.explorationDirectivityLevel === 2,
    `expected 2 (2 trues), got ${out.explorationDirectivityLevel}`);
});

check("sessionFlags: acuteCrisis non-boolean → false", () => {
  const out = normalizeSessionFlags({ acuteCrisis: "yes" });
  assert(out.acuteCrisis === false, "expected false for non-boolean acuteCrisis");
});

check("sessionFlags: postCrisisSupportCarryTurn non-boolean → false", () => {
  const out = normalizeSessionFlags({ postCrisisSupportCarryTurn: "yes" });
  assert(out.postCrisisSupportCarryTurn === false, "expected false for non-boolean postCrisisSupportCarryTurn");
});

check("sessionFlags: postCrisisSupportCarryTurn true preserved", () => {
  const out = normalizeSessionFlags({ postCrisisSupportCarryTurn: true });
  assert(out.postCrisisSupportCarryTurn === true, "expected true for explicit postCrisisSupportCarryTurn");
});

check("sessionFlags: unknown conversationState → 'exploration_open'", () => {
  const out = normalizeSessionFlags({ conversationState: "invalid" });
  assert(out.conversationState === "exploration_open",
    `expected 'exploration_open', got '${out.conversationState}'`);
});

check("sessionFlags: allianceSignal preserved", () => {
  const out = normalizeSessionFlags({ allianceSignal: "rupture" });
  assert(out.allianceSignal === "rupture");
});

check("sessionFlags: engagementLevel preserved", () => {
  const out = normalizeSessionFlags({ engagementLevel: "withdrawn" });
  assert(out.engagementLevel === "withdrawn");
});

check("sessionFlags: stagnationTurns preserved", () => {
  const out = normalizeSessionFlags({ stagnationTurns: 3 });
  assert(out.stagnationTurns === 3);
});

check("sessionFlags: dependencyRiskScore clamped", () => {
  const out = normalizeSessionFlags({ dependencyRiskScore: 150 });
  assert(out.dependencyRiskScore === 100,
    `expected 100, got ${out.dependencyRiskScore}`);
});

check("sessionFlags: extra props preserved", () => {
  const out = normalizeSessionFlags({ foo: "bar" });
  assert(out.foo === "bar", "expected extra prop preserved via spread");
});

// ─── registerExplorationRelance ───────────────────────────────────────────────

check("registerRelance: true pushes true onto window", () => {
  const out = registerExplorationRelance({ explorationRelanceWindow: [false, false, false, false] }, true);
  assert(out.explorationRelanceWindow[3] === true,
    `expected last entry true, got ${out.explorationRelanceWindow[3]}`);
  assert(out.explorationRelanceWindow.length === 4, "window should stay length 4");
});

check("registerRelance: false pushes false", () => {
  const out = registerExplorationRelance({ explorationRelanceWindow: [true, true, true, true] }, false);
  assert(out.explorationRelanceWindow[3] === false,
    `expected last entry false, got ${out.explorationRelanceWindow[3]}`);
});

check("registerRelance: directivity recomputed from window", () => {
  const out = registerExplorationRelance({ explorationRelanceWindow: [false, false, false, false] }, true);
  assert(out.explorationDirectivityLevel === 1,
    `expected level 1 (one true), got ${out.explorationDirectivityLevel}`);
});

check("registerRelance: window slides (length stays 4)", () => {
  const out = registerExplorationRelance({ explorationRelanceWindow: [true, true, true, true] }, false);
  assert(out.explorationRelanceWindow.length === 4, "window must stay at 4");
  assert(out.explorationRelanceWindow[0] === true, "oldest entry should shift out");
});

// ─── detectClosureIntent ──────────────────────────────────────────────────────

check("detectClosureIntent: 'au revoir' → true", () => {
  assert(detectClosureIntent("Au revoir !") === true, "expected true for 'au revoir'");
});
check("detectClosureIntent: 'bonne nuit' → true", () => {
  assert(detectClosureIntent("bonne nuit") === true, "expected true for 'bonne nuit'");
});
check("detectClosureIntent: 'bonsoir' → true", () => {
  assert(detectClosureIntent("Bonsoir !") === true, "expected true for 'bonsoir'");
});
check("detectClosureIntent: 'c\\'est bon pour aujourd\\'hui' → true", () => {
  assert(detectClosureIntent("c'est bon pour aujourd'hui") === true, "expected true");
});
check("detectClosureIntent: 'c\\'est tout pour aujourd\\'hui' → true", () => {
  assert(detectClosureIntent("c'est tout pour aujourd'hui") === true, "expected true");
});
check("detectClosureIntent: 'on s\\'arrête là' → true (accent normalisé)", () => {
  assert(detectClosureIntent("on s'arrête là") === true, "expected true with accent");
});
check("detectClosureIntent: 'je vais m\\'arrêter' → true (accent normalisé)", () => {
  assert(detectClosureIntent("je vais m'arrêter") === true, "expected true with accent");
});
check("detectClosureIntent: 'c\\'est fini pour aujourd\\'hui' → true", () => {
  assert(detectClosureIntent("c'est fini pour aujourd'hui") === true, "expected true");
});
check("detectClosureIntent: plain exploration message → false", () => {
  assert(detectClosureIntent("je me sens fatigué ce soir") === false, "expected false for non-closure");
});
check("detectClosureIntent: empty string → false", () => {
  assert(detectClosureIntent("") === false, "expected false for empty string");
});
check("detectClosureIntent: null → false (safe)", () => {
  assert(detectClosureIntent(null) === false, "expected false for null");
});

// ─── normalizeAffiliationWindow ───────────────────────────────────────────────

check("affiliationWindow: non-array → [0,0,0,0]", () => {
  assert(deepEqual(normalizeAffiliationWindow(null), [0, 0, 0, 0]), "expected [0,0,0,0] for null");
});
check("affiliationWindow: filters non-numbers, pads to 4", () => {
  const result = normalizeAffiliationWindow(["a", 0.5, null]);
  assert(result.length === 4, "expected length 4");
  assert(typeof result[3] === "number", "expected numbers only");
});
check("affiliationWindow: slices to last 4", () => {
  const w = [0.1, 0.2, 0.3, 0.4, 0.5];
  const result = normalizeAffiliationWindow(w);
  assert(result.length === 4, "expected max 4 entries");
  assert(result[3] === 0.5, "expected last entry to be 0.5");
});

// ─── computeAffiliationTurnScore ──────────────────────────────────────────────

check("affiliationTurnScore: empty string → 0", () => {
  assert(computeAffiliationTurnScore("") === 0, "expected 0 for empty string");
});
check("affiliationTurnScore: 'exactement' → >= 0.5", () => {
  assert(computeAffiliationTurnScore("exactement") >= 0.5, "expected validation match");
});
check("affiliationTurnScore: long message → > 0", () => {
  const msg = "a".repeat(300);
  assert(computeAffiliationTurnScore(msg) > 0, "expected length score > 0");
});

// ─── computeAffiliationEstablished ───────────────────────────────────────────

check("affiliationEstablished: [] → false", () => {
  assert(computeAffiliationEstablished([]) === false, "expected false for empty window");
});
check("affiliationEstablished: [0.3, 0.3, 0.3, 0.3] → false (max < 0.5)", () => {
  assert(computeAffiliationEstablished([0.3, 0.3, 0.3, 0.3]) === false, "expected false");
});
check("affiliationEstablished: [0, 0, 0, 0.5] → true (max >= 0.5)", () => {
  assert(computeAffiliationEstablished([0, 0, 0, 0.5]) === true, "expected true");
});

// ─── Summary ──────────────────────────────────────────────────────────────────

const total = passed + failed;
console.log(`\n[FLAGS] ${passed}/${total} checks passed.`);
if (failed > 0) process.exitCode = 1;
