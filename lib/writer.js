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
    const confidenceSignal = typeof postureDecision.confidenceSignal === "number" ? postureDecision.confidenceSignal : 1.0;
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
      `Signalement d'incertitude : ${confidenceSignal < 0.6 ? `oui — signale explicitement que tu n'es pas certain de ta lecture (confiance : ${confidenceSignal})` : "non"}`,
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
    if (postureDecision.interpretationRejectionModeActive === true || postureDecision.needsSoberReadjustment === true) {
      lines.push("Reajustement d'interpretation actif : n'ajoute pas de justification ni de meta-discours, repars du plus concret.");
    }
    if (postureDecision.humanFieldGuardActive === true) {
      lines.push("Human field guard actif : interdit de basculer en mode procedural/instrumental (mode d'emploi, check-list, manipulation d'outil).");
    }

    const theoreticalOrientationSignal = postureDecision.theoreticalOrientationSignal || "none";
    const orientationConfidence = postureDecision.orientationConfidence ?? 0.0;
    if (theoreticalOrientationSignal !== "none") {
      const orientationLabels = {
        disconnection: "désalignement entre mémoire des ressentis et mémoire du sens",
        limiting_belief: "croyance limitante au premier plan",
        transformation_in_progress: "mouvement de transformation ou d'intégration en cours",
        adaptive_mechanism: "mécanisme adaptatif perceptible comme contraignant pour la personne",
        relational_need: "besoin relationnel prioritaire ce tour",
        limit_expression: "difficulté à ressentir ou exprimer ses propres limites",
        unfinished_business: "affect non résolu envers une personne significative du passé (inachevé encore actif)"
      };
      const label = orientationLabels[theoreticalOrientationSignal] || theoreticalOrientationSignal;
      const certaintyNote = orientationConfidence < 0.7 ? ` (confiance : ${orientationConfidence} — reste ouvert à d'autres lectures)` : "";
      lines.push(`Orientation théorique arbitrée : ${label}${certaintyNote}`);
      lines.push("Cette orientation vient de l'analyseur ; formule depuis elle sans la re-détecter toi-même depuis le message.");
    }

    // Axe 1 — contrainte hard vouvoiement
    if (postureDecision.formalAddress === true) {
      lines.push("Contrainte absolue : cette personne vouvoie. Vouvoie dans toute ta réponse. Ne jamais tutoyer.");
    }

    // Patch D3 — writerOrientationHint
    const writerOrientationHint = postureDecision.writerOrientationHint || null;
    if (writerOrientationHint === "unfinished_business_subtle_opening") {
      lines.push("Hint d'orientation — affect non resolu (inacheve) :\n  La personne porte un affect non resolu envers quelqu'un du passe. N'invite pas directement a formuler ce qui n'a pas ete dit. Ouvre l'espace a travers une reformulation legerement deplacee ou une remarque contextuelle qui laisse sentir l'inacheve sans l'ordonner. Posture attendue : quelque chose du genre 'j'imagine qu'il y avait des choses que tu aurais aime lui dire...' ou un reflet de la relation qui laisse l'ouverture sans la forcer. Interdit : question directe sur ce qui n'a pas ete dit, interpretation du contenu de ce qui manque.");
    }

    // Patch G — writerIntentHints
    const writerIntentHints = Array.isArray(postureDecision.writerIntentHints) ? postureDecision.writerIntentHints : [];
    const INTENT_HINT_TEXTS = {
      auto_compassion_door_open: "Hint auto-compassion : Si le moment s'y prete, ouvre la porte vers la ressource bienveillante interne — sans etre cette voix toi-meme. Tu peux inviter la personne a identifier ce dont elle aurait eu besoin, ou ce qu'une voix douce lui dirait. Interdit : consolation directe, affirmation externe de valeur ('tu es quelqu'un de bien'), reparation du ressenti.",
      signify_pain_without_blocking: "Hint douleur presente : Formule combien il peut etre douloureux d'etre dans un rapport aussi dur avec soi-meme. Ne bloque pas le ressenti, ne le repare pas, ne le contredis pas. Laisse ce que ca fait d'etre la, sans chercher a en sortir.",
      hold_emotional_thread: "Hint fil emotionnel : Dans ce message, quelque chose commencait a emerger puis s'est coupe. Identifie ce qui etait la AVANT la coupure (avant le 'de toute facon', le changement de sujet, la fermeture) — c'est ce fil-la qui merite d'etre tenu, pas la deflexion elle-meme. Reconnais doucement cette amorce sans forcer a y retourner.",
      amplify_insight: "Hint moment d'insight : La personne vient de formuler quelque chose de nouveau meme pour elle. Marque ce moment, ralentis. Une phrase sobre qui nomme que quelque chose de different vient d'etre dit vaut plus qu'une relance qui disperserait."
    };
    const uniqueHints = [...new Set(writerIntentHints)];
    for (const hint of uniqueHints) {
      if (INTENT_HINT_TEXTS[hint]) lines.push(INTENT_HINT_TEXTS[hint]);
    }

    // Inject operational definitions only for terms that are actually forbidden this turn
    if (Array.isArray(postureDecision.forbidden) && postureDecision.forbidden.length > 0) {
      const forbiddenDefs = {
        relance: "toute invite explicite ou implicite a continuer/approfondir/preciser",
        interpretive_hypothesis: 'toute formulation du type "peut-être que tu ressens", "il semblerait que pour toi", "quelque chose comme de la peur" — interprétation du ressenti, du vécu intérieur ou de l\'expérience émotionnelle de la personne ; ne s\'applique pas aux reformulations factuelles ou contextuelles',
        open_question: "toute question ouverte (quoi, comment, qu est-ce qui...)",
        prescriptive_language: "toute instruction ou suggestion d action a l utilisateur (essaie de, tu pourrais)",
        action_concrete_proposal: "proposition de geste/action concrete comme solution immediate au malaise relationnel",
        list: "enumeration ou bullet points dans la reponse",
        recap: "synthese ou recapitulatif de ce qui a ete dit avant",
        self_justification: "explication ou defense de la reponse precedente du bot",
        value_affirmation: "affirmer la valeur de la personne directement ('tu as de la valeur', 'tu es quelqu'un de bien', 'c'est normal d'avoir du mal avec soi-meme') — laisser le ressenti tel qu'il est"
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

  // Build the discharge mode prompt block for active process responses.
  function getDischargePrompt(promptRegistry = buildDefaultPromptRegistry()) {
    const dischargeBlock = String(promptRegistry.MODE_DISCHARGE || "").trim();
    return wrapPromptBlock("MODE_DISCHARGE", dischargeBlock);
  }

  // Build the relational adjustment prompt block.
  function getRelationalAdjustmentPrompt(promptRegistry = buildDefaultPromptRegistry()) {
    const adjustmentBlock = String(promptRegistry.MODE_RELATIONAL_ADJUSTMENT || "").trim();
    return wrapPromptBlock("MODE_RELATIONAL_ADJUSTMENT", adjustmentBlock);
  }

  // Build the info mode prompt block, injecting the current normalized memory.
  function getInfoPrompt(infoSubmode = null, promptRegistry = buildDefaultPromptRegistry(), infoContractContext = {}) {
    const normalizedInfoSubmode = normalizeInfoSubmode(infoSubmode);
    const { psychoeducationType = null, infoContextFlags = [] } = infoContractContext;
    const infoBlockContent = normalizedInfoSubmode === "pure" ?
      String(promptRegistry.MODE_INFORMATION_PURE || promptRegistry.MODE_INFORMATION || "").trim() :
      normalizedInfoSubmode === "psychoeducation" ?
        String(promptRegistry.MODE_INFORMATION_PSYCHOEDUCATION || promptRegistry.MODE_INFORMATION_APP_THEORETICAL_MODEL || promptRegistry.MODE_INFORMATION_APP || promptRegistry.MODE_INFORMATION || "").trim() :
        String(promptRegistry.MODE_INFORMATION_APP_FEATURES || promptRegistry.MODE_INFORMATION_APP || promptRegistry.MODE_INFORMATION || "").trim();

    let contractInjection = "";
    if (normalizedInfoSubmode === "psychoeducation" && psychoeducationType) {
      contractInjection = `[TYPE DÉTECTÉ PAR L'ANALYSEUR : ${psychoeducationType}]\nApplique strictement et uniquement les contraintes du TYPE ${psychoeducationType} définies ci-dessous. Ne re-détecte pas le type.`;
    }
    if (normalizedInfoSubmode !== "pure" && normalizedInfoSubmode !== "psychoeducation" && infoContextFlags.length > 0) {
      contractInjection = `[FLAGS INFO ACTIFS : ${infoContextFlags.join(", ")}]\nApplique uniquement les sections correspondant à ces flags.`;
    }

    const block = contractInjection
      ? contractInjection + "\n\n" + infoBlockContent
      : infoBlockContent;

    return wrapPromptBlock("MODE_INFORMATION", block);
  }

  // Build the exploration prompt block, injecting directivity instructions.
  function getExplorationPrompt(explorationDirectivityLevel = 0, promptRegistry = buildDefaultPromptRegistry()) {
    const commonExplorationBlock = String(promptRegistry.COMMON_EXPLORATION || "").trim();
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

  function buildPostContactLandingPromptBlock() {
    // Removed: the post-discharge contact landing is handled by C3 contract (forbidden + writerIntentHints).
    // This function is kept as a no-op stub to avoid breaking any external callers.
    return "";
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

  function buildRelationalAdjustmentPromptBlock(relationalAdjustmentTriggered = false, promptRegistry = buildDefaultPromptRegistry(), relationalAdjustmentDepth = "moderate") {
    if (relationalAdjustmentTriggered !== true) {
      return "";
    }

    const depthInstruction = relationalAdjustmentDepth === "minimal"
      ? "Profondeur arbitrée : MINIMALE — une phrase de reconnaissance sobre, puis enchaîne directement sur le mode courant sans présence relationnelle développée."
      : "Profondeur arbitrée : MODÉRÉE — reconnaissance et réajustement en 2-3 phrases, puis geste conversationnel.";

    const adjustmentBlock = String(promptRegistry.MODE_RELATIONAL_ADJUSTMENT || "").trim();
    return wrapPromptBlock("RELATIONAL_ADJUSTMENT", depthInstruction + "\n\n" + adjustmentBlock);
  }

  function buildDischargeSubmodePromptBlock(contactSubmode = null, promptRegistry = buildDefaultPromptRegistry()) {
    const safeContactSubmode = normalizeContactSubmode(contactSubmode);

    if (!safeContactSubmode) {
      return "";
    }

    const content = safeContactSubmode === "dysregulated" ?
      String(promptRegistry.DISCHARGE_SUBMODE_DYSREGULATED || "").trim() :
      String(promptRegistry.DISCHARGE_SUBMODE_REGULATED || "").trim();

    return content ? wrapPromptBlock("DISCHARGE_SUBMODE", content) : "";
  }

  // Build the contact state prompt block (soft contact: internal charge directed inward).
  function buildContactStatePromptBlock(writerMode = null, promptRegistry = buildDefaultPromptRegistry()) {
    if (writerMode !== "contact") return "";
    const content = String(promptRegistry.MODE_CONTACT_STATE || "").trim();
    return content ? wrapPromptBlock("CONTACT_STATE_MODE", content) : "";
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
    const relationalAdjustmentTriggered = postureDecision.relationalAdjustmentActive;

    const contractWrapped = buildPostureContractBlock(postureDecision);
    const identityWrapped = getIdentityPrompt(promptRegistry);
    const relationalAdjustmentWrapped = buildRelationalAdjustmentPromptBlock(
      relationalAdjustmentTriggered,
      promptRegistry,
      postureDecision.relationalAdjustmentDepth || "moderate"
    );
    const interpretationSignal = {
      isInterpretationRejection: postureDecision.interpretationRejectionModeActive === true || interpretationRejection?.isInterpretationRejection === true,
      needsSoberReadjustment: postureDecision.needsSoberReadjustment === true || interpretationRejection?.needsSoberReadjustment === true,
      rejectsUnderlyingPhenomenon: postureDecision.underlyingPhenomenonRejected === true || interpretationRejection?.rejectsUnderlyingPhenomenon === true,
      tensionHoldLevel: postureDecision.tensionHoldLevel || interpretationRejection?.tensionHoldLevel || "medium"
    };
    const interpretationRejectionWrapped = buildInterpretationRejectionPromptBlock(interpretationSignal);

    // Extract and normalize memory upfront for unified injection
    const normalizedMemory = normalizeMemory(memory, promptRegistry);
    const memoryBlock = normalizedMemory
      ? wrapPromptBlock("MEMORY", normalizedMemory)
      : "";

    // Single style block selected by writerMode
    let styleBlock = "";
    const PHASE_C_STATES = ["stabilization", "alliance_rupture", "closure", "contact"];
    if (writerMode === "n2_crisis") {
      const n2Content = String(promptRegistry.N2_RESPONSE_LLM || "").trim();
      styleBlock = n2Content ? wrapPromptBlock("N2_CRISIS_STYLE", n2Content) : "";
    } else if (writerMode === "n1_crisis") {
      const n1Content = String(promptRegistry.N1_RESPONSE_LLM || "").trim();
      styleBlock = n1Content ? wrapPromptBlock("N1_CRISIS_STYLE", n1Content) : "";
    } else if (mode === "discharge") {
      const dischargeWrapped = getDischargePrompt(promptRegistry);
      const dischargeSubmodeWrapped = buildDischargeSubmodePromptBlock(contactSubmode, promptRegistry);
      styleBlock = [dischargeWrapped, dischargeSubmodeWrapped].filter(Boolean).join("\n\n");
    } else if (mode === "info") {
      const infoContractContext = {
        psychoeducationType: postureDecision.psychoeducationType || null,
        infoContextFlags: postureDecision.infoContextFlags || []
      };
      styleBlock = getInfoPrompt(infoSubmode, promptRegistry, infoContractContext);
    } else if (PHASE_C_STATES.includes(writerMode)) {
      // Quatre états Phase-C, chacun avec son bloc dédié :
      // contact, stabilization, alliance_rupture, closure.
      styleBlock = buildContactStatePromptBlock(writerMode, promptRegistry)
        || buildStabilizationPromptBlock(writerMode, promptRegistry)
        || buildAllianceRupturePromptBlock(writerMode, promptRegistry)
        || buildClosurePromptBlock(writerMode, promptRegistry);
    } else {
      // exploration_open and exploration_restrained
      const explorationWrapped = getExplorationPrompt(explorationDirectivityLevel, promptRegistry);
      const explorationSubmodeWrapped = buildExplorationSubmodePromptBlock(explorationSubmode, promptRegistry);
      styleBlock = [explorationWrapped, explorationSubmodeWrapped].filter(Boolean).join("\n\n");
    }

    // Recall injection: when the user attempts a recall, inject recall instructions
    // alongside the current state's style block (does not override the state).
    const recallBlock = postureDecision.recallInjectionActive === true
      ? (() => {
          const recallContent = String(promptRegistry.MEMORY_RECALL_RESPONSE || "").trim();
          return recallContent ? wrapPromptBlock("RECALL_MEMORY_STYLE", recallContent) : "";
        })()
      : "";

    // Dependency risk guardrail: injected when dependencyRiskLevel === "high".
    const dependencyGuardrailBlock = buildDependencyRiskGuardrailBlock(
      postureDecision.dependencyRiskLevel,
      promptRegistry
    );

    return [
      contractWrapped,
      identityWrapped,
      styleBlock,
      memoryBlock,
      recallBlock,
      relationalAdjustmentWrapped,
      interpretationRejectionWrapped,
      dependencyGuardrailBlock
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
    getDischargePrompt,
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
    buildDischargeSubmodePromptBlock,
    buildContactStatePromptBlock,
    buildInterpretationRejectionPromptBlock,
    buildSystemPrompt,
    generateReply
  };
}

module.exports = { createWriter };
