'use strict';

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
  normalizeAttentionWindow
} = require('./flags');

// ─── detectMemoryReactivationInState ───────────────────────────────────────────
// Detect if memoryState has ongoing movements that overlap with ancient movements.
// Returns { triggered: boolean, overlappingItems: [] }
function detectMemoryReactivationInState(memoryState = null) {
  if (!memoryState || typeof memoryState !== 'object') {
    return { triggered: false, overlappingItems: [] };
  }
  const onGoing = Array.isArray(memoryState.onGoingMovements)
    ? memoryState.onGoingMovements
        .map((item) =>
          item && typeof item === 'object'
            ? String(item.text || '').trim()
            : null
        )
        .filter(Boolean)
    : [];
  const ancient = Array.isArray(memoryState.ancientMovements)
    ? memoryState.ancientMovements
        .map((item) =>
          item && typeof item === 'object'
            ? String(item.text || '').trim()
            : null
        )
        .filter(Boolean)
    : [];

  if (onGoing.length === 0 || ancient.length === 0) {
    return { triggered: false, overlappingItems: [] };
  }

  const ancientSet = new Set(ancient);
  const overlappingItems = onGoing
    .filter((text) => ancientSet.has(text))
    .slice(0, 3);

  return {
    triggered: overlappingItems.length > 0,
    overlappingItems: overlappingItems
  };
}

// ─── buildTopChips ────────────────────────────────────────────────────────────
// Returns the array of display chips shown in the admin UI and debugMeta.
// Priority: N2 > N1 > mode chip, then optional annotation chips.
// Also exposes harmRiskLevel in the returned object for debug visibility.
function buildTopChips({
  suicideLevel = 'N0',
  majorHarmRiskLevel = 'H0',
  majorHarmImminenceBand = 'none',
  conversationState = null,
  explorationSignal = null,
  interpretationRejection = false,
  isRecallRequest = false,
  needsSoberReadjustment = false,
  relationalAdjustmentActive = false,
  infoContextFlags = []
} = {}) {
  const chips = [];

  function buildExplorationSignalChipLabel(signal = null) {
    if (signal === 'interpretation') return 'EXPLORATION : interprétation';
    if (signal === 'phenomenological_follow')
      return 'EXPLORATION : accompagnement';
    return 'EXPLORATION';
  }

  if (majorHarmRiskLevel === 'H2') {
    chips.push(
      majorHarmImminenceBand === 'immediate'
        ? 'RISQUE MAJEUR IMMEDIAT'
        : 'RISQUE MAJEUR PROCHE'
    );
  } else if (suicideLevel === 'N2') {
    chips.push('URGENCE : risque suicidaire');
  } else if (suicideLevel === 'N1') {
    chips.push('Risque suicidaire à clarifier');
  } else if (
    conversationState === 'exploration_open' ||
    conversationState === 'exploration_restrained'
  ) {
    chips.push(buildExplorationSignalChipLabel(explorationSignal));
  } else if (conversationState && conversationState.startsWith('info_')) {
    chips.push(
      conversationState === 'info_psychoeducation'
        ? 'PSYCHOEDUCATION'
        : conversationState === 'info_features'
          ? Array.isArray(infoContextFlags) &&
            infoContextFlags.includes('bot_nature_question')
            ? 'INFO APP : nature du bot'
            : Array.isArray(infoContextFlags) &&
                infoContextFlags.includes('bot_capacity_doubt')
              ? 'INFO APP : capacité du bot'
              : 'INFO APP : fonctionnalités'
          : conversationState === 'info_pure'
            ? 'INFO PURE'
            : 'INFO'
    );
  } else if (conversationState === 'discharge_dysregulated') {
    chips.push('DECHARGE : dérégulée');
  } else if (conversationState === 'discharge_regulated') {
    chips.push('DECHARGE : régulée');
  }

  if (interpretationRejection === true) {
    chips.push("Rejet d'interprétation");
  }
  if (isRecallRequest === true) {
    chips.push('Demande de rappel mémoire');
  }
  if (needsSoberReadjustment === true) {
    chips.push('Réajustement sobre');
  }
  if (relationalAdjustmentActive === true) {
    chips.push('Ajustement relationnel');
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
  explorationRelanceWindow = [],
  directivityInputLevel = null,
  directivityUsedLevel = null,
  directivityNextLevel = null,
  directivityNextWindow = [],
  relanceAsyncStatus = null,
  relanceAppliedAtTurnEntrySourceTurn = null,
  relanceAppliedAtTurnEntryStatus = null,
  relanceAsyncTargetTurn = null
} = {}) {
  if (!conversationState || !conversationState.startsWith('exploration_'))
    return '';

  const safeWindow = normalizeExplorationRelanceWindow(
    Array.isArray(directivityNextWindow) && directivityNextWindow.length > 0
      ? directivityNextWindow
      : explorationRelanceWindow
  );
  const safeNextLevel = clampExplorationDirectivityLevel(
    directivityNextLevel !== null && directivityNextLevel !== undefined
      ? directivityNextLevel
      : explorationDirectivityLevel
  );
  const safeInputLevel =
    directivityInputLevel !== null && directivityInputLevel !== undefined
      ? clampExplorationDirectivityLevel(directivityInputLevel)
      : null;
  const safeUsedLevel =
    directivityUsedLevel !== null && directivityUsedLevel !== undefined
      ? clampExplorationDirectivityLevel(directivityUsedLevel)
      : null;
  const safeRetainedLevel =
    explorationCalibrationLevel !== null &&
    explorationCalibrationLevel !== undefined
      ? clampExplorationDirectivityLevel(explorationCalibrationLevel)
      : null;

  if (
    safeRetainedLevel === null &&
    safeInputLevel === null &&
    safeUsedLevel === null &&
    safeNextLevel <= 0
  ) {
    return '';
  }

  function translateRelanceAsyncStatus(value) {
    if (value === 'pending') return 'en attente pour N+1';
    if (value === 'applied_at_entry') return 'applique en entree de tour';
    if (value === 'applied_at_entry_and_pending')
      return 'applique en entree de tour, nouveau calcul en attente';
    if (value === 'ready_for_next_turn')
      return 'prepare pour le prochain tour';
    if (value === 'applied_at_entry_and_ready_for_next')
      return 'applique en entree de tour, prochain tour deja prepare';
    if (value === 'not_requested') return 'non demande sur ce tour';
    return null;
  }

  const relanceStatusLabel = translateRelanceAsyncStatus(relanceAsyncStatus);
  const nextWindowPending =
    relanceAsyncStatus === 'pending' ||
    relanceAsyncStatus === 'applied_at_entry_and_pending';
  const nextWindowText = nextWindowPending
    ? 'Fenêtre de relance préparée (tour suivant) : calcul en cours'
    : `Fenêtre de relance préparée (tour suivant) : [${safeWindow.map((v) => (v ? '1' : '0')).join('-')}]`;

  const nextLevelText = nextWindowPending
    ? null
    : `Niveau de directivité préparé : ${safeNextLevel}/4`;

  return [
    safeRetainedLevel !== null
      ? `Niveau de structuration retenu : ${safeRetainedLevel}/4`
      : null,
    safeInputLevel !== null
      ? `Niveau de directivité hérité : ${safeInputLevel}/4`
      : null,
    safeUsedLevel !== null
      ? `Niveau de directivité utilisé : ${safeUsedLevel}/4`
      : null,
    nextLevelText,
    nextWindowText,
    relanceStatusLabel ? `Statut calcul relance : ${relanceStatusLabel}` : null
  ]
    .filter(Boolean)
    .join('\n');
}

function normalizeSecondaryTension(value) {
  if (!value || typeof value !== 'object') {
    return null;
  }

  const rawFamily = String(value.family || '')
    .trim()
    .toLowerCase();
  const canonicalFamily = rawFamily
    .replace(/[\s-]+/g, '_')
    .replace(/[^a-z0-9_]/g, '');

  const FAMILY_ALIASES = {
    discharge: 'discharge',
    decharge: 'discharge',
    emotional_discharge: 'discharge',
    info: 'info',
    information: 'info',
    informational: 'info',
    exploration: 'exploration',
    alliance_rupture: 'alliance_rupture',
    alliancerupture: 'alliance_rupture',
    rupture_alliance: 'alliance_rupture',
    relational_rupture: 'alliance_rupture',
    relationalrupture: 'alliance_rupture',
    relational_friction: 'alliance_rupture',
    friction_relationnelle: 'alliance_rupture',
    frictionrelationnelle: 'alliance_rupture'
  };

  const family = FAMILY_ALIASES[canonicalFamily] || null;
  if (!family) {
    return null;
  }

  const rawConfidence = String(value.confidence || '')
    .trim()
    .toLowerCase();
  const canonicalConfidence = rawConfidence
    .replace(/[\s-]+/g, '_')
    .replace(/[^a-z0-9_]/g, '');

  const CONFIDENCE_ALIASES = {
    high: 'high',
    highest: 'high',
    strong: 'high',
    fort: 'high',
    medium: 'medium',
    med: 'medium',
    moderate: 'medium',
    moyen: 'medium',
    moyenne: 'medium',
    low: 'low',
    weak: 'low',
    faible: 'low'
  };

  const confidence = CONFIDENCE_ALIASES[canonicalConfidence] || 'low';
  const detectedState =
    typeof value.detectedState === 'string' ? value.detectedState : null;
  const infoSource =
    typeof value.infoSource === 'string' ? value.infoSource : null;
  const infoContextFlags = Array.isArray(value.infoContextFlags)
    ? value.infoContextFlags.filter((flag) => typeof flag === 'string')
    : [];
  return { family, confidence, detectedState, infoSource, infoContextFlags };
}

function normalizeUncertaintyExpressionPolicy(value) {
  return value === 'explicit' ? 'explicit' : 'none';
}

function normalizeUncertaintyDrivers(value) {
  if (!Array.isArray(value)) {
    return [];
  }
  const allowed = new Set([
    'explicit_ambiguity',
    'recent_rejection',
    'short_context'
  ]);
  return value.filter((v) => typeof v === 'string' && allowed.has(v));
}

function normalizeMemoryState(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }

  const sessionStableContext = Array.isArray(value.sessionStableContext)
    ? value.sessionStableContext
        .map((item) => String(item || '').trim())
        .filter(Boolean)
    : [];

  function normalizeMovementList(list) {
    if (!Array.isArray(list)) return [];
    return list
      .map((item) => {
        if (!item || typeof item !== 'object' || Array.isArray(item))
          return null;
        const id = String(item.id || '').trim();
        const text = typeof item.text === 'string' ? item.text.trim() : '';
        if (!id && !text) return null;
        return {
          id,
          text,
          createdAt: typeof item.createdAt === 'string' ? item.createdAt : null,
          archivedAt:
            typeof item.archivedAt === 'string' ? item.archivedAt : null
        };
      })
      .filter(Boolean);
  }

  const onGoingMovements = normalizeMovementList(value.onGoingMovements).slice(
    0,
    2
  );
  const ancientMovements = normalizeMovementList(value.ancientMovements);

  return {
    sessionStableContext,
    onGoingMovements,
    ancientMovements
  };
}

// ─── buildResponseDebugMeta ───────────────────────────────────────────────────
// Builds the full V3 debugMeta object returned with every /chat response.
//
// Parameters that were previously captured from the handler closure are now
// explicit: pipelineStages, traceId, normalizeMemory (injected).
function buildResponseDebugMeta({
  // Core inputs
  memory = '',
  suicideLevel = 'N0',
  majorHarmRiskLevel = 'H0',
  majorHarmImminenceBand = 'none',
  majorHarmTargetsPeople = false,
  conversationState = 'exploration_open',
  effectiveConversationState = null,
  consecutiveNonExplorationTurns = 0,
  interpretationRejection = false,
  needsSoberReadjustment = false,
  relationalAdjustmentActive = false,
  isRecallRequest = false,
  explorationCalibrationLevel = null,
  explorationDirectivityLevel = 0,
  explorationRelanceWindow = [],
  directivityInputLevel = null,
  directivityUsedLevel = null,
  directivityNextLevel = null,
  directivityNextWindow = [],
  relanceAsyncStatus = null,
  relanceAppliedAtTurnEntrySourceTurn = null,
  relanceAppliedAtTurnEntryStatus = null,
  relanceAsyncTargetTurn = null,
  explorationSignal = null,
  memoryBeforeSanitization = null,
  memoryAncientCleanupDeletedIds = [],
  memoryState = null,
  intersessionMemoryRuntime = null,
  analyzerDeterministicEvidence = [],
  // Posture contract (V3)
  intent = null,
  forbidden = [],
  confidenceSignal = 1.0,
  uncertaintyExpressionPolicy = 'none',
  uncertaintyDrivers = [],
  responseRegister = 'courant',
  relancePolicy = 'selective',
  useDirectAddress = false,
  actionCollapseGuardActive = false,
  stateTransitionFrom = null,
  stateTransitionValid = true,
  stateTransitionRequested = null,
  // Phase B structural flags
  allianceSignal = 'good',
  engagementLevel = 'active',
  attentionWindow = 'open',
  dependencyRiskScore = 0,
  dependencyRiskLevel = 'low',
  isolationScore = 0,
  attachmentScore = 0,
  dependencyCareMessagePending = false,
  externalSupportMode = 'none',
  closureIntent = false,
  // Info routing observability
  infoRoutingSource = null,
  infoContextFlags = [],
  // Lot 8 fields
  affiliationScore = null,
  affiliationFinalScore = null,
  affiliationWindow = [],
  affiliationEstablished = false,
  emotionalDecentering = false,
  formalAddress = false,
  // Writer hints from posture decision
  writerIntentHints = [],
  writerIntentHintsInactive = [],
  // Contact analyzer sub-fields
  contactInsightMoment = false,
  contactSelfCriticismLevel = 'low',
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
  requestId = null,
  traceId = null,
  normalizeMemory = (m) => String(m || '').trim()
} = {}) {
  return {
    topChips: buildTopChips({
      suicideLevel,
      majorHarmRiskLevel,
      majorHarmImminenceBand,
      conversationState,
      explorationSignal,
      interpretationRejection,
      isRecallRequest,
      needsSoberReadjustment,
      relationalAdjustmentActive,
      infoContextFlags
    }),
    memory: normalizeMemory(memory),
    directivityText: buildDirectivityText({
      conversationState,
      explorationCalibrationLevel,
      explorationDirectivityLevel,
      explorationRelanceWindow,
      directivityInputLevel,
      directivityUsedLevel,
      directivityNextLevel,
      directivityNextWindow,
      relanceAsyncStatus,
      relanceAppliedAtTurnEntrySourceTurn,
      relanceAppliedAtTurnEntryStatus,
      relanceAsyncTargetTurn
    }),
    conversationState: normalizeConversationState(conversationState),
    effectiveConversationState:
      typeof effectiveConversationState === 'string'
        ? normalizeConversationState(effectiveConversationState)
        : normalizeConversationState(conversationState),
    consecutiveNonExplorationTurns: normalizeConsecutiveNonExplorationTurns(
      consecutiveNonExplorationTurns
    ),
    interpretationRejection: interpretationRejection === true,
    needsSoberReadjustment: needsSoberReadjustment === true,
    relationalAdjustmentActive: relationalAdjustmentActive === true,
    pipelineStages: Array.isArray(pipelineStages)
      ? pipelineStages
          .map((entry) => ({
            stage: typeof entry?.stage === 'string' ? entry.stage : null,
            deltaMs: Number.isFinite(entry?.deltaMs) ? entry.deltaMs : null
          }))
          .filter((entry) => entry.stage)
      : [],
    explorationCalibrationLevel:
      explorationCalibrationLevel !== null &&
      explorationCalibrationLevel !== undefined
        ? clampExplorationDirectivityLevel(explorationCalibrationLevel)
        : null,
    directivityInputLevel:
      directivityInputLevel !== null && directivityInputLevel !== undefined
        ? clampExplorationDirectivityLevel(directivityInputLevel)
        : null,
    directivityUsedLevel:
      directivityUsedLevel !== null && directivityUsedLevel !== undefined
        ? clampExplorationDirectivityLevel(directivityUsedLevel)
        : null,
    directivityNextLevel:
      directivityNextLevel !== null && directivityNextLevel !== undefined
        ? clampExplorationDirectivityLevel(directivityNextLevel)
        : null,
    directivityNextWindow: normalizeExplorationRelanceWindow(
      directivityNextWindow
    ),
    relanceAsyncStatus:
      typeof relanceAsyncStatus === 'string' ? relanceAsyncStatus : null,
    relanceAppliedAtTurnEntrySourceTurn: Number.isInteger(
      relanceAppliedAtTurnEntrySourceTurn
    )
      ? relanceAppliedAtTurnEntrySourceTurn
      : null,
    relanceAppliedAtTurnEntryStatus:
      typeof relanceAppliedAtTurnEntryStatus === 'string'
        ? relanceAppliedAtTurnEntryStatus
        : null,
    relanceAsyncTargetTurn: Number.isInteger(relanceAsyncTargetTurn)
      ? relanceAsyncTargetTurn
      : null,
    explorationSignal:
      (conversationState === 'exploration_open' ||
        conversationState === 'exploration_restrained') &&
      typeof explorationSignal === 'string'
        ? explorationSignal
        : null,
    memoryState: normalizeMemoryState(memoryState),
    intersessionMemoryRuntime:
      typeof intersessionMemoryRuntime === 'string' &&
      intersessionMemoryRuntime.trim().length > 0
        ? intersessionMemoryRuntime.trim()
        : null,
    memoryBeforeSanitization:
      typeof memoryBeforeSanitization === 'string' &&
      memoryBeforeSanitization.length > 0
        ? normalizeMemory(memoryBeforeSanitization)
        : null,
    memoryAncientCleanupDeletedIds: Array.isArray(
      memoryAncientCleanupDeletedIds
    )
      ? memoryAncientCleanupDeletedIds
          .map((id) => String(id || '').trim())
          .filter(Boolean)
      : [],
    analyzerDeterministicEvidence: Array.isArray(analyzerDeterministicEvidence)
      ? analyzerDeterministicEvidence.filter((i) => typeof i === 'string')
      : [],
    // Posture contract (V3)
    intent: typeof intent === 'string' ? intent : null,
    forbidden: Array.isArray(forbidden) ? forbidden : [],
    confidenceSignal:
      typeof confidenceSignal === 'number' ? confidenceSignal : 1.0,
    uncertaintyExpressionPolicy: normalizeUncertaintyExpressionPolicy(
      uncertaintyExpressionPolicy
    ),
    uncertaintyDrivers: normalizeUncertaintyDrivers(uncertaintyDrivers),
    responseRegister:
      typeof responseRegister === 'string' ? responseRegister : 'courant',
    relancePolicy:
      typeof relancePolicy === 'string' ? relancePolicy : 'selective',
    useDirectAddress: useDirectAddress === true,
    actionCollapseGuardActive: actionCollapseGuardActive === true,
    stateTransitionFrom:
      typeof stateTransitionFrom === 'string' ? stateTransitionFrom : null,
    stateTransitionValid: stateTransitionValid !== false,
    stateTransitionRequested:
      typeof stateTransitionRequested === 'string'
        ? stateTransitionRequested
        : null,
    // Phase B structural flags
    allianceSignal: normalizeAllianceState(allianceSignal),
    engagementLevel: normalizeEngagementLevel(engagementLevel),
    attentionWindow: normalizeAttentionWindow(attentionWindow),
    dependencyRiskScore: clampDependencyRiskScore(dependencyRiskScore),
    dependencyRiskLevel: normalizeDependencyRiskLevel(dependencyRiskLevel),
    isolationScore: clampDependencyRiskScore(isolationScore),
    attachmentScore: clampDependencyRiskScore(attachmentScore),
    dependencyCareMessagePending: ['medium', 'high'].includes(
      dependencyCareMessagePending
    )
      ? dependencyCareMessagePending
      : false,
    externalSupportMode: normalizeExternalSupportMode(externalSupportMode),
    closureIntent: closureIntent === true,
    infoRoutingSource:
      typeof infoRoutingSource === 'string' ? infoRoutingSource : null,
    // Lot 8 fields
    affiliationScore:
      typeof affiliationScore === 'number'
        ? Math.round(affiliationScore * 100) / 100
        : null,
    affiliationFinalScore:
      typeof affiliationFinalScore === 'number'
        ? Math.round(affiliationFinalScore * 100) / 100
        : null,
    affiliationWindow: Array.isArray(affiliationWindow)
      ? affiliationWindow.map((v) =>
          typeof v === 'number' ? Math.round(v * 100) / 100 : 0
        )
      : [],
    affiliationEstablished: affiliationEstablished === true,
    emotionalDecentering: emotionalDecentering === true,
    formalAddress: formalAddress === true,
    // Writer hints from posture decision
    writerIntentHints: Array.isArray(writerIntentHints)
      ? writerIntentHints
      : [],
    writerIntentHintsInactive: Array.isArray(writerIntentHintsInactive)
      ? writerIntentHintsInactive
          .map((entry) => {
            if (!entry || typeof entry !== 'object') return null;
            const hint = String(entry.hint || '').trim();
            const reason = String(entry.reason || '').trim();
            return hint && reason ? { hint, reason } : null;
          })
          .filter(Boolean)
      : [],
    memoryReactivationGuardTriggered: (() => {
      const reactivation = detectMemoryReactivationInState(memoryState);
      return reactivation.triggered;
    })(),
    memoryReactivationGuardItems: (() => {
      const reactivation = detectMemoryReactivationInState(memoryState);
      return reactivation.overlappingItems;
    })(),
    // Contact analyzer sub-fields
    contactInsightMoment: contactInsightMoment === true,
    contactSelfCriticismLevel:
      typeof contactSelfCriticismLevel === 'string'
        ? contactSelfCriticismLevel
        : 'low',
    // C3 limiting_belief gate (affiché uniquement si true)
    aggressiveDischargeDetected: aggressiveDischargeDetected === true,
    postDischargeTransitionActive: postDischargeTransitionActive === true,
    // Crisis sequence observability
    n2TurnType: typeof n2TurnType === 'string' ? n2TurnType : null,
    emergencyNumbersIncluded: emergencyNumbersIncluded === true,
    postCrisisSupportActive: postCrisisSupportActive === true,
    postCrisisSupportCarryTurn: postCrisisSupportCarryTurn === true,
    emergencySupportText:
      typeof emergencySupportText === 'string' ? emergencySupportText : null,
    requestId: typeof requestId === 'string' ? requestId : null,
    traceId: typeof traceId === 'string' ? traceId : null,
    // Tension secondaire
    secondaryTension: normalizeSecondaryTension(secondaryTension)
      ? normalizeSecondaryTension(secondaryTension)
      : null,
    majorHarmRiskLevel:
      majorHarmRiskLevel === 'H1' || majorHarmRiskLevel === 'H2'
        ? majorHarmRiskLevel
        : 'H0',
    majorHarmImminenceBand: [
      'none',
      'immediate',
      'short_term',
      'capability_opportunity'
    ].includes(majorHarmImminenceBand)
      ? majorHarmImminenceBand
      : 'none',
    majorHarmTargetsPeople: majorHarmTargetsPeople === true
  };
}

module.exports = {
  buildTopChips,
  buildDirectivityText,
  buildResponseDebugMeta,
  detectMemoryReactivationInState
};
