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
  const extractOngoing = String(registry.EXTRACT_ONGOING_MOVEMENTS || "");
  const extractStable = String(registry.EXTRACT_STABLE_CONTEXT || "");
  const cleanupAncient = String(registry.CLEANUP_ANCIENT_DUPLICATES || "");
  const updateIntersessionMemory = String(registry.UPDATE_INTERSESSION_MEMORY || "");
  const intersessionTemplate = String(registry.NORMALIZE_INTERSESSION_MEMORY_TEMPLATE || "");

  check(
    "EXTRACT_ONGOING_MOVEMENTS exists",
    extractOngoing.length > 0,
    "Missing EXTRACT_ONGOING_MOVEMENTS prompt"
  );

  check(
    "EXTRACT_ONGOING_MOVEMENTS enforces strict JSON output",
    extractOngoing.includes('"items"') && extractOngoing.includes("JSON valide uniquement"),
    "Missing strict JSON contract for EXTRACT_ONGOING_MOVEMENTS"
  );

  check(
    "EXTRACT_ONGOING_MOVEMENTS caps list to 2 items",
    extractOngoing.includes("max 2 items"),
    "Missing max-2 guard for ongoing extraction"
  );

  check(
    "EXTRACT_STABLE_CONTEXT exists",
    extractStable.length > 0,
    "Missing EXTRACT_STABLE_CONTEXT prompt"
  );

  check(
    "EXTRACT_STABLE_CONTEXT enforces strict JSON output",
    extractStable.includes('"items"') && extractStable.includes("JSON valide uniquement"),
    "Missing strict JSON contract for EXTRACT_STABLE_CONTEXT"
  );

  check(
    "CLEANUP_ANCIENT_DUPLICATES exists",
    cleanupAncient.length > 0,
    "Missing CLEANUP_ANCIENT_DUPLICATES prompt"
  );

  check(
    "CLEANUP_ANCIENT_DUPLICATES enforces deleteAncientIds contract",
    cleanupAncient.includes('"deleteAncientIds"') && cleanupAncient.includes("JSON valide uniquement"),
    "Missing strict deleteAncientIds contract"
  );

  check(
    "legacy UPDATE_MEMORY prompt stays absent",
    !Object.prototype.hasOwnProperty.call(registry, "UPDATE_MEMORY"),
    "Legacy UPDATE_MEMORY key should not be present"
  );

  check(
    "legacy ANALYZE_MEMORY_UPDATE_NEEDS prompt stays absent",
    !Object.prototype.hasOwnProperty.call(registry, "ANALYZE_MEMORY_UPDATE_NEEDS"),
    "Legacy ANALYZE_MEMORY_UPDATE_NEEDS key should not be present"
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
    "UPDATE_INTERSESSION_MEMORY enforces natural editable format",
    updateIntersessionMemory.includes("FORMAT ATTENDU") &&
      updateIntersessionMemory.includes("texte naturel lisible et editable par un humain") &&
      updateIntersessionMemory.includes("pas de prefixe technique") &&
      updateIntersessionMemory.includes("tu peux utiliser des puces \"-\" si utile, mais ce n'est pas obligatoire"),
    "Missing natural editable format guard"
  );

  check(
    "UPDATE_INTERSESSION_MEMORY keeps factual compact constraints",
    updateIntersessionMemory.includes("style factuel, concret, sans theorie ni interpretation") &&
      updateIntersessionMemory.includes("4 a 10 points max") &&
      updateIntersessionMemory.includes("chaque point doit rester compact (une phrase courte)"),
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
