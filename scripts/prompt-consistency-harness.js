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
  const updateIntersessionMemory = String(registry.UPDATE_INTERSESSION_MEMORY || "");
  const intersessionTemplate = String(registry.NORMALIZE_INTERSESSION_MEMORY_TEMPLATE || "");

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
    "UPDATE_MEMORY structure keeps 3 sections with locked Anciens mouvements",
    updateMemory.includes("Contexte stable:") &&
      updateMemory.includes("Mouvements en cours:") &&
      updateMemory.includes("Anciens mouvements:") &&
      updateMemory.includes("Les trois blocs doivent toujours être présents") &&
      updateMemory.includes('laisse toujours "Anciens mouvements" à "-"'),
    "Missing strict 3-block runtime-compatible structure guard"
  );

  check(
    "removed dead memory prompts stay absent",
    !Object.prototype.hasOwnProperty.call(registry, "REWRITE_INTERPRETATION_REJECTION_MEMORY") &&
      !Object.prototype.hasOwnProperty.call(registry, "FINALIZE_MEMORY_CANDIDATE") &&
      !Object.prototype.hasOwnProperty.call(registry, "COMPRESS_INTERSESSION_MEMORY"),
    "Dead memory prompt keys were reintroduced"
  );

  check(
    "UPDATE_INTERSESSION_MEMORY exists",
    updateIntersessionMemory.length > 0,
    "Missing UPDATE_INTERSESSION_MEMORY prompt"
  );

  check(
    "UPDATE_INTERSESSION_MEMORY enforces single-block format",
    updateIntersessionMemory.includes("FORMAT OBLIGATOIRE") &&
      updateIntersessionMemory.includes("Memoire inter-session:") &&
      updateIntersessionMemory.includes("Le bloc doit toujours etre present"),
    "Missing strict single-block format guard"
  );

  check(
    "UPDATE_INTERSESSION_MEMORY keeps compact factual constraints",
    updateIntersessionMemory.includes("style factuel, concret, sans theorie ni interpretation") &&
      updateIntersessionMemory.includes("4 a 10 items max") &&
      updateIntersessionMemory.includes("chaque item doit rester compact"),
    "Missing compact factual constraints"
  );

  check(
    "NORMALIZE_INTERSESSION_MEMORY_TEMPLATE is canonical",
    /^Memoire inter-session:\s*\n-\s*$/.test(intersessionTemplate.trim()),
    "Unexpected intersession memory template"
  );

  if (failed > 0) {
    console.error(`\n[PROMPT-CONSISTENCY] ${passed} passed, ${failed} failed.`);
    process.exit(1);
  }

  console.log(`\n[PROMPT-CONSISTENCY] ${passed} passed, 0 failed.`);
}

run();
