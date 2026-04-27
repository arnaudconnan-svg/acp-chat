"use strict";

const {
  RELANCE_WINDOW_SIZE,
  CONTACT_SCORE_WINDOW_SIZE,
  clampExplorationDirectivityLevel,
  computeExplorationDirectivityLevel,
  normalizeAllianceState,
  normalizeContactSubmode,
  normalizeEngagementLevel,
  normalizeExplorationRelanceWindow,
  normalizeProcessingWindow,
  normalizeStagnationTurns,
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
  const hasSituatedAsk = /comment je (fais|peux faire)|qu'est-ce que je fais|je voudrais (savoir|comprendre|faire|trouver|acceder|accéder|corriger|regler|régler|installer|configurer)|j'essaie|je viens d'essayer|je n'arrive pas|je peux pas/.test(text);
  const hasImpasseOrAffect = /bloqu|coince|imposs|trop grand|pas acces|perdu du temps|frustr|soule|galer|decourag|incapable|ca me saoul|ca me soule/.test(text);

  return hasFirstPerson && (hasSituatedAsk || hasImpasseOrAffect);
}

const shouldForceExplorationForTechnicalContext = shouldForceExplorationForSituatedImpasse;

function computeContactTurnScore(message = "") {
  const VALIDATION_PATTERNS = [
    /\bc'est (exactement |bien |vraiment )?ça\b/i,
    /\bexactement\b/i,
    /\bc'est (clair|juste|précis)\b/i,
    /\btout à fait\b/i,
    /\bvoilà\b(?!\s+(ce|que|comment|pourquoi|un|une|le|la|les|mon|ma|mes|ton|ta|tes|son|sa|ses)\b)/i
  ];
  const validationScore = VALIDATION_PATTERNS.some(p => p.test(message)) ? 0.5 : 0;
  const lengthScore = Math.min(message.length / 300, 1) * 0.5;
  return validationScore + lengthScore;
}

function computeContactEstablished(window = []) {
  if (!Array.isArray(window) || window.length === 0) return false;
  return Math.max(...window) >= 0.5;
}

function buildPostureDecision({
  detectedMode,
  detectedInfoSubmode,
  dischargeAnalysis,
  contactAnalysis,
  emotionalDecenteringAnalysis = { emotionalDecentering: false },
  contactScoreWindow = [0, 0, 0, 0],
  contactEstablished = false,
  relationalAdjustmentAnalysis,
  calibrationAnalysis,
  technicalContextDetected = false,
  somaticSignalAnalysis = { somaticSignalActive: false, somaticLocalizationBlocked: false },
  userRegisterAnalysis = { userRegister: "courant", formalAddress: false },
  previousFormalAddress = false,
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
  engagementAllianceAnalysis = null,
  suicideLevel = "N0",
  isRecallAttempt = false,
  psychoeducationType = null,
  infoContextFlags = [],
  theoreticalOrientation = "none",
  orientationConfidence = 0.0,
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
  } else if (detectedMode === "discharge") {
    flagUpdates.activeSubmode = dischargeAnalysis.contactSubmode;
  } else if (detectedMode === "contact") {
    flagUpdates.activeSubmode = "regulated";
  } else {
    flagUpdates.activeSubmode = null;
  }

  // E4 + E5 — overrides de mode avant résolution d'état
  let modeForStateResolution = detectedMode;
  if (emotionalDecenteringAnalysis?.emotionalDecentering === true && detectedMode === "exploration") {
    modeForStateResolution = "contact";
  }
  if (!contactEstablished && detectedMode === "exploration") {
    modeForStateResolution = "contact";
  }

  // C2 engagement/alliance analysis overrides persistent flag values for state resolution
  const resolvedAllianceState = engagementAllianceAnalysis
    ? normalizeAllianceState(engagementAllianceAnalysis.allianceState)
    : normalizeAllianceState(allianceState);
  const resolvedEngagementLevel = engagementAllianceAnalysis
    ? normalizeEngagementLevel(engagementAllianceAnalysis.engagementLevel)
    : normalizeEngagementLevel(engagementLevel);
  const resolvedProcessingWindow = engagementAllianceAnalysis
    ? normalizeProcessingWindow(engagementAllianceAnalysis.processingWindow)
    : normalizeProcessingWindow(processingWindow);
  // Stagnation: increment when exploration + engagement is passive or withdrawn;
  // reset when actively re-engaged; preserve persistent value when no analyzer ran.
  const resolvedStagnationTurns = normalizeStagnationTurns(
    engagementAllianceAnalysis !== null
      ? (
          (resolvedEngagementLevel === "passive" || resolvedEngagementLevel === "withdrawn") && detectedMode === "exploration"
            ? normalizeStagnationTurns(stagnationTurns) + 1
            : 0
        )
      : normalizeStagnationTurns(stagnationTurns)
  );

  const requestedConversationStateKey = resolveConversationState({
    detectedMode: modeForStateResolution,
    dischargeAnalysis,
    contactAnalysis,
    previousConversationStateKey,
    allianceState: resolvedAllianceState,
    engagementLevel: resolvedEngagementLevel,
    stagnationTurns: resolvedStagnationTurns,
    processingWindow: resolvedProcessingWindow,
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
    conversationStateKey === "contact" ||
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
  flagUpdates.contactScoreWindow = contactScoreWindow;
  flagUpdates.allianceState = resolvedAllianceState;
  flagUpdates.engagementLevel = resolvedEngagementLevel;
  flagUpdates.processingWindow = resolvedProcessingWindow;
  flagUpdates.stagnationTurns = resolvedStagnationTurns;

  const stateWriterMode = stateToWriterMode(conversationStateKey, {
    contactSubmode: dischargeAnalysis?.contactSubmode,
    infoSubmode: detectedInfoSubmode,
    directivityLevel: finalDirectivityLevel
  });
  // Priority: safety (N1) > recall > normal state
  const writerMode = suicideLevel === "N1" ? "n1_crisis"
    : stateWriterMode;

  const baseForbidden = WRITER_MODE_FORBIDDEN[writerMode] || [];
  const actionCollapseGuardActive = technicalContextDetected === true
    && (detectedMode === "exploration" || detectedMode === "discharge");
  const forbidden = actionCollapseGuardActive
    ? Array.from(new Set([...baseForbidden, "action_concrete_proposal"]))
    : baseForbidden;
  const allowed = WRITER_MODE_ALLOWED[writerMode] || [];
  const intent = WRITER_MODE_INTENT[writerMode] || "explorer librement";
  const { maxSentences = null, toneConstraint = null } = WRITER_MODE_CONSTRAINTS[writerMode] || {};
  const userRegister = ["familier", "courant", "soutenu"].includes(userRegisterAnalysis?.userRegister)
    ? userRegisterAnalysis.userRegister
    : "courant";
  const formalAddress = (userRegisterAnalysis?.formalAddress === true) || previousFormalAddress === true;
  flagUpdates.formalAddress = formalAddress;
  const responseRegister = detectedMode === "info" ? "courant" : userRegister;
  const phraseLengthPolicy = responseRegister === "familier"
    ? "courte"
    : (["stabilization", "alliance_rupture", "closure", "discharge_dysregulated"].includes(writerMode) ? "courte" : "moyenne");
  // relancePolicy calculé après le bloc C3 pour refléter effectiveForbidden (voir ci-dessous)
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
  const humanFieldGuardActive = technicalContextDetected === true
    && (detectedMode === "exploration" || detectedMode === "discharge");

  const criticalGuardrails = [...theoreticalConstraints];
  if (humanFieldGuardActive) {
    criticalGuardrails.push("no_procedural_instrumental_reply");
  }

  // C3 — confiance contextuelle (calculée en amont des décisions C3)
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

  // C3 — décisions sur le signal de friction / rejet d'interprétation
  const relationalFriction = interpretationRejection?.relationalFrictionSignal || "none";
  const isRejection = interpretationRejection?.isInterpretationRejection === true;
  const rejectsUnderlyingPhenomenon = interpretationRejection?.rejectsUnderlyingPhenomenon === true;

  // C3 — décision de réajustement sobre
  const needsSoberReadjustment =
    relationalFriction === "strong" ||
    isRejection ||
    (relationalFriction === "mild" && confidenceSignal < 0.5) ||
    (relationalAdjustmentAnalysis?.needsRelationalAdjustment === true && confidenceSignal < 0.4);

  // C3 — décision de tenue de tension
  let tensionHoldLevel;
  if (rejectsUnderlyingPhenomenon || (isRejection && confidenceSignal <= 0.3)) {
    tensionHoldLevel = "high";
  } else if (isRejection || (relationalFriction === "strong" && confidenceSignal < 0.7)) {
    tensionHoldLevel = "medium";
  } else {
    tensionHoldLevel = "low";
  }

  const interpretationRejectionDetected = isRejection;

  // C3 — règles dérivées du signal d'orientation théorique
  const theoreticalOrientationSignal = orientationConfidence >= 0.5
    ? theoreticalOrientation
    : "none";

  // Construit une copie avant toute mutation pour éviter de polluer les constantes WRITER_MODE_FORBIDDEN
  let effectiveForbidden = Array.from(forbidden);
  const writerIntentHints = [];

  // E5 — contactEstablished = false → gate exploration (modeForStateResolution déjà appliqué ci-dessus)
  // (le override modeForStateResolution est appliqué avant resolveConversationState, pas ici)
  if (theoreticalOrientationSignal === "relational_need" && detectedMode === "exploration") {
    if (!effectiveForbidden.includes("interpretive_hypothesis")) effectiveForbidden.push("interpretive_hypothesis");
  }

  if (theoreticalOrientationSignal === "limit_expression" && detectedMode === "exploration") {
    if (!effectiveForbidden.includes("relance")) effectiveForbidden.push("relance");
  }

  // C3 — restrictions post-discharge
  if (conversationStateKey === "contact" && normalizedPreviousConversationStateKey === "discharge") {
    if (!effectiveForbidden.includes("relance")) effectiveForbidden.push("relance");
    if (!effectiveForbidden.includes("interpretive_hypothesis")) effectiveForbidden.push("interpretive_hypothesis");
    writerIntentHints.push("auto_compassion_door_open");
  }

  // C3 — règles Patch E (nouvelles)
  // E1 — auto-critique sévère en mode contact
  if (contactAnalysis?.selfCriticismLevel === "high" && detectedMode === "contact") {
    if (!effectiveForbidden.includes("value_affirmation")) effectiveForbidden.push("value_affirmation");
    writerIntentHints.push("signify_pain_without_blocking", "auto_compassion_door_open");
  }

  // E2 — meaningProtest en mode contact
  if (contactAnalysis?.meaningProtest === true && detectedMode === "contact") {
    flagUpdates.activeSubmode = "meaning_making";
    if (!effectiveForbidden.includes("relance")) effectiveForbidden.push("relance");
    if (!effectiveForbidden.includes("interpretive_hypothesis")) effectiveForbidden.push("interpretive_hypothesis");
  }

  // E3 — insightMoment en mode contact
  if (contactAnalysis?.insightMoment === true && detectedMode === "contact") {
    flagUpdates.activeSubmode = "insight";
    if (!effectiveForbidden.includes("relance")) effectiveForbidden.push("relance");
    writerIntentHints.push("amplify_insight");
  }

  // E4 — décentering émotionnel
  if (emotionalDecenteringAnalysis?.emotionalDecentering === true) {
    writerIntentHints.push("hold_emotional_thread", "auto_compassion_door_open");
  }

  // D2 — orientation unfinished_business
  let writerOrientationHint = null;
  if (theoreticalOrientationSignal === "unfinished_business" && detectedMode === "exploration") {
    if (!effectiveForbidden.includes("interpretive_hypothesis")) effectiveForbidden.push("interpretive_hypothesis");
    writerOrientationHint = "unfinished_business_subtle_opening";
  }

  // Calcul de relancePolicy après le bloc C3 pour prendre en compte effectiveForbidden
  let relancePolicy = "selective";
  if (effectiveForbidden.includes("relance")) {
    relancePolicy = "forbidden";
  } else if (detectedMode === "exploration") {
    relancePolicy = finalDirectivityLevel >= 3 ? "discouraged" : (finalDirectivityLevel === 2 ? "selective" : "open");
  }

  // F2 — emotionSequenceStage heuristique
  let emotionSequenceStage = null;
  if (detectedMode === "discharge" && dischargeAnalysis?.contactSubmode === "dysregulated") {
    emotionSequenceStage = "global_distress";
  } else if (detectedMode === "discharge") {
    emotionSequenceStage = "secondary";
  } else if (detectedMode === "contact" && contactAnalysis?.selfCriticismLevel === "high") {
    emotionSequenceStage = "secondary";
  } else if (detectedMode === "contact" && contactAnalysis?.meaningProtest === true) {
    emotionSequenceStage = "need_access";
  } else if (detectedMode === "contact" && contactAnalysis?.insightMoment === true) {
    emotionSequenceStage = "primary_adaptive";
  } else if (detectedMode === "exploration" && stagnationTurns >= 3) {
    emotionSequenceStage = "resolution";
  }
  // Décentering : rétrograder d'un cran si possible
  if (emotionalDecenteringAnalysis?.emotionalDecentering === true && emotionSequenceStage !== null) {
    const STAGE_ORDER = ["global_distress", "secondary", "need_access", "primary_adaptive", "resolution"];
    const idx = STAGE_ORDER.indexOf(emotionSequenceStage);
    if (idx > 0) emotionSequenceStage = STAGE_ORDER[idx - 1];
  }
  flagUpdates.emotionSequenceStage = emotionSequenceStage;

  return {
    finalDetectedMode: detectedMode,
    finalDirectivityLevel,
    finalExplorationSubmode,
    conversationStateKey,
    consecutiveNonExplorationTurns,
    relationalAdjustmentTriggered: relationalAdjustmentAnalysis?.needsRelationalAdjustment === true,
    relationalAdjustmentDepth: relationalAdjustmentAnalysis?.needsRelationalAdjustment === true
      ? (detectedMode === "info" ? "minimal" : "moderate")
      : null,
    preAdjustmentDirectivityLevel,
    flagUpdates,
    writerMode,
    recallInjectionActive: isRecallAttempt === true,
    forbidden: effectiveForbidden,
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
    formalAddress,
    previousConversationStateKey: normalizedPreviousConversationStateKey,
    requestedConversationStateKey,
    stateTransitionValid,
    interpretationRejectionDetected,
    needsSoberReadjustment,
    rejectsUnderlyingPhenomenon,
    tensionHoldLevel,
    psychoeducationType,
    infoContextFlags,
    humanFieldGuardActive,
    theoreticalOrientationSignal,
    orientationConfidence,
    writerIntentHints,
    writerOrientationHint,
    emotionSequenceStage,
    memoryPrioritySignal: interpretationRejectionDetected
      ? "interpretation_rejected"
      : needsSoberReadjustment
      ? "relational_friction"
      : "normal"
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
    lines.push("suicideLevel: Risque suicidaire avéré");
  }

  if (calledMemory === "shortTermMemory") {
    lines.push("calledMemory: Appel à la mémoire à court terme");
  }
  if (calledMemory === "longTermMemory") {
    lines.push("calledMemory: Appel à la mémoire à long terme");
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

    lines.push(`explorationDirectivityLevel: Niveau de directivité : ${clampExplorationDirectivityLevel(explorationDirectivityLevel)}/4`);

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
  computeContactTurnScore,
  computeContactEstablished,
  isConceptualInformationQuestion,
  normalizeGuardText,
  shouldForceExplorationForSituatedImpasse,
  shouldForceExplorationForTechnicalContext,
  WRITER_MODE_CONSTRAINTS,
  WRITER_MODE_FORBIDDEN,
  WRITER_MODE_INTENT
};
