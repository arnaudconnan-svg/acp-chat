"use strict";

// â”€â”€â”€ Pure deterministic harness â€” no server required â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
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
    allianceState: "good",
    engagementLevel: "active",
    stagnationTurns: 0,
    processingWindow: "open",
    closureIntent: false,
    ...overrides
  });
}

// â”€â”€â”€ 1. CONVERSATION_STATES completeness â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
const EXPECTED_STATES = ["exploration", "discharge", "contact", "info", "stabilization", "alliance_rupture", "closure"];
assert(Array.isArray(CONVERSATION_STATES), "CONVERSATION_STATES is an array");
for (const s of EXPECTED_STATES) {
  assert(CONVERSATION_STATES.includes(s), `CONVERSATION_STATES includes '${s}'`);
}

// â”€â”€â”€ 2. STATE_TRANSITIONS coverage â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
for (const s of CONVERSATION_STATES) {
  assert(Array.isArray(STATE_TRANSITIONS[s]), `STATE_TRANSITIONS has entry for '${s}'`);
  assert(STATE_TRANSITIONS[s].length > 0, `STATE_TRANSITIONS['${s}'] is non-empty`);
}

// â”€â”€â”€ 3. isValidTransition guard â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Known valid edges
assert(isValidTransition("exploration", "contact"), "isValidTransition: exploration -> contact");
assert(isValidTransition("contact", "discharge"), "isValidTransition: contact -> discharge");
assert(isValidTransition("stabilization", "closure"), "isValidTransition: stabilization -> closure");
// Self-transitions
assert(isValidTransition("exploration", "exploration"), "isValidTransition: exploration -> exploration (self)");
assert(isValidTransition("contact", "contact"), "isValidTransition: contact -> contact (self)");
assert(isValidTransition("stabilization", "stabilization"), "isValidTransition: stabilization -> stabilization (self)");
assert(isValidTransition("info", "info"), "isValidTransition: info -> info (self)");
// closure has restricted successors
assert(!isValidTransition("closure", "alliance_rupture"), "isValidTransition: closure -> alliance_rupture BLOCKED");
assert(!isValidTransition("closure", "stabilization"), "isValidTransition: closure -> stabilization BLOCKED");
// unknown state is permissive
assert(isValidTransition("unknown_legacy_state", "exploration"), "isValidTransition: unknown legacy state is permissive");

// â”€â”€â”€ 4. resolveConversationState priority â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

// Priority 1: active contact beats everything
assert(resolve({ detectedState: "contact" }) === "contact",
  "resolve: contact wins over exploration");
assert(resolve({ detectedState: "contact", previousConversationState: "info_features" }) === "contact",
  "resolve: contact wins over info mode");
assert(resolve({ detectedState: "contact", closureIntent: true }) === "contact",
  "resolve: contact wins over closureIntent");

// Priority 2: post-discharge cooldown â€” previous was discharge, now exploration â†’ contact
assert(resolve({ previousConversationState: "discharge_regulated", detectedState: "exploration" }) === "contact",
  "resolve: contact (post-discharge cooldown) after discharge turn");
// No special state after contact â€” falls back to exploration
assert(resolve({ previousConversationState: "contact", detectedState: "exploration" }) === "exploration_open",
  "resolve: exploration_open after contact turn");
assert(resolve({ previousConversationState: "contact", detectedState: "info_features" }) === "info_features",
  "resolve: info_features beats exploration (prev contact but state switched to info)");

// Priority 3: info mode
assert(resolve({ detectedState: "info_features" }) === "info_features", "resolve: info_features -> info_features");
assert(resolve({ detectedState: "info_pure" }) === "info_pure", "resolve: info_pure -> info_pure");
assert(resolve({ detectedState: "info_psychoeducation" }) === "info_psychoeducation", "resolve: info_psychoeducation -> info_psychoeducation");

// Default: exploration_open
assert(resolve() === "exploration_open", "resolve: default is exploration_open");

// Default with restrained: exploration_restrained
assert(resolve({ directivityLevel: 3 }) === "exploration_restrained", "resolve: directivityLevel>=2 gives exploration_restrained");

// Phase B: alliance_rupture override
assert(
  resolve({ allianceState: "rupture" }) === "alliance_rupture",
  "resolve: alliance_rupture overrides exploration"
);
assert(
  resolve({ previousConversationState: "contact", detectedState: "exploration", allianceState: "rupture" }) === "alliance_rupture",
  "resolve: alliance_rupture overrides exploration (prev contact)"
);
// alliance_rupture does NOT apply when in contact
assert(
  resolve({ detectedState: "contact", allianceState: "rupture" }) === "contact",
  "resolve: alliance_rupture does not override active contact"
);

// Phase B: stabilization
assert(
  resolve({ processingWindow: "overloaded", engagementLevel: "withdrawn" }) === "stabilization",
  "resolve: stabilization when overloaded+withdrawn"
);
assert(
  resolve({ processingWindow: "overloaded", stagnationTurns: 2 }) === "stabilization",
  "resolve: stabilization when overloaded+stagnation>=2"
);
assert(
  resolve({ engagementLevel: "withdrawn", stagnationTurns: 2 }) === "stabilization",
  "resolve: stabilization when withdrawn+stagnation>=2"
);
// stabilization does NOT apply when stagnation is only 1
assert(
  resolve({ processingWindow: "overloaded", stagnationTurns: 1, engagementLevel: "active" }) === "exploration_open",
  "resolve: no stabilization with overloaded+stagnation=1 when not withdrawn"
);

// alliance_rupture takes precedence over stabilization
assert(
  resolve({ allianceState: "rupture", processingWindow: "overloaded", engagementLevel: "withdrawn" }) === "alliance_rupture",
  "resolve: alliance_rupture takes precedence over stabilization"
);

// Closure
assert(
  resolve({ closureIntent: true }) === "closure",
  "resolve: closureIntent -> closure"
);
assert(
  resolve({ closureIntent: true, allianceState: "rupture" }) === "alliance_rupture",
  "resolve: closureIntent cannot override alliance_rupture"
);
assert(
  resolve({ detectedState: "contact", closureIntent: true }) === "contact",
  "resolve: closureIntent cannot override contact"
);

// â”€â”€â”€ 5. baseStateOf mapping â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
assert(baseStateOf("exploration_open") === "exploration", "baseStateOf: exploration_open -> exploration");
assert(baseStateOf("exploration_restrained") === "exploration", "baseStateOf: exploration_restrained -> exploration");
assert(baseStateOf("discharge_regulated") === "discharge", "baseStateOf: discharge_regulated -> discharge");
assert(baseStateOf("discharge_dysregulated") === "discharge", "baseStateOf: discharge_dysregulated -> discharge");
assert(baseStateOf("info_pure") === "info", "baseStateOf: info_pure -> info");
assert(baseStateOf("info_features") === "info", "baseStateOf: info_features -> info");
assert(baseStateOf("info_psychoeducation") === "info", "baseStateOf: info_psychoeducation -> info");
assert(baseStateOf("contact") === "contact", "baseStateOf: contact -> contact");
assert(baseStateOf("stabilization") === "stabilization", "baseStateOf: stabilization -> stabilization");
assert(baseStateOf("alliance_rupture") === "alliance_rupture", "baseStateOf: alliance_rupture -> alliance_rupture");
assert(baseStateOf("closure") === "closure", "baseStateOf: closure -> closure");
assert(baseStateOf("n1_crisis") === "n1_crisis", "baseStateOf: n1_crisis passthrough");

// â”€â”€â”€ 6. STATE_* tables consistency â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
const allStates = [
  "exploration_open", "exploration_restrained", "contact", "stabilization",
  "alliance_rupture", "closure", "discharge_regulated", "discharge_dysregulated",
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

// â”€â”€â”€ Report â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
console.log(`\n[STATE] ${passed}/${passed + failed} checks passed.`);
if (failed > 0) {
  process.exitCode = 1;
}

