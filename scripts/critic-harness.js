"use strict";

const {
  hasAgencyInjectionInReply,
  hasTheoreticalViolationHeuristic,
  isProceduralInstrumentalReply
} = require("../lib/critic");

// ─── Harness helpers ─────────────────────────────────────────────────────────

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

// ─── hasAgencyInjectionInReply ───────────────────────────────────────────────

section("hasAgencyInjectionInReply");

check("empty string → false", () => {
  assert(hasAgencyInjectionInReply("") === false);
});

check("clean reply → false", () => {
  assert(hasAgencyInjectionInReply("Je suis là avec toi.") === false);
});

check("'tu pourrais' → true", () => {
  assert(hasAgencyInjectionInReply("Tu pourrais essayer d'en parler.") === true);
});

check("'essaie de' → true", () => {
  assert(hasAgencyInjectionInReply("Essaie de te rappeler comment c'était.") === true);
});

check("'il faudrait' → true", () => {
  assert(hasAgencyInjectionInReply("Il faudrait peut-être y revenir.") === true);
});

check("'tu devrais' → true", () => {
  assert(hasAgencyInjectionInReply("Tu devrais prendre le temps d'y réfléchir.") === true);
});

check("'pourquoi ne pas' → true", () => {
  assert(hasAgencyInjectionInReply("Pourquoi ne pas essayer autrement ?") === true);
});

check("'je t'encourage' → true", () => {
  assert(hasAgencyInjectionInReply("Je t'encourage à explorer ça.") === true);
});

check("'je te conseille' → true", () => {
  assert(hasAgencyInjectionInReply("Je te conseille d'en parler à quelqu'un.") === true);
});

check("'n'hesite pas a' → true", () => {
  assert(hasAgencyInjectionInReply("N'hesite pas a me dire si c'est le cas.") === true);
});

check("'n'hésite pas à' → true", () => {
  assert(hasAgencyInjectionInReply("N'hésite pas à me dire si c'est le cas.") === true);
});

check("case-insensitive match on 'TU POURRAIS' → true", () => {
  assert(hasAgencyInjectionInReply("TU POURRAIS voir les choses autrement.") === true);
});

check("neutral question → false", () => {
  assert(hasAgencyInjectionInReply("Qu'est-ce qui se passe là pour toi ?") === false);
});

check("witnessing statement → false", () => {
  assert(hasAgencyInjectionInReply("Ce que tu décris, c'est lourd à porter.") === false);
});

// ─── hasTheoreticalViolationHeuristic ────────────────────────────────────────

section("hasTheoreticalViolationHeuristic");

check("empty string → false", () => {
  assert(hasTheoreticalViolationHeuristic("") === false);
});

check("clean reply → false", () => {
  assert(hasTheoreticalViolationHeuristic("Je t'entends.") === false);
});

check("'inconscient' → true", () => {
  assert(hasTheoreticalViolationHeuristic("Il y a peut-être quelque chose d'inconscient là.") === true);
});

check("'subconscient' → true", () => {
  assert(hasTheoreticalViolationHeuristic("Ton subconscient te parle.") === true);
});

check("'non-conscient' → true", () => {
  assert(hasTheoreticalViolationHeuristic("Un processus non-conscient se met en place.") === true);
});

check("'mecanisme de defense' → true", () => {
  assert(hasTheoreticalViolationHeuristic("C'est un mecanisme de defense classique.") === true);
});

check("'mécanisme de défense' → true", () => {
  assert(hasTheoreticalViolationHeuristic("C'est un mécanisme de défense qui protège.") === true);
});

check("'psychopathologie' → true", () => {
  assert(hasTheoreticalViolationHeuristic("Sur le plan de la psychopathologie…") === true);
});

check("'santé mentale' → true", () => {
  assert(hasTheoreticalViolationHeuristic("Pour ta santé mentale il faudrait consulter.") === true);
});

check("'sante mentale' → true", () => {
  assert(hasTheoreticalViolationHeuristic("Pour ta sante mentale il faudrait consulter.") === true);
});

check("'tu évites' → true", () => {
  assert(hasTheoreticalViolationHeuristic("Tu évites de regarder ça en face.") === true);
});

check("'tu evites' → true", () => {
  assert(hasTheoreticalViolationHeuristic("Tu evites de regarder ça en face.") === true);
});

check("'tu résistes' → true", () => {
  assert(hasTheoreticalViolationHeuristic("Tu résistes à ce mouvement.") === true);
});

check("'tu resistes' → true", () => {
  assert(hasTheoreticalViolationHeuristic("Tu resistes à ce mouvement.") === true);
});

check("'il y a une résistance' → true", () => {
  assert(hasTheoreticalViolationHeuristic("Il y a une résistance que je perçois.") === true);
});

check("'tu refuses de' → true", () => {
  assert(hasTheoreticalViolationHeuristic("Tu refuses de voir les choses comme elles sont.") === true);
});

check("'tu fais tout pour ne pas' → true", () => {
  assert(hasTheoreticalViolationHeuristic("Tu fais tout pour ne pas y revenir.") === true);
});

check("phenomenological question → false", () => {
  assert(hasTheoreticalViolationHeuristic("Qu'est-ce que tu remarques là dans ton corps ?") === false);
});

// ─── isProceduralInstrumentalReply ───────────────────────────────────────────

section("isProceduralInstrumentalReply");

check("empty string → false", () => {
  assert(isProceduralInstrumentalReply("") === false);
});

check("short presence reply → false", () => {
  assert(isProceduralInstrumentalReply("Je suis là avec toi dans ce que tu traverses.") === false);
});

check("procedural tone + instrumental object → true", () => {
  assert(isProceduralInstrumentalReply("Pour avancer, utilise l'outil de suivi disponible dans la plateforme.") === true);
});

check("procedural 'commence par' + 'fichier' → true", () => {
  assert(isProceduralInstrumentalReply("Commence par ouvrir le fichier de synthèse.") === true);
});

check("procedural without instrumental object → false", () => {
  // 'tu peux' alone without an instrumental object shouldn't trigger
  assert(isProceduralInstrumentalReply("Tu peux prendre le temps qu'il faut.") === false);
});

check("bullet list + instrumental object → true", () => {
  const reply = "Voici les étapes :\n- Ouvre l'application\n- Accède à la section historique";
  assert(isProceduralInstrumentalReply(reply) === true);
});

check("numbered list + instrument → true", () => {
  const reply = "1. Ouvre l'éditeur\n2. Navigue vers la section document\n3. Copie-colle le contenu";
  assert(isProceduralInstrumentalReply(reply) === true);
});

check("numbered list without instrumental object → false", () => {
  const reply = "1. Prends un moment\n2. Remarque ce qui se passe en toi\n3. Reste avec ça";
  assert(isProceduralInstrumentalReply(reply) === false);
});

check("'copier-coller' + 'document' → true", () => {
  assert(isProceduralInstrumentalReply("Tu peux copier-coller depuis le document original.") === true);
});

check("'voir comment contourner' + 'systeme' → true", () => {
  assert(isProceduralInstrumentalReply("On peut voir comment contourner le systeme.") === true);
});

// ─── Summary ─────────────────────────────────────────────────────────────────

console.log(`\n${"═".repeat(60)}`);
console.log(`critic-harness: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  process.exitCode = 1;
}
