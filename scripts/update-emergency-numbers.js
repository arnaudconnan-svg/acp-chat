"use strict";

/**
 * update-emergency-numbers.js
 *
 * Interroge Wikidata via SPARQL pour mettre à jour data/emergency-numbers.json.
 * Les numéros déjà présents dans le fichier sont conservés si Wikidata ne retourne
 * aucune donnée pour ce pays (les entrées manuelles priment sur les données Wikidata).
 *
 * Usage : npm run update:emergency-numbers
 *
 * Comportement :
 *   1. Charge le fichier actuel (emergency-numbers.json) comme base de référence.
 *   2. Lance deux requêtes SPARQL :
 *      - numéros d'urgence généralistes (P3911) par pays
 *      - lignes de crise/suicide (instances de Q21491168) avec numéro de téléphone (P1329) par pays
 *   3. Fusionne : les entrées Wikidata écrasent uniquement les champs non-null obtenus.
 *   4. Les entrées manuelles (celles dont le suicide est curé à la main) ne sont jamais effacées
 *      si Wikidata ne retourne rien pour ce pays.
 *   5. Écrit le fichier mis à jour.
 *
 * Note : Wikidata ne couvre pas tous les pays, notamment pour les lignes suicide.
 * La curation manuelle reste nécessaire pour les pays non couverts.
 */

const https = require("https");
const fs = require("fs");
const path = require("path");

const OUTPUT_FILE = path.join(__dirname, "../data/emergency-numbers.json");
const WIKIDATA_SPARQL_URL = "https://query.wikidata.org/sparql";
const USER_AGENT = "facilitatio-emergency-numbers-updater/1.0 (facilitat.io; contact via maintainer)";

// ─── SPARQL queries ───────────────────────────────────────────────────────────

const QUERY_EMERGENCY_NUMBERS = `
SELECT ?countryCode (GROUP_CONCAT(DISTINCT ?emergencyNumber; SEPARATOR=", ") AS ?emergencyNumbers) WHERE {
  ?country wdt:P31 wd:Q6256 ;
           wdt:P297 ?countryCode ;
           wdt:P3911 ?emergencyNumber .
}
GROUP BY ?countryCode
ORDER BY ?countryCode
`;

const QUERY_SUICIDE_LINES = `
SELECT ?countryCode (GROUP_CONCAT(DISTINCT ?phone; SEPARATOR=", ") AS ?phones) WHERE {
  ?hotline wdt:P31 wd:Q21491168 ;
           wdt:P17 ?country ;
           wdt:P1329 ?phone .
  ?country wdt:P297 ?countryCode .
}
GROUP BY ?countryCode
ORDER BY ?countryCode
`;

// ─── HTTP helper ──────────────────────────────────────────────────────────────

function sparqlQuery(query) {
  return new Promise((resolve, reject) => {
    const params = new URLSearchParams({ query, format: "json" });
    const url = `${WIKIDATA_SPARQL_URL}?${params.toString()}`;

    const options = {
      headers: {
        "Accept": "application/sparql-results+json",
        "User-Agent": USER_AGENT
      },
      timeout: 30000
    };

    https.get(url, options, (res) => {
      let data = "";
      res.on("data", chunk => { data += chunk; });
      res.on("end", () => {
        if (res.statusCode !== 200) {
          reject(new Error(`HTTP ${res.statusCode}: ${data.slice(0, 200)}`));
          return;
        }
        try {
          resolve(JSON.parse(data));
        } catch (err) {
          reject(new Error(`JSON parse error: ${err.message}`));
        }
      });
    }).on("error", reject).on("timeout", () => reject(new Error("Request timeout")));
  });
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function extractBindings(result, varName) {
  const bindings = result?.results?.bindings || [];
  const map = {};
  for (const row of bindings) {
    const code = row.countryCode?.value;
    const value = row[varName]?.value;
    if (code && value) {
      map[code.toUpperCase()] = value.trim();
    }
  }
  return map;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log("[update-emergency-numbers] Démarrage...");

  // 1. Load current file
  let current = {};
  try {
    const raw = fs.readFileSync(OUTPUT_FILE, "utf-8");
    current = JSON.parse(raw);
    console.log(`[update-emergency-numbers] Fichier actuel chargé (${Object.keys(current).filter(k => !k.startsWith("_")).length} pays).`);
  } catch {
    console.warn("[update-emergency-numbers] Fichier actuel introuvable ou invalide, départ depuis zéro.");
  }

  // 2. Query Wikidata
  let emergencyMap = {};
  let suicideMap = {};

  console.log("[update-emergency-numbers] Requête SPARQL : numéros d'urgence...");
  try {
    const result = await sparqlQuery(QUERY_EMERGENCY_NUMBERS);
    emergencyMap = extractBindings(result, "emergencyNumbers");
    console.log(`[update-emergency-numbers] ${Object.keys(emergencyMap).length} pays avec numéros d'urgence.`);
  } catch (err) {
    console.error("[update-emergency-numbers] Échec requête urgences:", err.message);
    console.warn("[update-emergency-numbers] Poursuite avec données existantes pour les urgences.");
  }

  console.log("[update-emergency-numbers] Requête SPARQL : lignes de prévention suicide...");
  try {
    const result = await sparqlQuery(QUERY_SUICIDE_LINES);
    suicideMap = extractBindings(result, "phones");
    console.log(`[update-emergency-numbers] ${Object.keys(suicideMap).length} pays avec lignes suicide.`);
  } catch (err) {
    console.error("[update-emergency-numbers] Échec requête suicide:", err.message);
    console.warn("[update-emergency-numbers] Poursuite avec données existantes pour les lignes suicide.");
  }

  // 3. Merge: collect all country codes from both sources + existing
  const allCodes = new Set([
    ...Object.keys(emergencyMap),
    ...Object.keys(suicideMap),
    ...Object.keys(current).filter(k => !k.startsWith("_"))
  ]);

  const meta = current._meta || null;
  const updated = meta ? { _meta: meta } : {};
  let newEntries = 0;
  let updatedEntries = 0;

  for (const code of [...allCodes].sort()) {
    if (code.startsWith("_")) continue;
    if (!/^[A-Z]{2}$/.test(code)) continue;

    const existing = current[code] || null;
    const wikidataEmergency = emergencyMap[code] || null;
    const wikidataSuicide = suicideMap[code] || null;

    // Build merged entry:
    // - label: preserve existing, Wikidata doesn't provide French labels
    // - emergency: Wikidata wins if available, else keep existing
    // - suicide: Wikidata wins if available, else keep existing (manual curation preserved)
    const entry = {
      label: existing?.label || code,
      emergency: wikidataEmergency || existing?.emergency || null,
      suicide: wikidataSuicide || existing?.suicide || null
    };

    if (!existing) {
      newEntries++;
    } else if (
      entry.emergency !== existing.emergency ||
      entry.suicide !== existing.suicide
    ) {
      updatedEntries++;
    }

    updated[code] = entry;
  }

  // 4. Write
  const json = JSON.stringify(updated, null, 2);
  fs.writeFileSync(OUTPUT_FILE, json, "utf-8");

  const totalCountries = Object.keys(updated).filter(k => !k.startsWith("_")).length;
  console.log(`[update-emergency-numbers] Terminé. ${totalCountries} pays au total. ${newEntries} nouveaux, ${updatedEntries} mis à jour.`);
  console.log(`[update-emergency-numbers] Fichier écrit : ${OUTPUT_FILE}`);
  console.log("[update-emergency-numbers] RAPPEL : vérifier manuellement les entrées 'label' pour les nouveaux pays (Wikidata ne fournit pas les noms en français).");
}

main().catch(err => {
  console.error("[update-emergency-numbers] Erreur fatale:", err.message);
  process.exit(1);
});
