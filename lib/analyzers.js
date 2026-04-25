"use strict";

const { buildDefaultPromptRegistry } = require("./prompts");
const {
  clampExplorationDirectivityLevel,
  normalizeContactState,
  normalizeContactSubmode,
  normalizeExplorationRelanceWindow,
  normalizeInfoSubmode
} = require("./flags");

function createAnalyzers({
  client,
  MODEL_IDS,
  isExplicitAppFeatureRequest,
  llmInfoAnalysis,
  normalizeMemory,
  normalizeSessionFlags,
  shouldForceExplorationForSituatedImpasse,
  trimHistory,
  trimInfoAnalysisHistory,
  trimRecallAnalysisHistory,
  trimSuicideAnalysisHistory
}) {
  async function analyzeInfoRequest(message = "", history = [], promptRegistry = buildDefaultPromptRegistry()) {
    if (isExplicitAppFeatureRequest(message)) {
      return {
        isInfoRequest: true,
        source: "deterministic_app_features"
      };
    }

    if (shouldForceExplorationForSituatedImpasse(message)) {
      return {
        isInfoRequest: false,
        source: "deterministic_human_field"
      };
    }

    return await llmInfoAnalysis(message, history, promptRegistry);
  }

  function normalizeAnalyzerText(text = "") {
    return String(text || "")
      .toLowerCase()
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[\u2019]/g, "'")
      .replace(/\s+/g, " ")
      .trim();
  }

  async function analyzeInfoSubmode(message = "", history = [], promptRegistry = buildDefaultPromptRegistry()) {
    if (isExplicitAppFeatureRequest(message)) {
      return {
        infoSubmode: "app_features",
        source: "deterministic_app_features"
      };
    }

    const context = trimInfoAnalysisHistory(history);

    const r = await client.chat.completions.create({
      model: MODEL_IDS.analysis,
      temperature: 0,
      max_tokens: 60,
      messages: [
        { role: "system", content: promptRegistry.ANALYZE_INFO_SUBMODE },
        ...context.map(m => ({ role: m.role, content: m.content })),
        { role: "user", content: message }
      ]
    });

    try {
      const raw = (r.choices?.[0]?.message?.content || "").replace(/```json|```/g, "").trim();
      const parsed = JSON.parse(raw);

      return {
        infoSubmode: normalizeInfoSubmode(parsed.infoSubmode) || "app_features",
        source: "llm"
      };
    } catch {
      return {
        infoSubmode: "app_features",
        source: "llm_fallback"
      };
    }
  }

  async function analyzeContactState(
    message = "",
    history = [],
    previousContactState = { wasContact: false },
    promptRegistry = buildDefaultPromptRegistry()
  ) {
    const context = trimHistory(history);
    const safePreviousContactState = normalizeContactState(previousContactState);

    const user = `
Message utilisateur actuel :
${message}

Contexte recent :
${context.map(m => `${m.role === "user" ? "Utilisateur" : "Assistant"} : ${m.content}`).join("\n")}

previousContactState :
${JSON.stringify(safePreviousContactState)}
`;

    const r = await client.chat.completions.create({
      model: MODEL_IDS.analysis,
      temperature: 0,
      max_tokens: 80,
      messages: [
        { role: "system", content: promptRegistry.ANALYZE_CONTACT },
        { role: "user", content: user }
      ]
    });

    try {
      const raw = (r.choices?.[0]?.message?.content || "").replace(/```json|```/g, "").trim();
      const parsed = JSON.parse(raw);

      return {
        isContact: parsed.isContact === true,
        contactSubmode: parsed.isContact === true ? normalizeContactSubmode(parsed.contactSubmode) || "regulated" : null
      };
    } catch {
      return {
        isContact: false,
        contactSubmode: null
      };
    }
  }

  async function analyzeRelationalAdjustmentNeed(
    message = "",
    history = [],
    memory = "",
    isContact = false,
    promptRegistry = buildDefaultPromptRegistry()
  ) {
    if (isContact === true) {
      return {
        needsRelationalAdjustment: false
      };
    }

    const context = trimHistory(history);

    const user = `
Message utilisateur actuel :
${message}

Contexte recent :
${context.map(m => `${m.role === "user" ? "Utilisateur" : "Assistant"} : ${m.content}`).join("\n")}

Memoire :
${normalizeMemory(memory, promptRegistry)}
`;

    const r = await client.chat.completions.create({
      model: MODEL_IDS.analysis,
      temperature: 0,
      max_tokens: 100,
      messages: [
        { role: "system", content: promptRegistry.ANALYZE_RELATIONAL_ADJUSTMENT },
        { role: "user", content: user }
      ]
    });

    try {
      const raw = (r.choices?.[0]?.message?.content || "").replace(/```json|```/g, "").trim();
      const parsed = JSON.parse(raw);

      return {
        needsRelationalAdjustment: parsed.needsRelationalAdjustment === true
      };
    } catch {
      return {
        needsRelationalAdjustment: false
      };
    }
  }

  async function analyzeRecallRouting(
    message = "",
    recentHistory = [],
    memory = "",
    promptRegistry = buildDefaultPromptRegistry()
  ) {
    const context = trimRecallAnalysisHistory(recentHistory);

    const user = `
Message utilisateur :
${message}

RecentHistory :
${context.map(m => `${m.role === "user" ? "Utilisateur" : "Assistant"} : ${m.content}`).join("\n")}

Memoire resumee :
${normalizeMemory(memory, promptRegistry)}
`;

    const r = await client.chat.completions.create({
      model: MODEL_IDS.analysis,
      temperature: 0,
      max_tokens: 80,
      messages: [
        { role: "system", content: promptRegistry.ANALYZE_RECALL },
        { role: "user", content: user }
      ]
    });

    try {
      const raw = (r.choices?.[0]?.message?.content || "").replace(/```json|```/g, "").trim();
      const parsed = JSON.parse(raw);

      const isRecallAttempt = parsed.isRecallAttempt === true;
      const calledMemory = ["shortTermMemory", "longTermMemory", "none"].includes(parsed.calledMemory)
        ? parsed.calledMemory
        : "none";

      return {
        isRecallAttempt,
        calledMemory: isRecallAttempt ? calledMemory : "none",
        isLongTermMemoryRecall: isRecallAttempt && calledMemory === "longTermMemory",
        rawLlmOutput: raw
      };
    } catch {
      return {
        isRecallAttempt: false,
        calledMemory: "none",
        isLongTermMemoryRecall: false,
        rawLlmOutput: null
      };
    }
  }

  async function analyzeExplorationRelance({
    message = "",
    reply = "",
    history = [],
    memory = "",
    promptRegistry = buildDefaultPromptRegistry()
  }) {
    const context = trimHistory(history);

    const user = `
Message utilisateur actuel :
${message}

Contexte recent :
${context.map(m => `${m.role === "user" ? "Utilisateur" : "Assistant"} : ${m.content}`).join("\n")}

Memoire :
${normalizeMemory(memory, promptRegistry)}

Reponse du bot a analyser :
${reply}
`;

    const r = await client.chat.completions.create({
      model: MODEL_IDS.analysis,
      temperature: 0,
      max_tokens: 60,
      messages: [
        { role: "system", content: promptRegistry.ANALYZE_RELANCE },
        { role: "user", content: user }
      ]
    });

    try {
      const raw = (r.choices?.[0]?.message?.content || "").replace(/```json|```/g, "").trim();
      const parsed = JSON.parse(raw);

      return {
        isRelance: parsed.isRelance === true
      };
    } catch {
      return {
        isRelance: false
      };
    }
  }

  async function analyzeExplorationCalibration({
    message = "",
    history = [],
    memory = "",
    explorationDirectivityLevel = 0,
    explorationRelanceWindow = [],
    promptRegistry = buildDefaultPromptRegistry()
  }) {
    const context = trimHistory(history);

    const user = `
Message utilisateur actuel :
${message}

Contexte recent :
${context.map(m => `${m.role === "user" ? "Utilisateur" : "Assistant"} : ${m.content}`).join("\n")}

Memoire :
${normalizeMemory(memory, promptRegistry)}

Niveau precedent :
${clampExplorationDirectivityLevel(explorationDirectivityLevel)}

Fenetre recente de relances :
[${normalizeExplorationRelanceWindow(explorationRelanceWindow).map(v => (v ? "1" : "0")).join("-")}]
`;

    const r = await client.chat.completions.create({
      model: MODEL_IDS.analysis,
      temperature: 0,
      max_tokens: 60,
      messages: [
        { role: "system", content: promptRegistry.ANALYZE_EXPLORATION_CALIBRATION },
        { role: "user", content: user }
      ]
    });

    try {
      const raw = (r.choices?.[0]?.message?.content || "").replace(/```json|```/g, "").trim();
      const parsed = JSON.parse(raw);
      return {
        calibrationLevel: clampExplorationDirectivityLevel(parsed.calibrationLevel),
        explorationSubmode: ["interpretation", "phenomenological_follow"].includes(parsed.explorationSubmode)
          ? parsed.explorationSubmode
          : "interpretation"
      };
    } catch {
      return {
        calibrationLevel: clampExplorationDirectivityLevel(explorationDirectivityLevel),
        explorationSubmode: "interpretation"
      };
    }
  }

  async function analyzeInterpretationRejection({
    message = "",
    history = [],
    memory = "",
    promptRegistry = buildDefaultPromptRegistry()
  }) {
    const context = trimHistory(history);

    const user = `
Message utilisateur actuel :
${message}

Contexte recent :
${context.map(m => `${m.role === "user" ? "Utilisateur" : "Assistant"} : ${m.content}`).join("\n")}

Memoire :
${normalizeMemory(memory, promptRegistry)}
`;

    const r = await client.chat.completions.create({
      model: MODEL_IDS.analysis,
      temperature: 0,
      max_tokens: 120,
      messages: [
        { role: "system", content: promptRegistry.ANALYZE_INTERPRETATION_REJECTION },
        { role: "user", content: user }
      ]
    });

    try {
      const raw = (r.choices?.[0]?.message?.content || "").replace(/```json|```/g, "").trim();
      const parsed = JSON.parse(raw);

      return {
        isInterpretationRejection: parsed.isInterpretationRejection === true,
        rejectsUnderlyingPhenomenon: parsed.rejectsUnderlyingPhenomenon === true,
        needsSoberReadjustment: parsed.needsSoberReadjustment === true,
        tensionHoldLevel: ["low", "medium", "high"].includes(parsed.tensionHoldLevel)
          ? parsed.tensionHoldLevel
          : "medium"
      };
    } catch {
      return {
        isInterpretationRejection: false,
        rejectsUnderlyingPhenomenon: false,
        needsSoberReadjustment: false,
        tensionHoldLevel: "medium"
      };
    }
  }

  async function analyzeSituatedImpasse(message = "") {
    return {
      situatedImpasseDetected: shouldForceExplorationForSituatedImpasse(message) === true,
      source: "deterministic_human_field"
    };
  }

  async function analyzeUserRegister(message = "") {
    const text = normalizeAnalyzerText(message);
    const familiarPatterns = [
      /\b(ouais|nan|ca me saoule|ca me soule|ca saoule|ca soule|connerie|conneries|putain|merde|ras le bol|j'en ai marre|grave|franchement|genre|bah)\b/,
      /\b(j'suis|t'es|c'est chiant|ca me gonfle)\b/
    ];
    const sustainedPatterns = [
      /\b(cependant|neanmoins|toutefois|en outre|de surcroit|par ailleurs)\b/,
      /\b(en l'occurrence|dans une certaine mesure|il convient de|il me semble pertinent)\b/
    ];

    const familiarHits = familiarPatterns.reduce((count, pattern) => count + (pattern.test(text) ? 1 : 0), 0);
    const sustainedHits = sustainedPatterns.reduce((count, pattern) => count + (pattern.test(text) ? 1 : 0), 0);

    let userRegister = "courant";
    if (familiarHits > 0 && familiarHits >= sustainedHits) {
      userRegister = "familier";
    } else if (sustainedHits >= 2 && familiarHits === 0) {
      userRegister = "soutenu";
    }

    return {
      userRegister,
      source: "deterministic_register"
    };
  }

  async function analyzeSomaticSignal(message = "") {
    const text = normalizeAnalyzerText(message);
    const somaticSignalActive = /\b(corps|poitrine|ventre|gorge|machoire|epaules|dos|tete|nuque|souffle|respiration|coeur|serre|serrement|pression|chaleur|froid|boule|tension|palpitation|n\u0153ud|noeud)\b/.test(text);
    const somaticLocalizationBlocked = /\b(j'arrive pas a dire ou|je n'arrive pas a dire ou|je sais pas ou|impossible de localiser|pas reussi a localiser|ca m'enerve de pas reussir|ca m'enerve de ne pas reussir|ca me frustre de pas reussir)\b/.test(text);

    return {
      somaticSignalActive,
      somaticLocalizationBlocked,
      source: "deterministic_somatic"
    };
  }

  async function detectMode(message = "", history = [], promptRegistry = buildDefaultPromptRegistry()) {
    const info = await analyzeInfoRequest(message, history, promptRegistry);

    if (!info.isInfoRequest) {
      return {
        mode: "exploration",
        infoSource: info.source,
        infoSubmode: null,
        infoSubmodeSource: null
      };
    }

    const infoSubmode = await analyzeInfoSubmode(message, history, promptRegistry);

    return {
      mode: "info",
      infoSource: info.source,
      infoSubmode: infoSubmode.infoSubmode,
      infoSubmodeSource: infoSubmode.source
    };
  }

  // ----------------------------------------
  // SUICIDE RISK
  // ----------------------------------------

  // Analyze the user's message for suicidal risk using the prompt registry.
  // The result drives immediate override responses and clarification flows.
  async function analyzeSuicideRisk(
    message = "",
    history = [],
    sessionFlags = {},
    promptRegistry = buildDefaultPromptRegistry()
  ) {
    const safeFlags = normalizeSessionFlags(sessionFlags);

    const system = String(promptRegistry.ANALYZE_SUICIDE_RISK || "")
      .replace("{{acuteCrisis}}", safeFlags.acuteCrisis ? "oui" : "non");

    const context = trimSuicideAnalysisHistory(history);

    const r = await client.chat.completions.create({
      model: MODEL_IDS.analysis,
      temperature: 0,
      max_tokens: 240,
      messages: [
        { role: "system", content: system },
        ...context.map(m => ({ role: m.role, content: m.content })),
        { role: "user", content: message }
      ]
    });

    const raw = (r.choices?.[0]?.message?.content || "").trim();

    try {
      const cleaned = raw.replace(/```json|```/g, "").trim();
      const obj = JSON.parse(cleaned);

      let suicideLevel = ["N0", "N1", "N2"].includes(obj.suicideLevel) ?
        obj.suicideLevel :
        "N0";

      const idiomaticDeathExpression = obj.idiomaticDeathExpression === true;

      if (idiomaticDeathExpression) {
        suicideLevel = "N0";
      }

      let needsClarification =
        suicideLevel === "N1" || suicideLevel === "N2" ?
        obj.needsClarification === true :
        false;

      if (idiomaticDeathExpression) {
        needsClarification = false;
      }

      return {
        suicideLevel,
        needsClarification,
        isQuote: obj.isQuote === true,
        idiomaticDeathExpression,
        crisisResolved: obj.crisisResolved === true
      };
    } catch {
      return {
        suicideLevel: "N0",
        needsClarification: false,
        isQuote: false,
        idiomaticDeathExpression: false,
        crisisResolved: false
      };
    }
  }

  function n1Fallback() {
    return "Quand tu dis ca, est-ce que tu parles d'une envie de mourir, de disparaitre au sens vital, ou d'autre chose ?";
  }

  // Generate a clarification response for N1/ambiguous suicide risk.
  // Falls back to a safe canned response if LLM output is too long or missing.
  async function n1ResponseLLM(
    message,
    promptRegistry = buildDefaultPromptRegistry()
  ) {
    const system = promptRegistry.N1_RESPONSE_LLM;

    const r = await client.chat.completions.create({
      model: MODEL_IDS.generation,
      temperature: 0,
      max_tokens: 50,
      messages: [
        { role: "system", content: system },
        { role: "user", content: message }
      ]
    });

    const out = (r.choices?.[0]?.message?.content || "").trim();
    if (!out || out.length > 220) return n1Fallback();
    return out;
  }

  // Predefined crisis response used for N2 or unresolved acute crisis.
  function n2Response() {
    return "Je t'entends, et la c'est urgent. Si tu es en danger immediat, appelle le 112 ou le 3114. Si tu peux, ne reste pas seul.";
  }

  // Predefined follow-up response while remaining in acute crisis handling.
  function acuteCrisisFollowupResponse() {
    return "Je reste sur quelque chose de tres simple la. Si le danger est immediat, appelle le 112 ou le 3114. Si tu peux, ne reste pas seul.";
  }

  return {
    analyzeContactState,
    analyzeExplorationCalibration,
    analyzeExplorationRelance,
    analyzeInfoRequest,
    analyzeInfoSubmode,
    analyzeInterpretationRejection,
    analyzeSituatedImpasse,
    analyzeSomaticSignal,
    analyzeUserRegister,
    analyzeRecallRouting,
    analyzeRelationalAdjustmentNeed,
    analyzeSuicideRisk,
    acuteCrisisFollowupResponse,
    n1ResponseLLM,
    n2Response,
    detectMode
  };
}

module.exports = {
  createAnalyzers
};
