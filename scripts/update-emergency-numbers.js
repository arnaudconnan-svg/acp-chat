"use strict";

/**
 * update-emergency-numbers.js
 *
 * Interroge Wikidata via SPARQL pour mettre à jour data/emergency-numbers.json.
 * Les numéros déjà présents dans le fichier sont conservés si Wikidata ne retourne
 * aucune donnée pour ce pays (les entrées manuelles priment sur les données Wikidata).
 *
 * Usage : npm run update:emergency-numbers
 */

const path = require("path");
const { updateEmergencyNumbers } = require("../lib/emergency-updater");

const OUTPUT_FILE = path.join(__dirname, "../data/emergency-numbers.json");

updateEmergencyNumbers(OUTPUT_FILE, "[update-emergency-numbers]")
  .then(() => {
    console.log("[update-emergency-numbers] RAPPEL : vérifier manuellement les entrées 'label' pour les nouveaux pays (Wikidata ne fournit pas les noms en français).");
  })
  .catch(err => {
    console.error("[update-emergency-numbers] Erreur fatale:", err.message);
    process.exit(1);
  });