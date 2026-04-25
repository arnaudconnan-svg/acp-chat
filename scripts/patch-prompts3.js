"use strict";
const fs = require("fs");
let c = fs.readFileSync("lib/prompts.js", "utf8");
let changes = 0;

function rep(label, oldStr, newStr) {
  if (c.includes(oldStr)) {
    c = c.replace(oldStr, newStr);
    console.log("OK " + label);
    changes++;
  } else {
    console.error("MISS " + label);
  }
}

const R = "\r\n";

// 1. Retirer "prefere les phrases courtes" de CASE_0 Forme (couvert par COMMON)
rep(
  "case0_dedup",
  [
    "- style sobre, vivant, peu demonstratif",
    "- prefere les phrases courtes ; evite les constructions avec plusieurs subordonnees enchainees ; une phrase dense de 10 mots vaut souvent plus qu'une phrase elaborate de 25",
    "- possibilite de phrases courtes isolees pour marquer un pivot"
  ].join(R),
  [
    "- style sobre, vivant, peu demonstratif",
    "- possibilite de phrases courtes isolees pour marquer un pivot"
  ].join(R)
);

// 2. Corriger le triple dans CASE_1 et retirer (couvert par COMMON)
rep(
  "case1_triple_fix",
  [
    "- prefere les phrases courtes ; evite les constructions en cascade ; si une phrase prend plus d'une ligne, cherche a la couper",
    "- prefere les phrases courtes ; evite les constructions en cascade ; si une phrase prend plus d'une ligne, cherche a la couper",
    "- prefere les phrases courtes ; evite les constructions en cascade ; si une phrase prend plus d'une ligne, cherche a la couper",
    "- garde une certaine liberte de style, sans lyrisme ni amorti pseudo-therapeutique"
  ].join(R),
  [
    "- garde une certaine liberte de style, sans lyrisme ni amorti pseudo-therapeutique"
  ].join(R)
);

// 3. Retirer "prefere les phrases courtes" de CASE_2 Forme (couvert par COMMON)
rep(
  "case2_dedup",
  [
    "  - toute phrase doit apporter une information nouvelle, sans repetition ni reformulation de l'idee deja exprimee",
    "  - prefere les phrases courtes et directes ; evite les constructions avec plusieurs subordonnees ; si une phrase fait plus d'une ligne, cherche a la couper"
  ].join(R),
  [
    "  - toute phrase doit apporter une information nouvelle, sans repetition ni reformulation de l'idee deja exprimee"
  ].join(R)
);

fs.writeFileSync("lib/prompts.js", c);
console.log(`\n${changes}/3 modifications appliquees`);
