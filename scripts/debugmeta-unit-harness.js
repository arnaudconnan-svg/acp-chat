"use strict";

// scripts/debugmeta-unit-harness.js
// Pure unit tests for lib/debugmeta.js -- no server, no Firebase, no LLM.

const { buildTopChips, buildDirectivityText, buildResponseDebugMeta } = require("../lib/debugmeta");

let passed = 0;
let failed = 0;

function assert(label, actual, expected) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) { console.log("  PASS  " + label); passed++; }
  else { console.error("  FAIL  " + label); console.error("        expected: " + e); console.error("        actual:   " + a); failed++; }
}

function assertDeepEqual(label, actual, expected) {
  for (const key of Object.keys(expected)) {
    const a = JSON.stringify(actual[key]);
    const e = JSON.stringify(expected[key]);
    if (a !== e) { console.error("  FAIL  " + label + " [key: " + key + "]"); console.error("        expected: " + e); console.error("        actual:   " + a); failed++; return; }
  }
  console.log("  PASS  " + label); passed++;
}

// 1. buildTopChips
console.log("\n-- buildTopChips");
assert("N2 urgence chip", buildTopChips({ suicideLevel: "N2" }), ["URGENCE : risque suicidaire"]);
assert("N1 clarification chip", buildTopChips({ suicideLevel: "N1" }), ["Risque suicidaire à clarifier"]);
assert("exploration_open EXPLORATION", buildTopChips({ conversationState: "exploration_open" }), ["EXPLORATION"]);
assert("exploration_open interpretation submode", buildTopChips({ conversationState: "exploration_open", explorationSubmode: "interpretation" }), ["EXPLORATION : interprétation"]);
assert("exploration_open phenomenological_follow", buildTopChips({ conversationState: "exploration_open", explorationSubmode: "phenomenological_follow" }), ["EXPLORATION : accompagnement"]);
assert("info_pure", buildTopChips({ conversationState: "info_pure" }), ["INFO PURE"]);
assert("info_features", buildTopChips({ conversationState: "info_features" }), ["INFO APP : fonctionnalités"]);
assert("info_psychoeducation", buildTopChips({ conversationState: "info_psychoeducation" }), ["PSYCHOEDUCATION"]);
assert("contact", buildTopChips({ conversationState: "contact" }), ["CONTACT"]);
assert("discharge_regulated", buildTopChips({ conversationState: "discharge_regulated" }), ["CONTACT : régulé"]);
assert("discharge_dysregulated", buildTopChips({ conversationState: "discharge_dysregulated" }), ["CONTACT : dérégulé"]);
assert("N0 no state empty", buildTopChips({ suicideLevel: "N0", conversationState: null }), []);
assert("N2 overrides state", buildTopChips({ suicideLevel: "N2", conversationState: "exploration_open" }), ["URGENCE : risque suicidaire"]);
assert("interpretationRejection chip", buildTopChips({ interpretationRejection: true }), ["Rejet d'interprétation"]);
assert("isRecallRequest chip", buildTopChips({ isRecallRequest: true }), ["Demande de rappel mémoire"]);
assert("needsSoberReadjustment chip", buildTopChips({ needsSoberReadjustment: true }), ["Réajustement sobre"]);
assert("relationalAdjustmentActive chip", buildTopChips({ relationalAdjustmentActive: true }), ["Ajustement relationnel"]);
assert("exploration_open + recall + sober", buildTopChips({ conversationState: "exploration_open", isRecallRequest: true, needsSoberReadjustment: true }),
  ["EXPLORATION", "Demande de rappel mémoire", "Réajustement sobre"]);
assert("default call (no args)", buildTopChips(), []);

// 2. buildDirectivityText
console.log("\n-- buildDirectivityText");
assert("non-exploration state empty string", buildDirectivityText({ conversationState: "info_features" }), "");
assert("null state empty string", buildDirectivityText({ conversationState: null }), "");
assert("exploration_open level 0 no calibration empty string",
  buildDirectivityText({ conversationState: "exploration_open", explorationDirectivityLevel: 0, explorationCalibrationLevel: null }), "");
assert("exploration_open level 2 no calibration directivity line only",
  buildDirectivityText({ conversationState: "exploration_open", explorationDirectivityLevel: 2, explorationCalibrationLevel: null }),
  "Fenetre de relance : []\nNiveau de directivite (tour suivant) : 2/4");
assert("exploration_open level 2 calibration 3",
  buildDirectivityText({ conversationState: "exploration_open", explorationDirectivityLevel: 2, explorationCalibrationLevel: 3, explorationRelanceWindow: [true, false, true] }),
  "Niveau de structuration retenu : 3/4\nFenetre de relance : [1-0-1]\nNiveau de directivite (tour suivant) : 2/4");
assert("exploration_restrained calibration 1 shows retained level",
  buildDirectivityText({ conversationState: "exploration_restrained", explorationDirectivityLevel: 0, explorationCalibrationLevel: 1 }),
  "Niveau de structuration retenu : 1/4\nFenetre de relance : []\nNiveau de directivite (tour suivant) : 0/4");
assert("default call empty string", buildDirectivityText(), "");

// 3. buildResponseDebugMeta -- base contract
console.log("\n-- buildResponseDebugMeta base contract");
const base = buildResponseDebugMeta();
for (const field of [
  "topChips","memory","directivityText","conversationState",
  "consecutiveNonExplorationTurns","interpretationRejection","needsSoberReadjustment","relationalAdjustmentActive",
  "pipelineStages","explorationCalibrationLevel","explorationSubmode",
  "memoryRewriteIntent","memoryCompressed","memoryBeforeCompression",
  "criticTriggered","criticIssues","intent","forbidden","confidenceSignal",
  "responseRegister","phraseLengthPolicy","relancePolicy","somaticFocusPolicy","actionCollapseGuardActive",
  "stateTransitionFrom","stateTransitionValid","stateTransitionRequested",
  "allianceState","engagementLevel","stagnationTurns","processingWindow",
  "dependencyRiskScore","dependencyRiskLevel","externalSupportMode","closureIntent","traceId"
]) {
  assert("default has field: " + field, Object.prototype.hasOwnProperty.call(base, field), true);
}
assertDeepEqual("default values", base, {
  topChips: ["EXPLORATION"],
  memory: "",
  directivityText: "",
  conversationState: "exploration_open",
  consecutiveNonExplorationTurns: 0,
  interpretationRejection: false,
  needsSoberReadjustment: false,
  relationalAdjustmentActive: false,
  pipelineStages: [],
  explorationCalibrationLevel: null,
  explorationSubmode: null,
  memoryRewriteIntent: null,
  memoryCompressed: false,
  memoryBeforeCompression: null,
  criticTriggered: false,
  criticIssues: [],
  intent: null,
  forbidden: [],
  confidenceSignal: 1.0,
  responseRegister: "courant",
  phraseLengthPolicy: "moyenne",
  relancePolicy: "selective",
  somaticFocusPolicy: "none",
  actionCollapseGuardActive: false,
  stateTransitionFrom: null,
  stateTransitionValid: true,
  stateTransitionRequested: null,
  allianceState: "good",
  engagementLevel: "active",
  stagnationTurns: 0,
  processingWindow: "open",
  dependencyRiskScore: 0,
  dependencyRiskLevel: "low",
  externalSupportMode: "none",
  closureIntent: false,
  traceId: null
});

// 4. N2 path
console.log("\n-- buildResponseDebugMeta N2 path");
const n2 = buildResponseDebugMeta({ suicideLevel: "N2", conversationState: "n2_crisis", intent: null });
assert("N2 topChips", n2.topChips, ["URGENCE : risque suicidaire"]);
assert("N2 conversationState", n2.conversationState, "n2_crisis");
assert("N2 intent null", n2.intent, null);
assert("N2 directivityText empty", n2.directivityText, "");

// 5. exploration path
console.log("\n-- buildResponseDebugMeta exploration path");
const explo = buildResponseDebugMeta({
  conversationState: "exploration_open",
  intent: "accompagner_sans_guider",
  forbidden: ["diagnostic", "conseil_direct"],
  confidenceSignal: 0.5,
  responseRegister: "familier",
  phraseLengthPolicy: "courte",
  relancePolicy: "discouraged",
  somaticFocusPolicy: "prioritize_somatic_proximity",
  actionCollapseGuardActive: true,
  explorationDirectivityLevel: 2,
  explorationCalibrationLevel: 3,
  explorationRelanceWindow: [true, false, true],
  explorationSubmode: "phenomenological_follow",
  pipelineStages: [{ stage: "suicide_analysis", deltaMs: 42 }],
  traceId: "trace-abc-123"
});
assert("exploration topChips", explo.topChips, ["EXPLORATION : accompagnement"]);
assert("exploration conversationState", explo.conversationState, "exploration_open");
assert("exploration intent", explo.intent, "accompagner_sans_guider");
assert("exploration forbidden", explo.forbidden, ["diagnostic", "conseil_direct"]);
assert("exploration responseRegister", explo.responseRegister, "familier");
assert("exploration phraseLengthPolicy", explo.phraseLengthPolicy, "courte");
assert("exploration relancePolicy", explo.relancePolicy, "discouraged");
assert("exploration somaticFocusPolicy", explo.somaticFocusPolicy, "prioritize_somatic_proximity");
assert("exploration actionCollapseGuardActive", explo.actionCollapseGuardActive, true);
assert("exploration explorationSubmode", explo.explorationSubmode, "phenomenological_follow");
assert("exploration directivityText includes calibration",
  explo.directivityText.includes("Niveau de structuration retenu : 3/4"), true);
assert("exploration pipelineStages length", explo.pipelineStages.length, 1);
assert("exploration pipelineStages[0].stage", explo.pipelineStages[0].stage, "suicide_analysis");
assert("exploration pipelineStages[0].deltaMs", explo.pipelineStages[0].deltaMs, 42);
assert("exploration traceId", explo.traceId, "trace-abc-123");
assert("exploration explorationCalibrationLevel", explo.explorationCalibrationLevel, 3);

// 6. info path
console.log("\n-- buildResponseDebugMeta info path");
const info = buildResponseDebugMeta({ conversationState: "info_features", intent: "donner_information" });
assert("info topChips (info_features)", info.topChips, ["INFO APP : fonctionnalités"]);
assert("info conversationState", info.conversationState, "info_features");
assert("info directivityText empty", info.directivityText, "");
assert("info explorationSubmode null", info.explorationSubmode, null);

// 7. discharge path
console.log("\n-- buildResponseDebugMeta discharge path");
const discharge = buildResponseDebugMeta({ conversationState: "discharge_dysregulated", intent: "reguler_affect" });
assert("discharge topChips", discharge.topChips, ["CONTACT : dérégulé"]);
assert("discharge conversationState", discharge.conversationState, "discharge_dysregulated");

// 8. recall path
console.log("\n-- buildResponseDebugMeta recall path");
const recall = buildResponseDebugMeta({ isRecallRequest: true, intent: null });
assert("recall isRecallRequest chip (with default exploration_open state)", recall.topChips, ["EXPLORATION","Demande de rappel mémoire"]);
assert("recall intent null", recall.intent, null);

// 9. pipelineStages filtering
console.log("\n-- buildResponseDebugMeta pipelineStages filtering");
const piped = buildResponseDebugMeta({ pipelineStages: [
  { stage: "step_a", deltaMs: 10 },
  { stage: null, deltaMs: 5 },
  { deltaMs: 20 },
  { stage: "step_b", deltaMs: "bad" },
  { stage: "step_c", deltaMs: 30 }
]});
assert("pipelineStages length (nulls filtered)", piped.pipelineStages.length, 3);
assert("pipelineStages[0]", piped.pipelineStages[0], { stage: "step_a", deltaMs: 10 });
assert("pipelineStages[1] bad deltaMs null", piped.pipelineStages[1], { stage: "step_b", deltaMs: null });
assert("pipelineStages[2]", piped.pipelineStages[2], { stage: "step_c", deltaMs: 30 });
assert("empty pipelineStages", buildResponseDebugMeta({ pipelineStages: [] }).pipelineStages, []);
assert("non-array pipelineStages []", buildResponseDebugMeta({ pipelineStages: null }).pipelineStages, []);

// 10. normalizeMemory
console.log("\n-- buildResponseDebugMeta normalizeMemory");
const withMem = buildResponseDebugMeta({ memory: "  text.  ", normalizeMemory: (m) => String(m || "").trim() });
assert("normalizeMemory trims whitespace", withMem.memory, "text.");
const withFallback = buildResponseDebugMeta({ memory: "", normalizeMemory: (m) => String(m || "").trim() || "NONE" });
assert("normalizeMemory fallback", withFallback.memory, "NONE");

// 11. memoryCompressed
console.log("\n-- buildResponseDebugMeta memoryCompressed");
const compressed = buildResponseDebugMeta({ memoryCompressed: true, memoryBeforeCompression: "  Old text.  ", normalizeMemory: (m) => String(m || "").trim() });
assert("memoryCompressed true", compressed.memoryCompressed, true);
assert("memoryBeforeCompression present", compressed.memoryBeforeCompression, "Old text.");
const notCompressed = buildResponseDebugMeta({ memoryCompressed: false, memoryBeforeCompression: "irrelevant" });
assert("memoryBeforeCompression null when not compressed", notCompressed.memoryBeforeCompression, null);

// 12. memoryRewriteIntent
console.log("\n-- buildResponseDebugMeta memoryRewriteIntent");
const rewriteIntentDefaults = buildResponseDebugMeta({ memoryRewriteIntent: { compressionRequested: false } });
assert("memoryRewriteIntent normalized defaults", rewriteIntentDefaults.memoryRewriteIntent, {
  compressionRequested: false,
  interpretationRejectionActive: false,
  rejectsUnderlyingPhenomenon: false,
  soberReadjustmentActive: false,
  lectureBotForcedReset: false
});
const rewriteIntentTrue = buildResponseDebugMeta({
  memoryRewriteIntent: {
    compressionRequested: true,
    interpretationRejectionActive: true,
    rejectsUnderlyingPhenomenon: true,
    soberReadjustmentActive: true,
    lectureBotForcedReset: true
  }
});
assert("memoryRewriteIntent all true", rewriteIntentTrue.memoryRewriteIntent, {
  compressionRequested: true,
  interpretationRejectionActive: true,
  rejectsUnderlyingPhenomenon: true,
  soberReadjustmentActive: true,
  lectureBotForcedReset: true
});

// 13. Phase B flags
console.log("\n-- buildResponseDebugMeta Phase B flags");
const phaseB = buildResponseDebugMeta({
  allianceState: "fragile", engagementLevel: "withdrawn", stagnationTurns: 5,
  processingWindow: "narrowed", dependencyRiskScore: 0.7, dependencyRiskLevel: "medium",
  externalSupportMode: "discovery_validation", closureIntent: true
});
assert("allianceState", phaseB.allianceState, "fragile");
assert("engagementLevel", phaseB.engagementLevel, "withdrawn");
assert("stagnationTurns", phaseB.stagnationTurns, 5);
assert("processingWindow", phaseB.processingWindow, "narrowed");
assert("dependencyRiskLevel", phaseB.dependencyRiskLevel, "medium");
assert("externalSupportMode", phaseB.externalSupportMode, "discovery_validation");
assert("closureIntent", phaseB.closureIntent, true);

// 14. conversationState normalization
console.log("\n-- buildResponseDebugMeta conversationState normalization");
assert("exploration_open state", buildResponseDebugMeta({ conversationState: "exploration_open" }).conversationState, "exploration_open");
assert("unknown state defaults to exploration_open", buildResponseDebugMeta({ conversationState: "unknown_state" }).conversationState, "exploration_open");
assert("null state defaults to exploration_open", buildResponseDebugMeta({ conversationState: null }).conversationState, "exploration_open");

// 15. stateTransition fields
console.log("\n-- buildResponseDebugMeta stateTransition fields");
const stDefault = buildResponseDebugMeta();
assert("stateTransitionFrom default null", stDefault.stateTransitionFrom, null);
assert("stateTransitionValid default true", stDefault.stateTransitionValid, true);
assert("stateTransitionRequested default null", stDefault.stateTransitionRequested, null);
const stValid = buildResponseDebugMeta({ stateTransitionFrom: "exploration_open", stateTransitionValid: true, stateTransitionRequested: null });
assert("stateTransitionFrom string pass-through", stValid.stateTransitionFrom, "exploration_open");
assert("stateTransitionValid true", stValid.stateTransitionValid, true);
assert("stateTransitionRequested null", stValid.stateTransitionRequested, null);
const stInvalid = buildResponseDebugMeta({ stateTransitionFrom: "closure", stateTransitionValid: false, stateTransitionRequested: "alliance_rupture" });
assert("stateTransitionFrom on invalid", stInvalid.stateTransitionFrom, "closure");
assert("stateTransitionValid false", stInvalid.stateTransitionValid, false);
assert("stateTransitionRequested on invalid", stInvalid.stateTransitionRequested, "alliance_rupture");
const stBadFrom = buildResponseDebugMeta({ stateTransitionFrom: 42 });
assert("stateTransitionFrom non-string null", stBadFrom.stateTransitionFrom, null);
const stFalseCoerce = buildResponseDebugMeta({ stateTransitionValid: false });
assert("stateTransitionValid false coercion", stFalseCoerce.stateTransitionValid, false);

// Summary
console.log("\n" + "=".repeat(60));
console.log("debugmeta-unit-harness: " + passed + " passed, " + failed + " failed");
if (failed > 0) process.exit(1);
