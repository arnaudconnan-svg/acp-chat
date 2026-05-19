"use strict";

const {
  resolveConversationState,
  baseStateOf,
  isValidTransition,
  STATE_FORBIDDEN,
  STATE_INTENT
} = require("../lib/conversation-state");

let passed = 0;
let failed = 0;

function check(label, fn) {
  try {
    fn();
    passed += 1;
    console.log(`[PASS] ${label}`);
  } catch (err) {
    failed += 1;
    console.error(`[FAIL] ${label}: ${err.message}`);
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message || "assertion failed");
}

check("baseStateOf maps exploration/info/discharge correctly", () => {
  assert(baseStateOf("exploration_open") === "exploration");
  assert(baseStateOf("exploration_restrained") === "exploration");
  assert(baseStateOf("info_pure") === "info");
  assert(baseStateOf("info_features") === "info");
  assert(baseStateOf("info_psychoeducation") === "info");
  assert(baseStateOf("discharge_regulated") === "discharge");
  assert(baseStateOf("discharge_dysregulated") === "discharge");
});

check("resolveConversationState keeps discharge priority", () => {
  assert(resolveConversationState({ detectedState: "discharge_regulated" }) === "discharge_regulated");
  assert(resolveConversationState({ detectedState: "discharge_dysregulated" }) === "discharge_dysregulated");
});

check("post-discharge cooldown returns exploration (no contact state)", () => {
  const out = resolveConversationState({
    detectedState: "exploration",
    previousConversationState: "discharge_regulated",
    directivityLevel: 0
  });
  assert(out === "exploration_open", `expected exploration_open, got ${out}`);
});

check("info states pass through", () => {
  assert(resolveConversationState({ detectedState: "info_pure" }) === "info_pure");
  assert(resolveConversationState({ detectedState: "info_features" }) === "info_features");
  assert(resolveConversationState({ detectedState: "info_psychoeducation" }) === "info_psychoeducation");
});

check("exploration expands by directivity", () => {
  assert(resolveConversationState({ detectedState: "exploration", directivityLevel: 0 }) === "exploration_open");
  assert(resolveConversationState({ detectedState: "exploration", directivityLevel: 3 }) === "exploration_restrained");
});

check("Phase B overrides exploration", () => {
  assert(resolveConversationState({ detectedState: "exploration", allianceSignal: "rupture" }) === "alliance_rupture");
  assert(resolveConversationState({ detectedState: "exploration", attentionWindow: "overloaded", engagementLevel: "withdrawn" }) === "stabilization");
  assert(resolveConversationState({ detectedState: "exploration", closureIntent: true }) === "closure");
});

check("dependency care pending overrides exploration and info", () => {
  assert(resolveConversationState({ detectedState: "exploration", dependencyCareMessagePending: true }) === "need_human_support");
  assert(resolveConversationState({ detectedState: "info_features", dependencyCareMessagePending: true }) === "need_human_support");
});

check("dependency care pending keeps support state through alliance rupture", () => {
  assert(resolveConversationState({ detectedState: "exploration", dependencyCareMessagePending: true, allianceSignal: "rupture" }) === "need_human_support");
});

check("isValidTransition blocks closure -> stabilization", () => {
  assert(isValidTransition("closure", "stabilization") === false);
});

check("isValidTransition allows closure -> need_human_support", () => {
  assert(isValidTransition("closure", "need_human_support") === true);
});

check("isValidTransition supports need_human_support transitions", () => {
  assert(isValidTransition("need_human_support", "need_human_support") === true);
  assert(isValidTransition("need_human_support", "exploration") === true);
});

check("state tables contain no contact key", () => {
  assert(!("contact" in STATE_FORBIDDEN), "STATE_FORBIDDEN.contact should not exist");
  assert(!("contact" in STATE_INTENT), "STATE_INTENT.contact should not exist");
});

console.log(`\n[CONVERSATION-STATE] ${passed} passed, ${failed} failed.`);
if (failed > 0) process.exit(1);
