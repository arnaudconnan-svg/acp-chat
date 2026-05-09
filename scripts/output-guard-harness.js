"use strict";

const {
  hasSignalLeakRisk,
  stripSignalLeakFragments,
  validateReplyContract,
  buildRepairDirectives,
  buildDeterministicFallbackReply
} = require("../lib/output-guard");

let passed = 0;
let failed = 0;

function assert(condition, message) {
  if (!condition) throw new Error(message || "assertion failed");
}

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

check("signal leak detected on bracket annotation", () => {
  assert(hasSignalLeakRisk("[signaux: etat: exploration_open] texte") === true, "expected signal leak detection");
});

check("signal leak strip removes annotation", () => {
  const out = stripSignalLeakFragments("Bonjour. [signaux: etat: exploration_open]");
  assert(!out.includes("signaux"), "expected annotation stripped");
});

check("contract validator catches length overflow", () => {
  const result = validateReplyContract({
    reply: "Une phrase. Deuxieme phrase. Troisieme phrase.",
    postureDecision: { maxSentences: 2, forbidden: [] },
    message: ""
  });
  assert(result.violations.includes("contract_length_exceeded"), "expected length violation");
});

check("contract validator catches relance when forbidden", () => {
  const result = validateReplyContract({
    reply: "Je t'entends. Qu'est-ce qui se passe maintenant ?",
    postureDecision: { forbidden: ["relance"] },
    message: ""
  });
  assert(result.violations.includes("forbidden_relance"), "expected forbidden_relance");
});

check("contract validator catches open question when forbidden", () => {
  const result = validateReplyContract({
    reply: "Comment ca se passe pour toi ?",
    postureDecision: { forbidden: ["open_question"] },
    message: ""
  });
  assert(result.violations.includes("forbidden_open_question"), "expected forbidden_open_question");
});

check("contract validator catches prescriptive language", () => {
  const result = validateReplyContract({
    reply: "Tu pourrais essayer de prendre de la distance.",
    postureDecision: { forbidden: ["prescriptive_language"] },
    message: ""
  });
  assert(result.violations.includes("forbidden_prescriptive_language"), "expected forbidden_prescriptive_language");
});

check("repair directives generated for violations", () => {
  const directives = buildRepairDirectives([
    "contract_length_exceeded",
    "forbidden_relance",
    "signal_leak"
  ]);
  assert(Array.isArray(directives) && directives.length >= 3, "expected multiple directives");
});

check("closure fallback does not reopen session", () => {
  const out = buildDeterministicFallbackReply({ conversationState: "closure", formalAddress: false });
  assert(!out.includes("revenir"), "closure fallback should not invite to return");
});

console.log(`\n[OUTPUT-GUARD] ${passed} passed, ${failed} failed.`);
if (failed > 0) process.exitCode = 1;
