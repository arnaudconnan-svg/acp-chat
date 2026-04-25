"use strict";

// ─── Crisis routing harness ───────────────────────────────────────────────────
//
// Teste buildCrisisRoutingDecision(suicide, flags) en isolation.
// Aucun serveur requis. Couvre les 4 routes possibles + cas limites.

const { buildCrisisRoutingDecision } = require("../lib/chat-routing");

let passed = 0;
let failed = 0;

function assert(label, actual, expected) {
  if (actual === expected) {
    console.log(`  ✓ ${label}`);
    passed++;
  } else {
    console.error(`  ✗ ${label} — attendu "${expected}", reçu "${actual}"`);
    failed++;
  }
}

function run(label, suicide, flags, expectedRoute) {
  const decision = buildCrisisRoutingDecision(suicide, flags);
  assert(label, decision.route, expectedRoute);
}

console.log("\nCrisis routing harness\n");

// ── N2 : risque immédiat ──────────────────────────────────────────────────────
run(
  "N2 → route n2",
  { suicideLevel: "N2", needsClarification: false, crisisResolved: false },
  { acuteCrisis: false },
  "n2"
);

run(
  "N2 + acuteCrisis already true → route n2 (N2 priorité absolue)",
  { suicideLevel: "N2", needsClarification: false, crisisResolved: false },
  { acuteCrisis: true },
  "n2"
);

// ── Acute followup : crise aiguë non résolue ─────────────────────────────────
run(
  "acuteCrisis=true + crisisResolved=false → route acute_followup",
  { suicideLevel: "N1", needsClarification: false, crisisResolved: false },
  { acuteCrisis: true },
  "acute_followup"
);

run(
  "acuteCrisis=true + N0 + crisisResolved=false → route acute_followup",
  { suicideLevel: "N0", needsClarification: false, crisisResolved: false },
  { acuteCrisis: true },
  "acute_followup"
);

// ── Resolved crisis : pas de followup ────────────────────────────────────────
run(
  "acuteCrisis=true + crisisResolved=true → route null (crise résolue)",
  { suicideLevel: "N0", needsClarification: false, crisisResolved: true },
  { acuteCrisis: true },
  null
);

// ── N1 clarification ─────────────────────────────────────────────────────────
run(
  "N1 + acuteCrisis=false → route n1_clarification",
  { suicideLevel: "N1", needsClarification: false, crisisResolved: false },
  { acuteCrisis: false },
  "n1_clarification"
);

run(
  "N0 + needsClarification=true → route n1_clarification",
  { suicideLevel: "N0", needsClarification: true, crisisResolved: false },
  { acuteCrisis: false },
  "n1_clarification"
);

// ── N0 normal : aucune route crise ───────────────────────────────────────────
run(
  "N0 + pas de crise + acuteCrisis=false → route null",
  { suicideLevel: "N0", needsClarification: false, crisisResolved: false },
  { acuteCrisis: false },
  null
);

run(
  "N0 + crisisResolved=true + acuteCrisis=false → route null",
  { suicideLevel: "N0", needsClarification: false, crisisResolved: true },
  { acuteCrisis: false },
  null
);

// ── Vérification du ruleId et priority ───────────────────────────────────────
{
  const d = buildCrisisRoutingDecision(
    { suicideLevel: "N2", needsClarification: false, crisisResolved: false },
    { acuteCrisis: false }
  );
  assert("N2 → ruleId = suicide_n2", d.ruleId, "suicide_n2");
  assert("N2 → priority = 10",       String(d.priority), "10");
}

{
  const d = buildCrisisRoutingDecision(
    { suicideLevel: "N0", needsClarification: false, crisisResolved: false },
    { acuteCrisis: false }
  );
  assert("N0 normal → ruleId = null",   d.ruleId,   null);
  assert("N0 normal → priority = null", d.priority, null);
}

// ─── Résumé ───────────────────────────────────────────────────────────────────
console.log(`\n${passed + failed} test(s) — ${passed} passé(s), ${failed} échoué(s)\n`);
if (failed > 0) process.exit(1);
