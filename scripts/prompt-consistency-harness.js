"use strict";

const { buildDefaultPromptRegistry } = require("../lib/prompts");

let passed = 0;
let failed = 0;

function pass(label) {
  passed += 1;
  console.log(`[PASS] ${label}`);
}

function fail(label, details) {
  failed += 1;
  console.error(`[FAIL] ${label}`);
  if (details) {
    console.error(`       ${details}`);
  }
}

function check(label, condition, details = "") {
  if (condition) {
    pass(label);
  } else {
    fail(label, details);
  }
}

function run() {
  const registry = buildDefaultPromptRegistry();
  const updateMemory = String(registry.UPDATE_MEMORY || "");

  check(
    "UPDATE_MEMORY exists",
    updateMemory.length > 0,
    "Missing UPDATE_MEMORY prompt"
  );

  const periodicMatches = updateMemory.match(/- `periodic_refresh` :/g) || [];
  check(
    "periodic_refresh instruction appears exactly once",
    periodicMatches.length === 1,
    `Found ${periodicMatches.length} periodic_refresh instructions`
  );

  check(
    "legacy transfer wording is absent",
    !updateMemory.includes('Copie l\'etat precedent de "Mouvements en cours" dans "Anciens mouvements"'),
    "Found legacy LLM-driven transfer instruction"
  );

  check(
    "deterministic transfer wording is present",
    updateMemory.includes('Le transfert vers "Anciens mouvements" est géré automatiquement'),
    "Missing deterministic transfer instruction"
  );

  check(
    "legacy 4.e ANCIENS MOUVEMENTS section is absent",
    !updateMemory.includes("4.e ANCIENS MOUVEMENTS"),
    "Found legacy ANCIENS MOUVEMENTS section"
  );

  check(
    "UPDATE_MEMORY structure stays 2 writable sections",
    updateMemory.includes("Les deux blocs doivent toujours être présents") && updateMemory.includes('ne l\'écris pas'),
    "Missing explicit 2-block writable structure guard"
  );

  if (failed > 0) {
    console.error(`\n[PROMPT-CONSISTENCY] ${passed} passed, ${failed} failed.`);
    process.exit(1);
  }

  console.log(`\n[PROMPT-CONSISTENCY] ${passed} passed, 0 failed.`);
}

run();
