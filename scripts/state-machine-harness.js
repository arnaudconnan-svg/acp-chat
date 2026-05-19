"use strict";

// ─── Pure deterministic harness — no server required ─────────────────────────
// Tests the explicit state machine defined in lib/conversation-state.js:
// - STATE_TRANSITIONS: coverage and known valid/invalid edges
// - resolveConversationState: priority ordering
// - baseStateOf: mapping correctness
// - isValidTransition: guard accuracy

const {
  CONVERSATION_STATES,
  STATE_TRANSITIONS,
  STATE_FORBIDDEN,
  STATE_INTENT,
  STATE_CONSTRAINTS,
  resolveConversationState,
  baseStateOf,
  isValidTransition
} = require("../lib/conversation-state");

let passed = 0;
let failed = 0;

function assert(condition, label, detail = "") {
  if (condition) {
    console.log(`[PASS] ${label}`);
    passed++;
  } else {
    console.error(`[FAIL] ${label}${detail ? ": " + detail : ""}`);
    failed++;
  }
}

function resolve(overrides = {}) {
  return resolveConversationState({
    detectedState: "exploration",
    previousConversationState: "exploration_open",
    directivityLevel: 0,
    allianceSignal: "good",
    engagementLevel: "active",
    stagnationTurns: 0,
    attentionWindow: "open",
    closureIntent: false,
    ...overrides
  });
}

// ─── 1. CONVERSATION_STATES completeness ─────────────────────────────────────
const EXPECTED_STATES = ["exploration", "discharge", "info", "stabilization", "alliance_rupture", "need_human_support", "closure", "n1_crisis", "n2_crisis"];
assert(Array.isArray(CONVERSATION_STATES), "CONVERSATION_STATES is an array");
for (const s of EXPECTED_STATES) {
  assert(CONVERSATION_STATES.includes(s), `CONVERSATION_STATES includes '${s}'`);
}

// ─── 2. STATE_TRANSITIONS coverage ───────────────────────────────────────────
for (const s of CONVERSATION_STATES) {
  assert(Array.isArray(STATE_TRANSITIONS[s]), `STATE_TRANSITIONS has entry for '${s}'`);
  assert(STATE_TRANSITIONS[s].length > 0, `STATE_TRANSITIONS['${s}'] is non-empty`);
}

// ─── 3. isValidTransition guard ──────────────────────────────────────────────
// Known valid edges
assert(isValidTransition("exploration", "discharge"), "isValidTransition: exploration -> discharge");
assert(isValidTransition("discharge", "exploration"), "isValidTransition: discharge -> exploration");
assert(isValidTransition("stabilization", "closure"), "isValidTransition: stabilization -> closure");
// Self-transitions
assert(isValidTransition("exploration", "exploration"), "isValidTransition: exploration -> exploration (self)");
assert(isValidTransition("discharge", "discharge"), "isValidTransition: discharge -> discharge (self)");
assert(isValidTransition("stabilization", "stabilization"), "isValidTransition: stabilization -> stabilization (self)");
assert(isValidTransition("info", "info"), "isValidTransition: info -> info (self)");
// closure has restricted successors
assert(!isValidTransition("closure", "alliance_rupture"), "isValidTransition: closure -> alliance_rupture BLOCKED");
assert(!isValidTransition("closure", "stabilization"), "isValidTransition: closure -> stabilization BLOCKED");
// unknown state is permissive
assert(isValidTransition("unknown_legacy_state", "exploration"), "isValidTransition: unknown legacy state is permissive");

// ─── 4. resolveConversationState priority ────────────────────────────────────

// Priority 1: post-discharge cooldown
assert(resolve({ previousConversationState: "discharge_regulated", detectedState: "exploration" }) === "exploration_open",
  "resolve: exploration_open after discharge turn");
assert(resolve({ previousConversationState: "discharge_dysregulated", detectedState: "exploration" }) === "exploration_open",
  "resolve: exploration_open after dysregulated discharge turn");
assert(resolve({ previousConversationState: "discharge_regulated", detectedState: "info_features" }) === "info_features",
  "resolve: info_features beats cooldown after discharge");

// Priority 2: info mode
assert(resolve({ detectedState: "info_features" }) === "info_features", "resolve: info_features -> info_features");
assert(resolve({ detectedState: "info_pure" }) === "info_pure", "resolve: info_pure -> info_pure");
assert(resolve({ detectedState: "info_psychoeducation" }) === "info_psychoeducation", "resolve: info_psychoeducation -> info_psychoeducation");

// Default: exploration_open
assert(resolve() === "exploration_open", "resolve: default is exploration_open");

// Default with restrained: exploration_restrained
assert(resolve({ directivityLevel: 3 }) === "exploration_restrained", "resolve: directivityLevel>=2 gives exploration_restrained");

// Phase B: alliance_rupture override
assert(
  resolve({ allianceSignal: "rupture" }) === "alliance_rupture",
  "resolve: alliance_rupture overrides exploration"
);
assert(
  resolve({ previousConversationState: "discharge_regulated", detectedState: "exploration", allianceSignal: "rupture" }) === "alliance_rupture",
  "resolve: alliance_rupture overrides exploration (post-discharge)"
);

// Phase B: stabilization
assert(
  resolve({ attentionWindow: "overloaded", engagementLevel: "withdrawn" }) === "stabilization",
  "resolve: stabilization when overloaded+withdrawn"
);
assert(
  resolve({ attentionWindow: "overloaded", stagnationTurns: 2 }) === "stabilization",
  "resolve: stabilization when overloaded+stagnation>=2"
);
assert(
  resolve({ engagementLevel: "withdrawn", stagnationTurns: 2 }) === "stabilization",
  "resolve: stabilization when withdrawn+stagnation>=2"
);
// stabilization does NOT apply when stagnation is only 1
assert(
  resolve({ attentionWindow: "overloaded", stagnationTurns: 1, engagementLevel: "active" }) === "exploration_open",
  "resolve: no stabilization with overloaded+stagnation=1 when not withdrawn"
);

// alliance_rupture takes precedence over stabilization
assert(
  resolve({ allianceSignal: "rupture", attentionWindow: "overloaded", engagementLevel: "withdrawn" }) === "alliance_rupture",
  "resolve: alliance_rupture takes precedence over stabilization"
);

// Closure
assert(
  resolve({ closureIntent: true }) === "closure",
  "resolve: closureIntent -> closure"
);
assert(
  resolve({ closureIntent: true, allianceSignal: "rupture" }) === "alliance_rupture",
  "resolve: closureIntent cannot override alliance_rupture"
);

// ─── 5. baseStateOf mapping ───────────────────────────────────────────────────
assert(baseStateOf("exploration_open") === "exploration", "baseStateOf: exploration_open -> exploration");
assert(baseStateOf("exploration_restrained") === "exploration", "baseStateOf: exploration_restrained -> exploration");
assert(baseStateOf("discharge_regulated") === "discharge", "baseStateOf: discharge_regulated -> discharge");
assert(baseStateOf("discharge_dysregulated") === "discharge", "baseStateOf: discharge_dysregulated -> discharge");
assert(baseStateOf("info_pure") === "info", "baseStateOf: info_pure -> info");
assert(baseStateOf("info_features") === "info", "baseStateOf: info_features -> info");
assert(baseStateOf("info_psychoeducation") === "info", "baseStateOf: info_psychoeducation -> info");
assert(baseStateOf("stabilization") === "stabilization", "baseStateOf: stabilization -> stabilization");
assert(baseStateOf("alliance_rupture") === "alliance_rupture", "baseStateOf: alliance_rupture -> alliance_rupture");
assert(baseStateOf("need_human_support") === "need_human_support", "baseStateOf: need_human_support passthrough");
assert(baseStateOf("closure") === "closure", "baseStateOf: closure -> closure");
assert(baseStateOf("n1_crisis") === "n1_crisis", "baseStateOf: n1_crisis passthrough");

// ─── 6. STATE_* tables consistency ───────────────────────────────────────────
const allStates = [
  "exploration_open", "exploration_restrained", "stabilization",
  "alliance_rupture", "need_human_support", "closure", "discharge_regulated", "discharge_dysregulated",
  "info_pure", "info_psychoeducation", "info_features", "n1_crisis", "n2_crisis"
];
for (const st of allStates) {
  assert(st in STATE_FORBIDDEN, `STATE_FORBIDDEN has '${st}'`);
  assert(st in STATE_INTENT, `STATE_INTENT has '${st}'`);
  assert(Array.isArray(STATE_FORBIDDEN[st]), `STATE_FORBIDDEN['${st}'] is array`);
  assert(typeof STATE_INTENT[st] === "string", `STATE_INTENT['${st}'] is string`);
}
for (const st of Object.keys(STATE_CONSTRAINTS)) {
  const c = STATE_CONSTRAINTS[st];
  assert(typeof c.maxSentences === "number", `STATE_CONSTRAINTS['${st}'].maxSentences is number`);
  assert(typeof c.toneConstraint === "string" || c.toneConstraint === null, `STATE_CONSTRAINTS['${st}'].toneConstraint is string or null`);
}

// ─── Report ───────────────────────────────────────────────────────────────────
console.log(`\n[STATE] ${passed}/${passed + failed} checks passed.`);
if (failed > 0) {
  process.exitCode = 1;
}

