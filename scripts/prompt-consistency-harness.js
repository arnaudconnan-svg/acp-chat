'use strict';

const { buildDefaultPromptRegistry } = require('../lib/prompts');

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

function check(label, condition, details = '') {
  if (condition) {
    pass(label);
  } else {
    fail(label, details);
  }
}

function run() {
  const registry = buildDefaultPromptRegistry();
  const extractOngoing = String(registry.EXTRACT_ONGOING_MOVEMENTS || '');
  const extractStable = String(registry.EXTRACT_STABLE_CONTEXT || '');
  const cleanupAncient = String(registry.CLEANUP_ANCIENT_DUPLICATES || '');
  const updateIntersessionMemory = String(
    registry.UPDATE_INTERSESSION_MEMORY || ''
  );
  const intersessionTemplate = String(
    registry.NORMALIZE_INTERSESSION_MEMORY_TEMPLATE || ''
  );
  const commonExploration = String(registry.COMMON_EXPLORATION || '');
  const explorationCalibration = String(
    registry.ANALYZE_EXPLORATION_CALIBRATION || ''
  );
  const phenomenologicalFollow = String(
    registry.EXPLORATION_SIGNAL_PHENOMENOLOGICAL_FOLLOW || ''
  );
  const interpretationRejection = String(
    registry.ANALYZE_INTERPRETATION_REJECTION || ''
  );

  check(
    'EXTRACT_ONGOING_MOVEMENTS exists',
    extractOngoing.length > 0,
    'Missing EXTRACT_ONGOING_MOVEMENTS prompt'
  );

  check(
    'EXTRACT_ONGOING_MOVEMENTS enforces strict JSON output',
    extractOngoing.includes('"items"') &&
      extractOngoing.includes('JSON valide uniquement'),
    'Missing strict JSON contract for EXTRACT_ONGOING_MOVEMENTS'
  );

  check(
    'EXTRACT_ONGOING_MOVEMENTS caps list to 2 items',
    extractOngoing.includes('max 2 items'),
    'Missing max-2 guard for ongoing extraction'
  );

  check(
    'embodied experience remains optional rather than privileged',
    commonExploration.includes('sans imposer une voie corporelle') &&
      commonExploration.includes('ne prouve ni une incomprehension') &&
      !commonExploration.includes('privilegie une trace corporelle'),
    'COMMON_EXPLORATION still gives bodily experience superior authority'
  );

  check(
    'dismissed exploration paths cannot return in softened form',
    commonExploration.includes('meme sous forme indirecte, attenuee') &&
      commonExploration.includes('elle le reintroduit spontanement'),
    'Missing immediate non-reproposal protection'
  );

  check(
    'phenomenological follow covers several lived-experience channels',
    phenomenologicalFollow.includes('emotion, une relation, une image') &&
      phenomenologicalFollow.includes("Le corporel n'a aucune priorite"),
    'phenomenological_follow remains narrowly somatic'
  );

  check(
    'body metaphors are not promoted to declared sensations',
    phenomenologicalFollow.includes(
      'metaphore mentionnant le corps en sensation declaree'
    ) &&
      extractOngoing.includes(
        "metaphore qui mentionne le corps n'est pas, a elle seule"
      ),
    'Missing metaphor/sensation distinction'
  );

  check(
    'spontaneous sensations can be followed without imposed meaning',
    phenomenologicalFollow.includes('une sensation') &&
      phenomenologicalFollow.includes("N'impose aucune signification"),
    'Spontaneous sensations are either excluded or over-interpreted'
  );

  check(
    'saturated relance window has no bodily exception',
    explorationCalibration.includes(
      "le contenu du moment ne suffit pas a annuler cette saturation"
    ) && !explorationCalibration.includes('EXCEPTION : si un ressenti corporel'),
    'Somatic calibration exception is still active'
  );

  check(
    'bodily questions remain open and non-presupposing',
    commonExploration.includes('ouverte, facultative et sans presupposer') &&
      commonExploration.includes('catalogue de zones ou de sensations'),
    'Missing protection against bodily catalogues or presuppositions'
  );

  check(
    'feedback about the bot is classified as intervention feedback',
    interpretationRejection.includes(
      "feedback sur la conduite du bot est d'abord un feedback relationnel"
    ) && interpretationRejection.includes('reformulations enferment'),
    'Intervention feedback may still be internalized as user material'
  );

  check(
    'removed somatic policy is not referenced by active prompts',
    !Object.values(registry).some((prompt) =>
      /politique somatique|focus somatique/i.test(String(prompt || ''))
    ),
    'An active prompt still references the removed somatic policy'
  );

  check(
    'EXTRACT_STABLE_CONTEXT exists',
    extractStable.length > 0,
    'Missing EXTRACT_STABLE_CONTEXT prompt'
  );

  check(
    'EXTRACT_STABLE_CONTEXT enforces strict JSON output',
    extractStable.includes('"items"') &&
      extractStable.includes('JSON valide uniquement'),
    'Missing strict JSON contract for EXTRACT_STABLE_CONTEXT'
  );

  check(
    'CLEANUP_ANCIENT_DUPLICATES exists',
    cleanupAncient.length > 0,
    'Missing CLEANUP_ANCIENT_DUPLICATES prompt'
  );

  check(
    'CLEANUP_ANCIENT_DUPLICATES enforces deleteAncientIds contract',
    cleanupAncient.includes('"deleteAncientIds"') &&
      cleanupAncient.includes('JSON valide uniquement'),
    'Missing strict deleteAncientIds contract'
  );

  check(
    'legacy UPDATE_MEMORY prompt stays absent',
    !Object.prototype.hasOwnProperty.call(registry, 'UPDATE_MEMORY'),
    'Legacy UPDATE_MEMORY key should not be present'
  );

  check(
    'legacy ANALYZE_MEMORY_UPDATE_NEEDS prompt stays absent',
    !Object.prototype.hasOwnProperty.call(
      registry,
      'ANALYZE_MEMORY_UPDATE_NEEDS'
    ),
    'Legacy ANALYZE_MEMORY_UPDATE_NEEDS key should not be present'
  );

  check(
    'removed dead memory prompts stay absent',
    !Object.prototype.hasOwnProperty.call(
      registry,
      'REWRITE_INTERPRETATION_REJECTION_MEMORY'
    ) &&
      !Object.prototype.hasOwnProperty.call(
        registry,
        'FINALIZE_MEMORY_CANDIDATE'
      ) &&
      !Object.prototype.hasOwnProperty.call(
        registry,
        'COMPRESS_INTERSESSION_MEMORY'
      ),
    'Dead memory prompt keys were reintroduced'
  );

  check(
    'UPDATE_INTERSESSION_MEMORY exists',
    updateIntersessionMemory.length > 0,
    'Missing UPDATE_INTERSESSION_MEMORY prompt'
  );

  check(
    'UPDATE_INTERSESSION_MEMORY enforces strict JSON items output',
    updateIntersessionMemory.includes('FORMAT DE SORTIE STRICT') &&
      updateIntersessionMemory.includes('{"items":["fait stable 1"') &&
      updateIntersessionMemory.includes('JSON valide'),
    'Missing strict intersession JSON output guard'
  );

  check(
    'UPDATE_INTERSESSION_MEMORY keeps all useful facts within 6000 characters',
    updateIntersessionMemory.includes(
      'style factuel, concret, sans theorie ni interpretation'
    ) &&
      updateIntersessionMemory.includes(
        'sans selection arbitraire par nombre de points'
      ) &&
      updateIntersessionMemory.includes('budget de 6000 caracteres') &&
      !updateIntersessionMemory.includes('1 a 10 points distincts'),
    'Intersession prompt must use the 6000-character budget without top-N selection'
  );

  check(
    'runtime intersession compaction prompt stays absent',
    !Object.prototype.hasOwnProperty.call(
      registry,
      'COMPACT_INTERSESSION_RUNTIME_MEMORY'
    ),
    'Runtime compaction prompt was reintroduced'
  );

  check(
    'NORMALIZE_INTERSESSION_MEMORY_TEMPLATE is canonical',
    /^Memoire inter-session:\s*\n-\s*$/.test(intersessionTemplate.trim()),
    'Unexpected intersession memory template'
  );

  if (failed > 0) {
    console.error(`\n[PROMPT-CONSISTENCY] ${passed} passed, ${failed} failed.`);
    process.exit(1);
  }

  console.log(`\n[PROMPT-CONSISTENCY] ${passed} passed, 0 failed.`);
}

run();
