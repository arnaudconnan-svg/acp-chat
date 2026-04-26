"use strict";

const {
  RELANCE_WINDOW_SIZE,
  clampExplorationDirectivityLevel,
  computeExplorationDirectivityLevel,
  normalizeContactSubmode,
  normalizeExplorationRelanceWindow,
  normalizeSessionFlags
} = require("./flags");

const {
  WRITER_MODE_FORBIDDEN,
  WRITER_MODE_ALLOWED,
  WRITER_MODE_INTENT,
  WRITER_MODE_CONSTRAINTS,
  resolveConversationState,
  stateToWriterMode,
  isValidTransition
} = require("./conversation-state");

function normalizeGuardText(text = "") {
  return String(text || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[\u2019]/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

function isConceptualInformationQuestion(message = "") {
  const text = normalizeGuardText(message);

  return [
    /qu'est-ce que/,
    /quelle difference/,
    /comment fonctionne/,
    /pourquoi .*\b(est|fonctionne|refuse|encourage)\b/,
    /est-ce que .*\b(compatible|possible|normal|encourage|refuse)\b/,
    /comment .*se situe/
  ].some(pattern => pattern.test(text));
}

function shouldForceExplorationForSituatedImpasse(message = "") {
  const text = normalizeGuardText(message);

  if (isConceptualInformationQuestion(text)) {
    return false;
  }

  const hasFirstPerson = /\b(je|j'|moi|me|m'|mon|ma|mes)\b/.test(text);
  const hasSituatedAsk = /comment je (fais|peux faire)|qu'est-ce que je fais|je voudrais|j'essaie|je viens d'essayer|je n'arrive pas|je peux pas/.test(text);
  const hasImpasseOrAffect = /bloqu|coince|imposs|trop grand|pas acces|perdu du temps|frustr|soule|galer|decourag|incapable|ca me saoul|ca me soule/.test(text);

  return hasFirstPerson && (hasSituatedAsk || hasImpasseOrAffect);
}

const shouldForceExplorationForTechnicalContext = shouldForceExplorationForSituatedImpasse;

function buildPostureDecision({
  detectedMode,
  detectedInfoSubmode,
  contactAnalysis,
  relationalAdjustmentAnalysis,
  calibrationAnalysis,
  technicalContextDetected = false,
  somaticSignalAnalysis = { somaticSignalActive: false, somaticLocalizationBlocked: false },
  userRegisterAnalysis = { userRegister: "courant" },
  interpretationRejection,
  effectiveExplorationDirectivityLevel,
  previousConversationStateKey,
  currentConsecutiveNonExplorationTurns,
  currentExplorationRelanceWindow,
  allianceState = "good",
  engagementLevel = "active",
  stagnationTurns = 0,
  processingWindow = "open",
  closureIntent = false,
  suicideLevel = "N0",
  isRecallAttempt = false,
  message = "",
  recentHistory = []
}) {
  let finalDirectivityLevel = clampExplorationDirectivityLevel(effectiveExplorationDirectivityLevel);
  let finalExplorationSubmode = "interpretation";
  let preAdjustmentDirectivityLevel = null;
  const flagUpdates = {};

  if (detectedMode === "exploration") {
    finalDirectivityLevel = Math.min(
      clampExplorationDirectivityLevel(effectiveExplorationDirectivityLevel),
      clampExplorationDirectivityLevel(calibrationAnalysis.calibrationLevel)
    );

    if (relationalAdjustmentAnalysis?.needsRelationalAdjustment === true) {
      preAdjustmentDirectivityLevel = finalDirectivityLevel;
      finalDirectivityLevel = Math.min(finalDirectivityLevel, 2);
    }

    finalExplorationSubmode = ["interpretation", "phenomenological_follow"].includes(calibrationAnalysis.explorationSubmode)
      ? calibrationAnalysis.explorationSubmode
      : "interpretation";
    flagUpdates.explorationCalibrationLevel = finalDirectivityLevel;
    flagUpdates.activeSubmode = finalExplorationSubmode;
  } else if (detectedMode === "info") {
    flagUpdates.infoSubmode = detectedInfoSubmode;
    flagUpdates.activeSubmode = detectedInfoSubmode;
  } else if (detectedMode === "contact") {
    flagUpdates.activeSubmode = contactAnalysis.contactSubmode;
  } else {
    flagUpdates.activeSubmode = null;
  }

  const requestedConversationStateKey = resolveConversationState({
    detectedMode,
    contactAnalysis,
    previousConversationStateKey,
    allianceState,
    engagementLevel,
    stagnationTurns,
    processingWindow,
    closureIntent
  });

  const normalizedPreviousConversationStateKey = typeof previousConversationStateKey === "string"
    ? previousConversationStateKey
    : null;
  const stateTransitionValid = normalizedPreviousConversationStateKey === null
    ? true
    : isValidTransition(normalizedPreviousConversationStateKey, requestedConversationStateKey);

  // Enforcement: if the resolved transition is out-of-graph, fall back to the
  // previous state (stay where we are) rather than accepting an impossible state.
  // This ensures the writer always receives a contract consistent with the graph.
  const conversationStateKey = stateTransitionValid
    ? requestedConversationStateKey
    : (normalizedPreviousConversationStateKey || "exploration");

  let consecutiveNonExplorationTurns = currentConsecutiveNonExplorationTurns;
  if (
    conversationStateKey === "exploration" ||
    conversationStateKey === "post_contact" ||
    conversationStateKey === "stabilization" ||
    conversationStateKey === "alliance_rupture" ||
    conversationStateKey === "closure"
  ) {
    consecutiveNonExplorationTurns = 0;
  } else if (consecutiveNonExplorationTurns === 0) {
    consecutiveNonExplorationTurns = 1;
  } else {
    consecutiveNonExplorationTurns += 1;
    const decayedWindow = [...currentExplorationRelanceWindow, false].slice(-RELANCE_WINDOW_SIZE);
    flagUpdates.explorationRelanceWindow = decayedWindow;
    flagUpdates.explorationDirectivityLevel = computeExplorationDirectivityLevel(decayedWindow);
  }

  flagUpdates.conversationStateKey = conversationStateKey;
  flagUpdates.consecutiveNonExplorationTurns = consecutiveNonExplorationTurns;

  const stateWriterMode = stateToWriterMode(conversationStateKey, {
    contactSubmode: contactAnalysis.contactSubmode,
    infoSubmode: detectedInfoSubmode,
    directivityLevel: finalDirectivityLevel
  });
  // Priority: safety (N1) > recall > normal state
  const writerMode = suicideLevel === "N1" ? "n1_crisis"
    : isRecallAttempt ? "recall_memory"
    : stateWriterMode;

  const baseForbidden = WRITER_MODE_FORBIDDEN[writerMode] || [];
  const actionCollapseGuardActive = technicalContextDetected === true
    && (detectedMode === "exploration" || detectedMode === "contact");
  const forbidden = actionCollapseGuardActive
    ? Array.from(new Set([...baseForbidden, "action_concrete_proposal"]))
    : baseForbidden;
  const allowed = WRITER_MODE_ALLOWED[writerMode] || [];
  const intent = WRITER_MODE_INTENT[writerMode] || "explorer librement";
  const { maxSentences = null, toneConstraint = null } = WRITER_MODE_CONSTRAINTS[writerMode] || {};
  const userRegister = ["familier", "courant", "soutenu"].includes(userRegisterAnalysis?.userRegister)
    ? userRegisterAnalysis.userRegister
    : "courant";
  const responseRegister = detectedMode === "info" ? "courant" : userRegister;
  const phraseLengthPolicy = responseRegister === "familier"
    ? "courte"
    : (["stabilization", "alliance_rupture", "closure", "contact_dysregulated"].includes(writerMode) ? "courte" : "moyenne");
  let relancePolicy = "selective";
  if (forbidden.includes("relance")) {
    relancePolicy = "forbidden";
  } else if (detectedMode === "exploration") {
    relancePolicy = finalDirectivityLevel >= 3 ? "discouraged" : (finalDirectivityLevel === 2 ? "selective" : "open");
  }
  let somaticFocusPolicy = "none";
  if (detectedMode === "exploration") {
    if (somaticSignalAnalysis?.somaticLocalizationBlocked === true) {
      somaticFocusPolicy = "address_frustration_before_somatic_relocalization";
    } else if (somaticSignalAnalysis?.somaticSignalActive === true) {
      somaticFocusPolicy = "prioritize_somatic_proximity";
    }
  }
  const theoreticalConstraints = [
    "no_unconscious",
    "no_psychopathology",
    "no_defense_mechanisms",
    "no_implicit_agency"
  ];
  const interpretationRejectionDetected = interpretationRejection?.isInterpretationRejection === true;
  const needsSoberReadjustment = interpretationRejection?.needsSoberReadjustment === true;
  const rejectsUnderlyingPhenomenon = interpretationRejection?.rejectsUnderlyingPhenomenon === true;
  const tensionHoldLevel = ["low", "medium", "high"].includes(interpretationRejection?.tensionHoldLevel)
    ? interpretationRejection.tensionHoldLevel
    : "medium";
  const humanFieldGuardActive = technicalContextDetected === true
    && (detectedMode === "exploration" || detectedMode === "contact");

  const criticalGuardrails = [...theoreticalConstraints];
  if (humanFieldGuardActive) {
    criticalGuardrails.push("no_procedural_instrumental_reply");
  }

  const msgText = (message || "").toLowerCase();
  const hasExplicitAmbiguity = /je sais pas|c'est mélangé|c'est melange|je ne sais pas trop|je suis perdu|pas sur de|pas sûr de/.test(msgText);
  const hasRecentRejection = (recentHistory || []).slice(-4).some(m => {
    if (m.role !== "user") return false;
    const content = (m.content || "").toLowerCase();
    return /c'est pas ça|c'est pas ca|pas vraiment|pas du tout|t'as rate|t'as raté|c'est faux|pas ce que je veux dire|non,? pas /.test(content);
  });
  const contextLength = (recentHistory || []).filter(m => m.role === "user").length;
  let confidence = 1.0;
  if (hasExplicitAmbiguity) confidence -= 0.4;
  if (hasRecentRejection) confidence -= 0.3;
  if (contextLength <= 1) confidence -= 0.2;
  else if (contextLength <= 2) confidence -= 0.1;
  const confidenceSignal = Math.max(0, Math.round(confidence * 100) / 100);

  return {
    finalDetectedMode: detectedMode,
    finalDirectivityLevel,
    finalExplorationSubmode,
    conversationStateKey,
    consecutiveNonExplorationTurns,
    relationalAdjustmentTriggered: relationalAdjustmentAnalysis?.needsRelationalAdjustment === true,
    preAdjustmentDirectivityLevel,
    flagUpdates,
    writerMode,
    forbidden,
    allowed,
    intent,
    maxSentences,
    toneConstraint,
    responseRegister,
    phraseLengthPolicy,
    relancePolicy,
    somaticFocusPolicy,
    actionCollapseGuardActive,
    theoreticalConstraints,
    criticalGuardrails,
    confidenceSignal,
    previousConversationStateKey: normalizedPreviousConversationStateKey,
    requestedConversationStateKey,
    stateTransitionValid,
    interpretationRejectionDetected,
    needsSoberReadjustment,
    rejectsUnderlyingPhenomenon,
    tensionHoldLevel,
    humanFieldGuardActive
  };
}

function buildDebug(
  mode,
  {
    suicideLevel = "N0",
    calledMemory = "none",
    infoSubmode = null,
    contactSubmode = null,
    interpretationRejection = false,
    needsSoberReadjustment = false,
    relationalAdjustmentTriggered = false,
    explorationCalibrationLevel = null,
    explorationDirectivityLevel = 0,
    explorationRelanceWindow = []
  } = {}
) {
  const lines = [];

  if (mode === "info") lines.push("mode: INFORMATION");
  if (mode === "contact") lines.push("mode: CONTACT");

  if (mode === "info" && infoSubmode === "pure") {
    lines.push("infoSubmode: INFORMATION PURE");
  }
  if (mode === "info" && infoSubmode === "psychoeducation") {
    lines.push("infoSubmode: PSYCHOEDUCATION");
  }
  if (mode === "info" && infoSubmode === "app_features") {
    lines.push("infoSubmode: INFORMATION APP FEATURES");
  }
  if (mode === "contact" && contactSubmode === "regulated") {
    lines.push("contactSubmode: CONTACT REGULE");
  }
  if (mode === "contact" && contactSubmode === "dysregulated") {
    lines.push("contactSubmode: CONTACT DEREGULE");
  }

  if (suicideLevel === "N1") {
    lines.push("suicideLevel: Possible risque suicidaire");
  }
  if (suicideLevel === "N2") {
    lines.push("suicideLevel: Risque suicidaire avÃ©rÃ©");
  }

  if (calledMemory === "shortTermMemory") {
    lines.push("calledMemory: Appel Ã  la mÃ©moire Ã  court terme");
  }
  if (calledMemory === "longTermMemory") {
    lines.push("calledMemory: Appel Ã  la mÃ©moire Ã  long terme");
  }

  if (interpretationRejection) {
    lines.push("interpretationRejection: true");
  }
  if (needsSoberReadjustment) {
    lines.push("needsSoberReadjustment: true");
  }
  if (relationalAdjustmentTriggered) {
    lines.push("relationalAdjustmentTriggered: true");
  }

  if (mode === "exploration") {
    if (explorationCalibrationLevel !== null && explorationCalibrationLevel !== undefined) {
      lines.push(`explorationCalibrationLevel: Calibration LLM : ${clampExplorationDirectivityLevel(explorationCalibrationLevel)}/4`);
    }

    lines.push(`explorationDirectivityLevel: Niveau de directivitÃ© : ${clampExplorationDirectivityLevel(explorationDirectivityLevel)}/4`);

    lines.push(
      `explorationRelanceWindow: Relance aux derniers tours [${normalizeExplorationRelanceWindow(explorationRelanceWindow)
        .map(v => (v ? "1" : "0"))
        .join("-")}]`
    );
  }

  return lines;
}

function buildAdvancedDebugTrace({
  suicide = {},
  recallRouting = {},
  contactAnalysis = {},
  contactSubmode = null,
  detectedMode = "exploration",
  relationalAdjustmentAnalysis = null,
  infoSubmode = null,
  interpretationRejection = null,
  explorationCalibrationLevel = null,
  flagsBefore = {},
  flagsAfter = {},
  generatedBase = null,
  relanceAnalysis = null
} = {}) {
  const lines = [];

  const safeFlagsBefore = normalizeSessionFlags(flagsBefore);
  const safeFlagsAfter = normalizeSessionFlags(flagsAfter);

  lines.push(`trace.modeDetected: ${detectedMode}`);
  lines.push(`trace.suicideLevelRaw: ${suicide.suicideLevel || "N0"}`);
  lines.push(`trace.suicideNeedsClarification: ${suicide.needsClarification === true ? "true" : "false"}`);
  lines.push(`trace.suicideIsQuote: ${suicide.isQuote === true ? "true" : "false"}`);
  lines.push(`trace.suicideIdiomatic: ${suicide.idiomaticDeathExpression === true ? "true" : "false"}`);
  lines.push(`trace.suicideCrisisResolved: ${suicide.crisisResolved === true ? "true" : "false"}`);

  lines.push(`trace.recallAttempt: ${recallRouting.isRecallAttempt === true ? "true" : "false"}`);
  lines.push(`trace.calledMemory: ${recallRouting.calledMemory || "none"}`);
  lines.push(`trace.longTermMemoryRecall: ${recallRouting.isLongTermMemoryRecall === true ? "true" : "false"}`);
  lines.push(`trace.recallRaw: ${recallRouting.rawLlmOutput != null ? recallRouting.rawLlmOutput : "(unavailable)"}`);
  if (recallRouting.isRecallAttempt === true) {
    lines.push("trace.recallWARN: isRecallAttempt=true â€” a verifier si coherent avec le message");
  }

  lines.push(`trace.contactDetected: ${contactAnalysis.isContact === true ? "true" : "false"}`);
  lines.push(`trace.contactSubmode: ${normalizeContactSubmode(contactSubmode) || "none"}`);
  lines.push(`trace.relationalAdjustmentTriggered: ${relationalAdjustmentAnalysis?.needsRelationalAdjustment === true ? "true" : "false"}`);
  lines.push(`trace.infoSubmode: ${infoSubmode || "none"}`);
  lines.push(`trace.interpretationRejection: ${interpretationRejection?.isInterpretationRejection === true ? "true" : "false"}`);
  lines.push(`trace.previousWasContact: ${safeFlagsBefore.contactState?.wasContact === true ? "true" : "false"}`);
  lines.push(`trace.currentWasContact: ${safeFlagsAfter.contactState?.wasContact === true ? "true" : "false"}`);

  lines.push(`trace.acuteCrisisBefore: ${safeFlagsBefore.acuteCrisis === true ? "true" : "false"}`);
  lines.push(`trace.acuteCrisisAfter: ${safeFlagsAfter.acuteCrisis === true ? "true" : "false"}`);

  if (explorationCalibrationLevel !== null && explorationCalibrationLevel !== undefined) {
    lines.push(`trace.explorationCalibrationLevel: ${clampExplorationDirectivityLevel(explorationCalibrationLevel)}`);
  }

  if (relanceAnalysis) {
    lines.push(`trace.relanceDetected: ${relanceAnalysis.isRelance === true ? "true" : "false"}`);
  }

  return lines;
}

module.exports = {
  buildAdvancedDebugTrace,
  buildDebug,
  buildPostureDecision,
  isConceptualInformationQuestion,
  normalizeGuardText,
  shouldForceExplorationForSituatedImpasse,
  shouldForceExplorationForTechnicalContext,
  WRITER_MODE_CONSTRAINTS,
  WRITER_MODE_FORBIDDEN,
  WRITER_MODE_INTENT
};
