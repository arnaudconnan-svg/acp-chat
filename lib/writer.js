"use strict";

const { buildDefaultPromptRegistry } = require("./prompts");
const {
  getExplorationStructureInstruction,
  normalizeDependencyRiskLevel,
  normalizeContactSubmode,
  normalizeInfoSubmode
} = require("./flags");
const { buildLLMUserTurns } = require("./llm-messages");

function createWriter({ client, MODEL_IDS, normalizeMemory }) {
  // Wrap a prompt block with clear start/end markers to keep the prompt structure explicit.
  function wrapPromptBlock(marker, content) {
    return `[[${marker}_START]]
${String(content || "").trim()}
[[${marker}_END]]`;
  }

  // Build the explicit posture contract block injected at the top of every writer system prompt.
  // This is the single source of policy for the current turn — the writer does not need to infer it.
  function buildPostureContractBlock(postureDecision = {}) {
    const writerMode = postureDecision.writerMode || "exploration_open";
    const intent = postureDecision.intent || "explorer librement";
    const forbidden = Array.isArray(postureDecision.forbidden) && postureDecision.forbidden.length > 0
      ? postureDecision.forbidden.join(", ")
      : "aucune contrainte specifique";
    const confidenceSignal = postureDecision.confidenceSignal || "high";
    const maxSentences = postureDecision.maxSentences || null;
    const toneConstraint = postureDecision.toneConstraint || null;
    const responseRegister = postureDecision.responseRegister || "courant";
    const phraseLengthPolicy = postureDecision.phraseLengthPolicy || "moyenne";
    const relancePolicy = postureDecision.relancePolicy || "selective";
    const somaticFocusPolicy = postureDecision.somaticFocusPolicy || "none";
    const criticalGuardrails = Array.isArray(postureDecision.criticalGuardrails) && postureDecision.criticalGuardrails.length > 0
      ? postureDecision.criticalGuardrails.join(", ")
      : "no_unconscious, no_psychopathology, no_defense_mechanisms, no_implicit_agency";

    const lines = [
      `Etat : ${writerMode}`,
      `Intention : ${intent}`,
      `Interdit ce tour : ${forbidden}`,
      `Registre cible (arbitre) : ${responseRegister}`,
      `Longueur de phrase (arbitree) : ${phraseLengthPolicy}`,
      `Politique de relance (arbitree) : ${relancePolicy}`,
      `Politique somatique (arbitree) : ${somaticFocusPolicy}`,
      `Signalement d'incertitude : ${confidenceSignal === "low" ? "oui — signale explicitement que tu n'es pas certain de ta lecture" : "non"}`,
      `Garde-fous critiques actifs : ${criticalGuardrails}`,
      "Ces politiques structurelles (registre/longueur/relance/somatique) viennent de l'arbitrage; ne les redecide pas depuis le message.",
      "Contraintes theoriques actives : no_unconscious (ne jamais mobiliser inconscient/subconscient comme instance explicative), no_psychopathology (ne jamais cadrer via pathologie/sante mentale), no_defense_mechanisms (ne pas parler de mecanismes de defense), no_implicit_agency (ne pas attribuer d'agentivite implicite au sujet — 'tu evites', 'tu resistes')",
    ];
    if (responseRegister === "familier") {
      lines.push("Execution registre : language direct et courant, sans tournures cliniques ou soutenues.");
    } else if (responseRegister === "soutenu") {
      lines.push("Execution registre : ton pose et clair, sans jargon ni formalisme excessif.");
    } else {
      lines.push("Execution registre : ton courant, naturel et accessible.");
    }
    if (maxSentences) lines.push(`Longueur : max ${maxSentences} phrases`);
    if (toneConstraint) lines.push(`Ton : ${toneConstraint}`);
    if (phraseLengthPolicy === "courte") {
      lines.push("Execution longueur : privilegie des phrases courtes et directes; coupe les longues constructions.");
    } else {
      lines.push("Execution longueur : garde des phrases de taille moyenne; evite les phrases longues en cascade.");
    }
    if (relancePolicy === "forbidden") {
      lines.push("Execution relance : n'ouvre pas de relance.");
    } else if (relancePolicy === "discouraged") {
      lines.push("Execution relance : relance seulement si strictement necessaire; sinon, cloture sans ouverture.");
    } else if (relancePolicy === "selective") {
      lines.push("Execution relance : une relance courte est possible uniquement si elle apporte un deplacement concret.");
    } else {
      lines.push("Execution relance : relance autorisee mais jamais automatique.");
    }
    if (somaticFocusPolicy === "prioritize_somatic_proximity") {
      lines.push("Execution somatique : privilegie la proximite avec le ressenti corporel deja detecte.");
    } else if (somaticFocusPolicy === "address_frustration_before_somatic_relocalization") {
      lines.push("Execution somatique : traite d'abord la frustration relationnelle; n'impose pas de relocalisation corporelle.");
    }
    if (postureDecision.interpretationRejectionDetected === true || postureDecision.needsSoberReadjustment === true) {
      lines.push("Reajustement d'interpretation actif : n'ajoute pas de justification ni de meta-discours, repars du plus concret.");
    }
    if (postureDecision.humanFieldGuardActive === true) {
      lines.push("Human field guard actif : interdit de basculer en mode procedural/instrumental (mode d'emploi, check-list, manipulation d'outil).");
    }

    // Inject operational definitions only for terms that are actually forbidden this turn
    if (Array.isArray(postureDecision.forbidden) && postureDecision.forbidden.length > 0) {
      const forbiddenDefs = {
        relance: "toute invite explicite ou implicite a continuer/approfondir/preciser",
        interpretive_hypothesis: 'toute formulation du type "peut-etre que", "il semblerait que", "quelque chose comme"',
        open_question: "toute question ouverte (quoi, comment, qu est-ce qui...)",
        prescriptive_language: "toute instruction ou suggestion d action a l utilisateur (essaie de, tu pourrais)",
        action_concrete_proposal: "proposition de geste/action concrete comme solution immediate au malaise relationnel",
        list: "enumeration ou bullet points dans la reponse",
        recap: "synthese ou recapitulatif de ce qui a ete dit avant",
        self_justification: "explication ou defense de la reponse precedente du bot"
      };
      const defs = postureDecision.forbidden
        .filter(term => forbiddenDefs[term])
        .map(term => `  - ${term} : ${forbiddenDefs[term]}`)
        .join("\n");
      if (defs) lines.splice(3, 0, `Definitions des termes interdits :\n${defs}`);
    }

    return wrapPromptBlock("POSTURE_CONTRACT", lines.join("\n"));
  }

  // Build the identity prompt block containing the assistant's persona and behavior rules.
  function getIdentityPrompt(promptRegistry = buildDefaultPromptRegistry()) {
    const identityBlock = String(promptRegistry.IDENTITY_BLOCK || "").trim();
    return wrapPromptBlock("IDENTITY_BLOCK", identityBlock);
  }

  // Build the contact mode prompt block for explicit contact-style responses.
  function getContactPrompt(promptRegistry = buildDefaultPromptRegistry()) {
    const contactBlock = String(promptRegistry.MODE_CONTACT || "").trim();
    return wrapPromptBlock("MODE_CONTACT", contactBlock);
  }

  // Build the relational adjustment prompt block.
  function getRelationalAdjustmentPrompt(promptRegistry = buildDefaultPromptRegistry()) {
    const adjustmentBlock = String(promptRegistry.MODE_RELATIONAL_ADJUSTMENT || "").trim();
    return wrapPromptBlock("MODE_RELATIONAL_ADJUSTMENT", adjustmentBlock);
  }

  // Build the info mode prompt block, injecting the current normalized memory.
  function getInfoPrompt(memory, infoSubmode = null, promptRegistry = buildDefaultPromptRegistry()) {
    const normalizedMemory = normalizeMemory(memory, promptRegistry);
    const normalizedInfoSubmode = normalizeInfoSubmode(infoSubmode);
    const infoBlockContent = normalizedInfoSubmode === "pure" ?
      String(promptRegistry.MODE_INFORMATION_PURE || promptRegistry.MODE_INFORMATION || "").trim() :
      normalizedInfoSubmode === "psychoeducation" ?
        String(promptRegistry.MODE_INFORMATION_PSYCHOEDUCATION || promptRegistry.MODE_INFORMATION_APP_THEORETICAL_MODEL || promptRegistry.MODE_INFORMATION_APP || promptRegistry.MODE_INFORMATION || "").trim() :
        String(promptRegistry.MODE_INFORMATION_APP_FEATURES || promptRegistry.MODE_INFORMATION_APP || promptRegistry.MODE_INFORMATION || "").trim();
    const infoBlock = [
      infoBlockContent,
      `Memoire :\n${normalizedMemory}`
    ].filter(Boolean).join("\n\n").trim();

    return wrapPromptBlock("MODE_INFORMATION", infoBlock);
  }

  // Build the exploration prompt block, injecting memory and directivity instructions.
  function getExplorationPrompt(memory, explorationDirectivityLevel = 0, promptRegistry = buildDefaultPromptRegistry()) {
    const normalizedMemory = normalizeMemory(memory, promptRegistry);
    const commonExplorationBlock = String(promptRegistry.COMMON_EXPLORATION || "")
      .replace("{{MEMORY}}", normalizedMemory)
      .trim();
    const explorationStructureBlock = String(
      getExplorationStructureInstruction(explorationDirectivityLevel, promptRegistry) || ""
    ).trim();

    const explorationBlock = [
      commonExplorationBlock,
      explorationStructureBlock
    ].filter(Boolean).join("\n\n").trim();

    return wrapPromptBlock("MODE_EXPLORATION", explorationBlock);
  }

  function buildExplorationSubmodePromptBlock(explorationSubmode = "interpretation", promptRegistry = buildDefaultPromptRegistry()) {
    const safeExplorationSubmode = ["interpretation", "phenomenological_follow"].includes(explorationSubmode) ?
      explorationSubmode :
      "interpretation";

    const content = safeExplorationSubmode === "phenomenological_follow" ?
      String(promptRegistry.EXPLORATION_SUBMODE_PHENOMENOLOGICAL_FOLLOW || "").trim() :
      String(promptRegistry.EXPLORATION_SUBMODE_INTERPRETATION || "").trim();

    return wrapPromptBlock("EXPLORATION_SUBMODE", content);
  }

  function buildPostContactLandingPromptBlock(conversationStateKey, promptRegistry = buildDefaultPromptRegistry()) {
    if (conversationStateKey !== "post_contact") return "";
    const content = String(promptRegistry.POST_CONTACT_LANDING || "").trim();
    return content ? wrapPromptBlock("POST_CONTACT_LANDING", content) : "";
  }

  // Phase C state prompt blocks
  function buildStabilizationPromptBlock(conversationStateKey, promptRegistry = buildDefaultPromptRegistry()) {
    if (conversationStateKey !== "stabilization") return "";
    const content = String(promptRegistry.STABILIZATION_MODE || "").trim();
    return content ? wrapPromptBlock("STABILIZATION_MODE", content) : "";
  }

  function buildAllianceRupturePromptBlock(conversationStateKey, promptRegistry = buildDefaultPromptRegistry()) {
    if (conversationStateKey !== "alliance_rupture") return "";
    const content = String(promptRegistry.ALLIANCE_RUPTURE_REPAIR || "").trim();
    return content ? wrapPromptBlock("ALLIANCE_RUPTURE_REPAIR", content) : "";
  }

  function buildDependencyRiskGuardrailBlock(dependencyRiskLevel = "low", promptRegistry = buildDefaultPromptRegistry()) {
    if (normalizeDependencyRiskLevel(dependencyRiskLevel) !== "high") return "";
    const content = String(promptRegistry.DEPENDENCY_RISK_GUARDRAIL || "").trim();
    return content ? wrapPromptBlock("DEPENDENCY_RISK_GUARDRAIL", content) : "";
  }

  function buildClosurePromptBlock(conversationStateKey, promptRegistry = buildDefaultPromptRegistry()) {
    if (conversationStateKey !== "closure") return "";
    const content = String(promptRegistry.CLOSURE_MODE || "").trim();
    return content ? wrapPromptBlock("CLOSURE_MODE", content) : "";
  }

  function buildRelationalAdjustmentPromptBlock(relationalAdjustmentTriggered = false, promptRegistry = buildDefaultPromptRegistry()) {
    if (relationalAdjustmentTriggered !== true) {
      return "";
    }

    const adjustmentBlock = String(promptRegistry.MODE_RELATIONAL_ADJUSTMENT || "").trim();
    return wrapPromptBlock("RELATIONAL_ADJUSTMENT", adjustmentBlock);
  }

  function buildContactSubmodePromptBlock(contactSubmode = null, promptRegistry = buildDefaultPromptRegistry()) {
    const safeContactSubmode = normalizeContactSubmode(contactSubmode);

    if (!safeContactSubmode) {
      return "";
    }

    const content = safeContactSubmode === "dysregulated" ?
      String(promptRegistry.CONTACT_SUBMODE_DYSREGULATED || "").trim() :
      String(promptRegistry.CONTACT_SUBMODE_REGULATED || "").trim();

    return content ? wrapPromptBlock("CONTACT_SUBMODE", content) : "";
  }

  function buildInterpretationRejectionPromptBlock(interpretationRejection = null) {
    if (
      !interpretationRejection ||
      (
        interpretationRejection.isInterpretationRejection !== true &&
        interpretationRejection.needsSoberReadjustment !== true
      )
    ) {
      return "";
    }

    const lines = [
      "Rejet d'interpretation detecte sur le tour actuel.",
      "- n'essaie pas de defendre la lecture precedente",
      "- n'ajoute aucun meta-discours sur le fait de t'etre trompe",
      interpretationRejection.rejectsUnderlyingPhenomenon === true ?
        "- le phenomene de fond semble lui aussi rejete : repars du plus observable" :
        "- seul l'angle precedent semble rejete : garde le phenomene de fond seulement s'il reste tres concret",
      interpretationRejection.needsSoberReadjustment === true ?
        "- reajuste l'axe dans la reponse presente, de maniere sobre et concrete" :
        "- reste sobre et n'exagere pas le reajustement",
      interpretationRejection.tensionHoldLevel === "high" ?
        "- garde une tension ferme apres reajustement" :
        interpretationRejection.tensionHoldLevel === "low" ?
        "- reduis nettement la tension apres reajustement" :
        "- garde une tension calme apres reajustement"
    ];

    return wrapPromptBlock("INTERPRETATION_REJECTION", lines.join("\n"));
  }

  // Construct the full system prompt for the selected mode before calling the LLM.
  // postureDecision carries the full contract (writerMode, forbidden, intent, etc.).
  // The contract block is always injected first so the writer receives the policy
  // before any identity or style instructions.
  function buildSystemPrompt(postureDecision, memory, promptRegistry = buildDefaultPromptRegistry(), infoSubmode = null, interpretationRejection = null, contactSubmode = null) {
    const mode = postureDecision.finalDetectedMode;
    const writerMode = postureDecision.writerMode || "exploration_open";
    const explorationDirectivityLevel = postureDecision.finalDirectivityLevel;
    const explorationSubmode = postureDecision.finalExplorationSubmode || "interpretation";
    const relationalAdjustmentTriggered = postureDecision.relationalAdjustmentTriggered;

    const contractWrapped = buildPostureContractBlock(postureDecision);
    const identityWrapped = getIdentityPrompt(promptRegistry);
    const relationalAdjustmentWrapped = buildRelationalAdjustmentPromptBlock(relationalAdjustmentTriggered, promptRegistry);
    const interpretationSignal = {
      isInterpretationRejection: postureDecision.interpretationRejectionDetected === true || interpretationRejection?.isInterpretationRejection === true,
      needsSoberReadjustment: postureDecision.needsSoberReadjustment === true || interpretationRejection?.needsSoberReadjustment === true,
      rejectsUnderlyingPhenomenon: postureDecision.rejectsUnderlyingPhenomenon === true || interpretationRejection?.rejectsUnderlyingPhenomenon === true,
      tensionHoldLevel: postureDecision.tensionHoldLevel || interpretationRejection?.tensionHoldLevel || "medium"
    };
    const interpretationRejectionWrapped = buildInterpretationRejectionPromptBlock(interpretationSignal);

    // Single style block selected by writerMode
    let styleBlock = "";
    const PHASE_C_STATES = ["stabilization", "alliance_rupture", "closure", "post_contact"];
    if (mode === "contact") {
      const contactWrapped = getContactPrompt(promptRegistry);
      const contactSubmodeWrapped = buildContactSubmodePromptBlock(contactSubmode, promptRegistry);
      styleBlock = [contactWrapped, contactSubmodeWrapped].filter(Boolean).join("\n\n");
    } else if (mode === "info") {
      styleBlock = getInfoPrompt(memory, infoSubmode, promptRegistry);
    } else if (PHASE_C_STATES.includes(writerMode)) {
      // Phase C states: contract block is the sole policy source.
      // COMMON_EXPLORATION would introduce contradictory invitations (open questions, hypotheses).
      // No style block injected — identity + contract is sufficient.
      styleBlock = "";
    } else {
      // exploration_open and exploration_guided
      const explorationWrapped = getExplorationPrompt(memory, explorationDirectivityLevel, promptRegistry);
      const explorationSubmodeWrapped = buildExplorationSubmodePromptBlock(explorationSubmode, promptRegistry);
      styleBlock = [explorationWrapped, explorationSubmodeWrapped].filter(Boolean).join("\n\n");
    }

    return [
      contractWrapped,
      identityWrapped,
      styleBlock,
      relationalAdjustmentWrapped,
      interpretationRejectionWrapped
    ].filter(Boolean).join("\n\n").trim();
  }

  // Generate the assistant reply using the assembled system prompt and conversation history.
  async function generateReply({
    message,
    history,
    memory,
    postureDecision,
    infoSubmode = null,
    contactSubmode = null,
    interpretationRejection = null,
    promptRegistry = buildDefaultPromptRegistry(),
  }) {
    const systemPrompt = buildSystemPrompt(
      postureDecision,
      memory,
      promptRegistry,
      infoSubmode,
      interpretationRejection,
      contactSubmode,
    );

    const messages = [
      { role: "system", content: systemPrompt },
      ...buildLLMUserTurns(message, history),
    ];

    // Send the assembled prompt and conversation history to the LLM.
    const r = await client.chat.completions.create({
      model: MODEL_IDS.generation,
      temperature: 0.7,
      top_p: 1,
      presence_penalty: 0.5,
      frequency_penalty: 0.3,
      messages
    });

    return {
      reply: (r.choices?.[0]?.message?.content || "").trim() || "Je t'ecoute."
    };
  }

  return {
    wrapPromptBlock,
    buildPostureContractBlock,
    getIdentityPrompt,
    getContactPrompt,
    getRelationalAdjustmentPrompt,
    getInfoPrompt,
    getExplorationPrompt,
    buildExplorationSubmodePromptBlock,
    buildPostContactLandingPromptBlock,
    buildStabilizationPromptBlock,
    buildAllianceRupturePromptBlock,
    buildDependencyRiskGuardrailBlock,
    buildClosurePromptBlock,
    buildRelationalAdjustmentPromptBlock,
    buildContactSubmodePromptBlock,
    buildInterpretationRejectionPromptBlock,
    buildSystemPrompt,
    generateReply
  };
}

module.exports = { createWriter };
