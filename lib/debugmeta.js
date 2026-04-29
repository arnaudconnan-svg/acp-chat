"use strict";

// ─── lib/debugmeta.js ─────────────────────────────────────────────────────────
// Pure functions for building the debugMeta object returned by /chat.
// Extracted from server.js so they can be tested without a running server.
//
// Key design decision:
//   - pipelineStages and traceId are explicit parameters (not closure captures)
//   - promptRegistry is an explicit parameter with a default
//   - normalizeMemory is an explicit parameter (injected by caller) to avoid
//     pulling the full prompts.js dependency chain into this module

const {
  clampDependencyRiskScore,
  clampExplorationDirectivityLevel,
  normalizeAllianceState,
  normalizeConsecutiveNonExplorationTurns,
  normalizeConversationState,
  normalizeDependencyRiskLevel,
  normalizeEngagementLevel,
  normalizeExplorationRelanceWindow,
  normalizeExternalSupportMode,
  normalizeProcessingWindow,
  normalizeStagnationTurns
} = require("./flags");

// ─── buildTopChips ────────────────────────────────────────────────────────────
// Returns the array of display chips shown in the admin UI and debugMeta.
// Priority: N2 > N1 > mode chip, then optional annotation chips.
function buildTopChips({
  suicideLevel = "N0",
  conversationState = null,
  explorationSubmode = null,
  interpretationRejection = false,
  isRecallRequest = false,
  needsSoberReadjustment = false,
  relationalAdjustmentActive = false
} = {}) {
  const chips = [];

  function buildExplorationSubmodeChipLabel(submode = null) {
    if (submode === "interpretation") return "EXPLORATION : interprétation";
    if (submode === "phenomenological_follow") return "EXPLORATION : accompagnement";
    return "EXPLORATION";
  }

  if (suicideLevel === "N2") {
    chips.push("URGENCE : risque suicidaire");
  } else if (suicideLevel === "N1") {
    chips.push("Risque suicidaire à clarifier");
  } else if (conversationState === "exploration_open" || conversationState === "exploration_restrained") {
    chips.push(buildExplorationSubmodeChipLabel(explorationSubmode));
  } else if (conversationState && conversationState.startsWith("info_")) {
    chips.push(
      conversationState === "info_psychoeducation" ? "PSYCHOEDUCATION" :
      conversationState === "info_features" ? "INFO APP : fonctionnalités" :
      conversationState === "info_pure" ? "INFO PURE" :
      "INFO"
    );
  } else if (conversationState === "contact") {
    chips.push("CONTACT");
  } else if (conversationState === "discharge_dysregulated") {
    chips.push("CONTACT : dérégulé");
  } else if (conversationState === "discharge_regulated") {
    chips.push("CONTACT : régulé");
  }

  if (interpretationRejection === true) {
    chips.push("Rejet d'interprétation");
  }
  if (isRecallRequest === true) {
    chips.push("Demande de rappel mémoire");
  }
  if (needsSoberReadjustment === true) {
    chips.push("Réajustement sobre");
  }
  if (relationalAdjustmentActive === true) {
    chips.push("Ajustement relationnel");
  }

  return chips;
}

// ─── buildDirectivityText ─────────────────────────────────────────────────────
// Returns the human-readable exploration directivity summary string,
// or "" for non-exploration modes.
function buildDirectivityText({
  conversationState = null,
  explorationCalibrationLevel = null,
  explorationDirectivityLevel = 0,
  explorationRelanceWindow = []
} = {}) {
  if (!conversationState || !conversationState.startsWith("exploration_")) return "";

  const safeWindow = normalizeExplorationRelanceWindow(explorationRelanceWindow);
  const safeNextLevel = clampExplorationDirectivityLevel(explorationDirectivityLevel);
  const safeRetainedLevel = explorationCalibrationLevel !== null && explorationCalibrationLevel !== undefined
    ? clampExplorationDirectivityLevel(explorationCalibrationLevel)
    : null;

  if (safeRetainedLevel === null && safeNextLevel <= 0) return "";

  return [
    safeRetainedLevel !== null ? `Niveau de structuration retenu : ${safeRetainedLevel}/4` : null,
    `Fenetre de relance : [${safeWindow.map(v => (v ? "1" : "0")).join("-")}]`,
    `Niveau de directivite (tour suivant) : ${safeNextLevel}/4`
  ].filter(Boolean).join("\n");
}

// ─── buildResponseDebugMeta ───────────────────────────────────────────────────
// Builds the full V3 debugMeta object returned with every /chat response.
//
// Parameters that were previously captured from the handler closure are now
// explicit: pipelineStages, traceId, normalizeMemory (injected).
function buildResponseDebugMeta({
  // Core inputs
  memory = "",
  suicideLevel = "N0",
  conversationState = "exploration_open",
  consecutiveNonExplorationTurns = 0,
  interpretationRejection = false,
  needsSoberReadjustment = false,
  relationalAdjustmentActive = false,
  isRecallRequest = false,
  explorationCalibrationLevel = null,
  explorationDirectivityLevel = 0,
  explorationRelanceWindow = [],
  explorationSubmode = null,
  rewriteSource = null,
  memoryRewriteSource = null,
  memoryCompressed = false,
  memoryBeforeCompression = null,
  criticTriggered = false,
  criticIssues = [],
  criticOriginalReply = null,
  // Posture contract (V3)
  intent = null,
  forbidden = [],
  confidenceSignal = 1.0,
  responseRegister = "courant",
  phraseLengthPolicy = "moyenne",
  relancePolicy = "selective",
  somaticFocusPolicy = "none",
  actionCollapseGuardActive = false,
  stateTransitionFrom = null,
  stateTransitionValid = true,
  stateTransitionRequested = null,
  // Phase B structural flags
  allianceState = "good",
  engagementLevel = "active",
  stagnationTurns = 0,
  processingWindow = "open",
  dependencyRiskScore = 0,
  dependencyRiskLevel = "low",
  externalSupportMode = "none",
  closureIntent = false,
  // Info routing observability
  infoRoutingSource = null,
  // Lot 8 fields
  contactScore = null,
  contactScoreWindow = [],
  contactEstablished = false,
  emotionalDecentering = false,
  emotionSequenceStage = null,
  formalAddress = false,
  // Writer hints from posture decision
  writerIntentHints = [],
  writerOrientationHint = null,
  // Contact analyzer sub-fields
  contactInsightMoment = false,
  contactSelfCriticismLevel = "low",
  contactMeaningProtest = false,
  // Formerly closure-captured — now explicit
  pipelineStages = [],
  traceId = null,
  normalizeMemory = (m) => String(m || "").trim()
} = {}) {
  return {
    topChips: buildTopChips({
      suicideLevel,
      conversationState,
      explorationSubmode,
      interpretationRejection,
      isRecallRequest,
      needsSoberReadjustment,
      relationalAdjustmentActive
    }),
    memory: normalizeMemory(memory),
    directivityText: buildDirectivityText({
      conversationState,
      explorationCalibrationLevel,
      explorationDirectivityLevel,
      explorationRelanceWindow
    }),
    conversationState: normalizeConversationState(conversationState),
    consecutiveNonExplorationTurns: normalizeConsecutiveNonExplorationTurns(consecutiveNonExplorationTurns),
    interpretationRejection: interpretationRejection === true,
    needsSoberReadjustment: needsSoberReadjustment === true,
    relationalAdjustmentActive: relationalAdjustmentActive === true,
    pipelineStages: Array.isArray(pipelineStages)
      ? pipelineStages
          .map(entry => ({
            stage: typeof entry?.stage === "string" ? entry.stage : null,
            deltaMs: Number.isFinite(entry?.deltaMs) ? entry.deltaMs : null
          }))
          .filter(entry => entry.stage)
      : [],
    explorationCalibrationLevel:
      explorationCalibrationLevel !== null && explorationCalibrationLevel !== undefined
        ? clampExplorationDirectivityLevel(explorationCalibrationLevel)
        : null,
    explorationSubmode: (conversationState === "exploration_open" || conversationState === "exploration_restrained") && typeof explorationSubmode === "string" ? explorationSubmode : null,
    rewriteSource: typeof rewriteSource === "string" ? rewriteSource : null,
    memoryRewriteSource: typeof memoryRewriteSource === "string" ? memoryRewriteSource : null,
    memoryCompressed: memoryCompressed === true,
    memoryBeforeCompression:
      memoryCompressed === true && typeof memoryBeforeCompression === "string"
        ? normalizeMemory(memoryBeforeCompression)
        : null,
    criticTriggered: criticTriggered === true,
    criticIssues: Array.isArray(criticIssues) ? criticIssues : [],
    criticOriginalReply: (criticTriggered === true && typeof criticOriginalReply === "string" && criticOriginalReply.length > 0)
      ? criticOriginalReply
      : null,
    // Posture contract (V3)
    intent: typeof intent === "string" ? intent : null,
    forbidden: Array.isArray(forbidden) ? forbidden : [],
    confidenceSignal: typeof confidenceSignal === "number" ? confidenceSignal : 1.0,
    responseRegister: typeof responseRegister === "string" ? responseRegister : "courant",
    phraseLengthPolicy: typeof phraseLengthPolicy === "string" ? phraseLengthPolicy : "moyenne",
    relancePolicy: typeof relancePolicy === "string" ? relancePolicy : "selective",
    somaticFocusPolicy: typeof somaticFocusPolicy === "string" ? somaticFocusPolicy : "none",
    actionCollapseGuardActive: actionCollapseGuardActive === true,
    stateTransitionFrom: typeof stateTransitionFrom === "string" ? stateTransitionFrom : null,
    stateTransitionValid: stateTransitionValid !== false,
    stateTransitionRequested: typeof stateTransitionRequested === "string" ? stateTransitionRequested : null,
    // Phase B structural flags
    allianceState: normalizeAllianceState(allianceState),
    engagementLevel: normalizeEngagementLevel(engagementLevel),
    stagnationTurns: normalizeStagnationTurns(stagnationTurns),
    processingWindow: normalizeProcessingWindow(processingWindow),
    dependencyRiskScore: clampDependencyRiskScore(dependencyRiskScore),
    dependencyRiskLevel: normalizeDependencyRiskLevel(dependencyRiskLevel),
    externalSupportMode: normalizeExternalSupportMode(externalSupportMode),
    closureIntent: closureIntent === true,
    infoRoutingSource: typeof infoRoutingSource === "string" ? infoRoutingSource : null,
    // Lot 8 fields
    contactScore: typeof contactScore === "number" ? contactScore : null,
    contactScoreWindow: Array.isArray(contactScoreWindow) ? contactScoreWindow.map(v => typeof v === "number" ? Math.round(v * 100) / 100 : 0) : [],
    contactEstablished: contactEstablished === true,
    emotionalDecentering: emotionalDecentering === true,
    emotionSequenceStage: typeof emotionSequenceStage === "string" ? emotionSequenceStage : null,
    formalAddress: formalAddress === true,
    // Writer hints from posture decision
    writerIntentHints: Array.isArray(writerIntentHints) ? writerIntentHints : [],
    writerOrientationHint: typeof writerOrientationHint === "string" ? writerOrientationHint : null,
    // Contact analyzer sub-fields
    contactInsightMoment: contactInsightMoment === true,
    contactSelfCriticismLevel: typeof contactSelfCriticismLevel === "string" ? contactSelfCriticismLevel : "low",
    contactMeaningProtest: contactMeaningProtest === true,
    traceId: typeof traceId === "string" ? traceId : null
  };
}

module.exports = {
  buildTopChips,
  buildDirectivityText,
  buildResponseDebugMeta
};
