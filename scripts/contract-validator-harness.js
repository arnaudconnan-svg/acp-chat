"use strict";

// ─── contract-validator harness ─────────────────────────────────────────────
// Pure deterministic checks for posture contracts and writer mode tables.
// No server, no LLM, no network.

const {
  buildPostureDecision
} = require("../lib/pipeline");

const {
  CONVERSATION_STATES,
  WRITER_MODE_FORBIDDEN,
  WRITER_MODE_ALLOWED,
  WRITER_MODE_INTENT,
  WRITER_MODE_CONSTRAINTS,
  stateToWriterMode
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
    detectedMode: "exploration",
    detectedInfoSubmode: null,
    contactAnalysis: { isContact: false, contactSubmode: null },
    relationalAdjustmentAnalysis: { needsRelationalAdjustment: false },
    calibrationAnalysis: { calibrationLevel: 0, explorationSubmode: "interpretation" },
    situatedImpasseDetected: false,
    interpretationRejection: {
      isInterpretationRejection: false,
      needsSoberReadjustment: false,
      rejectsUnderlyingPhenomenon: false,
      tensionHoldLevel: "medium"
    },
    effectiveExplorationDirectivityLevel: 0,
    previousConversationStateKey: "exploration",
    currentConsecutiveNonExplorationTurns: 0,
    currentExplorationRelanceWindow: [false, false, false, false],
    allianceState: "good",
    engagementLevel: "active",
    stagnationTurns: 0,
    processingWindow: "open",
    closureIntent: false,
    message: "",
    recentHistory: [],
    ...overrides
  };
}

function expectedWriterModeForState(state) {
  if (state === "contact") {
    return [
      stateToWriterMode("contact", { contactSubmode: "regulated" }),
      stateToWriterMode("contact", { contactSubmode: "dysregulated" })
    ];
  }

  if (state === "info") {
    return [
      stateToWriterMode("info", { infoSubmode: "pure" }),
      stateToWriterMode("info", { infoSubmode: "psychoeducation" }),
      stateToWriterMode("info", { infoSubmode: "app_features" })
    ];
  }

  return [stateToWriterMode(state, { directivityLevel: 0 })];
}

check("writer mode tables are aligned", () => {
  const modeKeys = Object.keys(WRITER_MODE_ALLOWED).sort();
  const forbiddenKeys = Object.keys(WRITER_MODE_FORBIDDEN).sort();
  const intentKeys = Object.keys(WRITER_MODE_INTENT).sort();

  assert(JSON.stringify(modeKeys) === JSON.stringify(forbiddenKeys), "WRITER_MODE_FORBIDDEN keys mismatch WRITER_MODE_ALLOWED");
  assert(JSON.stringify(modeKeys) === JSON.stringify(intentKeys), "WRITER_MODE_INTENT keys mismatch WRITER_MODE_ALLOWED");
});

check("constraints keys are subset of writer mode keys", () => {
  const modeSet = new Set(Object.keys(WRITER_MODE_ALLOWED));
  for (const key of Object.keys(WRITER_MODE_CONSTRAINTS)) {
    assert(modeSet.has(key), `constraint key '${key}' missing from WRITER_MODE_ALLOWED`);
  }
});

check("every conversation state maps to a known writer mode", () => {
  const modeSet = new Set(Object.keys(WRITER_MODE_ALLOWED));
  for (const state of CONVERSATION_STATES) {
    const candidates = expectedWriterModeForState(state);
    for (const mode of candidates) {
      assert(modeSet.has(mode), `state '${state}' maps to unknown writerMode '${mode}'`);
    }
  }
});

check("posture decision always returns known writer mode", () => {
  const modeSet = new Set(Object.keys(WRITER_MODE_ALLOWED));

  const cases = [
    baseInput({ detectedMode: "exploration", calibrationAnalysis: { calibrationLevel: 0, explorationSubmode: "interpretation" } }),
    baseInput({ detectedMode: "exploration", calibrationAnalysis: { calibrationLevel: 3, explorationSubmode: "interpretation" }, effectiveExplorationDirectivityLevel: 4 }),
    baseInput({ detectedMode: "contact", contactAnalysis: { isContact: true, contactSubmode: "regulated" } }),
    baseInput({ detectedMode: "contact", contactAnalysis: { isContact: true, contactSubmode: "dysregulated" } }),
    baseInput({ detectedMode: "info", detectedInfoSubmode: "pure" }),
    baseInput({ detectedMode: "info", detectedInfoSubmode: "psychoeducation" }),
    baseInput({ detectedMode: "info", detectedInfoSubmode: "app_features" }),
    baseInput({ allianceState: "rupture" }),
    baseInput({ closureIntent: true }),
    baseInput({ processingWindow: "overloaded", engagementLevel: "withdrawn" })
  ];

  for (const input of cases) {
    const out = buildPostureDecision(input);
    assert(modeSet.has(out.writerMode), `unknown writerMode '${out.writerMode}'`);
  }
});

check("confidenceSignal only emits low|high", () => {
  const cases = [
    baseInput({ message: "je sais pas", recentHistory: [{ role: "user", content: "c'est pas ca" }] }),
    baseInput({ message: "ok", recentHistory: [{ role: "user", content: "merci" }] })
  ];

  for (const input of cases) {
    const out = buildPostureDecision(input);
    assert(["low", "high"].includes(out.confidenceSignal), `invalid confidenceSignal '${out.confidenceSignal}'`);
  }
});

check("relancePolicy follows contract constraints", () => {
  const forbiddenRelance = buildPostureDecision(baseInput({
    detectedMode: "contact",
    contactAnalysis: { isContact: true, contactSubmode: "dysregulated" }
  }));
  assert(forbiddenRelance.relancePolicy === "forbidden", "contact dysregulated should forbid relance");

  const openExploration = buildPostureDecision(baseInput({
    detectedMode: "exploration",
    effectiveExplorationDirectivityLevel: 0,
    calibrationAnalysis: { calibrationLevel: 0, explorationSubmode: "interpretation" }
  }));
  assert(openExploration.relancePolicy === "open", "exploration level 0 should keep relance open");

  const discouragedExploration = buildPostureDecision(baseInput({
    detectedMode: "exploration",
    effectiveExplorationDirectivityLevel: 4,
    calibrationAnalysis: { calibrationLevel: 4, explorationSubmode: "interpretation" }
  }));
  assert(discouragedExploration.relancePolicy === "discouraged", "exploration level 4 should discourage relance");
});

check("situated impasse activates action collapse guard", () => {
  const out = buildPostureDecision(baseInput({
    detectedMode: "exploration",
    situatedImpasseDetected: true
  }));
  assert(out.actionCollapseGuardActive === true, "actionCollapseGuardActive should be true");
  assert(out.forbidden.includes("action_concrete_proposal"), "forbidden should include action_concrete_proposal");
});

if (failed > 0) {
  console.error(`\n[CONTRACT-VALIDATOR] ${passed} passed, ${failed} failed.`);
  process.exit(1);
}

console.log(`\n[CONTRACT-VALIDATOR] ${passed} checks passed.`);
