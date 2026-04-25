"use strict";

// ─── Chat routing harness — pure deterministic, no server required ────────────
// Tests resolveChatPriorityRule and the CHAT_PRIORITY_MATCHERS table.
//
// Covers:
//   - All 5 rules: suicide_n2, acute_crisis_followup, suicide_clarification,
//                  recall_long_term, recall_none
//   - Priority ordering within each phase
//   - Phase isolation (post_suicide rules don't fire in post_recall and vice versa)
//   - Null / missing input safety
//   - Default flow (no rule matches → returns null)
//   - Edge cases: idiomaticDeathExpression override is NOT handled here (handled upstream);
//                 crisisResolved=true prevents acute_crisis_followup

const {
  CHAT_PRIORITY_RULES,
  CHAT_PRIORITY_MATCHERS,
  resolveChatPriorityRule
} = require("../lib/chat-routing");

let passed = 0;
let failed = 0;

function check(label, fn) {
  try {
    fn();
    passed++;
    console.log(`[PASS] ${label}`);
  } catch (err) {
    failed++;
    console.error(`[FAIL] ${label}: ${err.message}`);
  }
}

function assert(condition, msg) {
  if (!condition) throw new Error(msg || "assertion failed");
}

// ─── Table structure ──────────────────────────────────────────────────────────

check("CHAT_PRIORITY_RULES has 5 entries", () => {
  assert(CHAT_PRIORITY_RULES.length === 5, `expected 5, got ${CHAT_PRIORITY_RULES.length}`);
});

check("All rules have id, phase, priority", () => {
  for (const rule of CHAT_PRIORITY_RULES) {
    assert(typeof rule.id === "string" && rule.id.length > 0, `rule missing id`);
    assert(rule.phase === "post_suicide" || rule.phase === "post_recall", `unexpected phase: ${rule.phase}`);
    assert(typeof rule.priority === "number", `rule ${rule.id} missing priority`);
  }
});

check("post_suicide rules appear before post_recall in order", () => {
  const firstRecall = CHAT_PRIORITY_RULES.findIndex(r => r.phase === "post_recall");
  const lastSuicide = [...CHAT_PRIORITY_RULES].reverse().findIndex(r => r.phase === "post_suicide");
  const lastSuicideIdx = CHAT_PRIORITY_RULES.length - 1 - lastSuicide;
  assert(firstRecall > lastSuicideIdx, "post_recall rules should come after all post_suicide rules");
});

check("Priority ordering: suicide_n2 < acute_crisis_followup < suicide_clarification", () => {
  const n2 = CHAT_PRIORITY_RULES.find(r => r.id === "suicide_n2");
  const followup = CHAT_PRIORITY_RULES.find(r => r.id === "acute_crisis_followup");
  const clarif = CHAT_PRIORITY_RULES.find(r => r.id === "suicide_clarification");
  assert(n2.priority < followup.priority, "suicide_n2 should have lower priority number than acute_crisis_followup");
  assert(followup.priority < clarif.priority, "acute_crisis_followup should have lower priority number than suicide_clarification");
});

check("Priority ordering: recall_long_term < recall_none", () => {
  const longTerm = CHAT_PRIORITY_RULES.find(r => r.id === "recall_long_term");
  const none = CHAT_PRIORITY_RULES.find(r => r.id === "recall_none");
  assert(longTerm.priority < none.priority, "recall_long_term should have lower priority number than recall_none");
});

check("CHAT_PRIORITY_MATCHERS has an entry for each rule id", () => {
  for (const rule of CHAT_PRIORITY_RULES) {
    assert(typeof CHAT_PRIORITY_MATCHERS[rule.id] === "function", `no matcher for rule ${rule.id}`);
  }
});

// ─── Phase: post_suicide ──────────────────────────────────────────────────────

check("suicide_n2: matches when suicideLevel=N2", () => {
  const result = resolveChatPriorityRule({ phase: "post_suicide", suicide: { suicideLevel: "N2" } });
  assert(result?.id === "suicide_n2", `expected suicide_n2, got ${result?.id}`);
});

check("suicide_n2: N2 takes priority over N1 (first in table)", () => {
  // N2 + N1-like flags simultaneously — N2 wins
  const result = resolveChatPriorityRule({
    phase: "post_suicide",
    suicide: { suicideLevel: "N2", needsClarification: true }
  });
  assert(result?.id === "suicide_n2", `expected suicide_n2, got ${result?.id}`);
});

check("acute_crisis_followup: matches when acuteCrisis=true and crisisResolved!=true", () => {
  const result = resolveChatPriorityRule({
    phase: "post_suicide",
    suicide: { suicideLevel: "N0", crisisResolved: false },
    flags: { acuteCrisis: true }
  });
  assert(result?.id === "acute_crisis_followup", `expected acute_crisis_followup, got ${result?.id}`);
});

check("acute_crisis_followup: does NOT match when crisisResolved=true", () => {
  const result = resolveChatPriorityRule({
    phase: "post_suicide",
    suicide: { suicideLevel: "N0", crisisResolved: true },
    flags: { acuteCrisis: true }
  });
  // Should fall through to clarification or null
  assert(result?.id !== "acute_crisis_followup", `acute_crisis_followup should not match when crisisResolved=true`);
});

check("acute_crisis_followup: does NOT match when acuteCrisis=false", () => {
  const result = resolveChatPriorityRule({
    phase: "post_suicide",
    suicide: { suicideLevel: "N0" },
    flags: { acuteCrisis: false }
  });
  assert(result === null, `expected null, got ${result?.id}`);
});

check("suicide_clarification: matches when suicideLevel=N1", () => {
  const result = resolveChatPriorityRule({
    phase: "post_suicide",
    suicide: { suicideLevel: "N1", needsClarification: false }
  });
  assert(result?.id === "suicide_clarification", `expected suicide_clarification, got ${result?.id}`);
});

check("suicide_clarification: matches when needsClarification=true regardless of level", () => {
  const result = resolveChatPriorityRule({
    phase: "post_suicide",
    suicide: { suicideLevel: "N0", needsClarification: true }
  });
  assert(result?.id === "suicide_clarification", `expected suicide_clarification, got ${result?.id}`);
});

check("post_suicide: returns null when N0 and no crisis", () => {
  const result = resolveChatPriorityRule({
    phase: "post_suicide",
    suicide: { suicideLevel: "N0", needsClarification: false },
    flags: { acuteCrisis: false }
  });
  assert(result === null, `expected null, got ${result?.id}`);
});

check("N2 takes priority over acuteCrisis (N2 is first in table)", () => {
  const result = resolveChatPriorityRule({
    phase: "post_suicide",
    suicide: { suicideLevel: "N2", crisisResolved: false },
    flags: { acuteCrisis: true }
  });
  assert(result?.id === "suicide_n2", `expected suicide_n2, got ${result?.id}`);
});

check("acuteCrisis takes priority over N1 (acute_crisis_followup before suicide_clarification)", () => {
  const result = resolveChatPriorityRule({
    phase: "post_suicide",
    suicide: { suicideLevel: "N1", crisisResolved: false },
    flags: { acuteCrisis: true }
  });
  assert(result?.id === "acute_crisis_followup", `expected acute_crisis_followup, got ${result?.id}`);
});

// ─── Phase: post_recall ───────────────────────────────────────────────────────

check("recall_long_term: matches when isLongTermMemoryRecall=true", () => {
  const result = resolveChatPriorityRule({
    phase: "post_recall",
    recallRouting: { isLongTermMemoryRecall: true }
  });
  assert(result?.id === "recall_long_term", `expected recall_long_term, got ${result?.id}`);
});

check("recall_none: matches when isRecallAttempt=true and calledMemory=none", () => {
  const result = resolveChatPriorityRule({
    phase: "post_recall",
    recallRouting: { isRecallAttempt: true, calledMemory: "none" }
  });
  assert(result?.id === "recall_none", `expected recall_none, got ${result?.id}`);
});

check("recall_none: does NOT match when calledMemory is not none", () => {
  const result = resolveChatPriorityRule({
    phase: "post_recall",
    recallRouting: { isRecallAttempt: true, calledMemory: "session" }
  });
  assert(result === null, `expected null, got ${result?.id}`);
});

check("recall_long_term takes priority over recall_none when both would match", () => {
  // isLongTermMemoryRecall=true + isRecallAttempt=true + calledMemory=none
  const result = resolveChatPriorityRule({
    phase: "post_recall",
    recallRouting: { isLongTermMemoryRecall: true, isRecallAttempt: true, calledMemory: "none" }
  });
  assert(result?.id === "recall_long_term", `expected recall_long_term, got ${result?.id}`);
});

check("post_recall: returns null when no recall flags set", () => {
  const result = resolveChatPriorityRule({
    phase: "post_recall",
    recallRouting: { isRecallAttempt: false, isLongTermMemoryRecall: false }
  });
  assert(result === null, `expected null, got ${result?.id}`);
});

// ─── Phase isolation ──────────────────────────────────────────────────────────

check("post_suicide rules do NOT fire in post_recall phase (N2)", () => {
  const result = resolveChatPriorityRule({
    phase: "post_recall",
    suicide: { suicideLevel: "N2" },
    flags: { acuteCrisis: true }
  });
  assert(result === null || result.phase === "post_recall",
    `post_recall should not return a post_suicide rule, got ${result?.id}`);
});

check("post_recall rules do NOT fire in post_suicide phase", () => {
  const result = resolveChatPriorityRule({
    phase: "post_suicide",
    recallRouting: { isLongTermMemoryRecall: true }
  });
  assert(result === null || result.phase === "post_suicide",
    `post_suicide should not return a post_recall rule, got ${result?.id}`);
});

// ─── Null / missing input safety ─────────────────────────────────────────────

check("returns null when phase is unknown", () => {
  const result = resolveChatPriorityRule({ phase: "unknown_phase" });
  assert(result === null, `expected null for unknown phase, got ${result?.id}`);
});

check("returns null when called with no arguments", () => {
  const result = resolveChatPriorityRule();
  assert(result === null, `expected null for no args`);
});

check("handles null suicide without throwing", () => {
  const result = resolveChatPriorityRule({ phase: "post_suicide", suicide: null, flags: null });
  assert(result === null, `expected null`);
});

check("handles null recallRouting without throwing", () => {
  const result = resolveChatPriorityRule({ phase: "post_recall", recallRouting: null });
  assert(result === null, `expected null`);
});

// ─── Return shape ─────────────────────────────────────────────────────────────

check("returned rule has correct shape (id, phase, priority)", () => {
  const result = resolveChatPriorityRule({ phase: "post_suicide", suicide: { suicideLevel: "N2" } });
  assert(typeof result.id === "string", "rule.id should be string");
  assert(typeof result.phase === "string", "rule.phase should be string");
  assert(typeof result.priority === "number", "rule.priority should be number");
});

// ─── Summary ─────────────────────────────────────────────────────────────────

console.log(`\nChat routing harness: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
