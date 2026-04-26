"use strict";

const { normalizeInfoSubmode } = require("./flags");

// ─── Canonical state list ─────────────────────────────────────────────────────
// Every valid conversationStateKey must appear here.
const CONVERSATION_STATES = [
  "exploration",
  "post_contact",
  "contact",
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
  exploration:     ["exploration", "contact", "post_contact", "info", "stabilization", "alliance_rupture", "closure"],
  post_contact:    ["exploration", "contact", "info", "stabilization", "alliance_rupture", "closure"],
  contact:         ["contact", "post_contact", "exploration", "info", "stabilization", "alliance_rupture", "closure"],
  info:            ["exploration", "contact", "info", "stabilization", "alliance_rupture", "closure"],
  stabilization:   ["stabilization", "exploration", "contact", "info", "alliance_rupture", "closure"],
  alliance_rupture:["exploration", "contact", "info", "stabilization", "alliance_rupture", "closure"],
  closure:         ["exploration", "contact", "info"]
};

// ─── Writer mode tables ───────────────────────────────────────────────────────
// These tables are state-bound data: what the writer is allowed or forbidden
// to do in each state. They live here because they describe state semantics,
// not generation logic.

const WRITER_MODE_FORBIDDEN = {
  exploration_open:      [],
  exploration_guided:    ["prescriptive_language"],
  post_contact:          ["relance", "interpretive_hypothesis"],
  stabilization:         ["open_question", "interpretive_hypothesis", "relance", "list"],
  alliance_rupture:      ["relance", "interpretive_hypothesis", "self_justification", "recap"],
  closure:               ["relance", "open_question"],
  contact_regulated:     ["interpretive_hypothesis"],
  contact_dysregulated:  ["interpretive_hypothesis", "open_question", "relance"],
  info_pure:             [],
  info_psychoeducation:  [],
  info_app_features:     [],
  n1_crisis:             ["interpretive_hypothesis", "relance", "open_question"],
  recall_memory:         []
};

const WRITER_MODE_ALLOWED = {
  exploration_open:      ["reflect", "open_question", "exploration_hypothesis"],
  exploration_guided:    ["reflect", "guided_question", "single_anchor_proposal"],
  post_contact:          ["contain", "short_reflection", "simple_presence"],
  stabilization:         ["contain", "short_reflection", "single_grounding_anchor"],
  alliance_rupture:      ["validate_misalignment", "short_repair", "simple_presence"],
  closure:               ["summarize_lightly", "acknowledge_closure", "simple_next_step"],
  contact_regulated:     ["contain", "reflect", "simple_presence"],
  contact_dysregulated:  ["contain", "co_regulation_short", "simple_presence"],
  info_pure:             ["inform", "define", "clarify"],
  info_psychoeducation:  ["inform", "psychoeducate", "link_to_user_context_lightly"],
  info_app_features:     ["inform", "procedural_explanation", "next_action_concrete"],
  n1_crisis:             ["clarify_risk", "contain", "simple_presence"],
  recall_memory:         ["recall_context", "synthesize_memory", "acknowledge_absence"]
};

const WRITER_MODE_INTENT = {
  exploration_open:      "explorer librement",
  exploration_guided:    "structurer doucement",
  post_contact:          "atterrir sobrement apres le contact",
  stabilization:         "reduire la charge cognitive",
  alliance_rupture:      "reparer l'alliance sans dramatiser",
  closure:               "accompagner la cloture",
  contact_regulated:     "contenir et rester present",
  contact_dysregulated:  "ancrer et tenir sans amplifier",
  info_pure:             "donner une explication descriptive directe sans recentrer sur l'app",
  info_psychoeducation:  "expliquer le positionnement et les mecanismes de l'approche au bon niveau de detail",
  info_app_features:     "decrire uniquement les usages et fonctionnalites reellement disponibles",
  n1_crisis:             "clarifier le risque calmement",
  recall_memory:         "rappeler honnêtement ce qui a été retenu"
};

const WRITER_MODE_CONSTRAINTS = {
  stabilization:         { maxSentences: 3, toneConstraint: "minimal" },
  alliance_rupture:      { maxSentences: 4, toneConstraint: "sober" },
  closure:               { maxSentences: 4, toneConstraint: "sober" },
  contact_dysregulated:  { maxSentences: 3, toneConstraint: "minimal" },
  n1_crisis:             { maxSentences: 1, toneConstraint: "contained" },
  recall_memory:         { maxSentences: 4, toneConstraint: "sober" }
};

// ─── State resolution ─────────────────────────────────────────────────────────
// Single deterministic function: analyzer signals → conversationStateKey.
// This is the explicit state machine transition function.
// Priority order: contact > post_contact > info > exploration, then Phase B overrides.
function resolveConversationState({
  detectedMode,
  contactAnalysis,
  previousConversationStateKey,
  allianceState = "good",
  engagementLevel = "active",
  stagnationTurns = 0,
  processingWindow = "open",
  closureIntent = false
}) {
  let state;

  // Priority 1: active contact overrides everything
  if (contactAnalysis.isContact === true) {
    state = "contact";

  // Priority 2: post-contact cooldown (previous turn was contact, now back to exploration)
  } else if (previousConversationStateKey === "contact" && detectedMode === "exploration") {
    state = "post_contact";

  // Priority 3: information mode
  } else if (detectedMode === "info") {
    state = "info";

  // Default: exploration
  } else {
    state = "exploration";
  }

  // Phase B structural overrides apply only to exploration-family states
  if (state === "exploration" || state === "post_contact") {
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

  // Closure applies to everything except active contact and alliance rupture
  if (closureIntent === true && state !== "contact" && state !== "alliance_rupture") {
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
    case "post_contact":      return "post_contact";
    case "contact":
      return contactSubmode === "dysregulated" ? "contact_dysregulated" : "contact_regulated";
    case "info": {
      const norm = normalizeInfoSubmode(infoSubmode);
      if (norm === "pure")           return "info_pure";
      if (norm === "psychoeducation") return "info_psychoeducation";
      return "info_app_features";
    }
    default:
      return directivityLevel >= 2 ? "exploration_guided" : "exploration_open";
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
