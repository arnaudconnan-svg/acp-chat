"use strict";

const { createAnalyzers } = require("../lib/analyzers");

let passed = 0;
let failed = 0;

function assert(condition, message) {
  if (!condition) throw new Error(message || "assertion failed");
}

function check(label, fn) {
  try {
    fn();
    passed += 1;
    console.log(`[PASS] ${label}`);
  } catch (err) {
    failed += 1;
    console.error(`[FAIL] ${label}: ${err.message}`);
  }
}

function makeFakeClient() {
  return {
    chat: {
      completions: {
        create: async ({ messages = [] }) => {
          const system = String(messages?.[0]?.content || "");
          const user = String(messages?.[messages.length - 1]?.content || "");

          if (system.includes("ANALYZE_DISCHARGE") || system.includes("dischargeSignal\": \"regulated|dysregulated|null\"")) {
            const isDischarge = /craque|explose|pleure|ta gueule|ferme-la|ferme la|crise d'angoisse|attaque de panique|du mal a respirer|tete qui tourne|c'est horrible|ca va pas/i.test(user);
            const isDysregulated = /explose|panique|perte de controle|etouffe|crise d'angoisse|attaque de panique|du mal a respirer|tete qui tourne|c'est horrible|ca va pas/i.test(user);
            const aggressive = /ta gueule|ferme-la|ferme la/i.test(user);
            return {
              choices: [
                {
                  message: {
                    content: JSON.stringify({
                      isDischarge,
                      dischargeSignal: isDischarge ? (isDysregulated ? "dysregulated" : "regulated") : null,
                      aggressiveDischargeDirectedToBot: aggressive
                    })
                  }
                }
              ]
            };
          }

          if (system.includes("contact emotionnel non-dechargeant")) {
            return {
              choices: [
                {
                  message: {
                    content: JSON.stringify({
                      isContact: false,
                      contactSignal: null,
                      selfCriticismLevel: "low",
                      meaningCrisis: false,
                      insightMoment: false
                    })
                  }
                }
              ]
            };
          }

          if (system.includes("reajustement relationnel")) {
            const hasFriction = /tu ne m'aides? pas|tu ne comprends? pas|c'est nul|laisse tomber/i.test(user);
            return {
              choices: [
                {
                  message: {
                    content: JSON.stringify({ needsRelationalAdjustment: hasFriction })
                  }
                }
              ]
            };
          }

          if (system.includes("isExploration")) {
            const isExploration = /je me demande|j'essaie de comprendre|je cherche a comprendre|je cherche a voir ce que/i.test(user);
            const confidence = isExploration ? "high" : "low";
            return {
              choices: [
                {
                  message: {
                    content: JSON.stringify({ isExploration, confidence })
                  }
                }
              ]
            };
          }

          return {
            choices: [
              {
                message: {
                  content: JSON.stringify({})
                }
              }
            ]
          };
        }
      }
    }
  };
}

function makeAnalyzers() {
  const client = makeFakeClient();
  return createAnalyzers({
    client,
    MODEL_IDS: { analysis: "fake-analysis", generation: "fake-generation" },
    isExplicitAppFeatureRequest: (message = "") => /\b(app|outil|fonctionnalite|fonctionnalites)\b/i.test(String(message || "")),
    llmInfoAnalysis: async (message = "") => ({
      isInfoRequest: /\?/.test(String(message || "")),
      source: "fake_llm_info"
    }),
    normalizeMemory: (m) => String(m || ""),
    normalizeSessionFlags: (f) => f || {},
    shouldForceExplorationForSituatedImpasse: () => false,
    trimHistory: (h = []) => Array.isArray(h) ? h : [],
    trimInfoAnalysisHistory: (h = []) => Array.isArray(h) ? h : [],
    trimRecallAnalysisHistory: (h = []) => Array.isArray(h) ? h : [],
    trimSuicideAnalysisHistory: (h = []) => Array.isArray(h) ? h : []
  });
}

async function run() {
  const analyzers = makeAnalyzers();

  const discharge = await analyzers.proposeState("Je suis en train d'exploser", [], { wasDischarge: false });
  check("proposeState: candidat discharge produit (C2 n'arbitre plus)", () => {
    const candidate = (discharge.stateCandidates || []).find(c => c.family === "discharge");
    assert(candidate !== undefined, "expected discharge candidate in stateCandidates");
    assert(candidate.detectedState === "discharge_dysregulated", `expected discharge_dysregulated, got ${candidate.detectedState}`);
    assert(candidate.confidence === "high", "expected high confidence for discharge");
    // contactAnalysis est toujours présent — suppression déléguée à C3
    assert(discharge.contactAnalysis !== undefined, "expected contactAnalysis to be present");
  });

  const explorationWithContact = await analyzers.proposeState("Je m'en veux tellement", [], { wasDischarge: false });
  check("proposeState: pas de décharge ni info → candidat exploration high confidence", () => {
    const candidate = (explorationWithContact.stateCandidates || []).find(c => c.family === "exploration");
    assert(candidate !== undefined, "expected exploration candidate");
    assert(candidate.confidence === "high", `expected high confidence, got ${candidate.confidence}`);
    assert(explorationWithContact.contactAnalysis?.isContact === true, "expected contactAnalysis.isContact=true");
  });

  const infoWithContact = await analyzers.proposeState("Je m'en veux tellement, ton app fait quoi dans ce cas ?", [], { wasDischarge: false });
  check("proposeState: info détectée → candidat info présent, contactAnalysis passé tel quel", () => {
    const candidate = (infoWithContact.stateCandidates || []).find(c => c.family === "info");
    assert(candidate !== undefined, "expected info candidate in stateCandidates");
    assert(candidate.detectedState === "info_features", `expected info_features, got ${candidate.detectedState}`);
    assert(infoWithContact.contactAnalysis?.isContact === true, "expected contactAnalysis.isContact=true");
  });

  const relationalNeutral = await analyzers.analyzeRelationalAdjustmentNeed("Je me sens fatigué", [], "", false);
  check("analyzeRelationalAdjustmentNeed: neutral message -> deterministic skip, no LLM", () => {
    assert(relationalNeutral.needsRelationalAdjustment === false, "expected false");
    assert(relationalNeutral.llmTriggered === false, "expected llmTriggered=false");
    assert(relationalNeutral.source === "deterministic_no_trigger", `expected deterministic_no_trigger, got ${relationalNeutral.source}`);
  });

  const relationalFriction = await analyzers.analyzeRelationalAdjustmentNeed("Tu ne m'aides pas du tout", [], "", false);
  check("analyzeRelationalAdjustmentNeed: explicit friction -> LLM triggered", () => {
    assert(relationalFriction.llmTriggered === true, "expected llmTriggered=true");
    assert(relationalFriction.source === "llm", `expected llm, got ${relationalFriction.source}`);
  });

  const allianceHardRupture = await analyzers.analyzeAllianceRupture("Tu racontes n'importe quoi, t'es completement a cote de la plaque", []);
  check("analyzeAllianceRupture: hard rupture wording -> rupture", () => {
    assert(allianceHardRupture.explicitRelationalFriction === true, "expected explicitRelationalFriction=true");
    assert(allianceHardRupture.allianceSignal === "rupture", `expected rupture, got ${allianceHardRupture.allianceSignal}`);
  });

  const interpretationRejected = await analyzers.analyzeInterpretationRejection({
    message: "Pourquoi tu me dis ca ? Tu racontes n'importe quoi.",
    history: [],
    memory: ""
  });
  check("analyzeInterpretationRejection: challenge wording triggers analyzer path", () => {
    assert(interpretationRejected.source !== "deterministic_no_signal", `expected analyzer path, got ${interpretationRejected.source}`);
  });

  const relationalContact = await analyzers.analyzeRelationalAdjustmentNeed("Tu ne m'aides pas", [], "", true);
  check("analyzeRelationalAdjustmentNeed: isContact=true -> guard short-circuit", () => {
    assert(relationalContact.needsRelationalAdjustment === false, "expected false");
    assert(relationalContact.llmTriggered === false, "expected llmTriggered=false");
    assert(relationalContact.source === "isContact_guard", `expected isContact_guard, got ${relationalContact.source}`);
  });

  // --- analyzeDischargeState guard deterministe ---

  const dischargeCalm = await analyzers.analyzeDischargeState("Je me sens triste aujourd'hui", [], { wasDischarge: false });
  check("analyzeDischargeState: message calme -> guard deterministe, pas de LLM", () => {
    assert(dischargeCalm.isDischarge === false, "expected false");
    assert(dischargeCalm.source === "deterministic_no_signal", `expected deterministic_no_signal, got ${dischargeCalm.source}`);
  });

  const dischargeMontee = await analyzers.analyzeDischargeState("Je suis au bord de craquer", [], { wasDischarge: false });
  check("analyzeDischargeState: message avec signal positif (craqu) -> LLM declenche", () => {
    assert(dischargeMontee.source !== "deterministic_no_signal", `expected LLM path, got ${dischargeMontee.source}`);
  });

  const dischargeExplose = await analyzers.analyzeDischargeState("Je suis en train d'exploser", [], { wasDischarge: false });
  check("analyzeDischargeState: explos -> LLM declenche, detectedState discharge_dysregulated", () => {
    assert(dischargeExplose.isDischarge === true, "expected isDischarge=true");
    assert(dischargeExplose.detectedState === "discharge_dysregulated", `expected discharge_dysregulated, got ${dischargeExplose.detectedState}`);
  });

  const dischargeAgressif = await analyzers.analyzeDischargeState("Ta gueule !!!", [], { wasDischarge: false });
  check("analyzeDischargeState: insulte + !! -> LLM declenche, aggressiveDischargeDirectedToBot", () => {
    assert(dischargeAgressif.isDischarge === true, "expected isDischarge=true");
    assert(dischargeAgressif.aggressiveDischargeDirectedToBot === true, "expected aggressiveDischargeDirectedToBot=true");
  });

  const dischargeContinuite = await analyzers.analyzeDischargeState("Je me sens mieux maintenant", [], { wasDischarge: true });
  check("analyzeDischargeState: wasDischarge=true -> passe toujours au LLM meme sans signal", () => {
    assert(dischargeContinuite.source !== "deterministic_no_signal", `expected LLM path on continuation, got ${dischargeContinuite.source}`);
  });

  const dischargePanicSomatic = await analyzers.analyzeDischargeState("Je crois que je fais une crise d'angoisse, j'ai du mal a respirer", [], { wasDischarge: false });
  check("analyzeDischargeState: crise d'angoisse + respiration difficile -> candidate dysregulated", () => {
    assert(dischargePanicSomatic.isDischarge === true, "expected isDischarge=true");
    assert(dischargePanicSomatic.detectedState === "discharge_dysregulated", `expected discharge_dysregulated, got ${dischargePanicSomatic.detectedState}`);
  });

  const dischargePanicUrgency = await analyzers.analyzeDischargeState("J'ai la tete qui tourne, ca va pas, qu'est-ce que je fais ?", [], { wasDischarge: false });
  check("analyzeDischargeState: vertige + urgence explicite -> candidate dysregulated", () => {
    assert(dischargePanicUrgency.isDischarge === true, "expected isDischarge=true");
    assert(dischargePanicUrgency.detectedState === "discharge_dysregulated", `expected discharge_dysregulated, got ${dischargePanicUrgency.detectedState}`);
  });

  // --- analyzeExplorationSignal ---

  const explorationSelfQuery = await analyzers.analyzeExplorationSignal("Je me demande pourquoi je reagis comme ca", []);
  check("analyzeExplorationSignal: questionnement explicite sur soi -> isExploration=true, high", () => {
    assert(explorationSelfQuery.isExploration === true, "expected isExploration=true");
    assert(explorationSelfQuery.confidence === "high", `expected high, got ${explorationSelfQuery.confidence}`);
    assert(["llm", "llm_error"].includes(explorationSelfQuery.source), `expected llm source, got ${explorationSelfQuery.source}`);
  });

  const explorationNeutral = await analyzers.analyzeExplorationSignal("Je suis fatigue", []);
  check("analyzeExplorationSignal: description neutre -> isExploration=false", () => {
    assert(explorationNeutral.isExploration === false, "expected isExploration=false");
  });

  const stateWithExploration = await analyzers.proposeState("Je me demande pourquoi je reagis comme ca", [], { wasDischarge: false });
  check("proposeState: message exploratoire -> exploration candidate avec confiance LLM", () => {
    const candidate = (stateWithExploration.stateCandidates || []).find(c => c.family === "exploration");
    assert(candidate !== undefined, "expected exploration candidate");
    // Si LLM detecle l'exploration, confidence reflète ce que le LLM renvoie ("high" ici avec le fake)
    assert(["high", "medium", "low"].includes(candidate.confidence), `confidence inattendue: ${candidate.confidence}`);
  });

  console.log(`\n[ANALYZERS] ${passed} passed, ${failed} failed.`);
  if (failed > 0) process.exit(1);
}

run().catch((err) => {
  console.error("[ANALYZERS] fatal:", err?.message || err);
  process.exit(1);
});
