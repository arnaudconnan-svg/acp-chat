"use strict";

const { buildPostureDecision, electActiveStateFromCandidates } = require("../lib/pipeline");

let passed = 0;
let failed = 0;

function assert(condition, message) {
  if (!condition) throw new Error(message || "assertion failed");
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
    contactAnalysis: { isContact: false, selfCriticismLevel: "low", meaningCrisis: false, insightMoment: false },
    emotionalDecenteringAnalysis: { emotionalDecentering: false },
    affiliationWindow: [0, 0, 0, 0],
    affiliationEstablished: true,
    relationalAdjustmentAnalysis: { needsRelationalAdjustment: false },
    calibrationAnalysis: { calibrationLevel: 0, explorationSignal: "interpretation" },
    technicalContextDetected: false,
    somaticSignalAnalysis: { somaticSignalActive: false, somaticLocalizationBlocked: false },
    userRegisterAnalysis: { userRegister: "courant", formalAddress: false },
    interpretationRejection: {
      isInterpretationRejection: false,
      rejectsUnderlyingPhenomenon: false,
      relationalFrictionSignal: "none"
    },
    effectiveExplorationDirectivityLevel: 0,
    previousConversationState: "exploration_open",
    currentConsecutiveNonExplorationTurns: 0,
    currentExplorationRelanceWindow: [false, false, false, false],
    allianceSignal: "good",
    engagementLevel: "active",
    stagnationTurns: 0,
    attentionWindow: "open",
    closureIntent: false,
    engagementAllianceAnalysis: null,
    message: "",
    recentHistory: [],
    suicideLevel: "N0",
    isRecallAttempt: false,
    psychoeducationType: null,
    infoContextFlags: [],
    dischargeAnalysis: { aggressiveDischargeDirectedToBot: false },
    previousFormalAddress: false,
    dependencyRiskLevel: "low",
    ...overrides
  };
}

check("exploration detectedState -> exploration_* conversation state", () => {
  const out = buildPostureDecision(baseInput({ detectedState: "exploration" }));
  assert(out.conversationState === "exploration_open", `expected exploration_open, got ${out.conversationState}`);
});

check("info detectedState passes through", () => {
  const out = buildPostureDecision(baseInput({ detectedState: "info_features" }));
  assert(out.conversationState === "info_features", `expected info_features, got ${out.conversationState}`);
});

check("discharge detectedState keeps discharge state", () => {
  const out = buildPostureDecision(baseInput({ detectedState: "discharge_regulated" }));
  assert(out.conversationState === "discharge_regulated", `expected discharge_regulated, got ${out.conversationState}`);
});

check("post-discharge cooldown returns exploration (no contact state)", () => {
  const out = buildPostureDecision(baseInput({
    detectedState: "exploration",
    previousConversationState: "discharge_regulated"
  }));
  assert(out.conversationState === "exploration_open", `expected exploration_open, got ${out.conversationState}`);
});

check("post-discharge transition enforces restrained phenomenological exploration", () => {
  const out = buildPostureDecision(baseInput({
    detectedState: "exploration",
    previousConversationState: "discharge_dysregulated",
    effectiveExplorationDirectivityLevel: 4,
    calibrationAnalysis: { calibrationLevel: 4, explorationSignal: "interpretation" }
  }));
  assert(out.postDischargeTransitionActive === true, "expected postDischargeTransitionActive=true");
  assert(out.finalDirectivityLevel === 2, `expected finalDirectivityLevel=2, got ${out.finalDirectivityLevel}`);
  assert(out.finalExplorationSignal === "phenomenological_follow", `expected phenomenological_follow, got ${out.finalExplorationSignal}`);
  assert(out.forbidden.includes("relance"), "expected relance forbidden on post-discharge transition");
  assert(out.writerIntentHints.includes("post_discharge_soft_landing"), "expected post_discharge_soft_landing hint");
});

check("post-discharge transition applies in non-exploration states without forcing exploration shape", () => {
  const out = buildPostureDecision(baseInput({
    detectedState: "info_features",
    previousConversationState: "discharge_regulated"
  }));
  assert(out.postDischargeTransitionActive === true, "expected postDischargeTransitionActive=true");
  assert(out.writerIntentHints.includes("post_discharge_soft_landing"), "expected post_discharge_soft_landing hint");
  assert(out.forbidden.includes("relance"), "expected relance forbidden in info post-discharge transition");
});

check("contact self-criticism signal enriches forbidden + hints", () => {
  const out = buildPostureDecision(baseInput({
    detectedState: "exploration",
    contactAnalysis: { isContact: true, selfCriticismLevel: "high", meaningCrisis: false, insightMoment: false }
  }));
  assert(out.forbidden.includes("value_affirmation"), "expected value_affirmation in forbidden");
  assert(out.writerIntentHints.includes("signify_pain_without_blocking"), "expected signify_pain_without_blocking hint");
  assert(out.writerIntentHints.includes("auto_compassion_door_open"), "expected auto_compassion_door_open hint");
});

check("meaningCrisis signal constrains relance + interpretation", () => {
  const out = buildPostureDecision(baseInput({
    detectedState: "exploration",
    contactAnalysis: { isContact: true, selfCriticismLevel: "low", meaningCrisis: true, insightMoment: false }
  }));
  assert(out.forbidden.includes("relance"), "expected relance in forbidden");
  assert(out.forbidden.includes("interpretive_hypothesis"), "expected interpretive_hypothesis in forbidden");
});

check("insightMoment signal adds amplify_insight hint", () => {
  const out = buildPostureDecision(baseInput({
    detectedState: "exploration",
    contactAnalysis: { isContact: true, selfCriticismLevel: "low", meaningCrisis: false, insightMoment: true }
  }));
  assert(out.writerIntentHints.includes("amplify_insight"), "expected amplify_insight hint");
});

check("emotionalDecentering hints apply in info states", () => {
  const out = buildPostureDecision(baseInput({
    detectedState: "info_psychoeducation",
    emotionalDecenteringAnalysis: { emotionalDecentering: true }
  }));
  assert(out.writerIntentHints.includes("hold_emotional_thread"), "expected hold_emotional_thread hint");
  assert(out.writerIntentHints.includes("auto_compassion_door_open"), "expected auto_compassion_door_open hint");
});

check("narrowed processing window enforces single-axis exploration contract", () => {
  const out = buildPostureDecision(baseInput({
    detectedState: "exploration",
    attentionWindow: "open",
    engagementAllianceAnalysis: {
      allianceSignal: "good",
      engagementLevel: "active",
      attentionQuality: "narrowed"
    }
  }));
  assert(out.writerIntentHints.includes("attention_narrow_single_axis"), "expected attention_narrow_single_axis hint");
  assert(out.intent === "suivre un seul axe sans ouvrir de nouveau chantier", `unexpected intent: ${out.intent}`);
});

check("emotionSequenceStage removed from posture decision output", () => {
  const out = buildPostureDecision(baseInput({ detectedState: "exploration" }));
  assert(!("emotionSequenceStage" in out), "emotionSequenceStage should not exist in output");
});

check("secondary tension arbitration prefers higher confidence over semantic priority", () => {
  const out = buildPostureDecision(baseInput({
    detectedState: "exploration",
    allianceSignal: "fragile",
    secondaryTension: { family: "info", confidence: "high" }
  }));
  assert(!!out.secondaryTension, "expected secondaryTension to be set");
  assert(out.secondaryTension.family === "info", `expected family=info, got ${out.secondaryTension.family}`);
  assert(out.secondaryTension.confidence === "high", `expected confidence=high, got ${out.secondaryTension.confidence}`);
});

check("secondary tension tie-break uses semantic priority on equal confidence", () => {
  const out = buildPostureDecision(baseInput({
    detectedState: "exploration",
    allianceSignal: "fragile",
    secondaryTension: { family: "info", confidence: "medium" }
  }));
  assert(!!out.secondaryTension, "expected secondaryTension to be set");
  assert(out.secondaryTension.family === "alliance_rupture", `expected family=alliance_rupture, got ${out.secondaryTension.family}`);
  assert(out.secondaryTension.confidence === "medium", `expected confidence=medium, got ${out.secondaryTension.confidence}`);
});

check("secondary tension suppresses redundancy with active base family", () => {
  const out = buildPostureDecision(baseInput({
    detectedState: "info_features",
    allianceSignal: "good",
    engagementLevel: "active",
    attentionWindow: "open",
    stagnationTurns: 0,
    secondaryTension: { family: "info", confidence: "high" }
  }));
  assert(out.secondaryTension === null, "expected secondaryTension=null when candidate duplicates active base family");
});

check("secondary tension is disabled during aggressive discharge", () => {
  const out = buildPostureDecision(baseInput({
    detectedState: "discharge_dysregulated",
    allianceSignal: "rupture",
    secondaryTension: { family: "discharge", confidence: "high" },
    dischargeAnalysis: { aggressiveDischargeDirectedToBot: true }
  }));
  assert(out.secondaryTension === null, "expected secondaryTension=null when aggressive discharge is detected");
});

check("election tie-break reason: discharge priority", () => {
  const out = electActiveStateFromCandidates([
    { family: "discharge", detectedState: "discharge_regulated", confidence: "medium" },
    { family: "info", detectedState: "info_features", confidence: "high", infoSource: "llm", infoSignalSource: "llm" }
  ], { isContact: true });
  assert(out.tieBreakReason === "discharge_priority", `expected discharge_priority, got ${out.tieBreakReason}`);
});

check("election tie-break reason: app_features override", () => {
  const out = electActiveStateFromCandidates([
    { family: "info", detectedState: "info_features", confidence: "low", infoSource: "deterministic_app_features", infoSignalSource: "deterministic_app_features" },
    { family: "exploration", detectedState: "exploration", confidence: "high" }
  ], { isContact: false });
  assert(out.tieBreakReason === "override_app_features", `expected override_app_features, got ${out.tieBreakReason}`);
});

check("election tie-break reason: info stronger confidence", () => {
  const out = electActiveStateFromCandidates([
    { family: "info", detectedState: "info_pure", confidence: "high", infoSource: "llm", infoSignalSource: "llm" },
    { family: "exploration", detectedState: "exploration", confidence: "low" }
  ], { isContact: false });
  assert(out.tieBreakReason === "info_gt_exploration", `expected info_gt_exploration, got ${out.tieBreakReason}`);
});

check("election tie-break reason: exploration stronger confidence", () => {
  const out = electActiveStateFromCandidates([
    { family: "info", detectedState: "info_pure", confidence: "low", infoSource: "llm", infoSignalSource: "llm" },
    { family: "exploration", detectedState: "exploration", confidence: "high" }
  ], { isContact: false });
  assert(out.tieBreakReason === "exploration_gt_info", `expected exploration_gt_info, got ${out.tieBreakReason}`);
});

check("election tie-break reason: equal high favors info", () => {
  const out = electActiveStateFromCandidates([
    { family: "info", detectedState: "info_pure", confidence: "high", infoSource: "llm", infoSignalSource: "llm" },
    { family: "exploration", detectedState: "exploration", confidence: "high" }
  ], { isContact: false });
  assert(out.tieBreakReason === "tie_break_equal_high_info_primary", `expected tie_break_equal_high_info_primary, got ${out.tieBreakReason}`);
});

check("election tie-break reason: equal medium favors info", () => {
  const out = electActiveStateFromCandidates([
    { family: "info", detectedState: "info_pure", confidence: "medium", infoSource: "llm", infoSignalSource: "llm" },
    { family: "exploration", detectedState: "exploration", confidence: "medium" }
  ], { isContact: false });
  assert(out.tieBreakReason === "tie_break_equal_medium_info_primary", `expected tie_break_equal_medium_info_primary, got ${out.tieBreakReason}`);
});

check("election tie-break reason: equal low favors exploration", () => {
  const out = electActiveStateFromCandidates([
    { family: "info", detectedState: "info_pure", confidence: "low", infoSource: "llm", infoSignalSource: "llm" },
    { family: "exploration", detectedState: "exploration", confidence: "low" }
  ], { isContact: false });
  assert(out.tieBreakReason === "tie_break_equal_low_exploration_primary", `expected tie_break_equal_low_exploration_primary, got ${out.tieBreakReason}`);
});

check("election tie-break reason: info only candidate", () => {
  const out = electActiveStateFromCandidates([
    { family: "info", detectedState: "info_features", confidence: "medium", infoSource: "llm", infoSignalSource: "llm" }
  ], { isContact: false });
  assert(out.tieBreakReason === "info_only_candidate", `expected info_only_candidate, got ${out.tieBreakReason}`);
});

check("election tie-break reason: exploration only candidate", () => {
  const out = electActiveStateFromCandidates([
    { family: "exploration", detectedState: "exploration", confidence: "medium" }
  ], { isContact: false });
  assert(out.tieBreakReason === "exploration_only_candidate", `expected exploration_only_candidate, got ${out.tieBreakReason}`);
});

console.log(`\n[POSTURE] ${passed} passed, ${failed} failed.`);
if (failed > 0) process.exit(1);
