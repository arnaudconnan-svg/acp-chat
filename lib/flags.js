"use strict";

const RELANCE_WINDOW_SIZE = 4;
const AFFILIATION_WINDOW_SIZE = 4;
const STAGNATION_WINDOW_SIZE = 4;

function normalizeFlags(flags) {
  if (!flags || typeof flags !== "object") return {};
  if (Array.isArray(flags)) return {};
  return flags;
}

function clampExplorationDirectivityLevel(level) {
  const n = Number(level);
  if (!Number.isInteger(n)) return 0;
  return Math.max(0, Math.min(4, n));
}

function computeExplorationDirectivityLevel(relanceWindow = []) {
  const count = relanceWindow.filter(Boolean).length;
  return Math.max(0, Math.min(4, count));
}

function normalizeAffiliationWindow(windowValue) {
  if (!Array.isArray(windowValue)) return [0, 0, 0, 0];
  const nums = windowValue
    .filter(v => typeof v === "number" && isFinite(v))
    .slice(-AFFILIATION_WINDOW_SIZE);
  while (nums.length < AFFILIATION_WINDOW_SIZE) nums.unshift(0);
  return nums;
}

function normalizeExplorationRelanceWindow(windowValue) {
  if (!Array.isArray(windowValue)) return [];
  return windowValue
    .filter(v => typeof v === "boolean")
    .slice(-RELANCE_WINDOW_SIZE);
}

function normalizeDischargeState(dischargeState) {
  if (!dischargeState || typeof dischargeState !== "object" || Array.isArray(dischargeState)) {
    return { wasDischarge: false };
  }

  return {
    wasDischarge: dischargeState.wasDischarge === true
  };
}

// normalizeConversationState: validates and normalises the extended 11-state conversationState.
function normalizeConversationState(state) {
  const VALID_EXTENDED = [
    "exploration_open", "exploration_restrained",
    "discharge_regulated", "discharge_dysregulated",
    "info_pure", "info_features", "info_psychoeducation",
    "stabilization", "alliance_rupture", "closure",
    "n1_crisis", "n2_crisis"
  ];
  if (VALID_EXTENDED.includes(state)) return state;

  return "exploration_open";
}

function normalizeConsecutiveNonExplorationTurns(value) {
  if (!Number.isInteger(value) || value < 0) return 0;
  return value;
}

function normalizeAllianceState(value) {
  if (value === "good") return "good";
  if (value === "fragile") return "fragile";
  if (value === "rupture") return "rupture";
  return "good";
}

function normalizeEngagementLevel(value) {
  if (value === "active") return "active";
  if (value === "passive") return "passive";
  if (value === "withdrawn") return "withdrawn";
  return "active";
}

function normalizeStagnationTurns(value) {
  if (!Number.isInteger(value) || value < 0) return 0;
  return value;
}

function normalizeStagnationWindow(windowValue) {
  if (!Array.isArray(windowValue)) return [false, false, false, false];
  const bools = windowValue
    .filter(v => typeof v === "boolean")
    .slice(-STAGNATION_WINDOW_SIZE);
  while (bools.length < STAGNATION_WINDOW_SIZE) bools.unshift(false);
  return bools;
}

function normalizeAttentionWindow(value) {
  if (value === "open") return "open";
  if (value === "narrowed") return "narrowed";
  if (value === "overloaded") return "overloaded";
  return "open";
}

function clampDependencyRiskScore(value) {
  if (typeof value !== "number" || !isFinite(value)) return 0;
  return Math.max(0, Math.min(100, Math.round(value)));
}

function normalizeDependencyRiskLevel(value) {
  if (value === "low") return "low";
  if (value === "medium") return "medium";
  if (value === "high") return "high";
  return "low";
}

function normalizeExternalSupportMode(value) {
  if (value === "none") return "none";
  if (value === "discovery_validation") return "discovery_validation";
  if (value === "overreliance") return "overreliance";
  return "none";
}

function normalizeSessionFlags(flags) {
  const safe = normalizeFlags(flags);

  const hasExplicitRelanceWindow = Array.isArray(safe.explorationRelanceWindow);
  const hasExplicitDirectivityLevel = safe.explorationDirectivityLevel !== undefined;

  const bootstrapWindow = new Array(RELANCE_WINDOW_SIZE).fill(false);
  const explorationRelanceWindow = hasExplicitRelanceWindow
    ? normalizeExplorationRelanceWindow(safe.explorationRelanceWindow)
    : bootstrapWindow;

  const computedLevel = computeExplorationDirectivityLevel(explorationRelanceWindow);

  const explorationDirectivityLevel = hasExplicitDirectivityLevel
    ? clampExplorationDirectivityLevel(safe.explorationDirectivityLevel)
    : computedLevel;

  return {
    ...safe,
    acuteCrisis: safe.acuteCrisis === true,
    crisisFollowupTurnCount: Number.isInteger(safe.crisisFollowupTurnCount) && safe.crisisFollowupTurnCount >= 0 ? safe.crisisFollowupTurnCount : 0,
    postCrisisSupportCarryTurn: safe.postCrisisSupportCarryTurn === true,
    dischargeState: normalizeDischargeState(safe.dischargeState),
    explorationRelanceWindow,
    explorationDirectivityLevel,
    explorationCalibrationLevel: clampExplorationDirectivityLevel(safe.explorationCalibrationLevel),
    conversationState: normalizeConversationState(safe.conversationState),
    consecutiveNonExplorationTurns: normalizeConsecutiveNonExplorationTurns(safe.consecutiveNonExplorationTurns),
    allianceSignal: normalizeAllianceState(safe.allianceSignal),
    engagementLevel: normalizeEngagementLevel(safe.engagementLevel),
    stagnationTurns: normalizeStagnationTurns(safe.stagnationTurns),
    stagnationWindow: normalizeStagnationWindow(safe.stagnationWindow),
    attentionWindow: normalizeAttentionWindow(safe.attentionWindow),
    dependencyRiskScore: clampDependencyRiskScore(safe.dependencyRiskScore),
    dependencyRiskLevel: normalizeDependencyRiskLevel(safe.dependencyRiskLevel),
    isolationScore: clampDependencyRiskScore(safe.isolationScore),
    attachmentScore: clampDependencyRiskScore(safe.attachmentScore),
    dependencyAnalysisTurnsUntilRefresh: Number.isInteger(safe.dependencyAnalysisTurnsUntilRefresh) ? Math.max(0, safe.dependencyAnalysisTurnsUntilRefresh) : 0,
    dependencyCareTriggered: ['none', 'medium', 'high'].includes(safe.dependencyCareTriggered) ? safe.dependencyCareTriggered : 'none',
    dependencyCareMessagePending: ['medium', 'high'].includes(safe.dependencyCareMessagePending) ? safe.dependencyCareMessagePending : false,
    dependencyCareMessagePendingTurns: Number.isInteger(safe.dependencyCareMessagePendingTurns) ? Math.max(0, safe.dependencyCareMessagePendingTurns) : 0,
    externalSupportMode: normalizeExternalSupportMode(safe.externalSupportMode),
    closureIntent: safe.closureIntent === true,
    formalAddress: safe.formalAddress === true,
    affiliationWindow: normalizeAffiliationWindow(safe.affiliationWindow),
    affiliationAttachmentBoostStreak: Number.isInteger(safe.affiliationAttachmentBoostStreak) ? Math.max(0, safe.affiliationAttachmentBoostStreak) : 0,
    turnsUntilIntersessionRefresh: Number.isInteger(safe.turnsUntilIntersessionRefresh) ? Math.max(0, safe.turnsUntilIntersessionRefresh) : 0,
    attentionQualityTurnsUntilRefresh: Number.isInteger(safe.attentionQualityTurnsUntilRefresh) ? Math.max(0, safe.attentionQualityTurnsUntilRefresh) : 0,
    memoryUpdateTurnsUntilRefresh: Number.isInteger(safe.memoryUpdateTurnsUntilRefresh) ? Math.max(0, safe.memoryUpdateTurnsUntilRefresh) : 0
  };
}

function detectClosureIntent(message = "") {
  const text = String(message || "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[\u2019\u2018]/g, "'");
  const CLOSURE_PATTERNS = [
    /\bj'aimerais (m'arreter|qu'on s'arreter|s'arreter)\b/,
    /\bon (peut |va )?(s'arreter|s'arrete)\b/,
    /\bje (vais |voudrais )?(m'arreter|m'arrete)\b/,
    /\bc'est bon pour aujourd'hui\b/,
    /\bc'est tout pour aujourd'hui\b/,
    /\bje crois qu'on (peut |peut bien )?(s'arreter|s'arrete)\b/,
    /\bon s'arrete la\b/,
    /\bau revoir\b/,
    /\bbonne journee\b/,
    /\bbonne nuit\b/,
    /\bbonsoir\b/,
    /\ba bientot\b/,
    /\bmerci, c'est tout\b/,
    /\bc'est fini pour (moi|aujourd'hui)\b/,
    /\bje (te|vous) laisse\b/
  ];
  return CLOSURE_PATTERNS.some(p => p.test(text));
}

function registerExplorationRelance(flags, isRelance) {
  const safeFlags = normalizeSessionFlags(flags);
  const nextWindow = [...safeFlags.explorationRelanceWindow, isRelance === true].slice(-RELANCE_WINDOW_SIZE);

  return {
    ...safeFlags,
    explorationRelanceWindow: nextWindow,
    explorationDirectivityLevel: computeExplorationDirectivityLevel(nextWindow)
  };
}

function getExplorationStructureInstruction(
  explorationDirectivityLevel,
  promptRegistry
) {
  const safeLevel = clampExplorationDirectivityLevel(explorationDirectivityLevel);

  switch (safeLevel) {
    case 0:
      return String(promptRegistry.EXPLORATION_STRUCTURE_CASE_0 || "");
    case 1:
      return String(promptRegistry.EXPLORATION_STRUCTURE_CASE_1 || "");
    case 2:
      return String(promptRegistry.EXPLORATION_STRUCTURE_CASE_2 || "");
    case 3:
      return String(promptRegistry.EXPLORATION_STRUCTURE_CASE_3 || "");
    case 4:
      return String(promptRegistry.EXPLORATION_STRUCTURE_CASE_4 || "");
    default:
      return String(promptRegistry.EXPLORATION_STRUCTURE_CASE_0 || "");
  }
}

module.exports = {
  RELANCE_WINDOW_SIZE,
  AFFILIATION_WINDOW_SIZE,
  STAGNATION_WINDOW_SIZE,
  clampDependencyRiskScore,
  clampExplorationDirectivityLevel,
  computeExplorationDirectivityLevel,
  getExplorationStructureInstruction,
  normalizeAllianceState,
  normalizeAffiliationWindow,
  normalizeDischargeState,
  normalizeConversationState,
  normalizeConsecutiveNonExplorationTurns,
  normalizeDependencyRiskLevel,
  normalizeEngagementLevel,
  detectClosureIntent,
  normalizeExplorationRelanceWindow,
  normalizeExternalSupportMode,
  normalizeFlags,
  normalizeAttentionWindow,
  normalizeSessionFlags,
  normalizeStagnationTurns,
  normalizeStagnationWindow,
  registerExplorationRelance
};
