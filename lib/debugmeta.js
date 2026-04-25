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
  normalizeContactSubmode,
  normalizeConversationStateKey,
  normalizeDependencyRiskLevel,
  normalizeEngagementLevel,
  normalizeExplorationRelanceWindow,
  normalizeExternalSupportMode,
  normalizeInfoSubmode,
  normalizeProcessingWindow,
  normalizeStagnationTurns
} = require("./flags");

// ─── buildTopChips ────────────────────────────────────────────────────────────
// Returns the array of display chips shown in the admin UI and debugMeta.
// Priority: N2 > N1 > mode chip, then optional annotation chips.
function buildTopChips({
  suicideLevel = "N0",
  mode = null,
  infoSubmode = null,
  contactSubmode = null,
  explorationSubmode = null,
  interpretationRejection = false,
  isRecallRequest = false,
  needsSoberReadjustment = false,
  relationalAdjustmentTriggered = false
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
  } else if (mode === "exploration") {
    chips.push(buildExplorationSubmodeChipLabel(explorationSubmode));
  } else if (mode === "info") {
    const safeInfoSubmode = normalizeInfoSubmode(infoSubmode);
    chips.push(
      safeInfoSubmode === "psychoeducation" ? "PSYCHOEDUCATION" :
      safeInfoSubmode === "app_features" ? "INFO APP : fonctionnalités" :
      safeInfoSubmode === "pure" ? "INFO PURE" :
      "INFO"
    );
  } else if (mode === "contact") {
    const safeContactSubmode = normalizeContactSubmode(contactSubmode);
    chips.push(
      safeContactSubmode === "dysregulated" ? "CONTACT : dérégulé" :
      safeContactSubmode === "regulated" ? "CONTACT : régulé" :
      "CONTACT"
    );
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
  if (relationalAdjustmentTriggered === true) {
    chips.push("Ajustement relationnel");
  }

  return chips;
}

// ─── buildDirectivityText ─────────────────────────────────────────────────────
// Returns the human-readable exploration directivity summary string,
// or "" for non-exploration modes.
function buildDirectivityText({
  mode = null,
  explorationCalibrationLevel = null,
  explorationDirectivityLevel = 0,
  explorationRelanceWindow = []
} = {}) {
  if (mode !== "exploration") return "";

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
  mode = null,
  conversationStateKey = "exploration",
  consecutiveNonExplorationTurns = 0,
  infoSubmode = null,
  contactSubmode = null,
  interpretationRejection = false,
  needsSoberReadjustment = false,
  relationalAdjustmentTriggered = false,
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
  // Posture contract (V3)
  writerMode = null,
  intent = null,
  forbidden = [],
  confidenceSignal = "high",
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
  // Formerly closure-captured — now explicit
  pipelineStages = [],
  traceId = null,
  normalizeMemory = (m) => String(m || "").trim()
} = {}) {
  return {
    topChips: buildTopChips({
      suicideLevel,
      mode,
      infoSubmode,
      contactSubmode,
      explorationSubmode,
      interpretationRejection,
      isRecallRequest,
      needsSoberReadjustment,
      relationalAdjustmentTriggered
    }),
    memory: normalizeMemory(memory),
    directivityText: buildDirectivityText({
      mode,
      explorationCalibrationLevel,
      explorationDirectivityLevel,
      explorationRelanceWindow
    }),
    conversationStateKey: normalizeConversationStateKey(conversationStateKey),
    consecutiveNonExplorationTurns: normalizeConsecutiveNonExplorationTurns(consecutiveNonExplorationTurns),
    infoSubmode: normalizeInfoSubmode(infoSubmode),
    contactSubmode: normalizeContactSubmode(contactSubmode),
    interpretationRejection: interpretationRejection === true,
    needsSoberReadjustment: needsSoberReadjustment === true,
    relationalAdjustmentTriggered: relationalAdjustmentTriggered === true,
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
    explorationSubmode: mode === "exploration" && typeof explorationSubmode === "string" ? explorationSubmode : null,
    rewriteSource: typeof rewriteSource === "string" ? rewriteSource : null,
    memoryRewriteSource: typeof memoryRewriteSource === "string" ? memoryRewriteSource : null,
    memoryCompressed: memoryCompressed === true,
    memoryBeforeCompression:
      memoryCompressed === true && typeof memoryBeforeCompression === "string"
        ? normalizeMemory(memoryBeforeCompression)
        : null,
    criticTriggered: criticTriggered === true,
    criticIssues: Array.isArray(criticIssues) ? criticIssues : [],
    // Posture contract (V3)
    writerMode: typeof writerMode === "string" ? writerMode : null,
    intent: typeof intent === "string" ? intent : null,
    forbidden: Array.isArray(forbidden) ? forbidden : [],
    confidenceSignal: typeof confidenceSignal === "string" ? confidenceSignal : "high",
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
    traceId: typeof traceId === "string" ? traceId : null
  };
}

module.exports = {
  buildTopChips,
  buildDirectivityText,
  buildResponseDebugMeta
};
