"use strict";

const { normalizeInfoSubmode } = require("./flags");

// ─── Canonical state list ─────────────────────────────────────────────────────
// Every valid conversationStateKey must appear here.
const CONVERSATION_STATES = [
  "exploration",
  "contact",
  "discharge",
  "info",
  "stabilization",
  "alliance_rupture",
  "closure"
];

// ─── Transition graph ─────────────────────────────────────────────────────────
// Defines which states can follow each state in the next turn.
// This replaces the implicit rule-set that was scattered across buildPostureDecision.
const STATE_TRANSITIONS = {
  // Self-transitions are valid for states that can persist across multiple turns.
  exploration:     ["exploration", "discharge", "contact", "info", "stabilization", "alliance_rupture", "closure"],
  contact:         ["exploration", "discharge", "contact", "info", "stabilization", "alliance_rupture", "closure"],
  discharge:       ["discharge", "contact", "exploration", "info", "stabilization", "alliance_rupture", "closure"],
  info:            ["exploration", "discharge", "contact", "info", "stabilization", "alliance_rupture", "closure"],
  stabilization:   ["stabilization", "exploration", "discharge", "contact", "info", "alliance_rupture", "closure"],
  alliance_rupture:["exploration", "discharge", "contact", "info", "stabilization", "alliance_rupture", "closure"],
  closure:         ["exploration", "discharge", "contact", "info"]
};

// ─── Writer mode tables ───────────────────────────────────────────────────────
// These tables are state-bound data: what the writer is allowed or forbidden
// to do in each state. They live here because they describe state semantics,
// not generation logic.

const WRITER_MODE_FORBIDDEN = {
  exploration_open:      [],
  exploration_restrained: ["prescriptive_language"],
  contact:               ["interpretive_hypothesis"],
  stabilization:         ["open_question", "interpretive_hypothesis", "relance", "list"],
  alliance_rupture:      ["relance", "interpretive_hypothesis", "self_justification", "recap"],
  closure:               ["relance", "open_question"],
  discharge_regulated:   ["interpretive_hypothesis"],
  discharge_dysregulated:["interpretive_hypothesis", "open_question", "relance"],
  info_pure:             [],
  info_psychoeducation:  [],
  info_app_features:     [],
  n1_crisis:             ["interpretive_hypothesis", "relance", "open_question"]
};

const WRITER_MODE_ALLOWED = {
  exploration_open:      ["reflect", "open_question", "exploration_hypothesis"],
  exploration_restrained: ["reflect", "guided_question", "single_anchor_proposal"],
  contact:               ["contain", "short_reflection", "simple_presence"],
  stabilization:         ["contain", "short_reflection", "single_grounding_anchor"],
  alliance_rupture:      ["validate_misalignment", "short_repair", "simple_presence"],
  closure:               ["summarize_lightly", "acknowledge_closure", "simple_next_step"],
  discharge_regulated:   ["contain", "reflect", "simple_presence"],
  discharge_dysregulated:["contain", "co_regulation_short", "simple_presence"],
  info_pure:             ["inform", "define", "clarify"],
  info_psychoeducation:  ["inform", "psychoeducate", "link_to_user_context_lightly"],
  info_app_features:     ["inform", "procedural_explanation", "next_action_concrete"],
  n1_crisis:             ["clarify_risk", "contain", "simple_presence"]
};

const WRITER_MODE_INTENT = {
  exploration_open:      "explorer librement",
  exploration_restrained: "structurer doucement",
  contact:               "être présent à ce qui est là sans pousser",
  stabilization:         "reduire la charge cognitive",
  alliance_rupture:      "reparer l'alliance sans dramatiser",
  closure:               "accompagner la cloture",
  discharge_regulated:   "contenir et rester present",
  discharge_dysregulated:"ancrer et tenir sans amplifier",
  info_pure:             "donner une explication descriptive directe sans recentrer sur l'app",
  info_psychoeducation:  "expliquer le positionnement et les mecanismes de l'approche au bon niveau de detail",
  info_app_features:     "decrire uniquement les usages et fonctionnalites reellement disponibles",
  n1_crisis:             "clarifier le risque calmement"
};

const WRITER_MODE_CONSTRAINTS = {
  exploration_open:      { maxSentences: 5, toneConstraint: null },
  stabilization:         { maxSentences: 3, toneConstraint: "minimal" },
  alliance_rupture:      { maxSentences: 4, toneConstraint: "sober" },
  closure:               { maxSentences: 4, toneConstraint: "sober" },
  discharge_dysregulated:{ maxSentences: 3, toneConstraint: "minimal" },
  n1_crisis:             { maxSentences: 1, toneConstraint: "contained" }
};

// ─── State resolution ─────────────────────────────────────────────────────────
// Single deterministic function: analyzer signals → conversationStateKey.
// This is the explicit state machine transition function.
// Priority order: discharge > contact > info > exploration, then Phase B overrides.
function resolveConversationState({
  detectedMode,
  dischargeAnalysis,
  contactAnalysis,
  previousConversationStateKey,
  allianceState = "good",
  engagementLevel = "active",
  stagnationTurns = 0,
  processingWindow = "open",
  closureIntent = false
}) {
  let state;

  // Priority 1: active discharge overrides everything
  if (dischargeAnalysis?.isContact === true) {
    state = "discharge";

  // Priority 2: soft contact (auto-agacement, culpabilité douloureuse présente)
  } else if (contactAnalysis?.isContact === true) {
    state = "contact";

  // Priority 3: post-discharge cooldown (previous turn was discharge, current turn is not info)
  // NOTE: detectedMode here is modeForStateResolution from pipeline.js (may be overridden to
  // "contact" by E5 before resolveConversationState is called). Checking !== "info" ensures the
  // cooldown fires regardless of whether E5 has already overridden the mode.
  } else if (previousConversationStateKey === "discharge" && detectedMode !== "info") {
    state = "contact";

  // Priority 4: information mode
  } else if (detectedMode === "info") {
    state = "info";

  // Default: exploration
  } else {
    state = "exploration";
  }

  // Phase B structural overrides apply only to exploration-family states (not contact or discharge)
  if (state === "exploration") {
    if (allianceState === "rupture") {
      state = "alliance_rupture";
    } else if (
      (processingWindow === "overloaded" && engagementLevel === "withdrawn") ||
      (processingWindow === "overloaded" && stagnationTurns >= 2) ||
      (engagementLevel === "withdrawn" && stagnationTurns >= 2)
    ) {
      state = "stabilization";
    }
  }

  // Closure applies to everything except active discharge, alliance rupture, and active contact
  if (closureIntent === true && state !== "discharge" && state !== "alliance_rupture" && state !== "contact") {
    state = "closure";
  }

  return state;
}

// ─── WriterMode derivation ────────────────────────────────────────────────────
// Maps a resolved conversationStateKey + contextual signals → writerMode string.
// The writerMode then indexes into the WRITER_MODE_* tables above.
function stateToWriterMode(conversationStateKey, {
  contactSubmode = null,
  infoSubmode = null,
  directivityLevel = 0
} = {}) {
  switch (conversationStateKey) {
    case "alliance_rupture":  return "alliance_rupture";
    case "stabilization":     return "stabilization";
    case "closure":           return "closure";
    case "contact":           return "contact";
    case "discharge":
      return contactSubmode === "dysregulated" ? "discharge_dysregulated" : "discharge_regulated";
    case "info": {
      const norm = normalizeInfoSubmode(infoSubmode);
      if (norm === "pure")           return "info_pure";
      if (norm === "psychoeducation") return "info_psychoeducation";
      return "info_app_features";
    }
    default:
      return directivityLevel >= 2 ? "exploration_restrained" : "exploration_open";
  }
}

// ─── Transition guard ─────────────────────────────────────────────────────────
// Returns true if nextState is a documented valid successor of currentState.
// Enforced at runtime in buildPostureDecision: invalid transitions fall back to
// the previous state. Also used in harness assertions and warning logs.
function isValidTransition(currentState, nextState) {
  const allowed = STATE_TRANSITIONS[currentState];
  if (!allowed) return true; // unknown state: let it pass
  return allowed.includes(nextState);
}

module.exports = {
  CONVERSATION_STATES,
  STATE_TRANSITIONS,
  WRITER_MODE_FORBIDDEN,
  WRITER_MODE_ALLOWED,
  WRITER_MODE_INTENT,
  WRITER_MODE_CONSTRAINTS,
  resolveConversationState,
  stateToWriterMode,
  isValidTransition
};
