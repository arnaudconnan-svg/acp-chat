"use strict";

// ─── Chat routing priority table ─────────────────────────────────────────────
//
// Single declarative priority table for early /chat decision rules.
// Lower number = higher priority.
//
// Chaîne de priorité décisionnelle :
//  1. suicide_n2            — risque N2 → réponse de crise immédiate (override total)
//  2. acute_crisis_followup — crise aiguë en cours, non résolue → réponse de suivi de crise
//  3. suicide_clarification — risque N1 ou ambiguïté → clarification avant tout
//  4. recall_long_term      — rappel mémoire longue durée demandé → réponse de rappel
//  5. recall_none           — tentative de rappel sans mémoire disponible → réponse d'absence
//  6. (normal_flow)         — aucune règle prioritaire → pipeline complet (chemin par défaut)
//
// Les règles 1-3 sont résolues après analyse suicide (phase "post_suicide").
// Les règles 4-5 sont résolues après analyse recall  (phase "post_recall").
// La règle 6 n'apparaît pas dans la table ; c'est le chemin par défaut.

const CHAT_PRIORITY_RULES = Object.freeze([
  { id: "suicide_n2",            phase: "post_suicide", priority: 10 },
  { id: "acute_crisis_followup", phase: "post_suicide", priority: 20 },
  { id: "suicide_clarification", phase: "post_suicide", priority: 30 },
  { id: "recall_long_term",      phase: "post_recall",  priority: 10 },
  { id: "recall_none",           phase: "post_recall",  priority: 20 }
]);

const CHAT_PRIORITY_MATCHERS = Object.freeze({
  suicide_n2: ({ suicide }) => suicide?.suicideLevel === "N2",
  acute_crisis_followup: ({ suicide, flags }) => flags?.acuteCrisis === true && suicide?.crisisResolved !== true,
  suicide_clarification: ({ suicide }) => suicide?.suicideLevel === "N1" || suicide?.needsClarification === true,
  recall_long_term: ({ recallRouting }) => recallRouting?.isLongTermMemoryRecall === true,
  recall_none: ({ recallRouting }) => recallRouting?.isRecallAttempt === true && recallRouting?.calledMemory === "none"
});

function resolveChatPriorityRule({ phase, suicide = null, flags = null, recallRouting = null } = {}) {
  for (const rule of CHAT_PRIORITY_RULES) {
    if (rule.phase !== phase) {
      continue;
    }

    const matcher = CHAT_PRIORITY_MATCHERS[rule.id];
    if (typeof matcher !== "function") {
      continue;
    }

    if (matcher({ suicide, flags, recallRouting }) === true) {
      return rule;
    }
  }

  return null;
}

// ─── Crisis routing decision ──────────────────────────────────────────────────
//
// Fonction déterministe et testable qui encapsule la décision de routage crise/suicide.
// Retourne un objet { route, ruleId, priority } décrivant le chemin à prendre,
// ou { route: null } si aucune règle crise ne s'applique.
//
// route valeurs possibles :
//   "n2"               — risque N2 → réponse de crise immédiate
//   "acute_followup"   — crise aiguë non résolue → suivi de crise
//   "n1_clarification" — risque N1 ou ambiguïté → clarification
//   null               — chemin normal
//
// Peut être testée directement sans serveur.

const CRISIS_ROUTE_MAP = Object.freeze({
  suicide_n2:            "n2",
  acute_crisis_followup: "acute_followup",
  suicide_clarification: "n1_clarification"
});

function buildCrisisRoutingDecision(suicide, flags) {
  const rule = resolveChatPriorityRule({ phase: "post_suicide", suicide, flags });
  if (!rule) return { route: null, ruleId: null, priority: null };
  return {
    route:    CRISIS_ROUTE_MAP[rule.id] ?? null,
    ruleId:   rule.id,
    priority: rule.priority
  };
}

module.exports = {
  CHAT_PRIORITY_RULES,
  CHAT_PRIORITY_MATCHERS,
  resolveChatPriorityRule,
  buildCrisisRoutingDecision
};
