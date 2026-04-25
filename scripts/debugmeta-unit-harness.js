"use strict";

// ─── scripts/debugmeta-unit-harness.js ────────────────────────────────────────
// Pure unit tests for lib/debugmeta.js.
// No server, no Firebase, no LLM — fully deterministic.

const { buildTopChips, buildDirectivityText, buildResponseDebugMeta } = require("../lib/debugmeta");

let passed = 0;
let failed = 0;

function assert(label, actual, expected) {
  const actualJson = JSON.stringify(actual);
  const expectedJson = JSON.stringify(expected);
  if (actualJson === expectedJson) {
    console.log(`  PASS  ${label}`);
    passed++;
  } else {
    console.error(`  FAIL  ${label}`);
    console.error(`        expected: ${expectedJson}`);
    console.error(`        actual:   ${actualJson}`);
    failed++;
  }
}

function assertDeepEqual(label, actual, expected) {
  // Check every key in expected exists in actual with equal value
  for (const key of Object.keys(expected)) {
    const a = JSON.stringify(actual[key]);
    const e = JSON.stringify(expected[key]);
    if (a !== e) {
      console.error(`  FAIL  ${label} [key: ${key}]`);
      console.error(`        expected: ${e}`);
      console.error(`        actual:   ${a}`);
      failed++;
      return;
    }
  }
  console.log(`  PASS  ${label}`);
  passed++;
}

// ═══════════════════════════════════════════════════════════════════════════════
// 1. buildTopChips
// ═══════════════════════════════════════════════════════════════════════════════
console.log("\n── buildTopChips ──────────────────────────────────────────────");

assert("N2 → urgence chip", buildTopChips({ suicideLevel: "N2" }), ["URGENCE : risque suicidaire"]);
assert("N1 → clarification chip", buildTopChips({ suicideLevel: "N1" }), ["Risque suicidaire à clarifier"]);
assert("exploration → EXPLORATION", buildTopChips({ mode: "exploration" }), ["EXPLORATION"]);
assert("exploration interprétation", buildTopChips({ mode: "exploration", explorationSubmode: "interpretation" }), ["EXPLORATION : interprétation"]);
assert("exploration phenomenological_follow", buildTopChips({ mode: "exploration", explorationSubmode: "phenomenological_follow" }), ["EXPLORATION : accompagnement"]);
assert("info pure", buildTopChips({ mode: "info", infoSubmode: "pure" }), ["INFO PURE"]);
assert("info app_features", buildTopChips({ mode: "info", infoSubmode: "app_features" }), ["INFO APP : fonctionnalités"]);
assert("info psychoeducation", buildTopChips({ mode: "info", infoSubmode: "psychoeducation" }), ["PSYCHOEDUCATION"]);
assert("info null submode", buildTopChips({ mode: "info", infoSubmode: null }), ["INFO"]);
assert("contact regulated", buildTopChips({ mode: "contact", contactSubmode: "regulated" }), ["CONTACT : régulé"]);
assert("contact dysregulated", buildTopChips({ mode: "contact", contactSubmode: "dysregulated" }), ["CONTACT : dérégulé"]);
assert("contact null submode", buildTopChips({ mode: "contact", contactSubmode: null }), ["CONTACT"]);
assert("N0 no mode → empty", buildTopChips({ suicideLevel: "N0", mode: null }), []);
assert("N2 overrides mode", buildTopChips({ suicideLevel: "N2", mode: "exploration" }), ["URGENCE : risque suicidaire"]);
assert("interpretationRejection chip", buildTopChips({ interpretationRejection: true }), ["Rejet d'interprétation"]);
assert("isRecallRequest chip", buildTopChips({ isRecallRequest: true }), ["Demande de rappel mémoire"]);
assert("needsSoberReadjustment chip", buildTopChips({ needsSoberReadjustment: true }), ["Réajustement sobre"]);
assert("relationalAdjustmentTriggered chip", buildTopChips({ relationalAdjustmentTriggered: true }), ["Ajustement relationnel"]);
assert("exploration + recall + sober", buildTopChips({ mode: "exploration", isRecallRequest: true, needsSoberReadjustment: true }),
  ["EXPLORATION", "Demande de rappel mémoire", "Réajustement sobre"]);
assert("default call (no args)", buildTopChips(), []);

// ═══════════════════════════════════════════════════════════════════════════════
// 2. buildDirectivityText
// ═══════════════════════════════════════════════════════════════════════════════
console.log("\n── buildDirectivityText ───────────────────────────────────────");

assert("non-exploration mode → empty string", buildDirectivityText({ mode: "info" }), "");
assert("null mode → empty string", buildDirectivityText({ mode: null }), "");
assert("exploration level 0, no calibration → empty string",
  buildDirectivityText({ mode: "exploration", explorationDirectivityLevel: 0, explorationCalibrationLevel: null }), "");
assert("exploration level 2, no calibration → directivity line only",
  buildDirectivityText({ mode: "exploration", explorationDirectivityLevel: 2, explorationCalibrationLevel: null }),
  "Fenetre de relance : []\nNiveau de directivite (tour suivant) : 2/4");
assert("exploration level 2, calibration 3",
  buildDirectivityText({ mode: "exploration", explorationDirectivityLevel: 2, explorationCalibrationLevel: 3, explorationRelanceWindow: [true, false, true] }),
  "Niveau de structuration retenu : 3/4\nFenetre de relance : [1-0-1]\nNiveau de directivite (tour suivant) : 2/4");
assert("exploration, calibration 0 (falsy), level 0 → empty string",
  buildDirectivityText({ mode: "exploration", explorationDirectivityLevel: 0, explorationCalibrationLevel: null }), "");
assert("exploration, calibration 1 → shows retained level",
  buildDirectivityText({ mode: "exploration", explorationDirectivityLevel: 0, explorationCalibrationLevel: 1 }),
  "Niveau de structuration retenu : 1/4\nFenetre de relance : []\nNiveau de directivite (tour suivant) : 0/4");
assert("default call → empty string", buildDirectivityText(), "");

// ═══════════════════════════════════════════════════════════════════════════════
// 3. buildResponseDebugMeta — base contract
// ═══════════════════════════════════════════════════════════════════════════════
console.log("\n── buildResponseDebugMeta — base contract ─────────────────────");

const base = buildResponseDebugMeta();

// Required fields
for (const field of [
  "topChips", "memory", "directivityText", "conversationStateKey",
  "consecutiveNonExplorationTurns", "infoSubmode", "contactSubmode",
  "interpretationRejection", "needsSoberReadjustment", "relationalAdjustmentTriggered",
  "pipelineStages", "explorationCalibrationLevel", "explorationSubmode",
  "therapeuticAllianceSource", "rewriteSource", "memoryRewriteSource",
  "memoryCompressed", "memoryBeforeCompression", "soberReadjustmentOriginalReply",
  "criticTriggered", "criticIssues",
  "writerMode", "intent", "forbidden", "confidenceSignal",
  "stateTransitionFrom", "stateTransitionValid", "stateTransitionRequested",
  "allianceState", "engagementLevel", "stagnationTurns", "processingWindow",
  "dependencyRiskScore", "dependencyRiskLevel", "externalSupportMode",
  "closureIntent", "traceId"
]) {
  assert(`default has field: ${field}`, Object.prototype.hasOwnProperty.call(base, field), true);
}

// Default values
assertDeepEqual("default values", base, {
  topChips: [],
  memory: "",
  directivityText: "",
  conversationStateKey: "exploration",
  consecutiveNonExplorationTurns: 0,
  infoSubmode: null,
  contactSubmode: null,
  interpretationRejection: false,
  needsSoberReadjustment: false,
  relationalAdjustmentTriggered: false,
  pipelineStages: [],
  explorationCalibrationLevel: null,
  explorationSubmode: null,
  therapeuticAllianceSource: null,
  rewriteSource: null,
  memoryRewriteSource: null,
  memoryCompressed: false,
  memoryBeforeCompression: null,
  soberReadjustmentOriginalReply: null,
  criticTriggered: false,
  criticIssues: [],
  writerMode: null,
  intent: null,
  forbidden: [],
  confidenceSignal: "high",
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

// ═══════════════════════════════════════════════════════════════════════════════
// 4. buildResponseDebugMeta — N2 path (suicideLevel=N2, mode=null)
// ═══════════════════════════════════════════════════════════════════════════════
console.log("\n── buildResponseDebugMeta — N2 path ───────────────────────────");

const n2 = buildResponseDebugMeta({ suicideLevel: "N2", mode: null, writerMode: null, intent: null });
assert("N2 topChips", n2.topChips, ["URGENCE : risque suicidaire"]);
assert("N2 writerMode null", n2.writerMode, null);
assert("N2 intent null", n2.intent, null);
assert("N2 directivityText empty", n2.directivityText, "");
assert("N2 conversationStateKey normalized", n2.conversationStateKey, "exploration");

// ═══════════════════════════════════════════════════════════════════════════════
// 5. buildResponseDebugMeta — exploration path
// ═══════════════════════════════════════════════════════════════════════════════
console.log("\n── buildResponseDebugMeta — exploration path ──────────────────");

const explo = buildResponseDebugMeta({
  mode: "exploration",
  conversationStateKey: "exploration",
  writerMode: "open_exploration",
  intent: "accompagner_sans_guider",
  forbidden: ["diagnostic", "conseil_direct"],
  confidenceSignal: "medium",
  explorationDirectivityLevel: 2,
  explorationCalibrationLevel: 3,
  explorationRelanceWindow: [true, false, true],
  explorationSubmode: "phenomenological_follow",
  pipelineStages: [{ stage: "suicide_analysis", deltaMs: 42 }],
  traceId: "trace-abc-123"
});

assert("exploration topChips", explo.topChips, ["EXPLORATION : accompagnement"]);
assert("exploration writerMode", explo.writerMode, "open_exploration");
assert("exploration intent", explo.intent, "accompagner_sans_guider");
assert("exploration forbidden", explo.forbidden, ["diagnostic", "conseil_direct"]);
assert("exploration confidenceSignal", explo.confidenceSignal, "medium");
assert("exploration explorationSubmode", explo.explorationSubmode, "phenomenological_follow");
assert("exploration directivityText includes calibration",
  explo.directivityText.includes("Niveau de structuration retenu : 3/4"), true);
assert("exploration pipelineStages length", explo.pipelineStages.length, 1);
assert("exploration pipelineStages[0].stage", explo.pipelineStages[0].stage, "suicide_analysis");
assert("exploration pipelineStages[0].deltaMs", explo.pipelineStages[0].deltaMs, 42);
assert("exploration traceId", explo.traceId, "trace-abc-123");
assert("exploration explorationCalibrationLevel", explo.explorationCalibrationLevel, 3);

// ═══════════════════════════════════════════════════════════════════════════════
// 6. buildResponseDebugMeta — info path
// ═══════════════════════════════════════════════════════════════════════════════
console.log("\n── buildResponseDebugMeta — info path ─────────────────────────");

const info = buildResponseDebugMeta({
  mode: "info",
  infoSubmode: "app",  // legacy → should normalize to app_features
  writerMode: "informer",
  intent: "donner_information"
});

assert("info topChips (app → app_features)", info.topChips, ["INFO APP : fonctionnalités"]);
assert("info infoSubmode normalized (app → app_features)", info.infoSubmode, "app_features");
assert("info writerMode", info.writerMode, "informer");
assert("info directivityText empty", info.directivityText, "");
assert("info explorationSubmode null (not exploration)", info.explorationSubmode, null);

// ═══════════════════════════════════════════════════════════════════════════════
// 7. buildResponseDebugMeta — contact path
// ═══════════════════════════════════════════════════════════════════════════════
console.log("\n── buildResponseDebugMeta — contact path ──────────────────────");

const contact = buildResponseDebugMeta({
  mode: "contact",
  contactSubmode: "dysregulated",
  writerMode: "stabiliser",
  intent: "reguler_affect"
});

assert("contact topChips", contact.topChips, ["CONTACT : dérégulé"]);
assert("contact contactSubmode", contact.contactSubmode, "dysregulated");
assert("contact writerMode", contact.writerMode, "stabiliser");

// ═══════════════════════════════════════════════════════════════════════════════
// 8. buildResponseDebugMeta — recall path (writerMode null)
// ═══════════════════════════════════════════════════════════════════════════════
console.log("\n── buildResponseDebugMeta — recall path ───────────────────────");

const recall = buildResponseDebugMeta({
  isRecallRequest: true,
  writerMode: null,
  intent: null
});

assert("recall isRecallRequest chip", recall.topChips, ["Demande de rappel mémoire"]);
assert("recall writerMode null", recall.writerMode, null);
assert("recall intent null", recall.intent, null);

// ═══════════════════════════════════════════════════════════════════════════════
// 9. buildResponseDebugMeta — pipelineStages filtering
// ═══════════════════════════════════════════════════════════════════════════════
console.log("\n── buildResponseDebugMeta — pipelineStages filtering ──────────");

const piped = buildResponseDebugMeta({
  pipelineStages: [
    { stage: "step_a", deltaMs: 10 },
    { stage: null, deltaMs: 5 },       // filtered: no stage
    { deltaMs: 20 },                    // filtered: no stage
    { stage: "step_b", deltaMs: "bad" }, // deltaMs becomes null
    { stage: "step_c", deltaMs: 30 }
  ]
});

assert("pipelineStages length (nulls filtered)", piped.pipelineStages.length, 3);
assert("pipelineStages[0]", piped.pipelineStages[0], { stage: "step_a", deltaMs: 10 });
assert("pipelineStages[1] bad deltaMs → null", piped.pipelineStages[1], { stage: "step_b", deltaMs: null });
assert("pipelineStages[2]", piped.pipelineStages[2], { stage: "step_c", deltaMs: 30 });
assert("empty pipelineStages", buildResponseDebugMeta({ pipelineStages: [] }).pipelineStages, []);
assert("non-array pipelineStages → []", buildResponseDebugMeta({ pipelineStages: null }).pipelineStages, []);

// ═══════════════════════════════════════════════════════════════════════════════
// 10. buildResponseDebugMeta — memory injection via normalizeMemory param
// ═══════════════════════════════════════════════════════════════════════════════
console.log("\n── buildResponseDebugMeta — normalizeMemory injection ──────────");

const withMem = buildResponseDebugMeta({
  memory: "  Souffrance liée au travail.  ",
  normalizeMemory: (m) => String(m || "").trim()
});
assert("normalizeMemory trims whitespace", withMem.memory, "Souffrance liée au travail.");

const withFallback = buildResponseDebugMeta({
  memory: "",
  normalizeMemory: (m) => String(m || "").trim() || "AUCUNE MEMOIRE"
});
assert("normalizeMemory fallback for empty memory", withFallback.memory, "AUCUNE MEMOIRE");

// ═══════════════════════════════════════════════════════════════════════════════
// 11. buildResponseDebugMeta — memoryCompressed branch
// ═══════════════════════════════════════════════════════════════════════════════
console.log("\n── buildResponseDebugMeta — memoryCompressed ──────────────────");

const compressed = buildResponseDebugMeta({
  memoryCompressed: true,
  memoryBeforeCompression: "  Old memory text.  ",
  normalizeMemory: (m) => String(m || "").trim()
});
assert("memoryCompressed=true flag", compressed.memoryCompressed, true);
assert("memoryBeforeCompression present", compressed.memoryBeforeCompression, "Old memory text.");

const notCompressed = buildResponseDebugMeta({ memoryCompressed: false, memoryBeforeCompression: "irrelevant" });
assert("memoryBeforeCompression null when not compressed", notCompressed.memoryBeforeCompression, null);

// ═══════════════════════════════════════════════════════════════════════════════
// 12. buildResponseDebugMeta — Phase B flags
// ═══════════════════════════════════════════════════════════════════════════════
console.log("\n── buildResponseDebugMeta — Phase B flags ─────────────────────");

const phaseB = buildResponseDebugMeta({
  allianceState: "fragile",
  engagementLevel: "withdrawn",
  stagnationTurns: 5,
  processingWindow: "narrowed",
  dependencyRiskScore: 0.7,
  dependencyRiskLevel: "medium",
  externalSupportMode: "discovery_validation",
  closureIntent: true
});
assert("allianceState", phaseB.allianceState, "fragile");
assert("engagementLevel", phaseB.engagementLevel, "withdrawn");
assert("stagnationTurns", phaseB.stagnationTurns, 5);
assert("processingWindow", phaseB.processingWindow, "narrowed");
assert("dependencyRiskLevel", phaseB.dependencyRiskLevel, "medium");
assert("externalSupportMode", phaseB.externalSupportMode, "discovery_validation");
assert("closureIntent", phaseB.closureIntent, true);

// ═══════════════════════════════════════════════════════════════════════════════
// 13. buildResponseDebugMeta — conversationStateKey normalization
// ═══════════════════════════════════════════════════════════════════════════════
console.log("\n── buildResponseDebugMeta — conversationStateKey ──────────────");

assert("exploration state key", buildResponseDebugMeta({ conversationStateKey: "exploration" }).conversationStateKey, "exploration");
assert("unknown state key → exploration", buildResponseDebugMeta({ conversationStateKey: "unknown_state" }).conversationStateKey, "exploration");
assert("null state key → exploration", buildResponseDebugMeta({ conversationStateKey: null }).conversationStateKey, "exploration");

// ═══════════════════════════════════════════════════════════════════════════════
// 14. buildResponseDebugMeta — stateTransition fields
// ═══════════════════════════════════════════════════════════════════════════════
console.log("\n── buildResponseDebugMeta — stateTransition fields ───────");

// Default: valid first-turn (no previous state)
const stDefault = buildResponseDebugMeta();
assert("stateTransitionFrom default", stDefault.stateTransitionFrom, null);
assert("stateTransitionValid default", stDefault.stateTransitionValid, true);
assert("stateTransitionRequested default", stDefault.stateTransitionRequested, null);

// Valid transition with previous state
const stValid = buildResponseDebugMeta({
  stateTransitionFrom: "exploration",
  stateTransitionValid: true,
  stateTransitionRequested: null
});
assert("stateTransitionFrom string pass-through", stValid.stateTransitionFrom, "exploration");
assert("stateTransitionValid true", stValid.stateTransitionValid, true);
assert("stateTransitionRequested null on valid transition", stValid.stateTransitionRequested, null);

// Invalid transition: enforcement kicked in
const stInvalid = buildResponseDebugMeta({
  stateTransitionFrom: "closure",
  stateTransitionValid: false,
  stateTransitionRequested: "alliance_rupture"
});
assert("stateTransitionFrom on invalid", stInvalid.stateTransitionFrom, "closure");
assert("stateTransitionValid false", stInvalid.stateTransitionValid, false);
assert("stateTransitionRequested on invalid", stInvalid.stateTransitionRequested, "alliance_rupture");

// Non-string stateTransitionFrom → null
const stBadFrom = buildResponseDebugMeta({ stateTransitionFrom: 42 });
assert("stateTransitionFrom non-string → null", stBadFrom.stateTransitionFrom, null);

// stateTransitionValid: false coercion
const stFalseCoerce = buildResponseDebugMeta({ stateTransitionValid: false });
assert("stateTransitionValid false coercion", stFalseCoerce.stateTransitionValid, false);

// ═══════════════════════════════════════════════════════════════════════════════
// Summary
// ═══════════════════════════════════════════════════════════════════════════════
console.log(`\n${"═".repeat(60)}`);
console.log(`debugmeta-unit-harness: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
