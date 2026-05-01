"use strict";

/**
 * emergency-updater.js
 *
 * Logique de mise à jour des numéros d'urgence via Wikidata SPARQL.
 * Utilisé par :
 *   - scripts/update-emergency-numbers.js (CLI manuel)
 *   - server.js (refresh automatique mensuel)
 */

const https = require("https");
const fs = require("fs");

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

// ─── Core update logic ────────────────────────────────────────────────────────

/**
 * Met à jour les numéros d'urgence depuis Wikidata.
 *
 * @param {string} outputFile - Chemin absolu vers emergency-numbers.json
 * @param {string} [logPrefix] - Préfixe pour les logs console (ex: "[server]")
 * @returns {Promise<object>} - L'objet mis à jour (sans _meta), prêt pour emergencyNumbers en mémoire
 */
async function updateEmergencyNumbers(outputFile, logPrefix = "[emergency-updater]") {
  console.log(`${logPrefix} Démarrage mise à jour des numéros d'urgence...`);

  // 1. Charger le fichier actuel
  let current = {};
  try {
    const raw = fs.readFileSync(outputFile, "utf-8");
    current = JSON.parse(raw);
    const count = Object.keys(current).filter(k => !k.startsWith("_")).length;
    console.log(`${logPrefix} Fichier actuel chargé (${count} pays).`);
  } catch {
    console.warn(`${logPrefix} Fichier actuel introuvable ou invalide, départ depuis zéro.`);
  }

  // 2. Requêtes Wikidata
  let emergencyMap = {};
  let suicideMap = {};

  console.log(`${logPrefix} Requête SPARQL : numéros d'urgence...`);
  try {
    const result = await sparqlQuery(QUERY_EMERGENCY_NUMBERS);
    emergencyMap = extractBindings(result, "emergencyNumbers");
    console.log(`${logPrefix} ${Object.keys(emergencyMap).length} pays avec numéros d'urgence.`);
  } catch (err) {
    console.error(`${logPrefix} Échec requête urgences:`, err.message);
    console.warn(`${logPrefix} Conservation des données existantes pour les urgences.`);
  }

  console.log(`${logPrefix} Requête SPARQL : lignes de prévention suicide...`);
  try {
    const result = await sparqlQuery(QUERY_SUICIDE_LINES);
    suicideMap = extractBindings(result, "phones");
    console.log(`${logPrefix} ${Object.keys(suicideMap).length} pays avec lignes suicide.`);
  } catch (err) {
    console.error(`${logPrefix} Échec requête suicide:`, err.message);
    console.warn(`${logPrefix} Conservation des données existantes pour les lignes suicide.`);
  }

  // 3. Fusion
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

    const entry = {
      label: existing?.label || code,
      emergency: wikidataEmergency || existing?.emergency || null,
      suicide: wikidataSuicide || existing?.suicide || null
    };

    if (!existing) {
      newEntries++;
    } else if (entry.emergency !== existing.emergency || entry.suicide !== existing.suicide) {
      updatedEntries++;
    }

    updated[code] = entry;
  }

  // 4. Écriture sur disque
  fs.writeFileSync(outputFile, JSON.stringify(updated, null, 2), "utf-8");

  const totalCountries = Object.keys(updated).filter(k => !k.startsWith("_")).length;
  console.log(`${logPrefix} Terminé. ${totalCountries} pays au total. ${newEntries} nouveaux, ${updatedEntries} mis à jour.`);

  // Retourner l'objet sans _meta pour mise à jour en mémoire
  const inMemory = {};
  for (const [k, v] of Object.entries(updated)) {
    if (!k.startsWith("_")) inMemory[k] = v;
  }
  return inMemory;
}

module.exports = { updateEmergencyNumbers };
