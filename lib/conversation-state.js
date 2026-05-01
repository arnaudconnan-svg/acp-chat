"use strict";

// ─── Canonical state list ─────────────────────────────────────────────────────
// 8 base states — used by the transition graph.
// Extended conversationState is returned by resolveConversationState.
// n1_crisis and n2_crisis are handled via early return in the pipeline but are
// included here for graph completeness and table alignment.
const CONVERSATION_STATES = [
  "exploration",
  "discharge",
  "info",
  "stabilization",
  "alliance_rupture",
  "closure",
  "n1_crisis",
  "n2_crisis"
];

// ─── baseStateOf ──────────────────────────────────────────────────────────────
// Extracts the 7-base-state from an extended 11-state conversationState.
// Used for transition graph lookups and state categorization.
function baseStateOf(state) {
  if (state === "exploration_open" || state === "exploration_restrained") return "exploration";
  if (state === "info_pure" || state === "info_features" || state === "info_psychoeducation") return "info";
  if (state === "discharge_regulated" || state === "discharge_dysregulated") return "discharge";
  return state; // stabilization, alliance_rupture, closure, n1_crisis, n2_crisis
}

// ─── Transition graph ─────────────────────────────────────────────────────────
// Defines which states can follow each state in the next turn.
// This replaces the implicit rule-set that was scattered across buildPostureDecision.
const STATE_TRANSITIONS = {
  // Self-transitions are valid for states that can persist across multiple turns.
  exploration:     ["exploration", "discharge", "info", "stabilization", "alliance_rupture", "closure"],
  discharge:       ["discharge", "exploration", "info", "stabilization", "alliance_rupture", "closure"],
  info:            ["exploration", "discharge", "info", "stabilization", "alliance_rupture", "closure"],
  stabilization:   ["stabilization", "exploration", "discharge", "info", "alliance_rupture", "closure"],
  alliance_rupture:["exploration", "discharge", "info", "stabilization", "alliance_rupture", "closure"],
  closure:         ["exploration", "discharge", "info"],
  // Crisis states — handled via early return in the pipeline; transitions are
  // informational and reflect post-crisis resolution paths.
  n1_crisis:       ["n1_crisis", "n2_crisis", "exploration", "closure"],
  n2_crisis:       ["n2_crisis", "n1_crisis", "exploration", "closure"]
};

// ─── State tables ─────────────────────────────────────────────────────────────
// State-bound data: what the writer is allowed or forbidden in each state.
// Keys are the extended 11-state conversationState values.

const STATE_FORBIDDEN = {
  exploration_open:      [],
  exploration_restrained: ["prescriptive_language"],
  stabilization:         ["open_question", "interpretive_hypothesis", "relance", "list"],
  alliance_rupture:      ["relance", "interpretive_hypothesis", "self_justification", "recap"],
  closure:               ["relance", "open_question"],
  discharge_regulated:   ["interpretive_hypothesis"],
  discharge_dysregulated:["interpretive_hypothesis", "open_question", "relance"],
  info_pure:             [],
  info_psychoeducation:  [],
  info_features:         [],
  n1_crisis:             ["interpretive_hypothesis", "relance", "open_question"],
  n2_crisis:             ["interpretive_hypothesis", "relance", "open_question", "exploration_hypothesis", "reflect"]
};

const STATE_ALLOWED = {
  exploration_open:      ["reflect", "open_question", "exploration_hypothesis"],
  exploration_restrained: ["reflect", "guided_question", "single_anchor_proposal"],
  stabilization:         ["contain", "short_reflection", "single_grounding_anchor"],
  alliance_rupture:      ["validate_misalignment", "short_repair", "simple_presence"],
  closure:               ["summarize_lightly", "acknowledge_closure", "simple_next_step"],
  discharge_regulated:   ["contain", "reflect", "simple_presence"],
  discharge_dysregulated:["contain", "co_regulation_short", "simple_presence"],
  info_pure:             ["inform", "define", "clarify"],
  info_psychoeducation:  ["inform", "psychoeducate", "link_to_user_context_lightly"],
  info_features:         ["inform", "procedural_explanation", "next_action_concrete"],
  n1_crisis:             ["clarify_risk", "contain", "simple_presence"],
  n2_crisis:             ["orient_to_safety", "simple_presence"]
};

const STATE_INTENT = {
  exploration_open:      "explorer librement",
  exploration_restrained: "structurer doucement",
  stabilization:         "reduire la charge cognitive",
  alliance_rupture:      "reparer l'alliance sans dramatiser",
  closure:               "accompagner la cloture",
  discharge_regulated:   "contenir et rester present",
  discharge_dysregulated:"ancrer et tenir sans amplifier",
  info_pure:             "donner une explication descriptive directe sans recentrer sur l'app",
  info_psychoeducation:  "expliquer le positionnement et les mecanismes de l'approche au bon niveau de detail",
  info_features:         "decrire uniquement les usages et fonctionnalites reellement disponibles",
  n1_crisis:             "clarifier le risque calmement",
  n2_crisis:             "orienter vers les ressources de crise"
};

const STATE_CONSTRAINTS = {
  exploration_open:       { maxSentences: 5, toneConstraint: null },
  exploration_restrained: { maxSentences: 4, toneConstraint: null },
  stabilization:          { maxSentences: 3, toneConstraint: "minimal" },
  alliance_rupture:       { maxSentences: 4, toneConstraint: "sober" },
  closure:                { maxSentences: 4, toneConstraint: "sober" },
  discharge_regulated:    { maxSentences: 2, toneConstraint: null },
  discharge_dysregulated: { maxSentences: 3, toneConstraint: "minimal" },
  n1_crisis:              { maxSentences: 1, toneConstraint: "contained" },
  n2_crisis:              { maxSentences: 3, toneConstraint: "contained" }
};

// ─── State resolution ─────────────────────────────────────────────────────────
// Single deterministic function: C2 detectedState + context → extended conversationState.
// Accepts the already-potentially-overridden detectedState (modeForStateResolution from pipeline).
// Priority order: discharge > post-discharge cooldown > info > exploration,
// then Phase B overrides (stabilization, alliance_rupture, closure).
// Returns one of the extended state values.
function resolveConversationState({
  detectedState,
  previousConversationState = null,
  directivityLevel = 0,
  allianceState = "good",
  engagementLevel = "active",
  stagnationTurns = 0,
  processingWindow = "open",
  closureIntent = false
}) {
  const prevBase = previousConversationState ? baseStateOf(previousConversationState) : null;
  let base;

  // Priority 1: active discharge overrides everything
  if (detectedState === "discharge_regulated" || detectedState === "discharge_dysregulated") {
    base = detectedState; // already the extended state

  // Priority 2: post-discharge cooldown (previous turn was discharge, current is not info)
  } else if (prevBase === "discharge" && !detectedState.startsWith("info_")) {
    base = "exploration";

  // Priority 3: information mode
  } else if (detectedState.startsWith("info_")) {
    base = detectedState; // already the extended state (info_pure, info_features, info_psychoeducation)

  // Default: exploration
  } else {
    base = "exploration";
  }

  // Phase B structural overrides apply only to exploration (not discharge or info)
  if (base === "exploration") {
    if (allianceState === "rupture") {
      base = "alliance_rupture";
    } else if (
      (processingWindow === "overloaded" && engagementLevel === "withdrawn") ||
      (processingWindow === "overloaded" && stagnationTurns >= 2) ||
      (engagementLevel === "withdrawn" && stagnationTurns >= 2)
    ) {
      base = "stabilization";
    }
  }

  // Closure applies to everything except active discharge and alliance rupture
  if (closureIntent === true && base !== "discharge_regulated" && base !== "discharge_dysregulated"
      && base !== "alliance_rupture") {
    base = "closure";
  }

  // Expand exploration to open/restrained based on directivity
  if (base === "exploration") {
    return directivityLevel >= 2 ? "exploration_restrained" : "exploration_open";
  }

  return base;
}

// ─── Transition guard ─────────────────────────────────────────────────────────
// Returns true if nextState is a documented valid successor of currentState.
// Accepts both 7-base-states and 11-extended-states (uses baseStateOf).
function isValidTransition(currentState, nextState) {
  const allowed = STATE_TRANSITIONS[baseStateOf(currentState)];
  if (!allowed) return true; // unknown state: let it pass
  return allowed.includes(baseStateOf(nextState));
}

module.exports = {
  CONVERSATION_STATES,
  STATE_TRANSITIONS,
  STATE_FORBIDDEN,
  STATE_ALLOWED,
  STATE_INTENT,
  STATE_CONSTRAINTS,
  baseStateOf,
  resolveConversationState,
  isValidTransition
};
