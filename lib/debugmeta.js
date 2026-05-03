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
  explorationSignal = null,
  interpretationRejection = false,
  isRecallRequest = false,
  needsSoberReadjustment = false,
  relationalAdjustmentActive = false
} = {}) {
  const chips = [];

  function buildExplorationSignalChipLabel(signal = null) {
    if (signal === "interpretation") return "EXPLORATION : interprétation";
    if (signal === "phenomenological_follow") return "EXPLORATION : accompagnement";
    return "EXPLORATION";
  }

  if (suicideLevel === "N2") {
    chips.push("URGENCE : risque suicidaire");
  } else if (suicideLevel === "N1") {
    chips.push("Risque suicidaire à clarifier");
  } else if (conversationState === "exploration_open" || conversationState === "exploration_restrained") {
    chips.push(buildExplorationSignalChipLabel(explorationSignal));
  } else if (conversationState && conversationState.startsWith("info_")) {
    chips.push(
      conversationState === "info_psychoeducation" ? "PSYCHOEDUCATION" :
      conversationState === "info_features" ? "INFO APP : fonctionnalités" :
      conversationState === "info_pure" ? "INFO PURE" :
      "INFO"
    );
  } else if (conversationState === "discharge_dysregulated") {
    chips.push("DECHARGE : dérégulée");
  } else if (conversationState === "discharge_regulated") {
    chips.push("DECHARGE : régulée");
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

function normalizeMemoryRewriteIntent(value) {
  if (!value || typeof value !== "object") {
    return null;
  }

  return {
    compressionRequested: value.compressionRequested === true,
    interpretationRejectionActive: value.interpretationRejectionActive === true,
    rejectsUnderlyingPhenomenon: value.rejectsUnderlyingPhenomenon === true,
    soberReadjustmentActive: value.soberReadjustmentActive === true,
    lectureBotForcedReset: value.lectureBotForcedReset === true
  };
}

function normalizeSecondaryTension(value) {
  if (!value || typeof value !== "object") {
    return null;
  }

  const rawFamily = String(value.family || "").trim().toLowerCase();
  const canonicalFamily = rawFamily
    .replace(/[\s-]+/g, "_")
    .replace(/[^a-z0-9_]/g, "");

  const FAMILY_ALIASES = {
    discharge: "discharge",
    decharge: "discharge",
    emotional_discharge: "discharge",
    info: "info",
    information: "info",
    informational: "info",
    exploration: "exploration",
    stabilization: "stabilization",
    stabilisation: "stabilization",
    alliance_rupture: "alliance_rupture",
    alliancerupture: "alliance_rupture",
    rupture_alliance: "alliance_rupture",
    relational_rupture: "alliance_rupture",
    relationalrupture: "alliance_rupture",
    relational_friction: "alliance_rupture",
    friction_relationnelle: "alliance_rupture",
    frictionrelationnelle: "alliance_rupture"
  };

  const family = FAMILY_ALIASES[canonicalFamily] || null;
  if (!family) {
    return null;
  }

  const rawConfidence = String(value.confidence || "").trim().toLowerCase();
  const canonicalConfidence = rawConfidence
    .replace(/[\s-]+/g, "_")
    .replace(/[^a-z0-9_]/g, "");

  const CONFIDENCE_ALIASES = {
    high: "high",
    highest: "high",
    strong: "high",
    fort: "high",
    medium: "medium",
    med: "medium",
    moderate: "medium",
    moyen: "medium",
    moyenne: "medium",
    low: "low",
    weak: "low",
    faible: "low"
  };

  const confidence = CONFIDENCE_ALIASES[canonicalConfidence] || "low";
  return { family, confidence };
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
  explorationSignal = null,
  memoryRewriteIntent = null,
  memoryCompressed = false,
  memoryBeforeCompression = null,
  memoryAge = 0,
  criticTriggered = false,
  criticIssues = [],
  criticOriginalReply = null,
  criticTriggerReasons = [],
  // Posture contract (V3)
  intent = null,
  forbidden = [],
  confidenceSignal = 1.0,
  responseRegister = "courant",
  phraseLengthPolicy = "moyenne",
  relancePolicy = "selective",
  somaticFocusPolicy = "none",
  useDirectAddress = false,
  actionCollapseGuardActive = false,
  stateTransitionFrom = null,
  stateTransitionValid = true,
  stateTransitionRequested = null,
  // Phase B structural flags
  allianceSignal = "good",
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
  affiliationScore = null,
  affiliationWindow = [],
  affiliationEstablished = false,
  emotionalDecentering = false,
  formalAddress = false,
  // Writer hints from posture decision
  writerIntentHints = [],
  // Contact analyzer sub-fields
  contactInsightMoment = false,
  contactSelfCriticismLevel = "low",
  contactMeaningCrisis = false,
  // C3 limiting_belief gate
  aggressiveDischargeDetected = false,
  postDischargeTransitionActive = false,
  // Tension secondaire
  secondaryTension = null,
  // Crisis sequence observability
  n2TurnType = null,
  emergencyNumbersIncluded = false,
  postCrisisSupportActive = false,
  postCrisisSupportCarryTurn = false,
  emergencySupportText = null,
  // Formerly closure-captured — now explicit
  pipelineStages = [],
  traceId = null,
  normalizeMemory = (m) => String(m || "").trim()
} = {}) {
  return {
    topChips: buildTopChips({
      suicideLevel,
      conversationState,
      explorationSignal,
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
    explorationSignal: (conversationState === "exploration_open" || conversationState === "exploration_restrained") && typeof explorationSignal === "string" ? explorationSignal : null,
    memoryRewriteIntent: normalizeMemoryRewriteIntent(memoryRewriteIntent),
    memoryCompressed: memoryCompressed === true,
    memoryAge: Number.isInteger(memoryAge) && memoryAge > 0 ? memoryAge : 0,
    memoryBeforeCompression:
      memoryCompressed === true && typeof memoryBeforeCompression === "string"
        ? normalizeMemory(memoryBeforeCompression)
        : null,
    criticTriggered: criticTriggered === true,
    criticIssues: Array.isArray(criticIssues) ? criticIssues : [],
    criticOriginalReply: (criticTriggered === true && typeof criticOriginalReply === "string" && criticOriginalReply.length > 0)
      ? criticOriginalReply
      : null,
    criticTriggerReasons: Array.isArray(criticTriggerReasons) ? criticTriggerReasons : [],
    // Posture contract (V3)
    intent: typeof intent === "string" ? intent : null,
    forbidden: Array.isArray(forbidden) ? forbidden : [],
    confidenceSignal: typeof confidenceSignal === "number" ? confidenceSignal : 1.0,
    responseRegister: typeof responseRegister === "string" ? responseRegister : "courant",
    phraseLengthPolicy: typeof phraseLengthPolicy === "string" ? phraseLengthPolicy : "moyenne",
    relancePolicy: typeof relancePolicy === "string" ? relancePolicy : "selective",
    somaticFocusPolicy: typeof somaticFocusPolicy === "string" ? somaticFocusPolicy : "none",
    useDirectAddress: useDirectAddress === true,
    actionCollapseGuardActive: actionCollapseGuardActive === true,
    stateTransitionFrom: typeof stateTransitionFrom === "string" ? stateTransitionFrom : null,
    stateTransitionValid: stateTransitionValid !== false,
    stateTransitionRequested: typeof stateTransitionRequested === "string" ? stateTransitionRequested : null,
    // Phase B structural flags
    allianceSignal: normalizeAllianceState(allianceSignal),
    engagementLevel: normalizeEngagementLevel(engagementLevel),
    stagnationTurns: normalizeStagnationTurns(stagnationTurns),
    processingWindow: normalizeProcessingWindow(processingWindow),
    dependencyRiskScore: clampDependencyRiskScore(dependencyRiskScore),
    dependencyRiskLevel: normalizeDependencyRiskLevel(dependencyRiskLevel),
    externalSupportMode: normalizeExternalSupportMode(externalSupportMode),
    closureIntent: closureIntent === true,
    infoRoutingSource: typeof infoRoutingSource === "string" ? infoRoutingSource : null,
    // Lot 8 fields
    affiliationScore: typeof affiliationScore === "number" ? affiliationScore : null,
    affiliationWindow: Array.isArray(affiliationWindow) ? affiliationWindow.map(v => typeof v === "number" ? Math.round(v * 100) / 100 : 0) : [],
    affiliationEstablished: affiliationEstablished === true,
    emotionalDecentering: emotionalDecentering === true,
    formalAddress: formalAddress === true,
    // Writer hints from posture decision
    writerIntentHints: Array.isArray(writerIntentHints) ? writerIntentHints : [],
    // Contact analyzer sub-fields
    contactInsightMoment: contactInsightMoment === true,
    contactSelfCriticismLevel: typeof contactSelfCriticismLevel === "string" ? contactSelfCriticismLevel : "low",
    contactMeaningCrisis: contactMeaningCrisis === true,
    // C3 limiting_belief gate (affiché uniquement si true)
    aggressiveDischargeDetected: aggressiveDischargeDetected === true,
    postDischargeTransitionActive: postDischargeTransitionActive === true,
    // Crisis sequence observability
    n2TurnType: typeof n2TurnType === "string" ? n2TurnType : null,
    emergencyNumbersIncluded: emergencyNumbersIncluded === true,
    postCrisisSupportActive: postCrisisSupportActive === true,
    postCrisisSupportCarryTurn: postCrisisSupportCarryTurn === true,
    emergencySupportText: typeof emergencySupportText === "string" ? emergencySupportText : null,
    traceId: typeof traceId === "string" ? traceId : null,
    // Tension secondaire
    secondaryTension: normalizeSecondaryTension(secondaryTension)
  };
}

module.exports = {
  buildTopChips,
  buildDirectivityText,
  buildResponseDebugMeta
};
