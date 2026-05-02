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
            const isDischarge = /craque|explose|pleure|ta gueule|ferme-la|ferme la/i.test(user);
            const isDysregulated = /explose|panique|perte de controle|etouffe/i.test(user);
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

  const discharge = await analyzers.detectMode("Je suis en train d'exploser", [], { wasDischarge: false });
  check("detectMode: discharge priority is preserved", () => {
    assert(discharge.detectedState === "discharge_dysregulated", `expected discharge_dysregulated, got ${discharge.detectedState}`);
    assert(discharge.contactAnalysis?.isContact === false, "expected contactAnalysis to be reset on discharge path");
  });

  const explorationWithContact = await analyzers.detectMode("Je m'en veux tellement", [], { wasDischarge: false });
  check("detectMode: non-discharge contact keeps exploration when no info request", () => {
    assert(explorationWithContact.detectedState === "exploration", `expected exploration, got ${explorationWithContact.detectedState}`);
    assert(explorationWithContact.contactAnalysis?.isContact === true, "expected contactAnalysis.isContact=true");
  });

  const infoWithContact = await analyzers.detectMode("Je m'en veux tellement, ton app fait quoi dans ce cas ?", [], { wasDischarge: false });
  check("detectMode: non-discharge contact signal survives in info mode", () => {
    assert(infoWithContact.detectedState === "info_features", `expected info_features, got ${infoWithContact.detectedState}`);
    assert(infoWithContact.contactAnalysis?.isContact === true, "expected contactAnalysis.isContact=true in info mode");
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

  const relationalContact = await analyzers.analyzeRelationalAdjustmentNeed("Tu ne m'aides pas", [], "", true);
  check("analyzeRelationalAdjustmentNeed: isContact=true -> guard short-circuit", () => {
    assert(relationalContact.needsRelationalAdjustment === false, "expected false");
    assert(relationalContact.llmTriggered === false, "expected llmTriggered=false");
    assert(relationalContact.source === "isContact_guard", `expected isContact_guard, got ${relationalContact.source}`);
  });

  console.log(`\n[ANALYZERS] ${passed} passed, ${failed} failed.`);
  if (failed > 0) process.exit(1);
}

run().catch((err) => {
  console.error("[ANALYZERS] fatal:", err?.message || err);
  process.exit(1);
});
