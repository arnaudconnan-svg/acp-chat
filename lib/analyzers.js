"use strict";

const { buildDefaultPromptRegistry } = require("./prompts");
const {
  clampExplorationDirectivityLevel,
  normalizeDischargeState,
  normalizeExplorationRelanceWindow
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

  async function analyzeInfoSignal(message = "", history = [], promptRegistry = buildDefaultPromptRegistry()) {
    if (isExplicitAppFeatureRequest(message)) {
      return {
        detectedState: "info_features",
        psychoeducationType: null,
        infoContextFlags: [],
        source: "deterministic_app_features"
      };
    }

    const context = trimInfoAnalysisHistory(history);

    const r = await client.chat.completions.create({
      model: MODEL_IDS.analysis,
      temperature: 0,
      max_tokens: 120,
      messages: [
        { role: "system", content: promptRegistry.ANALYZE_INFO_SIGNAL },
        ...context.map(m => ({ role: m.role, content: m.content })),
        { role: "user", content: message }
      ]
    });

    try {
      const raw = (r.choices?.[0]?.message?.content || "").replace(/```json|```/g, "").trim();
      const parsed = JSON.parse(raw);

      // Normalize detectedState from LLM output
      const rawState = parsed.detectedState || "";
      const VALID_INFO_STATES = ["info_pure", "info_features", "info_psychoeducation"];
      // Accept legacy values for robustness
      const stateMap = {
        "pure": "info_pure",
        "app_features": "info_features",
        "app": "info_features",
        "psychoeducation": "info_psychoeducation",
        "app_theoretical_model": "info_psychoeducation"
      };
      const detectedState = VALID_INFO_STATES.includes(rawState)
        ? rawState
        : (stateMap[rawState] || "info_features");

      return {
        detectedState,
        psychoeducationType: parsed.psychoeducationType || null,
        infoContextFlags: Array.isArray(parsed.infoContextFlags) ? parsed.infoContextFlags : [],
        source: "llm"
      };
    } catch {
      return {
        detectedState: "info_features",
        psychoeducationType: null,
        infoContextFlags: [],
        source: "llm_fallback"
      };
    }
  }

  async function analyzeDischargeState(
    message = "",
    history = [],
    previousDischargeState = { wasDischarge: false },
    promptRegistry = buildDefaultPromptRegistry()
  ) {
    const context = trimHistory(history);
    const safePreviousDischargeState = normalizeDischargeState(previousDischargeState);

    const user = `
Message utilisateur actuel :
${message}

Contexte recent :
${context.map(m => `${m.role === "user" ? "Utilisateur" : "Assistant"} : ${m.content}`).join("\n")}

previousDischargeState :
${JSON.stringify(safePreviousDischargeState)}
`;

    const r = await client.chat.completions.create({
      model: MODEL_IDS.analysis,
      temperature: 0,
      max_tokens: 80,
      messages: [
        { role: "system", content: promptRegistry.ANALYZE_DISCHARGE },
        { role: "user", content: user }
      ]
    });

    try {
      const raw = (r.choices?.[0]?.message?.content || "").replace(/```json|```/g, "").trim();
      const parsed = JSON.parse(raw);

      const isDischarge = parsed.isDischarge === true || parsed.isContact === true;
      if (!isDischarge) {
        return {
          isDischarge: false,
          detectedState: null,
          aggressiveDischargeDirectedToBot: false
        };
      }
      // Support legacy key `contactSubmode` while migrating to `dischargeSubmode`.
      const rawSubmode = parsed.dischargeSubmode || parsed.contactSubmode;
      const submode = rawSubmode === "dysregulated" ? "dysregulated" : "regulated";
      return {
        isDischarge: true,
        detectedState: submode === "dysregulated" ? "discharge_dysregulated" : "discharge_regulated",
        aggressiveDischargeDirectedToBot: parsed.aggressiveDischargeDirectedToBot === true
      };
    } catch {
      return {
        isDischarge: false,
        detectedState: null,
        aggressiveDischargeDirectedToBot: false
      };
    }
  }

  async function analyzeContactState(
    message = "",
    history = [],
    promptRegistry = buildDefaultPromptRegistry()
  ) {
    // Passe déterministe — patterns d'auto-agacement actif et culpabilité douloureuse présente
    const CONTACT_PATTERNS = [
      /\bça m'agace contre moi(-même|\s*meme)\b/i,
      /\bm'en veux tellement\b/i,
      /\bm'en veux vraiment\b/i,
      /\bje m'en veux\b/i,
      /\bcoincée? dans un truc que je reproduis\b/i,
      /\bras-le-bol.{0,20}contre moi\b/i
    ];
    const EXCLUSION_PATTERNS = [
      /\bj'ai souvent tendance à\b/i,
      /\bnormalement je m'en veux\b/i,
      /\bça m'énerve souvent\b/i
    ];
    const HIGH_CRITICISM_PATTERNS = [
      /\bje suis (vraiment |tellement )?(nul|nulle|mauvais|mauvaise|honteux|honteuse)\b/i,
      /\bc'est honteux de ma part\b/i,
      /\bje n'aurais (jamais )?dû\b/i,
      /\bj'aurais (jamais )?dû\b/i
    ];

    const hasExclusion = EXCLUSION_PATTERNS.some(p => p.test(message));
    if (!hasExclusion && CONTACT_PATTERNS.some(p => p.test(message))) {
      const selfCriticismLevel = HIGH_CRITICISM_PATTERNS.some(p => p.test(message)) ? "high" : "low";
      return {
        isContact: true,
        contactSubmode: "regulated",
        selfCriticismLevel,
        meaningCrisis: false,
        insightMoment: false,
        source: "deterministic_contact"
      };
    }

    // Fallback LLM
    const context = trimHistory(history);
    const user = `
Message utilisateur actuel :
${message}

Contexte recent :
${context.map(m => `${m.role === "user" ? "Utilisateur" : "Assistant"} : ${m.content}`).join("\n")}
`;

    const r = await client.chat.completions.create({
      model: MODEL_IDS.analysis,
      temperature: 0,
      max_tokens: 120,
      messages: [
        { role: "system", content: promptRegistry.ANALYZE_CONTACT },
        { role: "user", content: user }
      ]
    });

    try {
      const raw = (r.choices?.[0]?.message?.content || "").replace(/```json|```/g, "").trim();
      const parsed = JSON.parse(raw);
      if (!parsed.isContact) {
        return { isContact: false, contactSubmode: null, selfCriticismLevel: "low", meaningCrisis: false, insightMoment: false };
      }
      const selfCriticismLevel = parsed.selfCriticismLevel === "high" ? "high" : "low";
      const meaningCrisis = parsed.meaningCrisis === true;
      const insightMoment = parsed.insightMoment === true;
      const contactSubmode = meaningCrisis ? "meaning_making" : insightMoment ? "insight" : "regulated";
      return { isContact: true, contactSubmode, selfCriticismLevel, meaningCrisis, insightMoment };
    } catch {
      return { isContact: false, contactSubmode: null, selfCriticismLevel: "low", meaningCrisis: false, insightMoment: false };
    }
  }

  async function analyzeEmotionalDecentering(message = "", history = []) {
    const DECENTERING_PATTERNS = [
      /\bde toute façon\b/i,
      /\bc'est pas grave\b/i,
      /\bbref\b/i,
      /\bpassons\b/i,
      /\boublie\b/i,
      /j'allais dire.{0,30}(bref|non|laisse|oublie|rien)/i,
      /\b(finalement|en fait)\b.{0,40}\b(rien|pas grave|peu importe|laisse tomber)\b/i
    ];

    // Heuristique : match dans la deuxième moitié du message après amorce émotionnelle dans la première moitié
    const mid = Math.floor(message.length / 2);
    const firstHalf = message.slice(0, mid);
    const secondHalf = message.slice(mid);
    const EMOTIONAL_AMORCE = /\b(je|j'|ça|ca|c'est|c est|quelque chose|il y a|je me sens|je ressens|j'ai|j ai)\b/i;
    const hasEmotionalAmorce = EMOTIONAL_AMORCE.test(firstHalf);
    const hasDecenteringInSecondHalf = DECENTERING_PATTERNS.some(p => p.test(secondHalf));

    if (hasEmotionalAmorce && hasDecenteringInSecondHalf) {
      return { emotionalDecentering: true };
    }

    // Déflexion dès le début sans amorce émotionnelle : pas de décentering
    const startsWithDecentering = /^\s*(bref|de toute façon|c'est pas grave|passons|oublie|laisse tomber)/i.test(message);
    if (startsWithDecentering) {
      return { emotionalDecentering: false };
    }

    // Fallback LLM si pattern ambigu
    if (DECENTERING_PATTERNS.some(p => p.test(message))) {
      try {
        const context = trimHistory(history);
        const r = await client.chat.completions.create({
          model: MODEL_IDS.analysis,
          temperature: 0,
          max_tokens: 40,
          messages: [
            { role: "system", content: "Tu detectes si la personne amorce une emotion et la deflecte avant qu'elle soit exprimee. Reponds uniquement : {\"emotionalDecentering\": true|false}" },
            ...context.map(m => ({ role: m.role, content: m.content })),
            { role: "user", content: message }
          ]
        });
        const raw = (r.choices?.[0]?.message?.content || "").replace(/```json|```/g, "").trim();
        const parsed = JSON.parse(raw);
        return { emotionalDecentering: parsed.emotionalDecentering === true };
      } catch {
        return { emotionalDecentering: false };
      }
    }

    return { emotionalDecentering: false };
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

  async function analyzeEngagementAndAlliance(
    message = "",
    history = [],
    promptRegistry = buildDefaultPromptRegistry()
  ) {
    const context = trimHistory(history);

    const user = `
Message utilisateur actuel :
${message}

Contexte recent :
${context.map(m => `${m.role === "user" ? "Utilisateur" : "Assistant"} : ${m.content}`).join("\n")}
`;

    try {
      const r = await client.chat.completions.create({
        model: MODEL_IDS.analysis,
        temperature: 0,
        max_tokens: 80,
        messages: [
          { role: "system", content: promptRegistry.ANALYZE_ENGAGEMENT_ALLIANCE },
          { role: "user", content: user }
        ]
      });

      const raw = (r.choices?.[0]?.message?.content || "").replace(/```json|```/g, "").trim();
      const parsed = JSON.parse(raw);

      const allianceState = ["good", "fragile", "rupture"].includes(parsed.allianceState)
        ? parsed.allianceState : "good";
      const engagementLevel = ["active", "passive", "withdrawn"].includes(parsed.engagementLevel)
        ? parsed.engagementLevel : "active";
      const processingWindow = ["open", "narrowed", "overloaded"].includes(parsed.processingWindow)
        ? parsed.processingWindow : "open";

      return { allianceState, engagementLevel, processingWindow };
    } catch {
      return { allianceState: "good", engagementLevel: "active", processingWindow: "open" };
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

  async function analyzeTheoreticalOrientation(message = "", history = [], memory = "", promptRegistry = buildDefaultPromptRegistry()) {
    const fallback = { theoreticalOrientation: "none", orientationConfidence: 0.0 };

    const context = trimHistory(history);

    try {
      const r = await client.chat.completions.create({
        model: MODEL_IDS.analysis,
        temperature: 0,
        max_tokens: 60,
        messages: [
          { role: "system", content: promptRegistry.ANALYZE_THEORETICAL_ORIENTATION },
          ...context.map(m => ({ role: m.role, content: m.content })),
          { role: "user", content: message }
        ]
      });

      const raw = (r.choices?.[0]?.message?.content || "").replace(/```json|```/g, "").trim();
      const parsed = JSON.parse(raw);

      const validOrientations = [
        "disconnection", "limiting_belief", "discharge_in_progress",
        "transformation_in_progress", "adaptive_mechanism", "relational_need",
        "limit_expression", "unfinished_business", "none"
      ];
      const orientation = validOrientations.includes(parsed.theoreticalOrientation)
        ? parsed.theoreticalOrientation
        : "none";
      const confidence = typeof parsed.orientationConfidence === "number"
        ? Math.max(0, Math.min(1, Math.round(parsed.orientationConfidence * 100) / 100))
        : 0.0;

      return { theoreticalOrientation: orientation, orientationConfidence: confidence };
    } catch {
      return fallback;
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

      const frictionRaw = parsed.relationalFrictionSignal;
      return {
        isInterpretationRejection: parsed.isInterpretationRejection === true,
        rejectsUnderlyingPhenomenon: parsed.rejectsUnderlyingPhenomenon === true,
        relationalFrictionSignal: frictionRaw === "strong" ? "strong" : frictionRaw === "mild" ? "mild" : "none"
      };
    } catch {
      return {
        isInterpretationRejection: false,
        rejectsUnderlyingPhenomenon: false,
        relationalFrictionSignal: "none"
      };
    }
  }

  async function analyzeTechnicalContext(message = "") {
    return {
      technicalContextDetected: shouldForceExplorationForSituatedImpasse(message) === true,
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

    // Detect formal address (vouvoiement) — excludes "voilà" and "voici"
    const formalAddressPattern = /\b(vous|votre|vos)\b/;
    const formalExcludePattern = /\b(voil[aà]|voici)\b/;
    const rawText = (message || "").toLowerCase();
    const formalAddress = formalAddressPattern.test(rawText) && !formalExcludePattern.test(rawText);

    return {
      userRegister,
      formalAddress,
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

  async function detectMode(message = "", history = [], currentDischargeState = null, promptRegistry = buildDefaultPromptRegistry()) {
    const [info, dischargeResult, contactResult] = await Promise.all([
      analyzeInfoRequest(message, history, promptRegistry),
      analyzeDischargeState(message, history, currentDischargeState || { wasDischarge: false }, promptRegistry),
      analyzeContactState(message, history, promptRegistry)
    ]);

    if (dischargeResult.isDischarge) {
      return {
        detectedState: dischargeResult.detectedState || "discharge_regulated",
        dischargeAnalysis: {
          aggressiveDischargeDirectedToBot: dischargeResult.aggressiveDischargeDirectedToBot === true
        },
        contactAnalysis: { isContact: false },
        infoSource: null,
        infoSubmodeSource: null
      };
    }

    if (!info.isInfoRequest) {
      return {
        detectedState: "exploration",
        dischargeAnalysis: { aggressiveDischargeDirectedToBot: false },
        contactAnalysis: contactResult,
        infoSource: info.source,
        infoSubmodeSource: null
      };
    }

    const infoSignal = await analyzeInfoSignal(message, history, promptRegistry);

    return {
      detectedState: infoSignal.detectedState,
      dischargeAnalysis: { aggressiveDischargeDirectedToBot: false },
      contactAnalysis: contactResult,
      infoSource: info.source,
      infoSubmodeSource: infoSignal.source,
      psychoeducationType: infoSignal.psychoeducationType || null,
      infoContextFlags: infoSignal.infoContextFlags || []
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

  // C2 — Closure intent detection (deterministic pass + LLM fallback for ambiguous signals).
  // Mirrors the STRONG_CLOSURE_PATTERNS from detectClosureIntent in flags.js, then extends
  // coverage with ambiguous signals routed to a lightweight LLM pass.
  async function analyzeClosureIntent(message = "") {
    const text = String(message || "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");

    // Pass 1 — Strong patterns: immediate return, no LLM cost.
    const STRONG_CLOSURE_PATTERNS = [
      /\bj'aimerais (m'arreter|qu'on s'arrête|qu'on s'arreter|s'arreter)\b/,
      /\bon (peut |va )?(s'arreter|s'arrete|s'arrêter|s'arrête)\b/,
      /\bje (vais |voudrais )?(m'arreter|m'arrete|m'arrêter|m'arrête)\b/,
      /\bc'est bon pour aujourd'hui\b/,
      /\bc'est tout pour aujourd'hui\b/,
      /\bje crois qu'on (peut |peut bien )?(s'arreter|s'arrête|s'arrete)\b/,
      /\bon s'arrete la\b/,
      /\bau revoir\b/,
      /\bbonne journee\b/,
      /\bbonne nuit\b/,
      /\bbonsoir\b/,
      /\ba bientot\b/,
      /\bmerci, c'est tout\b/,
      /\bc'est fini pour (moi|aujourd'hui)\b/
    ];
    if (STRONG_CLOSURE_PATTERNS.some(p => p.test(text))) {
      return { closureIntent: true };
    }

    // Pass 2 — Ambiguous signals: trigger LLM fallback only if present.
    const AMBIGUOUS_CLOSURE_PATTERNS = [
      /\bc'est assez (pour|pour moi)\b/,
      /\bon a (bien |assez |beaucoup )?(travaille|avance|fait|aborde)\b/,
      /\bj'ai besoin de (temps|digerer|reflechir)\b/,
      /\bje crois que c'est (tout|bon|assez)\b/,
      /\bpour aujourd'hui (c'est|ca|ca suffit|ca me va)\b/,
      /\bje dois y aller\b/,
      /\bje (te|vous) laisse\b/
    ];
    if (!AMBIGUOUS_CLOSURE_PATTERNS.some(p => p.test(text))) {
      return { closureIntent: false };
    }

    // LLM fallback for ambiguous signals only.
    try {
      const r = await client.chat.completions.create({
        model: MODEL_IDS.analysis,
        temperature: 0,
        max_tokens: 30,
        messages: [
          {
            role: "system",
            content: "Tu detectes si la personne signale qu'elle veut mettre fin a la conversation pour aujourd'hui. Ne confonds pas une pause thematique avec une intention de cloture. Reponds uniquement : {\"closureIntent\": true|false}"
          },
          { role: "user", content: message }
        ]
      });
      const raw = (r.choices?.[0]?.message?.content || "").replace(/```json|```/g, "").trim();
      const parsed = JSON.parse(raw);
      return { closureIntent: parsed.closureIntent === true };
    } catch {
      return { closureIntent: false };
    }
  }

  return {
    analyzeDischargeState,
    analyzeContactState,
    analyzeEmotionalDecentering,
    analyzeEngagementAndAlliance,
    analyzeExplorationCalibration,
    analyzeTheoreticalOrientation,
    analyzeExplorationRelance,
    analyzeInfoRequest,
    analyzeInfoSignal,
    analyzeInterpretationRejection,
    analyzeTechnicalContext,
    analyzeSomaticSignal,
    analyzeUserRegister,
    analyzeRecallRouting,
    analyzeRelationalAdjustmentNeed,
    analyzeSuicideRisk,
    analyzeClosureIntent,
    acuteCrisisFollowupResponse,
    n1Fallback,
    n1ResponseLLM,
    n2Response,
    detectMode
  };
}

module.exports = {
  createAnalyzers
};
