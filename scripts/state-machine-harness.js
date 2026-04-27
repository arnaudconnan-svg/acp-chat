"use strict";

// ─── Pure deterministic harness — no server required ─────────────────────────
// Tests the explicit state machine defined in lib/conversation-state.js:
// - CONVERSATION_STATES: completeness
// - STATE_TRANSITIONS: coverage and known valid/invalid edges
// - resolveConversationState: priority ordering
// - stateToWriterMode: mapping correctness
// - isValidTransition: guard accuracy

const {
  CONVERSATION_STATES,
  STATE_TRANSITIONS,
  WRITER_MODE_FORBIDDEN,
  WRITER_MODE_INTENT,
  WRITER_MODE_CONSTRAINTS,
  resolveConversationState,
  stateToWriterMode,
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
    detectedMode: "exploration",
    contactAnalysis: { isContact: false, contactSubmode: null },
    previousConversationStateKey: "exploration",
    allianceState: "good",
    engagementLevel: "active",
    stagnationTurns: 0,
    processingWindow: "open",
    closureIntent: false,
    ...overrides
  });
}

// ─── 1. CONVERSATION_STATES completeness ─────────────────────────────────────
const EXPECTED_STATES = ["exploration", "discharge", "contact", "info", "stabilization", "alliance_rupture", "closure"];
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

// ─── 4. resolveConversationState priority ────────────────────────────────────

// Priority 1: active contact beats everything
assert(resolve({ contactAnalysis: { isContact: true, contactSubmode: "regulated" } }) === "contact",
  "resolve: contact wins over exploration");
assert(resolve({ contactAnalysis: { isContact: true }, detectedMode: "info" }) === "contact",
  "resolve: contact wins over info mode");
assert(resolve({ contactAnalysis: { isContact: true }, closureIntent: true }) === "contact",
  "resolve: contact wins over closureIntent");

// Priority 2: post-discharge cooldown — previous was discharge, now exploration → contact
assert(resolve({ previousConversationStateKey: "discharge", detectedMode: "exploration" }) === "contact",
  "resolve: contact (post-discharge cooldown) after discharge turn");
// No special state after contact — falls back to exploration
assert(resolve({ previousConversationStateKey: "contact", detectedMode: "exploration" }) === "exploration",
  "resolve: exploration after contact turn (no post_contact state)");
assert(resolve({ previousConversationStateKey: "contact", detectedMode: "info" }) === "info",
  "resolve: info beats exploration (prev contact but mode switched to info)");

// Priority 3: info mode
assert(resolve({ detectedMode: "info" }) === "info", "resolve: info mode -> info state");

// Default: exploration
assert(resolve() === "exploration", "resolve: default is exploration");

// Phase B: alliance_rupture override
assert(
  resolve({ allianceState: "rupture" }) === "alliance_rupture",
  "resolve: alliance_rupture overrides exploration"
);
assert(
  resolve({ previousConversationStateKey: "contact", detectedMode: "exploration", allianceState: "rupture" }) === "alliance_rupture",
  "resolve: alliance_rupture overrides exploration (prev contact)"
);
// alliance_rupture does NOT apply when in contact
assert(
  resolve({ contactAnalysis: { isContact: true }, allianceState: "rupture" }) === "contact",
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
  resolve({ processingWindow: "overloaded", stagnationTurns: 1, engagementLevel: "active" }) === "exploration",
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
  resolve({ closureIntent: true, contactAnalysis: { isContact: true } }) === "contact",
  "resolve: closureIntent cannot override contact"
);

// ─── 5. stateToWriterMode mapping ────────────────────────────────────────────
assert(stateToWriterMode("alliance_rupture") === "alliance_rupture", "stateToWriterMode: alliance_rupture");
assert(stateToWriterMode("stabilization") === "stabilization", "stateToWriterMode: stabilization");
assert(stateToWriterMode("closure") === "closure", "stateToWriterMode: closure");
// contact state always produces "contact" writerMode regardless of submode
assert(stateToWriterMode("contact") === "contact",
  "stateToWriterMode: contact default");
assert(stateToWriterMode("contact", { contactSubmode: "regulated" }) === "contact",
  "stateToWriterMode: contact with regulated submode");
assert(stateToWriterMode("contact", { contactSubmode: "dysregulated" }) === "contact",
  "stateToWriterMode: contact with dysregulated submode (dysregulation is discharge territory)");
// discharge state dispatches on submode
assert(stateToWriterMode("discharge") === "discharge_regulated",
  "stateToWriterMode: discharge default is regulated");
assert(stateToWriterMode("discharge", { contactSubmode: "dysregulated" }) === "discharge_dysregulated",
  "stateToWriterMode: discharge dysregulated");
assert(stateToWriterMode("info", { infoSubmode: "psychoeducation" }) === "info_psychoeducation",
  "stateToWriterMode: info psychoeducation");
assert(stateToWriterMode("info", { infoSubmode: "pure" }) === "info_pure",
  "stateToWriterMode: info pure");
assert(stateToWriterMode("info", { infoSubmode: "app_features" }) === "info_app_features",
  "stateToWriterMode: info app_features");
assert(stateToWriterMode("info") === "info_app_features",
  "stateToWriterMode: info default is app_features");
assert(stateToWriterMode("exploration", { directivityLevel: 3 }) === "exploration_restrained",
  "stateToWriterMode: exploration guided (level>=2)");
assert(stateToWriterMode("exploration", { directivityLevel: 1 }) === "exploration_open",
  "stateToWriterMode: exploration open (level<2)");
assert(stateToWriterMode("exploration") === "exploration_open",
  "stateToWriterMode: exploration default is open");

// ─── 6. WRITER_MODE_* tables consistency ─────────────────────────────────────
const allWriterModes = [
  "exploration_open", "exploration_restrained", "contact", "stabilization",
  "alliance_rupture", "closure", "discharge_regulated", "discharge_dysregulated",
  "info_pure", "info_psychoeducation", "info_app_features", "n1_crisis", "n2_crisis"
];
for (const wm of allWriterModes) {
  assert(wm in WRITER_MODE_FORBIDDEN, `WRITER_MODE_FORBIDDEN has '${wm}'`);
  assert(wm in WRITER_MODE_INTENT, `WRITER_MODE_INTENT has '${wm}'`);
  assert(Array.isArray(WRITER_MODE_FORBIDDEN[wm]), `WRITER_MODE_FORBIDDEN['${wm}'] is array`);
  assert(typeof WRITER_MODE_INTENT[wm] === "string", `WRITER_MODE_INTENT['${wm}'] is string`);
}
for (const wm of Object.keys(WRITER_MODE_CONSTRAINTS)) {
  const c = WRITER_MODE_CONSTRAINTS[wm];
  assert(typeof c.maxSentences === "number", `WRITER_MODE_CONSTRAINTS['${wm}'].maxSentences is number`);
  assert(typeof c.toneConstraint === "string" || c.toneConstraint === null, `WRITER_MODE_CONSTRAINTS['${wm}'].toneConstraint is string or null`);
}

// ─── Report ───────────────────────────────────────────────────────────────────
console.log(`\n[STATE] ${passed}/${passed + failed} checks passed.`);
if (failed > 0) {
  process.exitCode = 1;
}
