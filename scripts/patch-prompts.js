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

// 1. COMMON_EXPLORATION — bloc Registre et langue
rep(
  "common_registre",
  [
    "- quand la relation semble mal ajustee, ne transforme pas automatiquement cette rupture en nouveau contenu d'exploration ; traite-la d'abord comme un possible signal de mauvaise strategie de reponse",
    "",
    "Forme generale :"
  ].join(R),
  [
    "- quand la relation semble mal ajustee, ne transforme pas automatiquement cette rupture en nouveau contenu d'exploration ; traite-la d'abord comme un possible signal de mauvaise strategie de reponse",
    "",
    "Registre et langue :",
    "- cale ton niveau de langue sur celui de l'utilisateur ; si son message est direct, courant ou familier, ta reponse peut et doit l'etre aussi ; un registre soutenu face a un message familier cree une distance artificielle",
    "- prefere les phrases courtes ; une phrase directe de 10-12 mots pese souvent plus qu'une construction avec trois propositions subordonnees enchainees",
    "- n'habille pas une observation simple avec du vocabulaire pseudo-phenomenologique ; 'ca tourne en boucle' vaut mieux que 'une boucle d\u2019agitation cherchant son ancrage'",
    "- les formulations 'je reconnais', 'je percois que', 'je ressens comme' peuvent sonner clinique ; selon le registre de la personne, une adresse directe en 'tu' ou une formulation en 'ca' peut etre plus juste",
    "",
    "Forme generale :"
  ].join(R)
);

// 2. Niveau 0 Direction — relance non obligatoire
rep(
  "dir0_relance",
  [
    "  - privilegie une lecture vivante, situee et un peu remuante plutot qu'un reflet propre ou consensuel",
    "",
    "Forme :"
  ].join(R),
  [
    "  - privilegie une lecture vivante, situee et un peu remuante plutot qu'un reflet propre ou consensuel",
    "  - la relance n'est pas obligatoire ; une lecture qui tient sans question peut etre plus juste qu'une relance systematique",
    "",
    "Forme :"
  ].join(R)
);

// 3. Niveau 0 Forme — phrase courte
rep(
  "forme0_court",
  [
    "- style sobre, vivant, peu demonstratif",
    "- possibilite de phrases courtes isolees pour marquer un pivot"
  ].join(R),
  [
    "- style sobre, vivant, peu demonstratif",
    "- prefere les phrases courtes ; evite les constructions avec plusieurs subordonnees enchainees ; une phrase dense de 10 mots vaut souvent plus qu'une phrase elaborate de 25",
    "- possibilite de phrases courtes isolees pour marquer un pivot"
  ].join(R)
);

// 4. Niveau 1 Forme — phrase courte
rep(
  "forme1_court",
  [
    "- garde une certaine liberte de style, sans lyrisme ni amorti pseudo-therapeutique",
    "  - reponse plutot breve, dense et peu demonstrative",
    "`,"
  ].join(R),
  [
    "- prefere les phrases courtes ; evite les constructions en cascade ; si une phrase prend plus d'une ligne, cherche a la couper",
    "- garde une certaine liberte de style, sans lyrisme ni amorti pseudo-therapeutique",
    "  - reponse plutot breve, dense et peu demonstrative",
    "`,"
  ].join(R)
);

// 5. Niveau 2 Forme — phrase courte
rep(
  "forme2_court",
  [
    "  - toute phrase doit apporter une information nouvelle, sans repetition ni reformulation de l'idee deja exprimee",
    "`,"
  ].join(R),
  [
    "  - toute phrase doit apporter une information nouvelle, sans repetition ni reformulation de l'idee deja exprimee",
    "  - prefere les phrases courtes et directes ; evite les constructions avec plusieurs subordonnees ; si une phrase fait plus d'une ligne, cherche a la couper",
    "`,"
  ].join(R)
);

fs.writeFileSync("lib/prompts.js", c);
console.log(`\n${changes}/5 modifications appliquees`);
