"use strict";

// â”€â”€â”€ posture harness â€” pure deterministic, no server required â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Exercises buildPostureDecision in isolation: all inputs are constructed
// in-process, no LLM calls, no Firebase.
//
// Covers:
//   - output field contract (all fields present, correct types)
//   - conversationState derivation across every state variant
//   - relational adjustment caps directivity
//   - confidenceSignal logic (ambiguity + rejection history)
//   - humanFieldGuardActive (situated impasse + exploration/contact mode)
//   - exploration submode derivation from calibrationAnalysis
//   - consecutiveNonExplorationTurns propagation
//   - flagUpdates contents per mode
//   - forbidden / intent / maxSentences / toneConstraint tables

const { buildPostureDecision } = require("../lib/pipeline");

// â”€â”€â”€ Assertion helpers â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

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

// â”€â”€â”€ Input factories â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

function contact(isContact = true) {
  return { isContact };
}

function noContact() {
  return { isContact: false };
}

function calibration(calibrationLevel = 0, explorationSubmode = "interpretation") {
  return { calibrationLevel, explorationSubmode };
}

function relational(needsRelationalAdjustment = false) {
  return { needsRelationalAdjustment };
}

function rejection(isInterpretationRejection = false, needsSoberReadjustment = false) {
  return { isInterpretationRejection, needsSoberReadjustment };
}

// Minimal valid input for exploration mode
// affiliationEstablished: true avoids E5 guard (no-contact → contact routing)
function explorationInput(overrides = {}) {
  return {
    detectedState: "exploration",
    affiliationEstablished: true,
    relationalAdjustmentAnalysis: relational(),
    calibrationAnalysis: calibration(0),
    technicalContextDetected: false,
    interpretationRejection: rejection(),
    effectiveExplorationDirectivityLevel: 0,
    previousConversationState: "exploration_open",
    currentConsecutiveNonExplorationTurns: 0,
    currentExplorationRelanceWindow: [false, false, false, false],
    message: "",
    recentHistory: [],
    ...overrides
  };
}

// â”€â”€â”€ Output shape contract â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

check("output: all required fields present", () => {
  const out = buildPostureDecision(explorationInput());
  const requiredStrings = ["requestedBaseState", "finalExplorationSubmode", "conversationState", "intent"];
  for (const f of requiredStrings) {
    assert(typeof out[f] === "string", `field '${f}' must be a string, got ${typeof out[f]}`);
  }
  const requiredNumbers = ["finalDirectivityLevel", "consecutiveNonExplorationTurns", "confidenceSignal"];
  for (const f of requiredNumbers) {
    assert(typeof out[f] === "number", `field '${f}' must be a number, got ${typeof out[f]}`);
  }
  const requiredBooleans = ["relationalAdjustmentActive", "interpretationRejectionModeActive",
    "needsSoberReadjustment", "underlyingPhenomenonRejected", "humanFieldGuardActive", "stateTransitionValid"];
  for (const f of requiredBooleans) {
    assert(typeof out[f] === "boolean", `field '${f}' must be boolean, got ${typeof out[f]}`);
  }
  assert(out.previousConversationState === null || typeof out.previousConversationState === "string",
    `field 'previousConversationState' must be null or string, got ${typeof out.previousConversationState}`);
  const requiredArrays = ["forbidden", "allowed", "theoreticalConstraints", "criticalGuardrails"];
  for (const f of requiredArrays) {
    assert(Array.isArray(out[f]), `field '${f}' must be an array`);
  }
  assert(typeof out.flagUpdates === "object" && out.flagUpdates !== null, "flagUpdates must be an object");
});

check("output: flagUpdates.conversationState always set", () => {
  const out = buildPostureDecision(explorationInput());
  assert(typeof out.flagUpdates.conversationState === "string",
    `flagUpdates.conversationState must be string, got ${typeof out.flagUpdates.conversationState}`);
});

check("output: maxSentences is null or number", () => {
  const out = buildPostureDecision(explorationInput());
  assert(out.maxSentences === null || typeof out.maxSentences === "number",
    `maxSentences must be null or number, got ${out.maxSentences}`);
});

check("output: toneConstraint is null or string", () => {
  const out = buildPostureDecision(explorationInput());
  assert(out.toneConstraint === null || typeof out.toneConstraint === "string",
    `toneConstraint must be null or string, got ${out.toneConstraint}`);
});

// â”€â”€â”€ conversationState resolution â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

check("state: exploration mode â†’ exploration_open", () => {
  const out = buildPostureDecision(explorationInput());
  assert(out.conversationState === "exploration_open",
    `expected 'exploration_open', got '${out.conversationState}'`);
});

check("state: contact detectedState â†’ contact", () => {
  const out = buildPostureDecision(explorationInput({
    detectedState: "contact",
    contactAnalysis: contact(true)
  }));
  assert(out.conversationState === "contact",
    `expected 'contact', got '${out.conversationState}'`);
});

check("state: info_features detectedState â†’ info_features", () => {
  const out = buildPostureDecision(explorationInput({
    detectedState: "info_features",
  }));
  assert(out.conversationState === "info_features",
    `expected 'info_features', got '${out.conversationState}'`);
});

check("state: prev=contact + exploration â†’ exploration_open (no post_contact state)", () => {
  const out = buildPostureDecision(explorationInput({
    previousConversationState: "contact"
  }));
  assert(out.conversationState === "exploration_open",
    `expected 'exploration_open', got '${out.conversationState}'`);
});

// â”€â”€â”€ discharge / post-discharge cooldown â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

check("state: prev=discharge_regulated + exploration â†’ contact (post-discharge cooldown)", () => {
  const out = buildPostureDecision(explorationInput({
    previousConversationState: "discharge_regulated"
  }));
  assert(out.conversationState === "contact",
    `expected 'contact' (post-discharge cooldown), got '${out.conversationState}'`);
});

check("state: prev=discharge_regulated + info_features â†’ info_features (cooldown skipped for info)", () => {
  const out = buildPostureDecision(explorationInput({
    detectedState: "info_features",
    previousConversationState: "discharge_regulated"
  }));
  assert(out.conversationState === "info_features",
    `expected 'info_features', got '${out.conversationState}'`);
});

check("forbidden: post-discharge contact forbids relance + interpretive_hypothesis (C3)", () => {
  const out = buildPostureDecision(explorationInput({
    previousConversationState: "discharge_regulated"
  }));
  assert(out.forbidden.includes("relance"),
    `expected 'relance' in forbidden for post-discharge contact, got [${out.forbidden.join(", ")}]`);
  assert(out.forbidden.includes("interpretive_hypothesis"),
    `expected 'interpretive_hypothesis' in forbidden for post-discharge contact`);
});

check("C3: post-discharge contact includes auto_compassion_door_open hint", () => {
  const out = buildPostureDecision(explorationInput({
    previousConversationState: "discharge_regulated"
  }));
  assert(Array.isArray(out.writerIntentHints) && out.writerIntentHints.includes("auto_compassion_door_open"),
    `expected 'auto_compassion_door_open' in writerIntentHints, got [${(out.writerIntentHints || []).join(", ")}]`);
});

check("state: alliance_rupture overrides exploration", () => {
  const out = buildPostureDecision(explorationInput({
    allianceState: "rupture"
  }));
  assert(out.conversationState === "alliance_rupture",
    `expected 'alliance_rupture', got '${out.conversationState}'`);
});

check("state: alliance_rupture overrides exploration (prev contact)", () => {
  const out = buildPostureDecision(explorationInput({
    previousConversationState: "contact",
    allianceState: "rupture"
  }));
  assert(out.conversationState === "alliance_rupture",
    `expected 'alliance_rupture', got '${out.conversationState}'`);
});

check("state: alliance_rupture does NOT override active contact", () => {
  const out = buildPostureDecision(explorationInput({
    detectedState: "contact",
    contactAnalysis: contact(true),
    allianceState: "rupture"
  }));
  assert(out.conversationState === "contact",
    `expected 'contact', got '${out.conversationState}'`);
});

check("state: stabilization (overloaded + withdrawn)", () => {
  const out = buildPostureDecision(explorationInput({
    processingWindow: "overloaded",
    engagementLevel: "withdrawn"
  }));
  assert(out.conversationState === "stabilization",
    `expected 'stabilization', got '${out.conversationState}'`);
});

check("state: stabilization (overloaded + stagnation>=2)", () => {
  const out = buildPostureDecision(explorationInput({
    processingWindow: "overloaded",
    stagnationTurns: 2
  }));
  assert(out.conversationState === "stabilization",
    `expected 'stabilization', got '${out.conversationState}'`);
});

check("state: no stabilization with stagnation=1 alone", () => {
  const out = buildPostureDecision(explorationInput({
    processingWindow: "overloaded",
    stagnationTurns: 1
  }));
  assert(out.conversationState === "exploration_open",
    `expected 'exploration_open', got '${out.conversationState}'`);
});

check("state: closureIntent â†’ closure", () => {
  const out = buildPostureDecision(explorationInput({ closureIntent: true }));
  assert(out.conversationState === "closure",
    `expected 'closure', got '${out.conversationState}'`);
});

check("state: closureIntent cannot override active contact", () => {
  const out = buildPostureDecision(explorationInput({
    detectedState: "contact",
    contactAnalysis: contact(true),
    closureIntent: true
  }));
  assert(out.conversationState === "contact",
    `expected 'contact', got '${out.conversationState}'`);
});

check("state: closureIntent cannot override alliance_rupture", () => {
  const out = buildPostureDecision(explorationInput({
    allianceState: "rupture",
    closureIntent: true
  }));
  assert(out.conversationState === "alliance_rupture",
    `expected 'alliance_rupture', got '${out.conversationState}'`);
});

check("state transition guard: closure -> stabilization marked invalid", () => {
  const out = buildPostureDecision(explorationInput({
    previousConversationState: "closure",
    processingWindow: "overloaded",
    engagementLevel: "withdrawn"
  }));
  assert(out.conversationState === "closure",
    `expected enforced state 'closure', got '${out.conversationState}'`);
  assert(out.requestedConversationState === "stabilization",
    `expected requestedConversationState 'stabilization', got '${out.requestedConversationState}'`);
  assert(out.stateTransitionValid === false,
    `expected stateTransitionValid=false for closure -> stabilization`);
});

check("state transition guard: closure -> alliance_rupture marked invalid", () => {
  const out = buildPostureDecision(explorationInput({
    previousConversationState: "closure",
    allianceState: "rupture"
  }));
  assert(out.conversationState === "closure",
    `expected enforced state 'closure', got '${out.conversationState}'`);
  assert(out.requestedConversationState === "alliance_rupture",
    `expected requestedConversationState 'alliance_rupture', got '${out.requestedConversationState}'`);
  assert(out.stateTransitionValid === false,
    `expected stateTransitionValid=false for closure -> alliance_rupture`);
});

check("state transition guard: exploration -> contact is valid", () => {
  const out = buildPostureDecision(explorationInput({
    previousConversationState: "exploration_open",
    detectedState: "contact",
    contactAnalysis: { isContact: true }
  }));
  assert(out.conversationState === "contact",
    `expected 'contact', got '${out.conversationState}'`);
  assert(out.stateTransitionValid === true,
    `expected stateTransitionValid=true`);
});

check("state transition guard: first turn (no previous state) is always valid", () => {
  const out = buildPostureDecision(explorationInput({
    previousConversationState: null
  }));
  assert(out.stateTransitionValid === true,
    `expected stateTransitionValid=true for first turn (null prev)`);
  assert(out.previousConversationState === null,
    `expected previousConversationState null, got '${out.previousConversationState}'`);
});

// â”€â”€â”€ conversationState derivation (extended states) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

check("conversationState: exploration + level 0 â†’ exploration_open", () => {
  const out = buildPostureDecision(explorationInput({ effectiveExplorationDirectivityLevel: 0 }));
  assert(out.conversationState === "exploration_open",
    `expected 'exploration_open', got '${out.conversationState}'`);
});

check("conversationState: exploration + level 2 â†’ exploration_restrained", () => {
  const out = buildPostureDecision(explorationInput({
    effectiveExplorationDirectivityLevel: 2,
    calibrationAnalysis: calibration(2)
  }));
  assert(out.conversationState === "exploration_restrained",
    `expected 'exploration_restrained', got '${out.conversationState}'`);
});

check("conversationState: contact detectedState â†’ contact", () => {
  const out = buildPostureDecision(explorationInput({
    detectedState: "contact",
    contactAnalysis: contact(true)
  }));
  assert(out.conversationState === "contact",
    `expected 'contact', got '${out.conversationState}'`);
});

check("conversationState: prev=contact + exploration â†’ exploration_open", () => {
  const out = buildPostureDecision(explorationInput({
    previousConversationState: "contact"
  }));
  assert(out.conversationState === "exploration_open",
    `expected 'exploration_open', got '${out.conversationState}'`);
});

check("conversationState: prev=discharge_regulated + exploration â†’ contact (post-discharge cooldown)", () => {
  const out = buildPostureDecision(explorationInput({
    previousConversationState: "discharge_regulated",
    affiliationEstablished: true
  }));
  assert(out.conversationState === "contact",
    `expected 'contact', got '${out.conversationState}'`);
});

check("conversationState: info_features â†’ info_features", () => {
  const out = buildPostureDecision(explorationInput({
    detectedState: "info_features"
  }));
  assert(out.conversationState === "info_features",
    `expected 'info_features', got '${out.conversationState}'`);
});

check("conversationState: info_psychoeducation â†’ info_psychoeducation", () => {
  const out = buildPostureDecision(explorationInput({
    detectedState: "info_psychoeducation"
  }));
  assert(out.conversationState === "info_psychoeducation",
    `expected 'info_psychoeducation', got '${out.conversationState}'`);
});

check("conversationState: info_pure â†’ info_pure", () => {
  const out = buildPostureDecision(explorationInput({
    detectedState: "info_pure"
  }));
  assert(out.conversationState === "info_pure",
    `expected 'info_pure', got '${out.conversationState}'`);
});

check("conversationState: alliance_rupture â†’ alliance_rupture", () => {
  const out = buildPostureDecision(explorationInput({ allianceState: "rupture" }));
  assert(out.conversationState === "alliance_rupture",
    `expected 'alliance_rupture', got '${out.conversationState}'`);
});

check("conversationState: stabilization â†’ stabilization", () => {
  const out = buildPostureDecision(explorationInput({
    processingWindow: "overloaded",
    engagementLevel: "withdrawn"
  }));
  assert(out.conversationState === "stabilization",
    `expected 'stabilization', got '${out.conversationState}'`);
});

check("conversationState: closure â†’ closure", () => {
  const out = buildPostureDecision(explorationInput({ closureIntent: true }));
  assert(out.conversationState === "closure",
    `expected 'closure', got '${out.conversationState}'`);
});

// â”€â”€â”€ forbidden / intent / constraints tables â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

check("forbidden: contact mode forbids interpretive_hypothesis", () => {
  const out = buildPostureDecision(explorationInput({
    detectedState: "contact",
    contactAnalysis: contact(true)
  }));
  assert(out.forbidden.includes("interpretive_hypothesis"),
    `expected 'interpretive_hypothesis' in forbidden, got [${out.forbidden.join(", ")}]`);
});

check("forbidden: stabilization includes open_question and relance", () => {
  const out = buildPostureDecision(explorationInput({
    processingWindow: "overloaded",
    engagementLevel: "withdrawn"
  }));
  assert(out.forbidden.includes("open_question"),
    `expected 'open_question' in stabilization forbidden`);
  assert(out.forbidden.includes("relance"),
    `expected 'relance' in stabilization forbidden`);
});

check("intent: post_contact intent is non-empty string", () => {
  const out = buildPostureDecision(explorationInput({
    previousConversationState: "contact"
  }));
  assert(typeof out.intent === "string" && out.intent.length > 0,
    `expected non-empty intent, got '${out.intent}'`);
});

check("maxSentences: contact mode = 3", () => {
  const out = buildPostureDecision(explorationInput({
    detectedState: "contact",
    contactAnalysis: contact(true)
  }));
  assert(out.maxSentences === 3,
    `expected maxSentences 3 for contact mode, got ${out.maxSentences}`);
});

check("maxSentences: exploration_open = 5", () => {
  const out = buildPostureDecision(explorationInput());
  assert(out.maxSentences === 5,
    `expected maxSentences 5 for exploration_open, got ${out.maxSentences}`);
});

check("toneConstraint: stabilization = 'minimal'", () => {
  const out = buildPostureDecision(explorationInput({
    processingWindow: "overloaded",
    engagementLevel: "withdrawn"
  }));
  assert(out.toneConstraint === "minimal",
    `expected toneConstraint 'minimal', got '${out.toneConstraint}'`);
});

// â”€â”€â”€ relational adjustment caps directivity â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

check("relational adjustment: caps directivity to 2 when level is 4", () => {
  const out = buildPostureDecision(explorationInput({
    effectiveExplorationDirectivityLevel: 4,
    calibrationAnalysis: calibration(4),
    relationalAdjustmentAnalysis: relational(true)
  }));
  assert(out.finalDirectivityLevel <= 2,
    `expected directivity <= 2 after relational adjustment, got ${out.finalDirectivityLevel}`);
  assert(out.relationalAdjustmentActive === true,
    "expected relationalAdjustmentActive true");
  assert(out.preAdjustmentDirectivityLevel === 4,
    `expected preAdjustmentDirectivityLevel 4, got ${out.preAdjustmentDirectivityLevel}`);
});

check("relational adjustment: no cap when level already â‰¤ 2", () => {
  const out = buildPostureDecision(explorationInput({
    effectiveExplorationDirectivityLevel: 1,
    calibrationAnalysis: calibration(1),
    relationalAdjustmentAnalysis: relational(true)
  }));
  assert(out.finalDirectivityLevel <= 2,
    `expected directivity <= 2, got ${out.finalDirectivityLevel}`);
  assert(out.relationalAdjustmentActive === true,
    "expected relationalAdjustmentActive true");
});

check("no relational adjustment: directivity untouched", () => {
  const out = buildPostureDecision(explorationInput({
    effectiveExplorationDirectivityLevel: 3,
    calibrationAnalysis: calibration(3),
    relationalAdjustmentAnalysis: relational(false)
  }));
  assert(out.relationalAdjustmentActive === false,
    "expected relationalAdjustmentActive false");
  assert(out.preAdjustmentDirectivityLevel === null,
    `expected preAdjustmentDirectivityLevel null, got ${out.preAdjustmentDirectivityLevel}`);
});

// â”€â”€â”€ exploration calibration selects min(effective, calibration) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

check("directivity: min(effective=3, calibration=1) = 1", () => {
  const out = buildPostureDecision(explorationInput({
    effectiveExplorationDirectivityLevel: 3,
    calibrationAnalysis: calibration(1)
  }));
  assert(out.finalDirectivityLevel === 1,
    `expected finalDirectivityLevel 1, got ${out.finalDirectivityLevel}`);
});

check("directivity: min(effective=1, calibration=3) = 1", () => {
  const out = buildPostureDecision(explorationInput({
    effectiveExplorationDirectivityLevel: 1,
    calibrationAnalysis: calibration(3)
  }));
  assert(out.finalDirectivityLevel === 1,
    `expected finalDirectivityLevel 1, got ${out.finalDirectivityLevel}`);
});

// â”€â”€â”€ exploration submode â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

check("explorationSubmode: phenomenological_follow passed through", () => {
  const out = buildPostureDecision(explorationInput({
    calibrationAnalysis: calibration(0, "phenomenological_follow")
  }));
  assert(out.finalExplorationSubmode === "phenomenological_follow",
    `expected 'phenomenological_follow', got '${out.finalExplorationSubmode}'`);
});

check("explorationSubmode: unknown falls back to 'interpretation'", () => {
  const out = buildPostureDecision(explorationInput({
    calibrationAnalysis: calibration(0, "unknown_submode")
  }));
  assert(out.finalExplorationSubmode === "interpretation",
    `expected 'interpretation', got '${out.finalExplorationSubmode}'`);
});

// â”€â”€â”€ flagUpdates â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

check("flagUpdates: exploration sets explorationCalibrationLevel", () => {
  const out = buildPostureDecision(explorationInput({
    effectiveExplorationDirectivityLevel: 2,
    calibrationAnalysis: calibration(2)
  }));
  assert(out.flagUpdates.explorationCalibrationLevel === 2,
    `expected explorationCalibrationLevel 2, got ${out.flagUpdates.explorationCalibrationLevel}`);
});

check("flagUpdates: conversationState is set for all modes", () => {
  const out = buildPostureDecision(explorationInput({
    detectedState: "info_psychoeducation"
  }));
  assert(typeof out.flagUpdates.conversationState === "string",
    `expected conversationState string in flagUpdates, got ${typeof out.flagUpdates.conversationState}`);
});

// â”€â”€â”€ consecutiveNonExplorationTurns â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

check("consecutiveTurns: exploration resets to 0", () => {
  const out = buildPostureDecision(explorationInput({
    currentConsecutiveNonExplorationTurns: 5
  }));
  assert(out.consecutiveNonExplorationTurns === 0,
    `expected 0 after exploration, got ${out.consecutiveNonExplorationTurns}`);
});

check("consecutiveTurns: info mode from 0 â†’ 1", () => {
  const out = buildPostureDecision(explorationInput({
    detectedState: "info_features",
    currentConsecutiveNonExplorationTurns: 0
  }));
  assert(out.consecutiveNonExplorationTurns === 1,
    `expected 1, got ${out.consecutiveNonExplorationTurns}`);
});

check("consecutiveTurns: info mode from 3 â†’ 4, window decays", () => {
  const out = buildPostureDecision(explorationInput({
    detectedState: "info_features",
    currentConsecutiveNonExplorationTurns: 3,
    currentExplorationRelanceWindow: [true, true, false, false]
  }));
  assert(out.consecutiveNonExplorationTurns === 4,
    `expected 4, got ${out.consecutiveNonExplorationTurns}`);
  assert(Array.isArray(out.flagUpdates.explorationRelanceWindow),
    "expected explorationRelanceWindow in flagUpdates after non-exploration accumulation");
});

check("consecutiveTurns: post_contact resets to 0", () => {
  const out = buildPostureDecision(explorationInput({
    previousConversationState: "contact",
    currentConsecutiveNonExplorationTurns: 3
  }));
  assert(out.consecutiveNonExplorationTurns === 0,
    `expected 0 after post_contact, got ${out.consecutiveNonExplorationTurns}`);
});

// â”€â”€â”€ confidenceSignal â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

check("confidenceSignal: default with no ambiguity â†’ 0.8", () => {
  const out = buildPostureDecision(explorationInput({
    message: "Je veux avancer sur quelque chose.",
    recentHistory: []
  }));
  assert(out.confidenceSignal === 0.8,
    `expected 0.8, got ${out.confidenceSignal}`);
});

check("confidenceSignal: explicit ambiguity + no context â†’ 0.4", () => {
  const out = buildPostureDecision(explorationInput({
    message: "je sais pas, c'est mÃ©langÃ© pour moi.",
    recentHistory: []
  }));
  assert(out.confidenceSignal === 0.4,
    `expected 0.4, got ${out.confidenceSignal}`);
});

check("confidenceSignal: recent rejection signal â†’ 0.1", () => {
  const out = buildPostureDecision(explorationInput({
    message: "je sais pas",
    recentHistory: [
      { role: "user", content: "c'est pas ca du tout" }
    ]
  }));
  assert(out.confidenceSignal === 0.1,
    `expected 0.1, got ${out.confidenceSignal}`);
});

// â”€â”€â”€ humanFieldGuardActive â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

check("humanFieldGuard: situated impasse + exploration â†’ active", () => {
  const out = buildPostureDecision(explorationInput({
    technicalContextDetected: true
  }));
  assert(out.humanFieldGuardActive === true,
    `expected humanFieldGuardActive true, got ${out.humanFieldGuardActive}`);
  assert(out.criticalGuardrails.includes("no_procedural_instrumental_reply"),
    "expected 'no_procedural_instrumental_reply' in criticalGuardrails");
});

check("humanFieldGuard: conceptual info question â†’ NOT active", () => {
  const out = buildPostureDecision(explorationInput({
    technicalContextDetected: false
  }));
  assert(out.humanFieldGuardActive === false,
    `expected humanFieldGuardActive false for conceptual question, got ${out.humanFieldGuardActive}`);
});

check("humanFieldGuard: info mode â†’ NOT active (guard only for exploration/discharge)", () => {
  const out = buildPostureDecision(explorationInput({
    detectedState: "info_features",
    technicalContextDetected: true
  }));
  assert(out.humanFieldGuardActive === false,
    `expected humanFieldGuardActive false in info mode, got ${out.humanFieldGuardActive}`);
});

// â”€â”€â”€ theoreticalConstraints always present â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

check("theoreticalConstraints: always includes no_unconscious", () => {
  const out = buildPostureDecision(explorationInput());
  assert(out.theoreticalConstraints.includes("no_unconscious"),
    "expected 'no_unconscious' in theoreticalConstraints");
});

check("theoreticalConstraints: always includes no_implicit_agency", () => {
  const out = buildPostureDecision(explorationInput());
  assert(out.theoreticalConstraints.includes("no_implicit_agency"),
    "expected 'no_implicit_agency' in theoreticalConstraints");
});

// â”€â”€â”€ detectedState passthrough â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

check("requestedBaseState: matches input detectedState", () => {
  const outInfo = buildPostureDecision(explorationInput({ detectedState: "info_pure" }));
  assert(outInfo.requestedBaseState === "info_pure", `expected 'info_pure', got '${outInfo.requestedBaseState}'`);

  const outContact = buildPostureDecision(explorationInput({ detectedState: "contact", contactAnalysis: contact() }));
  assert(outContact.requestedBaseState === "contact", `expected 'contact', got '${outContact.requestedBaseState}'`);
});
// N1 routing: buildPostureDecision does NOT set conversationState to n1_crisis.
// N1 uses effectiveConversationState internally for forbidden/intent routing,
// but conversationState output stays as the normally-resolved state.
// The actual n1_crisis override is handled by server.js early-return logic.

check("N1: forbidden includes n1_crisis restrictions", () => {
  const out = buildPostureDecision(explorationInput({ suicideLevel: "N1" }));
  assert(out.forbidden.includes("relance"), "expected relance in forbidden for N1, got [" + out.forbidden.join(", ") + "]");
  assert(out.forbidden.includes("open_question"), "expected open_question in forbidden for N1");
});

check("N0: normal conversationState (no override)", () => {
  const out = buildPostureDecision(explorationInput({ suicideLevel: "N0" }));
  assert(out.conversationState !== "n1_crisis", "expected normal state, got n1_crisis");
  assert(out.conversationState === "exploration_open", "expected exploration_open, got " + out.conversationState);
});

check("N1 in contact mode: forbidden includes n1_crisis restrictions", () => {
  const out = buildPostureDecision(explorationInput({ detectedState: "contact", affiliationEstablished: true, suicideLevel: "N1" }));
  assert(out.forbidden.includes("relance"), "expected relance in forbidden for N1+contact, got [" + out.forbidden.join(", ") + "]");
});

check("recallInjectionActive: flag passed (no conversationState override)", () => {
  const out = buildPostureDecision(explorationInput({ isRecallAttempt: true }));
  assert(out.recallInjectionActive === true, "expected recallInjectionActive true, got " + out.recallInjectionActive);
  assert(out.conversationState !== "recall_memory", "conversationState must not be recall_memory");
});

check("N1 + recall: N1 routing applied (forbidden includes n1_crisis restrictions)", () => {
  const out = buildPostureDecision(explorationInput({ suicideLevel: "N1", isRecallAttempt: true }));
  assert(out.forbidden.includes("relance"), "expected relance in forbidden for N1+recall, got [" + out.forbidden.join(", ") + "]");
  assert(out.recallInjectionActive === true, "expected recallInjectionActive true");
});

const total = passed + failed;
console.log("\n[POSTURE] " + passed + "/" + total + " checks passed.");
if (failed > 0) process.exitCode = 1;
