"use strict";

const RELANCE_WINDOW_SIZE = 4;
const CONTACT_SCORE_WINDOW_SIZE = 4;

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

function normalizeContactScoreWindow(windowValue) {
  if (!Array.isArray(windowValue)) return [0, 0, 0, 0];
  const nums = windowValue
    .filter(v => typeof v === "number" && isFinite(v))
    .slice(-CONTACT_SCORE_WINDOW_SIZE);
  while (nums.length < CONTACT_SCORE_WINDOW_SIZE) nums.unshift(0);
  return nums;
}

function normalizeEmotionSequenceStage(value) {
  const valid = ["global_distress", "secondary", "need_access", "primary_adaptive", "resolution"];
  return valid.includes(value) ? value : null;
}

function normalizeExplorationRelanceWindow(windowValue) {
  if (!Array.isArray(windowValue)) return [];
  return windowValue
    .filter(v => typeof v === "boolean")
    .slice(-RELANCE_WINDOW_SIZE);
}

function normalizeContactState(contactState) {
  if (!contactState || typeof contactState !== "object" || Array.isArray(contactState)) {
    return { wasContact: false };
  }

  return {
    wasContact: contactState.wasContact === true
  };
}

function normalizeInfoSubmode(infoSubmode) {
  if (infoSubmode === "pure") return "pure";
  if (infoSubmode === "psychoeducation") return "psychoeducation";
  if (infoSubmode === "app_theoretical_model") return "psychoeducation";
  if (infoSubmode === "app_features") return "app_features";
  if (infoSubmode === "app") return "app_features";
  return null;
}

function normalizeContactSubmode(contactSubmode) {
  if (contactSubmode === "regulated") return "regulated";
  if (contactSubmode === "dysregulated") return "dysregulated";
  return null;
}

function normalizeConversationStateKey(conversationStateKey) {
  if (conversationStateKey === "exploration") return "exploration";
  if (conversationStateKey === "info") return "info";
  if (conversationStateKey === "contact") return "contact";
  if (conversationStateKey === "post_contact") return "post_contact";
  if (conversationStateKey === "stabilization") return "stabilization";
  if (conversationStateKey === "alliance_rupture") return "alliance_rupture";
  if (conversationStateKey === "closure") return "closure";
  return "exploration";
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

function normalizeProcessingWindow(value) {
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
    contactState: normalizeContactState(safe.contactState),
    explorationRelanceWindow,
    explorationDirectivityLevel,
    infoSubmode: normalizeInfoSubmode(safe.infoSubmode),
    explorationCalibrationLevel: clampExplorationDirectivityLevel(safe.explorationCalibrationLevel),
    conversationStateKey: normalizeConversationStateKey(safe.conversationStateKey),
    consecutiveNonExplorationTurns: normalizeConsecutiveNonExplorationTurns(safe.consecutiveNonExplorationTurns),
    allianceState: normalizeAllianceState(safe.allianceState),
    engagementLevel: normalizeEngagementLevel(safe.engagementLevel),
    stagnationTurns: normalizeStagnationTurns(safe.stagnationTurns),
    processingWindow: normalizeProcessingWindow(safe.processingWindow),
    dependencyRiskScore: clampDependencyRiskScore(safe.dependencyRiskScore),
    dependencyRiskLevel: normalizeDependencyRiskLevel(safe.dependencyRiskLevel),
    externalSupportMode: normalizeExternalSupportMode(safe.externalSupportMode),
    closureIntent: safe.closureIntent === true,
    formalAddress: safe.formalAddress === true,
    contactScoreWindow: normalizeContactScoreWindow(safe.contactScoreWindow),
    emotionSequenceStage: normalizeEmotionSequenceStage(safe.emotionSequenceStage)
  };
}

function detectClosureIntent(message = "") {
  const text = String(message || "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  const CLOSURE_PATTERNS = [
    /\bj'aimerais (m'arreter|qu'on s'arrête|qu'on s'arreter|s'arreter)\b/,
    /\bon (peut |va )?(s'arreter|s'arrete|s'arrêter|s'arrête)\b/,
    /\bje (vais |voudrais )?(m'arreter|m'arrete|m'arrêter|m'arrête)\b/,
    /\bc'est bon pour aujourd'hui\b/,
    /\bc'est tout pour aujourd'hui\b/,
    /\bje crois qu'on (peut |peut bien )?(s'arreter|s'arrête|s'arrete)\b/,
    /\bon s'arrete la\b/,
    /\bau revoir\b/,
    /\bbonne journee\b/,
    /\bbonne nuit\b/,
    /\bbonsoir\b/,
    /\ba bientot\b/,
    /\bmerci, c'est tout\b/,
    /\bc'est fini pour (moi|aujourd'hui)\b/
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
  CONTACT_SCORE_WINDOW_SIZE,
  clampDependencyRiskScore,
  clampExplorationDirectivityLevel,
  computeExplorationDirectivityLevel,
  getExplorationStructureInstruction,
  normalizeAllianceState,
  normalizeContactScoreWindow,
  normalizeContactState,
  normalizeContactSubmode,
  normalizeConversationStateKey,
  normalizeConsecutiveNonExplorationTurns,
  normalizeDependencyRiskLevel,
  normalizeEmotionSequenceStage,
  normalizeEngagementLevel,
  detectClosureIntent,
  normalizeExplorationRelanceWindow,
  normalizeExternalSupportMode,
  normalizeFlags,
  normalizeInfoSubmode,
  normalizeProcessingWindow,
  normalizeSessionFlags,
  normalizeStagnationTurns,
  registerExplorationRelance
};
