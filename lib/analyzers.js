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
  shouldForceExplorationForSituatedImpasse,
  trimHistory,
  trimInfoAnalysisHistory,
  trimRecallAnalysisHistory
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
      console.log("[RECALL][RAW_LLM]", raw);
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

  return {
    analyzeContactState,
    analyzeExplorationCalibration,
    analyzeExplorationRelance,
    analyzeInfoRequest,
    analyzeInfoSubmode,
    analyzeInterpretationRejection,
    analyzeSituatedImpasse,
    analyzeRecallRouting,
    analyzeRelationalAdjustmentNeed,
    detectMode
  };
}

module.exports = {
  createAnalyzers
};
