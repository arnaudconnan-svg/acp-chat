"use strict";

// ─── conversation-state harness — pure deterministic, no server required ──────
// Exercises resolveConversationState, baseStateOf, and isValidTransition from
// lib/conversation-state.js.
// Focus: the three Phase B override paths (stabilization, alliance_rupture, closure)
// that were previously only reachable via live pipeline tests, plus all priority
// paths (discharge, contact, post-discharge, info, exploration expansion).

const {
  resolveConversationState,
  baseStateOf,
  isValidTransition,
  STATE_FORBIDDEN,
  STATE_ALLOWED,
  STATE_INTENT
} = require("../lib/conversation-state");

let passed = 0;
let failed = 0;
let currentSection = "";

function section(name) {
  currentSection = name;
  console.log(`\n── ${name} ${"─".repeat(Math.max(0, 58 - name.length))}`);
}

function check(label, fn) {
  try {
    fn();
    passed++;
    console.log(`  PASS  ${label}`);
  } catch (err) {
    failed++;
    console.error(`  FAIL  ${label}: ${err.message}`);
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message || "assertion failed");
}

// ─── baseStateOf ──────────────────────────────────────────────────────────────

section("baseStateOf");

check("exploration_open → exploration", () => {
  assert(baseStateOf("exploration_open") === "exploration");
});
check("exploration_restrained → exploration", () => {
  assert(baseStateOf("exploration_restrained") === "exploration");
});
check("info_pure → info", () => {
  assert(baseStateOf("info_pure") === "info");
});
check("info_features → info", () => {
  assert(baseStateOf("info_features") === "info");
});
check("info_psychoeducation → info", () => {
  assert(baseStateOf("info_psychoeducation") === "info");
});
check("discharge_regulated → discharge", () => {
  assert(baseStateOf("discharge_regulated") === "discharge");
});
check("discharge_dysregulated → discharge", () => {
  assert(baseStateOf("discharge_dysregulated") === "discharge");
});
check("contact → contact (passthrough)", () => {
  assert(baseStateOf("contact") === "contact");
});
check("stabilization → stabilization (passthrough)", () => {
  assert(baseStateOf("stabilization") === "stabilization");
});
check("alliance_rupture → alliance_rupture (passthrough)", () => {
  assert(baseStateOf("alliance_rupture") === "alliance_rupture");
});
check("closure → closure (passthrough)", () => {
  assert(baseStateOf("closure") === "closure");
});

// ─── Priority 1 — discharge ───────────────────────────────────────────────────

section("Priority 1 — discharge overrides everything");

check("discharge_regulated → discharge_regulated", () => {
  const r = resolveConversationState({ detectedState: "discharge_regulated" });
  assert(r === "discharge_regulated", `expected discharge_regulated, got ${r}`);
});
check("discharge_dysregulated → discharge_dysregulated", () => {
  const r = resolveConversationState({ detectedState: "discharge_dysregulated" });
  assert(r === "discharge_dysregulated", `expected discharge_dysregulated, got ${r}`);
});
check("discharge overrides allianceState rupture (Phase B does not apply)", () => {
  const r = resolveConversationState({ detectedState: "discharge_regulated", allianceState: "rupture" });
  assert(r === "discharge_regulated", `expected discharge_regulated, got ${r}`);
});
check("discharge overrides closureIntent (closure not applied to discharge)", () => {
  const r = resolveConversationState({ detectedState: "discharge_regulated", closureIntent: true });
  assert(r === "discharge_regulated", `expected discharge_regulated, got ${r}`);
});

// ─── Priority 2 — contact ─────────────────────────────────────────────────────

section("Priority 2 — explicit contact");

check("contact → contact", () => {
  const r = resolveConversationState({ detectedState: "contact" });
  assert(r === "contact", `expected contact, got ${r}`);
});
check("contact overrides allianceState rupture (Phase B does not apply)", () => {
  const r = resolveConversationState({ detectedState: "contact", allianceState: "rupture" });
  assert(r === "contact", `expected contact, got ${r}`);
});
check("contact overrides closureIntent", () => {
  const r = resolveConversationState({ detectedState: "contact", closureIntent: true });
  assert(r === "contact", `expected contact (closure blocked), got ${r}`);
});

// ─── Priority 3 — post-discharge cooldown ─────────────────────────────────────

section("Priority 3 — post-discharge cooldown");

check("exploration after discharge → contact (cooldown)", () => {
  const r = resolveConversationState({
    detectedState: "exploration",
    previousConversationState: "discharge_regulated"
  });
  assert(r === "contact", `expected contact (post-discharge cooldown), got ${r}`);
});
check("dysregulated discharge prev → cooldown still applies", () => {
  const r = resolveConversationState({
    detectedState: "exploration",
    previousConversationState: "discharge_dysregulated"
  });
  assert(r === "contact", `expected contact, got ${r}`);
});
check("info after discharge → info (cooldown skipped for info)", () => {
  const r = resolveConversationState({
    detectedState: "info_features",
    previousConversationState: "discharge_regulated"
  });
  assert(r === "info_features", `expected info_features (cooldown skipped), got ${r}`);
});

// ─── Priority 4 — info ────────────────────────────────────────────────────────

section("Priority 4 — info states");

check("info_pure → info_pure", () => {
  const r = resolveConversationState({ detectedState: "info_pure" });
  assert(r === "info_pure", `expected info_pure, got ${r}`);
});
check("info_features → info_features", () => {
  const r = resolveConversationState({ detectedState: "info_features" });
  assert(r === "info_features", `expected info_features, got ${r}`);
});
check("info_psychoeducation → info_psychoeducation", () => {
  const r = resolveConversationState({ detectedState: "info_psychoeducation" });
  assert(r === "info_psychoeducation", `expected info_psychoeducation, got ${r}`);
});
check("info overrides allianceState rupture (Phase B does not apply to info)", () => {
  const r = resolveConversationState({ detectedState: "info_pure", allianceState: "rupture" });
  assert(r === "info_pure", `expected info_pure, got ${r}`);
});

// ─── Default — exploration expansion ──────────────────────────────────────────

section("Default — exploration expansion by directivity");

check("exploration + level 0 → exploration_open", () => {
  const r = resolveConversationState({ detectedState: "exploration", directivityLevel: 0 });
  assert(r === "exploration_open", `expected exploration_open, got ${r}`);
});
check("exploration + level 1 → exploration_open", () => {
  const r = resolveConversationState({ detectedState: "exploration", directivityLevel: 1 });
  assert(r === "exploration_open", `expected exploration_open, got ${r}`);
});
check("exploration + level 2 → exploration_restrained", () => {
  const r = resolveConversationState({ detectedState: "exploration", directivityLevel: 2 });
  assert(r === "exploration_restrained", `expected exploration_restrained, got ${r}`);
});
check("exploration + level 4 → exploration_restrained", () => {
  const r = resolveConversationState({ detectedState: "exploration", directivityLevel: 4 });
  assert(r === "exploration_restrained", `expected exploration_restrained, got ${r}`);
});

// ─── Phase B — alliance_rupture ───────────────────────────────────────────────

section("Phase B — alliance_rupture");

check("exploration + allianceState=rupture → alliance_rupture", () => {
  const r = resolveConversationState({ detectedState: "exploration", allianceState: "rupture" });
  assert(r === "alliance_rupture", `expected alliance_rupture, got ${r}`);
});
check("alliance_rupture overrides stabilization conditions (rupture is checked first)", () => {
  const r = resolveConversationState({
    detectedState: "exploration",
    allianceState: "rupture",
    processingWindow: "overloaded",
    engagementLevel: "withdrawn"
  });
  assert(r === "alliance_rupture", `expected alliance_rupture, got ${r}`);
});
check("closureIntent does NOT override alliance_rupture", () => {
  const r = resolveConversationState({
    detectedState: "exploration",
    allianceState: "rupture",
    closureIntent: true
  });
  assert(r === "alliance_rupture", `expected alliance_rupture (closure blocked), got ${r}`);
});
check("allianceState=good → no alliance_rupture", () => {
  const r = resolveConversationState({ detectedState: "exploration", allianceState: "good" });
  assert(r !== "alliance_rupture", `expected no alliance_rupture for good alliance, got ${r}`);
});
check("allianceState=fragile → no alliance_rupture", () => {
  const r = resolveConversationState({ detectedState: "exploration", allianceState: "fragile" });
  assert(r !== "alliance_rupture", `expected no alliance_rupture for fragile alliance, got ${r}`);
});
check("STATE_FORBIDDEN alliance_rupture contains relance and interpretive_hypothesis", () => {
  assert(STATE_FORBIDDEN.alliance_rupture.includes("relance"), "expected relance in forbidden");
  assert(STATE_FORBIDDEN.alliance_rupture.includes("interpretive_hypothesis"), "expected interpretive_hypothesis in forbidden");
});

// ─── Phase B — stabilization ──────────────────────────────────────────────────

section("Phase B — stabilization");

check("overloaded + withdrawn → stabilization", () => {
  const r = resolveConversationState({
    detectedState: "exploration",
    processingWindow: "overloaded",
    engagementLevel: "withdrawn"
  });
  assert(r === "stabilization", `expected stabilization, got ${r}`);
});
check("overloaded + stagnationTurns=2 → stabilization", () => {
  const r = resolveConversationState({
    detectedState: "exploration",
    processingWindow: "overloaded",
    stagnationTurns: 2
  });
  assert(r === "stabilization", `expected stabilization, got ${r}`);
});
check("overloaded + stagnationTurns=1 → NOT stabilization (threshold is 2)", () => {
  const r = resolveConversationState({
    detectedState: "exploration",
    processingWindow: "overloaded",
    engagementLevel: "active",
    stagnationTurns: 1
  });
  assert(r !== "stabilization", `expected no stabilization for stagnation=1, got ${r}`);
});
check("withdrawn + stagnationTurns=2 → stabilization", () => {
  const r = resolveConversationState({
    detectedState: "exploration",
    engagementLevel: "withdrawn",
    stagnationTurns: 2
  });
  assert(r === "stabilization", `expected stabilization, got ${r}`);
});
check("withdrawn + stagnationTurns=1 → NOT stabilization", () => {
  const r = resolveConversationState({
    detectedState: "exploration",
    engagementLevel: "withdrawn",
    stagnationTurns: 1
  });
  assert(r !== "stabilization", `expected no stabilization for stagnation=1, got ${r}`);
});
check("active + open → NOT stabilization (all good)", () => {
  const r = resolveConversationState({
    detectedState: "exploration",
    processingWindow: "open",
    engagementLevel: "active"
  });
  assert(r !== "stabilization", `expected no stabilization for active/open, got ${r}`);
});
check("stabilization does NOT apply to contact (Phase B is exploration-only)", () => {
  const r = resolveConversationState({
    detectedState: "contact",
    processingWindow: "overloaded",
    engagementLevel: "withdrawn"
  });
  assert(r === "contact", `expected contact (Phase B blocked), got ${r}`);
});
check("stabilization does NOT apply to info (Phase B is exploration-only)", () => {
  const r = resolveConversationState({
    detectedState: "info_pure",
    processingWindow: "overloaded",
    engagementLevel: "withdrawn"
  });
  assert(r === "info_pure", `expected info_pure (Phase B blocked), got ${r}`);
});
check("closureIntent does NOT override stabilization (not blocked by closure guard)", () => {
  const r = resolveConversationState({
    detectedState: "exploration",
    processingWindow: "overloaded",
    engagementLevel: "withdrawn",
    closureIntent: true
  });
  assert(r === "closure", `expected closure (closure applies on top of stabilization), got ${r}`);
});
check("STATE_FORBIDDEN stabilization contains open_question, relance, interpretive_hypothesis", () => {
  assert(STATE_FORBIDDEN.stabilization.includes("open_question"), "expected open_question in forbidden");
  assert(STATE_FORBIDDEN.stabilization.includes("relance"), "expected relance in forbidden");
  assert(STATE_FORBIDDEN.stabilization.includes("interpretive_hypothesis"), "expected interpretive_hypothesis in forbidden");
});

// ─── Closure ─────────────────────────────────────────────────────────────────

section("Closure");

check("closureIntent + exploration → closure", () => {
  const r = resolveConversationState({ detectedState: "exploration", closureIntent: true });
  assert(r === "closure", `expected closure, got ${r}`);
});
check("closureIntent + info → closure", () => {
  const r = resolveConversationState({ detectedState: "info_features", closureIntent: true });
  assert(r === "closure", `expected closure, got ${r}`);
});
check("closureIntent + discharge_regulated → NOT closure (discharge blocks closure)", () => {
  const r = resolveConversationState({ detectedState: "discharge_regulated", closureIntent: true });
  assert(r === "discharge_regulated", `expected discharge_regulated (closure blocked), got ${r}`);
});
check("closureIntent + discharge_dysregulated → NOT closure", () => {
  const r = resolveConversationState({ detectedState: "discharge_dysregulated", closureIntent: true });
  assert(r === "discharge_dysregulated", `expected discharge_dysregulated (closure blocked), got ${r}`);
});
check("closureIntent + contact → NOT closure (contact blocks closure)", () => {
  const r = resolveConversationState({ detectedState: "contact", closureIntent: true });
  assert(r === "contact", `expected contact (closure blocked), got ${r}`);
});
check("closureIntent=false → no closure", () => {
  const r = resolveConversationState({ detectedState: "exploration", closureIntent: false });
  assert(r !== "closure", `expected no closure when closureIntent=false, got ${r}`);
});
check("STATE_FORBIDDEN closure contains relance, open_question", () => {
  assert(STATE_FORBIDDEN.closure.includes("relance"), "expected relance in forbidden");
  assert(STATE_FORBIDDEN.closure.includes("open_question"), "expected open_question in forbidden");
});

// ─── isValidTransition ────────────────────────────────────────────────────────

section("isValidTransition");

check("exploration → contact (valid)", () => {
  assert(isValidTransition("exploration", "contact") === true);
});
check("exploration → alliance_rupture (valid)", () => {
  assert(isValidTransition("exploration", "alliance_rupture") === true);
});
check("exploration → stabilization (valid)", () => {
  assert(isValidTransition("exploration", "stabilization") === true);
});
check("exploration → closure (valid)", () => {
  assert(isValidTransition("exploration", "closure") === true);
});
check("closure → exploration (valid)", () => {
  assert(isValidTransition("closure", "exploration") === true);
});
check("closure → contact (valid)", () => {
  assert(isValidTransition("closure", "contact") === true);
});
check("closure → alliance_rupture (invalid — not in transition table)", () => {
  assert(isValidTransition("closure", "alliance_rupture") === false, "expected false");
});
check("closure → stabilization (invalid)", () => {
  assert(isValidTransition("closure", "stabilization") === false, "expected false");
});
check("stabilization → alliance_rupture (valid)", () => {
  assert(isValidTransition("stabilization", "alliance_rupture") === true);
});
check("alliance_rupture → stabilization (valid)", () => {
  assert(isValidTransition("alliance_rupture", "stabilization") === true);
});
check("extended states: exploration_open → contact (uses baseStateOf)", () => {
  assert(isValidTransition("exploration_open", "contact") === true);
});
check("extended states: discharge_regulated → contact (valid)", () => {
  assert(isValidTransition("discharge_regulated", "contact") === true);
});
check("unknown state → true (passthrough, no graph entry)", () => {
  assert(isValidTransition("unknown_state", "exploration") === true);
});

// ─── STATE_INTENT spot checks ─────────────────────────────────────────────────

section("STATE_INTENT coverage");

check("all 11 extended states have an intent entry", () => {
  const states = [
    "exploration_open", "exploration_restrained",
    "contact", "stabilization", "alliance_rupture", "closure",
    "discharge_regulated", "discharge_dysregulated",
    "info_pure", "info_features", "info_psychoeducation"
  ];
  for (const s of states) {
    assert(typeof STATE_INTENT[s] === "string" && STATE_INTENT[s].length > 0,
      `missing or empty intent for '${s}'`);
  }
});

// ─── Summary ──────────────────────────────────────────────────────────────────

const total = passed + failed;
console.log(`\n${"═".repeat(60)}`);
console.log(`conversation-state-harness: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;
