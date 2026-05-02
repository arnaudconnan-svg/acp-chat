"use strict";

const { buildPostureDecision } = require("../lib/pipeline");

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
    processingWindow: "open",
    closureIntent: false,
    engagementAllianceAnalysis: null,
    message: "",
    recentHistory: [],
    suicideLevel: "N0",
    isRecallAttempt: false,
    psychoeducationType: null,
    infoContextFlags: [],
    theoreticalOrientation: "none",
    orientationConfidence: 0,
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

check("emotionSequenceStage removed from posture decision output", () => {
  const out = buildPostureDecision(baseInput({ detectedState: "exploration" }));
  assert(!("emotionSequenceStage" in out), "emotionSequenceStage should not exist in output");
});

console.log(`\n[POSTURE] ${passed} passed, ${failed} failed.`);
if (failed > 0) process.exit(1);
