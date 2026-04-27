"use strict";

// ─── posture harness — pure deterministic, no server required ────────────────
// Exercises buildPostureDecision in isolation: all inputs are constructed
// in-process, no LLM calls, no Firebase.
//
// Covers:
//   - output field contract (all fields present, correct types)
//   - writerMode derivation across every state variant
//   - conversationStateKey resolution (contact > info > exploration, Phase B)
//   - relational adjustment caps directivity
//   - confidenceSignal logic (ambiguity + rejection history)
//   - humanFieldGuardActive (situated impasse + exploration/contact mode)
//   - exploration submode derivation from calibrationAnalysis
//   - consecutiveNonExplorationTurns propagation
//   - flagUpdates contents per mode
//   - forbidden / intent / maxSentences / toneConstraint tables

const { buildPostureDecision } = require("../lib/pipeline");

// ─── Assertion helpers ────────────────────────────────────────────────────────

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

// ─── Input factories ──────────────────────────────────────────────────────────

function contact(isContact = true, contactSubmode = "regulated") {
  return { isContact, contactSubmode };
}

function noContact() {
  return { isContact: false, contactSubmode: null };
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
function explorationInput(overrides = {}) {
  return {
    detectedMode: "exploration",
    detectedInfoSubmode: null,
    contactAnalysis: noContact(),
    relationalAdjustmentAnalysis: relational(),
    calibrationAnalysis: calibration(0),
    technicalContextDetected: false,
    interpretationRejection: rejection(),
    effectiveExplorationDirectivityLevel: 0,
    previousConversationStateKey: "exploration",
    currentConsecutiveNonExplorationTurns: 0,
    currentExplorationRelanceWindow: [false, false, false, false],
    message: "",
    recentHistory: [],
    ...overrides
  };
}

// ─── Output shape contract ────────────────────────────────────────────────────

check("output: all required fields present", () => {
  const out = buildPostureDecision(explorationInput());
  const requiredStrings = ["finalDetectedMode", "finalExplorationSubmode", "conversationStateKey",
    "writerMode", "intent"];
  for (const f of requiredStrings) {
    assert(typeof out[f] === "string", `field '${f}' must be a string, got ${typeof out[f]}`);
  }
  const requiredNumbers = ["finalDirectivityLevel", "consecutiveNonExplorationTurns", "confidenceSignal"];
  for (const f of requiredNumbers) {
    assert(typeof out[f] === "number", `field '${f}' must be a number, got ${typeof out[f]}`);
  }
  const requiredBooleans = ["relationalAdjustmentTriggered", "interpretationRejectionDetected",
    "needsSoberReadjustment", "rejectsUnderlyingPhenomenon", "humanFieldGuardActive", "stateTransitionValid"];
  for (const f of requiredBooleans) {
    assert(typeof out[f] === "boolean", `field '${f}' must be boolean, got ${typeof out[f]}`);
  }
  assert(out.previousConversationStateKey === null || typeof out.previousConversationStateKey === "string",
    `field 'previousConversationStateKey' must be null or string, got ${typeof out.previousConversationStateKey}`);
  const requiredArrays = ["forbidden", "allowed", "theoreticalConstraints", "criticalGuardrails"];
  for (const f of requiredArrays) {
    assert(Array.isArray(out[f]), `field '${f}' must be an array`);
  }
  assert(typeof out.flagUpdates === "object" && out.flagUpdates !== null, "flagUpdates must be an object");
});

check("output: flagUpdates.conversationStateKey always set", () => {
  const out = buildPostureDecision(explorationInput());
  assert(typeof out.flagUpdates.conversationStateKey === "string",
    `flagUpdates.conversationStateKey must be string, got ${typeof out.flagUpdates.conversationStateKey}`);
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

// ─── conversationStateKey resolution ─────────────────────────────────────────

check("state: exploration mode → exploration", () => {
  const out = buildPostureDecision(explorationInput());
  assert(out.conversationStateKey === "exploration",
    `expected 'exploration', got '${out.conversationStateKey}'`);
});

check("state: contact mode → contact", () => {
  const out = buildPostureDecision(explorationInput({
    detectedMode: "contact",
    contactAnalysis: contact(true, "regulated")
  }));
  assert(out.conversationStateKey === "contact",
    `expected 'contact', got '${out.conversationStateKey}'`);
});

check("state: info mode → info", () => {
  const out = buildPostureDecision(explorationInput({
    detectedMode: "info",
    detectedInfoSubmode: "app_features",
    calibrationAnalysis: calibration(0)
  }));
  assert(out.conversationStateKey === "info",
    `expected 'info', got '${out.conversationStateKey}'`);
});

check("state: prev=contact + exploration \u2192 exploration (post_contact retired)", () => {
  // post_contact removed from state machine; prev=contact + exploration resolves to exploration.
  const out = buildPostureDecision(explorationInput({
    previousConversationStateKey: "contact"
  }));
  assert(out.conversationStateKey === "exploration",
    `expected 'exploration', got '${out.conversationStateKey}'`);
});

// ─── discharge / post-discharge cooldown ──────────────────────────────────────
// post_contact replaced by: resolveConversationState Priority 3 triggers contact state
// when previousConversationStateKey === "discharge" and detectedMode !== "info".
// Priority 3 now uses !== "info" instead of === "exploration" so the E5 override
// (modeForStateResolution = "contact" when !contactEstablished) no longer bypasses it.

check("state: discharge still active \u2192 discharge", () => {
  const out = buildPostureDecision(explorationInput({
    detectedMode: "discharge",
    dischargeAnalysis: { isContact: true, contactSubmode: "regulated" },
    previousConversationStateKey: "discharge",
    contactEstablished: true
  }));
  assert(out.conversationStateKey === "discharge",
    `expected 'discharge', got '${out.conversationStateKey}'`);
});

check("state: prev=discharge + exploration (contactEstablished:false) \u2192 contact (cooldown fires via E5 path)", () => {
  // Bug fix: when !contactEstablished, E5 sets modeForStateResolution="contact" before
  // resolveConversationState. Priority 3 now checks detectedMode !== "info" so it fires
  // regardless of the E5 override. contactEstablished: false is the real scenario.
  const out = buildPostureDecision(explorationInput({
    previousConversationStateKey: "discharge"
    // contactEstablished defaults to false in explorationInput
  }));
  assert(out.conversationStateKey === "contact",
    `expected 'contact' (post-discharge cooldown), got '${out.conversationStateKey}'`);
});

check("state: prev=discharge + exploration (contactEstablished:true) \u2192 contact (cooldown fires directly)", () => {
  // When contactEstablished is true, E5 does not override; Priority 3 fires on detectedMode="exploration".
  const out = buildPostureDecision(explorationInput({
    previousConversationStateKey: "discharge",
    contactEstablished: true
  }));
  assert(out.conversationStateKey === "contact",
    `expected 'contact' (post-discharge cooldown), got '${out.conversationStateKey}'`);
});

check("state: prev=discharge + info \u2192 info (cooldown skipped for info mode)", () => {
  // Priority 3 skips when detectedMode === "info" so the user can switch to info after discharge.
  const out = buildPostureDecision(explorationInput({
    detectedMode: "info",
    detectedInfoSubmode: "app_features",
    previousConversationStateKey: "discharge"
  }));
  assert(out.conversationStateKey === "info",
    `expected 'info' (cooldown does not block info after discharge), got '${out.conversationStateKey}'`);
});

check("forbidden: post-discharge contact forbids relance + interpretive_hypothesis (C3)", () => {
  const out = buildPostureDecision(explorationInput({
    previousConversationStateKey: "discharge"
  }));
  assert(out.forbidden.includes("relance"),
    `expected 'relance' in forbidden for post-discharge contact, got [${out.forbidden.join(", ")}]`);
  assert(out.forbidden.includes("interpretive_hypothesis"),
    `expected 'interpretive_hypothesis' in forbidden for post-discharge contact`);
});

check("C3: post-discharge contact includes auto_compassion_door_open hint", () => {
  const out = buildPostureDecision(explorationInput({
    previousConversationStateKey: "discharge"
  }));
  assert(Array.isArray(out.writerIntentHints) && out.writerIntentHints.includes("auto_compassion_door_open"),
    `expected 'auto_compassion_door_open' in writerIntentHints, got [${(out.writerIntentHints || []).join(", ")}]`);
});

check("state: alliance_rupture overrides exploration", () => {
  const out = buildPostureDecision(explorationInput({
    allianceState: "rupture"
  }));
  assert(out.conversationStateKey === "alliance_rupture",
    `expected 'alliance_rupture', got '${out.conversationStateKey}'`);
});

check("state: alliance_rupture overrides post_contact", () => {
  const out = buildPostureDecision(explorationInput({
    previousConversationStateKey: "contact",
    allianceState: "rupture"
  }));
  assert(out.conversationStateKey === "alliance_rupture",
    `expected 'alliance_rupture', got '${out.conversationStateKey}'`);
});

check("state: alliance_rupture does NOT override active contact", () => {
  const out = buildPostureDecision(explorationInput({
    detectedMode: "contact",
    contactAnalysis: contact(true, "regulated"),
    allianceState: "rupture"
  }));
  assert(out.conversationStateKey === "contact",
    `expected 'contact', got '${out.conversationStateKey}'`);
});

check("state: stabilization (overloaded + withdrawn)", () => {
  const out = buildPostureDecision(explorationInput({
    processingWindow: "overloaded",
    engagementLevel: "withdrawn"
  }));
  assert(out.conversationStateKey === "stabilization",
    `expected 'stabilization', got '${out.conversationStateKey}'`);
});

check("state: stabilization (overloaded + stagnation>=2)", () => {
  const out = buildPostureDecision(explorationInput({
    processingWindow: "overloaded",
    stagnationTurns: 2
  }));
  assert(out.conversationStateKey === "stabilization",
    `expected 'stabilization', got '${out.conversationStateKey}'`);
});

check("state: no stabilization with stagnation=1 alone", () => {
  const out = buildPostureDecision(explorationInput({
    processingWindow: "overloaded",
    stagnationTurns: 1
  }));
  assert(out.conversationStateKey === "exploration",
    `expected 'exploration', got '${out.conversationStateKey}'`);
});

check("state: closureIntent → closure", () => {
  const out = buildPostureDecision(explorationInput({ closureIntent: true }));
  assert(out.conversationStateKey === "closure",
    `expected 'closure', got '${out.conversationStateKey}'`);
});

check("state: closureIntent cannot override active contact", () => {
  const out = buildPostureDecision(explorationInput({
    detectedMode: "contact",
    contactAnalysis: contact(true, "regulated"),
    closureIntent: true
  }));
  assert(out.conversationStateKey === "contact",
    `expected 'contact', got '${out.conversationStateKey}'`);
});

check("state: closureIntent cannot override alliance_rupture", () => {
  const out = buildPostureDecision(explorationInput({
    allianceState: "rupture",
    closureIntent: true
  }));
  assert(out.conversationStateKey === "alliance_rupture",
    `expected 'alliance_rupture', got '${out.conversationStateKey}'`);
});

check("state transition guard: closure -> stabilization marked invalid", () => {
  const out = buildPostureDecision(explorationInput({
    previousConversationStateKey: "closure",
    processingWindow: "overloaded",
    engagementLevel: "withdrawn"
  }));
  // Enforcement: invalid transition → effective state is the previous state (closure)
  assert(out.conversationStateKey === "closure",
    `expected enforced state 'closure', got '${out.conversationStateKey}'`);
  assert(out.requestedConversationStateKey === "stabilization",
    `expected requestedConversationStateKey 'stabilization', got '${out.requestedConversationStateKey}'`);
  assert(out.stateTransitionValid === false,
    `expected stateTransitionValid=false for closure -> stabilization, got '${out.stateTransitionValid}'`);
});

check("state transition guard: closure -> alliance_rupture marked invalid", () => {
  const out = buildPostureDecision(explorationInput({
    previousConversationStateKey: "closure",
    allianceState: "rupture"
  }));
  // Enforcement: invalid transition → effective state is the previous state (closure)
  assert(out.conversationStateKey === "closure",
    `expected enforced state 'closure', got '${out.conversationStateKey}'`);
  assert(out.requestedConversationStateKey === "alliance_rupture",
    `expected requestedConversationStateKey 'alliance_rupture', got '${out.requestedConversationStateKey}'`);
  assert(out.stateTransitionValid === false,
    `expected stateTransitionValid=false for closure -> alliance_rupture, got '${out.stateTransitionValid}'`);
});

check("state transition guard: known valid exploration -> contact is valid", () => {
  const out = buildPostureDecision(explorationInput({
    previousConversationStateKey: "exploration",
    detectedMode: "contact",
    contactAnalysis: { isContact: true, contactSubmode: "regulated" }
  }));
  assert(out.conversationStateKey === "contact",
    `expected 'contact', got '${out.conversationStateKey}'`);
  assert(out.stateTransitionValid === true,
    `expected stateTransitionValid=true for exploration -> contact, got '${out.stateTransitionValid}'`);
});

check("state transition guard: first turn (no previous state) is always valid", () => {
  const out = buildPostureDecision(explorationInput({
    previousConversationStateKey: null
  }));
  assert(out.stateTransitionValid === true,
    `expected stateTransitionValid=true for first turn (null prev), got '${out.stateTransitionValid}'`);
  assert(out.previousConversationStateKey === null,
    `expected previousConversationStateKey null, got '${out.previousConversationStateKey}'`);
});

// ─── writerMode derivation ────────────────────────────────────────────────────

check("writerMode: exploration + level 0 → exploration_open", () => {
  const out = buildPostureDecision(explorationInput({ effectiveExplorationDirectivityLevel: 0 }));
  assert(out.writerMode === "exploration_open",
    `expected 'exploration_open', got '${out.writerMode}'`);
});

check("writerMode: exploration + level 1 → exploration_open", () => {
  const out = buildPostureDecision(explorationInput({
    effectiveExplorationDirectivityLevel: 1,
    calibrationAnalysis: calibration(1)
  }));
  assert(out.writerMode === "exploration_open",
    `expected 'exploration_open', got '${out.writerMode}'`);
});

check("writerMode: exploration + level 2 → exploration_guided", () => {
  const out = buildPostureDecision(explorationInput({
    effectiveExplorationDirectivityLevel: 2,
    calibrationAnalysis: calibration(2)
  }));
  assert(out.writerMode === "exploration_guided",
    `expected 'exploration_guided', got '${out.writerMode}'`);
});

check("writerMode: contact regulated → contact (merged)", () => {
  // contact_regulated/contact_dysregulated merged into single 'contact' writerMode.
  const out = buildPostureDecision(explorationInput({
    detectedMode: "contact",
    contactAnalysis: contact(true, "regulated")
  }));
  assert(out.writerMode === "contact",
    `expected 'contact', got '${out.writerMode}'`);
});

check("writerMode: contact dysregulated → contact (merged)", () => {
  const out = buildPostureDecision(explorationInput({
    detectedMode: "contact",
    contactAnalysis: contact(true, "dysregulated")
  }));
  assert(out.writerMode === "contact",
    `expected 'contact', got '${out.writerMode}'`);
});

check("writerMode: prev=contact + exploration → exploration_open (post_contact retired)", () => {
  // post_contact was removed; prev=contact + detectedMode=exploration resolves to exploration_open.
  const out = buildPostureDecision(explorationInput({
    previousConversationStateKey: "contact"
  }));
  assert(out.writerMode === "exploration_open",
    `expected 'exploration_open', got '${out.writerMode}'`);
});
check("writerMode: prev=discharge + exploration (contactEstablished) \u2192 contact (post-discharge cooldown)", () => {
  const out = buildPostureDecision(explorationInput({
    previousConversationStateKey: "discharge",
    contactEstablished: true
  }));
  assert(out.writerMode === "contact",
    `expected 'contact' writerMode for post-discharge cooldown, got '${out.writerMode}'`);
});
check("writerMode: info app_features → info_app_features", () => {
  const out = buildPostureDecision(explorationInput({
    detectedMode: "info",
    detectedInfoSubmode: "app_features"
  }));
  assert(out.writerMode === "info_app_features",
    `expected 'info_app_features', got '${out.writerMode}'`);
});

check("writerMode: info psychoeducation → info_psychoeducation", () => {
  const out = buildPostureDecision(explorationInput({
    detectedMode: "info",
    detectedInfoSubmode: "psychoeducation"
  }));
  assert(out.writerMode === "info_psychoeducation",
    `expected 'info_psychoeducation', got '${out.writerMode}'`);
});

check("writerMode: info pure → info_pure", () => {
  const out = buildPostureDecision(explorationInput({
    detectedMode: "info",
    detectedInfoSubmode: "pure"
  }));
  assert(out.writerMode === "info_pure",
    `expected 'info_pure', got '${out.writerMode}'`);
});

check("writerMode: alliance_rupture → alliance_rupture", () => {
  const out = buildPostureDecision(explorationInput({ allianceState: "rupture" }));
  assert(out.writerMode === "alliance_rupture",
    `expected 'alliance_rupture', got '${out.writerMode}'`);
});

check("writerMode: stabilization → stabilization", () => {
  const out = buildPostureDecision(explorationInput({
    processingWindow: "overloaded",
    engagementLevel: "withdrawn"
  }));
  assert(out.writerMode === "stabilization",
    `expected 'stabilization', got '${out.writerMode}'`);
});

check("writerMode: closure → closure", () => {
  const out = buildPostureDecision(explorationInput({ closureIntent: true }));
  assert(out.writerMode === "closure",
    `expected 'closure', got '${out.writerMode}'`);
});

// ─── forbidden / intent / constraints tables ──────────────────────────────────

check("forbidden: contact mode forbids interpretive_hypothesis (base; C3 may add more)", () => {
  // contact writerMode base: only interpretive_hypothesis. C3 adds relance for specific signals.
  const out = buildPostureDecision(explorationInput({
    detectedMode: "contact",
    contactAnalysis: contact(true, "dysregulated")
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
    previousConversationStateKey: "contact"
  }));
  assert(typeof out.intent === "string" && out.intent.length > 0,
    `expected non-empty intent, got '${out.intent}'`);
});

check("maxSentences: contact mode = null (no hard limit; contract-driven)", () => {
  // contact writerMode has no maxSentences in WRITER_MODE_CONSTRAINTS.
  const out = buildPostureDecision(explorationInput({
    detectedMode: "contact",
    contactAnalysis: contact(true, "dysregulated")
  }));
  assert(out.maxSentences === null,
    `expected maxSentences null for contact mode, got ${out.maxSentences}`);
});

check("maxSentences: exploration_open = 5", () => {
  // WRITER_MODE_CONSTRAINTS sets exploration_open.maxSentences = 5.
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

// ─── relational adjustment caps directivity ───────────────────────────────────

check("relational adjustment: caps directivity to 2 when level is 4", () => {
  const out = buildPostureDecision(explorationInput({
    effectiveExplorationDirectivityLevel: 4,
    calibrationAnalysis: calibration(4),
    relationalAdjustmentAnalysis: relational(true)
  }));
  assert(out.finalDirectivityLevel <= 2,
    `expected directivity <= 2 after relational adjustment, got ${out.finalDirectivityLevel}`);
  assert(out.relationalAdjustmentTriggered === true,
    "expected relationalAdjustmentTriggered true");
  assert(out.preAdjustmentDirectivityLevel === 4,
    `expected preAdjustmentDirectivityLevel 4, got ${out.preAdjustmentDirectivityLevel}`);
});

check("relational adjustment: no cap when level already ≤ 2", () => {
  const out = buildPostureDecision(explorationInput({
    effectiveExplorationDirectivityLevel: 1,
    calibrationAnalysis: calibration(1),
    relationalAdjustmentAnalysis: relational(true)
  }));
  assert(out.finalDirectivityLevel <= 2,
    `expected directivity <= 2, got ${out.finalDirectivityLevel}`);
  assert(out.relationalAdjustmentTriggered === true,
    "expected relationalAdjustmentTriggered true");
});

check("no relational adjustment: directivity untouched", () => {
  const out = buildPostureDecision(explorationInput({
    effectiveExplorationDirectivityLevel: 3,
    calibrationAnalysis: calibration(3),
    relationalAdjustmentAnalysis: relational(false)
  }));
  assert(out.relationalAdjustmentTriggered === false,
    "expected relationalAdjustmentTriggered false");
  assert(out.preAdjustmentDirectivityLevel === null,
    `expected preAdjustmentDirectivityLevel null, got ${out.preAdjustmentDirectivityLevel}`);
});

// ─── exploration calibration selects min(effective, calibration) ──────────────

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

// ─── exploration submode ──────────────────────────────────────────────────────

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

// ─── flagUpdates ──────────────────────────────────────────────────────────────

check("flagUpdates: exploration sets explorationCalibrationLevel", () => {
  const out = buildPostureDecision(explorationInput({
    effectiveExplorationDirectivityLevel: 2,
    calibrationAnalysis: calibration(2)
  }));
  assert(out.flagUpdates.explorationCalibrationLevel === 2,
    `expected explorationCalibrationLevel 2, got ${out.flagUpdates.explorationCalibrationLevel}`);
});

check("flagUpdates: info mode sets infoSubmode", () => {
  const out = buildPostureDecision(explorationInput({
    detectedMode: "info",
    detectedInfoSubmode: "psychoeducation"
  }));
  assert(out.flagUpdates.infoSubmode === "psychoeducation",
    `expected infoSubmode 'psychoeducation', got '${out.flagUpdates.infoSubmode}'`);
});

// ─── consecutiveNonExplorationTurns ──────────────────────────────────────────

check("consecutiveTurns: exploration resets to 0", () => {
  const out = buildPostureDecision(explorationInput({
    currentConsecutiveNonExplorationTurns: 5
  }));
  assert(out.consecutiveNonExplorationTurns === 0,
    `expected 0 after exploration, got ${out.consecutiveNonExplorationTurns}`);
});

check("consecutiveTurns: info mode from 0 → 1", () => {
  const out = buildPostureDecision(explorationInput({
    detectedMode: "info",
    detectedInfoSubmode: "app_features",
    currentConsecutiveNonExplorationTurns: 0
  }));
  assert(out.consecutiveNonExplorationTurns === 1,
    `expected 1, got ${out.consecutiveNonExplorationTurns}`);
});

check("consecutiveTurns: info mode from 3 → 4, window decays", () => {
  const out = buildPostureDecision(explorationInput({
    detectedMode: "info",
    detectedInfoSubmode: "app_features",
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
    previousConversationStateKey: "contact",
    currentConsecutiveNonExplorationTurns: 3
  }));
  assert(out.consecutiveNonExplorationTurns === 0,
    `expected 0 after post_contact, got ${out.consecutiveNonExplorationTurns}`);
});

// ─── confidenceSignal ─────────────────────────────────────────────────────────

check("confidenceSignal: default with no ambiguity → 0.8", () => {
  const out = buildPostureDecision(explorationInput({
    message: "Je veux avancer sur quelque chose.",
    recentHistory: []
  }));
  assert(out.confidenceSignal === 0.8,
    `expected 0.8, got ${out.confidenceSignal}`);
});

check("confidenceSignal: explicit ambiguity + no context → 0.4", () => {
  const out = buildPostureDecision(explorationInput({
    message: "je sais pas, c'est mélangé pour moi.",
    recentHistory: []
  }));
  assert(out.confidenceSignal === 0.4,
    `expected 0.4, got ${out.confidenceSignal}`);
});

check("confidenceSignal: recent rejection signal → 0.1", () => {
  const out = buildPostureDecision(explorationInput({
    message: "je sais pas",
    recentHistory: [
      { role: "user", content: "c'est pas ça du tout" }
    ]
  }));
  assert(out.confidenceSignal === 0.1,
    `expected 0.1, got ${out.confidenceSignal}`);
});

// ─── humanFieldGuardActive ────────────────────────────────────────────────────

check("humanFieldGuard: situated impasse + exploration → active", () => {
  const out = buildPostureDecision(explorationInput({
    technicalContextDetected: true
  }));
  assert(out.humanFieldGuardActive === true,
    `expected humanFieldGuardActive true, got ${out.humanFieldGuardActive}`);
  assert(out.criticalGuardrails.includes("no_procedural_instrumental_reply"),
    "expected 'no_procedural_instrumental_reply' in criticalGuardrails");
});

check("humanFieldGuard: conceptual info question → NOT active", () => {
  const out = buildPostureDecision(explorationInput({
    technicalContextDetected: false
  }));
  assert(out.humanFieldGuardActive === false,
    `expected humanFieldGuardActive false for conceptual question, got ${out.humanFieldGuardActive}`);
});

check("humanFieldGuard: info mode → NOT active (guard only for exploration/contact)", () => {
  const out = buildPostureDecision(explorationInput({
    detectedMode: "info",
    detectedInfoSubmode: "app_features",
    technicalContextDetected: true
  }));
  assert(out.humanFieldGuardActive === false,
    `expected humanFieldGuardActive false in info mode, got ${out.humanFieldGuardActive}`);
});

// ─── theoreticalConstraints always present ────────────────────────────────────

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

// ─── finalDetectedMode passthrough ───────────────────────────────────────────

check("finalDetectedMode: matches detectedMode input", () => {
  const outInfo = buildPostureDecision(explorationInput({ detectedMode: "info", detectedInfoSubmode: "pure" }));
  assert(outInfo.finalDetectedMode === "info", `expected 'info', got '${outInfo.finalDetectedMode}'`);

  const outContact = buildPostureDecision(explorationInput({ detectedMode: "contact", contactAnalysis: contact() }));
  assert(outContact.finalDetectedMode === "contact", `expected 'contact', got '${outContact.finalDetectedMode}'`);
});

// ─── N1 writerMode override ───────────────────────────────────────────────────

check("writerMode: suicideLevel N1 → n1_crisis override (safety invariant)", () => {
  const out = buildPostureDecision(explorationInput({ detectedMode: "exploration", suicideLevel: "N1" }));
  assert(out.writerMode === "n1_crisis", `expected 'n1_crisis', got '${out.writerMode}'`);
});

check("writerMode: suicideLevel N0 → normal writerMode (no override)", () => {
  const out = buildPostureDecision(explorationInput({ detectedMode: "exploration", suicideLevel: "N0" }));
  assert(out.writerMode !== "n1_crisis", `expected normal mode, got 'n1_crisis'`);
});

check("writerMode: suicideLevel N1 in contact mode → n1_crisis override", () => {
  const out = buildPostureDecision(explorationInput({ detectedMode: "contact", contactAnalysis: contact(), suicideLevel: "N1" }));
  assert(out.writerMode === "n1_crisis", `expected 'n1_crisis', got '${out.writerMode}'`);
});

check("writerMode: isRecallAttempt → recall_memory override", () => {
  const out = buildPostureDecision(explorationInput({ detectedMode: "exploration", isRecallAttempt: true }));
  assert(out.writerMode === "recall_memory", `expected 'recall_memory', got '${out.writerMode}'`);
});

check("writerMode: N1 takes priority over recall", () => {
  const out = buildPostureDecision(explorationInput({ detectedMode: "exploration", suicideLevel: "N1", isRecallAttempt: true }));
  assert(out.writerMode === "n1_crisis", `expected 'n1_crisis' (N1 > recall), got '${out.writerMode}'`);
});

// ─── Summary ──────────────────────────────────────────────────────────────────

const total = passed + failed;
console.log(`\n[POSTURE] ${passed}/${total} checks passed.`);
if (failed > 0) process.exitCode = 1;
