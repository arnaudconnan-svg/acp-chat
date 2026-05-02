"use strict";

// ─── contract-validator harness ─────────────────────────────────────────────
// Pure deterministic checks for posture contracts and writer mode tables.
// No server, no LLM, no network.

const {
  buildPostureDecision
} = require("../lib/pipeline");

const {
  CONVERSATION_STATES,
  STATE_FORBIDDEN,
  STATE_ALLOWED,
  STATE_INTENT,
  STATE_CONSTRAINTS
} = require("../lib/conversation-state");

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

function baseInput(overrides = {}) {
  return {
    detectedState: "exploration",
    contactAnalysis: { selfCriticismLevel: null, meaningCrisis: false, insightMoment: false },
    relationalAdjustmentAnalysis: { needsRelationalAdjustment: false },
    calibrationAnalysis: { calibrationLevel: 0, explorationSignal: "interpretation" },
    technicalContextDetected: false,
    interpretationRejection: {
      isInterpretationRejection: false,
      needsSoberReadjustment: false,
      rejectsUnderlyingPhenomenon: false,
      tensionHoldLevel: "medium"
    },
    effectiveExplorationDirectivityLevel: 0,
    previousConversationState: "exploration",
    affiliationEstablished: true,
    currentConsecutiveNonExplorationTurns: 0,
    currentExplorationRelanceWindow: [false, false, false, false],
    allianceSignal: "good",
    engagementLevel: "active",
    stagnationTurns: 0,
    processingWindow: "open",
    closureIntent: false,
    message: "",
    recentHistory: [],
    ...overrides
  };
}

// Maps each base CONVERSATION_STATE to its extended STATE_ALLOWED key candidates.
// discharge → ["discharge_regulated", "discharge_dysregulated"] ; etc.
function expectedStatesForBaseState(state) {
  if (state === "exploration") return ["exploration_open", "exploration_restrained"];
  if (state === "discharge") return ["discharge_regulated", "discharge_dysregulated"];
  if (state === "info") return ["info_pure", "info_psychoeducation", "info_features"];
  return [state]; // stabilization, alliance_rupture, closure
}

check("state tables are aligned", () => {
  const allowedKeys = Object.keys(STATE_ALLOWED).sort();
  const forbiddenKeys = Object.keys(STATE_FORBIDDEN).sort();
  const intentKeys = Object.keys(STATE_INTENT).sort();

  assert(JSON.stringify(allowedKeys) === JSON.stringify(forbiddenKeys), "STATE_FORBIDDEN keys mismatch STATE_ALLOWED");
  assert(JSON.stringify(allowedKeys) === JSON.stringify(intentKeys), "STATE_INTENT keys mismatch STATE_ALLOWED");
});

check("constraints keys are subset of state table keys", () => {
  const stateSet = new Set(Object.keys(STATE_ALLOWED));
  for (const key of Object.keys(STATE_CONSTRAINTS)) {
    assert(stateSet.has(key), `constraint key '${key}' missing from STATE_ALLOWED`);
  }
});

check("every conversation state maps to a known extended state", () => {
  const stateSet = new Set(Object.keys(STATE_ALLOWED));
  for (const state of CONVERSATION_STATES) {
    const candidates = expectedStatesForBaseState(state);
    for (const extState of candidates) {
      assert(stateSet.has(extState), `base state '${state}' maps to unknown extended state '${extState}'`);
    }
  }
});

check("posture decision always returns known conversationState", () => {
  const stateSet = new Set(Object.keys(STATE_ALLOWED));

  const cases = [
    baseInput({ detectedState: "exploration", calibrationAnalysis: { calibrationLevel: 0, explorationSignal: "interpretation" } }),
    baseInput({ detectedState: "exploration", calibrationAnalysis: { calibrationLevel: 3, explorationSignal: "interpretation" }, effectiveExplorationDirectivityLevel: 4 }),
    baseInput({ detectedState: "discharge_regulated" }),
    baseInput({ detectedState: "discharge_dysregulated" }),
    baseInput({ detectedState: "info_pure" }),
    baseInput({ detectedState: "info_psychoeducation" }),
    baseInput({ detectedState: "info_features" }),
    baseInput({ detectedState: "exploration", allianceSignal: "rupture" }),
    baseInput({ detectedState: "exploration", closureIntent: true }),
    baseInput({ detectedState: "exploration", processingWindow: "overloaded", engagementLevel: "withdrawn" })
  ];

  for (const input of cases) {
    const out = buildPostureDecision(input);
    assert(stateSet.has(out.conversationState), `unknown conversationState '${out.conversationState}'`);
  }
});

check("confidenceSignal is float between 0 and 1", () => {
  const cases = [
    baseInput({ message: "je sais pas", recentHistory: [{ role: "user", content: "c'est pas ca" }] }),
    baseInput({ message: "ok", recentHistory: [{ role: "user", content: "merci" }] })
  ];

  for (const input of cases) {
    const out = buildPostureDecision(input);
    assert(typeof out.confidenceSignal === "number" && out.confidenceSignal >= 0 && out.confidenceSignal <= 1,
      `invalid confidenceSignal '${out.confidenceSignal}' (must be number 0.00-1.00)`);
  }
});

check("relancePolicy follows contract constraints", () => {
  const openExploration = buildPostureDecision(baseInput({
    detectedState: "exploration",
    effectiveExplorationDirectivityLevel: 0,
    calibrationAnalysis: { calibrationLevel: 0, explorationSignal: "interpretation" }
  }));
  assert(openExploration.relancePolicy === "open", "exploration level 0 should keep relance open");

  const discouragedExploration = buildPostureDecision(baseInput({
    detectedState: "exploration",
    effectiveExplorationDirectivityLevel: 4,
    calibrationAnalysis: { calibrationLevel: 4, explorationSignal: "interpretation" }
  }));
  assert(discouragedExploration.relancePolicy === "discouraged", "exploration level 4 should discourage relance");

  const stabilizationForbidden = buildPostureDecision(baseInput({
    detectedState: "exploration",
    processingWindow: "overloaded",
    engagementLevel: "withdrawn"
  }));
  assert(stabilizationForbidden.relancePolicy === "forbidden", "stabilization should forbid relance");
});

check("situated impasse activates action collapse guard", () => {
  const out = buildPostureDecision(baseInput({
    detectedState: "exploration",
    technicalContextDetected: true
  }));
  assert(out.actionCollapseGuardActive === true, "actionCollapseGuardActive should be true");
  assert(out.forbidden.includes("action_concrete_proposal"), "forbidden should include action_concrete_proposal");
});

if (failed > 0) {
  console.error(`\n[CONTRACT-VALIDATOR] ${passed} passed, ${failed} failed.`);
  process.exit(1);
}

console.log(`\n[CONTRACT-VALIDATOR] ${passed} checks passed.`);
