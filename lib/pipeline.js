"use strict";

const {
  RELANCE_WINDOW_SIZE,
  AFFILIATION_WINDOW_SIZE,
  clampExplorationDirectivityLevel,
  computeExplorationDirectivityLevel,
  normalizeAllianceState,
  normalizeEngagementLevel,
  normalizeExplorationRelanceWindow,
  normalizeProcessingWindow,
  normalizeStagnationTurns,
  normalizeSessionFlags
} = require("./flags");

const {
  STATE_FORBIDDEN,
  STATE_ALLOWED,
  STATE_INTENT,
  STATE_CONSTRAINTS,
  resolveConversationState,
  isValidTransition,
  baseStateOf
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

function computeAffiliationTurnScore(message = "") {
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

function computeAffiliationEstablished(window = []) {
  if (!Array.isArray(window) || window.length === 0) return false;
  return Math.max(...window) >= 0.5;
}

function buildPostureDecision({
  detectedState,
  contactAnalysis,
  emotionalDecenteringAnalysis = { emotionalDecentering: false },
  affiliationWindow = [0, 0, 0, 0],
  affiliationEstablished = false,
  relationalAdjustmentAnalysis,
  calibrationAnalysis,
  technicalContextDetected = false,
  somaticSignalAnalysis = { somaticSignalActive: false, somaticLocalizationBlocked: false },
  userRegisterAnalysis = { userRegister: "courant", formalAddress: false },
  previousFormalAddress = false,
  interpretationRejection,
  effectiveExplorationDirectivityLevel,
  previousConversationState,
  currentConsecutiveNonExplorationTurns,
  currentExplorationRelanceWindow,
  allianceSignal = "good",
  engagementLevel = "active",
  stagnationTurns = 0,
  processingWindow = "open",
  closureIntent = false,
  dependencyRiskLevel = "low",
  attentionAnalysis = null,
  allianceRuptureAnalysis = null,
  // Backward-compatible alias used by existing harnesses/tests.
  engagementAllianceAnalysis = null,
  suicideLevel = "N0",
  isRecallAttempt = false,
  psychoeducationType = null,
  infoContextFlags = [],
  dischargeAnalysis = { aggressiveDischargeDirectedToBot: false },
  message = "",
  recentHistory = [],
  secondaryTension = null
}) {
  let finalDirectivityLevel = clampExplorationDirectivityLevel(effectiveExplorationDirectivityLevel);
  let finalExplorationSignal = "interpretation";
  let preAdjustmentDirectivityLevel = null;
  const flagUpdates = {};

  if (detectedState === "exploration") {
    finalDirectivityLevel = Math.min(
      clampExplorationDirectivityLevel(effectiveExplorationDirectivityLevel),
      clampExplorationDirectivityLevel(calibrationAnalysis.calibrationLevel)
    );

    if (relationalAdjustmentAnalysis?.needsRelationalAdjustment === true) {
      preAdjustmentDirectivityLevel = finalDirectivityLevel;
      finalDirectivityLevel = Math.min(finalDirectivityLevel, 2);
    }

    finalExplorationSignal = ["interpretation", "phenomenological_follow"].includes(calibrationAnalysis.explorationSignal)
      ? calibrationAnalysis.explorationSignal
      : "interpretation";
    flagUpdates.explorationCalibrationLevel = finalDirectivityLevel;
  }

  // E4 — signal before state resolution (contact remains a signal, not a state)
  const signalForStateResolution = detectedState;

  const effectiveAttentionAnalysis = attentionAnalysis || engagementAllianceAnalysis;

  // Rupture and attention signals are now separated:
  // - allianceRuptureAnalysis drives allianceSignal (event-driven)
  // - attentionAnalysis drives engagement/processing quality (periodic)
  const resolvedAllianceState = allianceRuptureAnalysis
    ? normalizeAllianceState(allianceRuptureAnalysis.allianceSignal)
    : normalizeAllianceState(allianceSignal);
  const resolvedEngagementLevel = effectiveAttentionAnalysis
    ? normalizeEngagementLevel(effectiveAttentionAnalysis.attentionEngagement || effectiveAttentionAnalysis.engagementLevel)
    : normalizeEngagementLevel(engagementLevel);
  const resolvedProcessingWindow = effectiveAttentionAnalysis
    ? normalizeProcessingWindow(effectiveAttentionAnalysis.attentionQuality || effectiveAttentionAnalysis.processingWindow)
    : normalizeProcessingWindow(processingWindow);
  // Stagnation: increment when exploration + engagement is passive or withdrawn;
  // reset when actively re-engaged; preserve persistent value when no analyzer ran.
  const resolvedStagnationTurns = normalizeStagnationTurns(
    effectiveAttentionAnalysis !== null
      ? (
          (resolvedEngagementLevel === "passive" || resolvedEngagementLevel === "withdrawn") && detectedState === "exploration"
            ? normalizeStagnationTurns(stagnationTurns) + 1
            : 0
        )
      : normalizeStagnationTurns(stagnationTurns)
  );

  const requestedConversationState = resolveConversationState({
    detectedState: signalForStateResolution,
    previousConversationState,
    directivityLevel: finalDirectivityLevel,
    allianceSignal: resolvedAllianceState,
    engagementLevel: resolvedEngagementLevel,
    stagnationTurns: resolvedStagnationTurns,
    processingWindow: resolvedProcessingWindow,
    closureIntent
  });

  const normalizedPreviousConversationState = typeof previousConversationState === "string"
    ? previousConversationState
    : null;
  const stateTransitionValid = normalizedPreviousConversationState === null
    ? true
    : isValidTransition(normalizedPreviousConversationState, requestedConversationState);

  // Enforcement: if the resolved transition is out-of-graph, fall back to the
  // previous state (stay where we are) rather than accepting an impossible state.
  const conversationState = stateTransitionValid
    ? requestedConversationState
    : (normalizedPreviousConversationState || "exploration_open");

  let consecutiveNonExplorationTurns = currentConsecutiveNonExplorationTurns;
  const baseState = baseStateOf(conversationState);
  if (
    baseState === "exploration" ||
    baseState === "stabilization" ||
    baseState === "alliance_rupture" ||
    baseState === "closure"
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

  flagUpdates.conversationState = conversationState;
  flagUpdates.consecutiveNonExplorationTurns = consecutiveNonExplorationTurns;
  flagUpdates.affiliationWindow = affiliationWindow;
  flagUpdates.allianceSignal = resolvedAllianceState;
  flagUpdates.engagementLevel = resolvedEngagementLevel;
  flagUpdates.processingWindow = resolvedProcessingWindow;
  flagUpdates.stagnationTurns = resolvedStagnationTurns;

  // Priority: safety (N1) > recall > normal state
  // For N1, conversationState stays as-is but the effective state for prompt routing is n1_crisis
  const effectiveConversationState = suicideLevel === "N1" ? "n1_crisis" : conversationState;

  const baseForbidden = STATE_FORBIDDEN[effectiveConversationState] || [];
  const actionCollapseGuardActive = technicalContextDetected === true
    && (detectedState === "exploration" || detectedState.startsWith("discharge_"));
  const forbidden = actionCollapseGuardActive
    ? Array.from(new Set([...baseForbidden, "action_concrete_proposal"]))
    : baseForbidden;
  const allowed = STATE_ALLOWED[effectiveConversationState] || [];
  let intent = STATE_INTENT[effectiveConversationState] || "explorer librement";
  const { maxSentences: baseMaxSentences = null, toneConstraint = null } = STATE_CONSTRAINTS[effectiveConversationState] || {};
  const messageWordCount = (message || "").trim().split(/\s+/).filter(Boolean).length;
  const isInfoState = detectedState.startsWith("info_");
  const maxSentences = (!isInfoState && messageWordCount > 0 && messageWordCount <= 15 && baseMaxSentences !== null)
    ? Math.min(baseMaxSentences, 3)
    : baseMaxSentences;
  const userRegister = ["familier", "courant", "soutenu"].includes(userRegisterAnalysis?.userRegister)
    ? userRegisterAnalysis.userRegister
    : "courant";
  const formalAddress = (userRegisterAnalysis?.formalAddress === true) || previousFormalAddress === true;
  flagUpdates.formalAddress = formalAddress;
  const responseRegister = detectedState.startsWith("info_") ? "courant" : userRegister;
  const phraseLengthPolicy = responseRegister === "familier"
    ? "courte"
    : (["stabilization", "alliance_rupture", "closure", "discharge_dysregulated"].includes(effectiveConversationState) ? "courte" : "moyenne");
  // relancePolicy calculé après le bloc C3 pour refléter effectiveForbidden (voir ci-dessous)
  let somaticFocusPolicy = "none";
  if (detectedState === "exploration") {
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
    && (detectedState === "exploration" || detectedState.startsWith("discharge_"));

  const criticalGuardrails = [...theoreticalConstraints];
  if (humanFieldGuardActive) {
    criticalGuardrails.push("no_procedural_instrumental_reply");
  }

  // C3 — confiance contextuelle
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

  const interpretationRejectionModeActive = isRejection;

  const affiliationBuildingActive = detectedState === "exploration" && affiliationEstablished !== true;
  const previousBaseState = normalizedPreviousConversationState
    ? baseStateOf(normalizedPreviousConversationState)
    : null;
  const postDischargeTransitionActive = previousBaseState === "discharge"
    && baseState !== "discharge"
    && suicideLevel !== "N1"
    && suicideLevel !== "N2";

  // C3 — writerIntentHints initialization
  const writerIntentHints = [];

  // Construit une copie avant toute mutation pour éviter de polluer les constantes STATE_FORBIDDEN
  let effectiveForbidden = Array.from(forbidden);
  // Exception A — ne plus forcer un changement d'etat vers contact quand l'affiliation n'est
  // pas encore etablie. On garde l'exploration et on transmet une guidance writer explicite.
  if (affiliationBuildingActive) {
    writerIntentHints.push("affiliation_first_join");
  }

  const aggressiveDischargeDetected = dischargeAnalysis?.aggressiveDischargeDirectedToBot === true
    && baseStateOf(conversationState) === "discharge";
  if (aggressiveDischargeDetected) {
    writerIntentHints.push("aggressive_discharge_minimal_presence");
  }

  // C3 — atterrissage post-decharge (hors crise) quel que soit l'etat suivant.
  // Si retour en exploration, on force un tour plus contenu.
  if (postDischargeTransitionActive) {
    if (!effectiveForbidden.includes("relance")) effectiveForbidden.push("relance");
    writerIntentHints.push("post_discharge_soft_landing");

    if (baseState === "exploration") {
      finalDirectivityLevel = Math.min(finalDirectivityLevel, 2);
      finalExplorationSignal = "phenomenological_follow";
      flagUpdates.explorationCalibrationLevel = finalDirectivityLevel;
    }
  }

  if (detectedState === "exploration" && resolvedProcessingWindow === "narrowed") {
    writerIntentHints.push("attention_narrow_single_axis");
    intent = "suivre un seul axe sans ouvrir de nouveau chantier";
  }

  // C3 — règles dérivées des signaux Contact (Contact n'est plus un état)
  if (contactAnalysis?.selfCriticismLevel === "high") {
    if (!effectiveForbidden.includes("value_affirmation")) effectiveForbidden.push("value_affirmation");
    writerIntentHints.push("signify_pain_without_blocking", "auto_compassion_door_open");
  }

  if (contactAnalysis?.meaningCrisis === true) {
    if (!effectiveForbidden.includes("relance")) effectiveForbidden.push("relance");
    if (!effectiveForbidden.includes("interpretive_hypothesis")) effectiveForbidden.push("interpretive_hypothesis");
  }

  if (contactAnalysis?.insightMoment === true) {
    if (!effectiveForbidden.includes("relance")) effectiveForbidden.push("relance");
    writerIntentHints.push("amplify_insight");
  }

  // E4 — décentering émotionnel
  if (emotionalDecenteringAnalysis?.emotionalDecentering === true) {
    writerIntentHints.push("hold_emotional_thread", "auto_compassion_door_open");
  }

  // Calcul de relancePolicy après le bloc C3 pour prendre en compte effectiveForbidden
  let relancePolicy = "selective";
  if (effectiveForbidden.includes("relance")) {
    relancePolicy = "forbidden";
  } else if (detectedState === "exploration") {
    relancePolicy = finalDirectivityLevel >= 3 ? "discouraged" : (finalDirectivityLevel === 2 ? "selective" : "open");
  }

  // C3 — force direct address in exploration states to keep style continuity
  const useDirectAddress = conversationState === "exploration_open" || conversationState === "exploration_restrained";

  return {
    requestedBaseState: detectedState,
    finalDirectivityLevel,
    finalExplorationSignal,
    conversationState,
    consecutiveNonExplorationTurns,
    recallInjectionActive: isRecallAttempt === true,
    forbidden: effectiveForbidden,
    allowed,
    intent,
    relationalAdjustmentActive: relationalAdjustmentAnalysis?.needsRelationalAdjustment === true,
    relationalAdjustmentDepth: relationalAdjustmentAnalysis?.needsRelationalAdjustment === true
      ? (detectedState.startsWith("info_") ? "minimal" : "moderate")
      : null,
    preAdjustmentDirectivityLevel,
    flagUpdates,
    phraseLengthPolicy,
    relancePolicy,
    somaticFocusPolicy,
    actionCollapseGuardActive,
    theoreticalConstraints,
    criticalGuardrails,
    confidenceSignal,
    formalAddress,
    previousConversationState: normalizedPreviousConversationState,
    requestedConversationState,
    stateTransitionValid,
    interpretationRejectionModeActive,
    needsSoberReadjustment,
    underlyingPhenomenonRejected: rejectsUnderlyingPhenomenon,
    phenomenonAnchorInstruction: rejectsUnderlyingPhenomenon ? "from_observable" : "keep_if_concrete",
    tensionHoldLevel,
    psychoeducationType,
    infoContextFlags,
    humanFieldGuardActive,
    intent,
    writerIntentHints,
    aggressiveDischargeDetected,
    postDischargeTransitionActive,
    affiliationBuildingActive,
    useDirectAddress,
    dependencyRiskLevel,
    memoryPrioritySignal: interpretationRejectionModeActive
      ? "interpretation_rejected"
      : needsSoberReadjustment
      ? "relational_friction"
      : "normal",
    // Arbitrage par confiance + tie-break priorit\u00e9 s\u00e9mantique (plus haute confiance gagne).
    // Suppressions : d\u00e9charge agressive ; famille secondaire = base de l'\u00e9tat actif (redondance).
    secondaryTension: (() => {
      if (aggressiveDischargeDetected) return null;
      const convBase = baseStateOf(conversationState);
      const CONF_RANK = { high: 3, medium: 2, low: 1 };
      // Tie-break : urgence relationnelle > charge > stabilisation > questionnement > exploration
      const PRIORITY = { alliance_rupture: 5, discharge: 4, stabilization: 3, info: 2, exploration: 1 };

      const candidates = [];
      // C2 candidate (d\u00e9j\u00e0 filtr\u00e9 \u2265 medium par electActiveStateFromCandidates)
      if (secondaryTension && secondaryTension.family !== convBase) {
        candidates.push(secondaryTension);
      }
      // Structurel : alliance_rupture
      if (convBase !== "alliance_rupture") {
        if (resolvedAllianceState === "rupture") candidates.push({ family: "alliance_rupture", confidence: "high" });
        else if (resolvedAllianceState === "fragile") candidates.push({ family: "alliance_rupture", confidence: "medium" });
      }
      // Structurel : stabilization
      if (convBase !== "stabilization") {
        const isOverloaded = resolvedProcessingWindow === "overloaded";
        const isWithdrawn = resolvedEngagementLevel === "withdrawn";
        const stagnationHigh = resolvedStagnationTurns >= 2;
        const conds = [isOverloaded && isWithdrawn, isOverloaded && stagnationHigh, isWithdrawn && stagnationHigh].filter(Boolean).length;
        if (conds >= 1) candidates.push({ family: "stabilization", confidence: conds >= 2 ? "high" : "medium" });
      }

      if (candidates.length === 0) return null;
      // Tri : confiance d\u00e9croissante, \u00e9galit\u00e9 r\u00e9solue par priorit\u00e9 s\u00e9mantique
      candidates.sort((a, b) => {
        const confDiff = (CONF_RANK[b.confidence] || 0) - (CONF_RANK[a.confidence] || 0);
        if (confDiff !== 0) return confDiff;
        return (PRIORITY[b.family] || 0) - (PRIORITY[a.family] || 0);
      });
      return candidates[0];
    })()
  };
}

function buildDebug(
  detectedState,
  {
    suicideLevel = "N0",
    calledMemory = "none",
    interpretationRejection = false,
    needsSoberReadjustment = false,
    relationalAdjustmentTriggered = false,
    explorationCalibrationLevel = null,
    explorationDirectivityLevel = 0,
    explorationRelanceWindow = []
  } = {}
) {
  const lines = [];

  if (detectedState && detectedState.startsWith("info_")) lines.push("state: INFORMATION");

  if (detectedState === "info_pure") {
    lines.push("infoState: INFORMATION PURE");
  }
  if (detectedState === "info_psychoeducation") {
    lines.push("infoState: PSYCHOEDUCATION");
  }
  if (detectedState === "info_features") {
    lines.push("infoState: INFORMATION APP FEATURES");
  }
  if (detectedState === "discharge_regulated") {
    lines.push("dischargeState: DECHARGE REGULEE");
  }
  if (detectedState === "discharge_dysregulated") {
    lines.push("dischargeState: DECHARGE DEREGULEE");
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

  if (detectedState === "exploration") {
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
  detectedState = "exploration",
  relationalAdjustmentAnalysis = null,
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

  lines.push(`trace.detectedState: ${detectedState}`);
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
  lines.push(`trace.relationalAdjustmentTriggered: ${relationalAdjustmentAnalysis?.needsRelationalAdjustment === true ? "true" : "false"}`);
  lines.push(`trace.interpretationRejection: ${interpretationRejection?.isInterpretationRejection === true ? "true" : "false"}`);
  lines.push(`trace.previousWasDischarge: ${safeFlagsBefore.dischargeState?.wasDischarge === true ? "true" : "false"}`);
  lines.push(`trace.currentWasDischarge: ${safeFlagsAfter.dischargeState?.wasDischarge === true ? "true" : "false"}`);

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

// ─── electActiveStateFromCandidates ──────────────────────────────────────────
// C3 arbitrage : élit l'état actif unique depuis la liste de candidats C2.
// Priorité produit : discharge > info > exploration (invariant non-négociable).
// contactAnalysis est un overlay séparé — C3 décide s'il s'applique.
function electActiveStateFromCandidates(stateCandidates = [], contactAnalysis = { isContact: false }) {
  const safeContactAnalysis = contactAnalysis && typeof contactAnalysis === "object"
    ? contactAnalysis
    : { isContact: false };

  // Priorité 1 : décharge
  const discharge = stateCandidates.find(c => c && c.family === "discharge");
  if (discharge) {
    return {
      detectedState: discharge.detectedState || "discharge_regulated",
      dischargeAnalysis: { aggressiveDischargeDirectedToBot: discharge.aggressiveDischargeDirectedToBot === true },
      contactAnalysis: { isContact: false }, // contact supprimé pendant décharge
      infoSource: null,
      infoSignalSource: null,
      psychoeducationType: null,
      infoContextFlags: []
    };
  }

  // Priorité 2 : info
  const info = stateCandidates.find(c => c && c.family === "info");
  if (info) {
    return {
      detectedState: info.detectedState || "info_features",
      dischargeAnalysis: { aggressiveDischargeDirectedToBot: false },
      contactAnalysis: safeContactAnalysis,
      infoSource: info.infoSource || null,
      infoSignalSource: info.infoSignalSource || null,
      psychoeducationType: info.psychoeducationType || null,
      infoContextFlags: Array.isArray(info.infoContextFlags) ? info.infoContextFlags : []
    };
  }

  // Défaut : exploration
  const exploration = stateCandidates.find(c => c && c.family === "exploration");
  return {
    detectedState: "exploration",
    dischargeAnalysis: { aggressiveDischargeDirectedToBot: false },
    contactAnalysis: safeContactAnalysis,
    infoSource: (exploration && exploration.infoSource) || null,
    infoSignalSource: null,
    psychoeducationType: null,
    infoContextFlags: []
  };
}

module.exports = {
  buildAdvancedDebugTrace,
  buildDebug,
  buildPostureDecision,
  computeAffiliationTurnScore,
  computeAffiliationEstablished,
  electActiveStateFromCandidates,
  isConceptualInformationQuestion,
  normalizeGuardText,
  shouldForceExplorationForSituatedImpasse,
  shouldForceExplorationForTechnicalContext,
  STATE_CONSTRAINTS,
  STATE_FORBIDDEN,
  STATE_INTENT
};
