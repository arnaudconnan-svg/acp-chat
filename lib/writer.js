"use strict";

const { buildDefaultPromptRegistry } = require("./prompts");
const {
  getExplorationStructureInstruction,
  normalizeDependencyRiskLevel,
} = require("./flags");
const { buildLLMUserTurns } = require("./llm-messages");

function createWriter({ client, MODEL_IDS, normalizeMemory }) {
  function normalizeTextForMatch(value) {
    return String(value || "")
      .toLowerCase()
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[’']/g, "'")
      .replace(/\s+/g, " ")
      .trim();
  }

  function extractSentenceStartKey(text, maxWords = 5) {
    const firstSentence = String(text || "")
      .split(/[.!?\n]/)
      .map(part => part.trim())
      .find(Boolean) || "";

    const words = normalizeTextForMatch(firstSentence).match(/[a-z0-9']+/g) || [];
    return words.slice(0, Math.max(1, maxWords)).join(" ");
  }

  function detectOpeningFormula(text) {
    const normalized = normalizeTextForMatch(text);
    const formulas = [
      "je reconnais",
      "je comprends",
      "j'entends",
      "je vois",
      "je ressens",
      "j'imagine",
      "je percois",
      "je sens"
    ];
    return formulas.find(formula => normalized.startsWith(formula)) || "";
  }

  function buildRecentAntiRepetitionPromptBlock(history = []) {
    const safeHistory = Array.isArray(history) ? history : [];
    const lastTwoAssistantTurns = safeHistory
      .filter(turn => turn && turn.role === "assistant" && typeof turn.content === "string" && turn.content.trim())
      .slice(-2)
      .map(turn => String(turn.content || "").trim());

    if (lastTwoAssistantTurns.length === 0) return "";

    const lines = [
      "Anti-repetition locale (2 derniers tours assistant uniquement) :",
      "- Interdiction de reprendre un debut de phrase identique a l'un des deux derniers tours assistant."
    ];

    const lastAssistantTurn = lastTwoAssistantTurns[lastTwoAssistantTurns.length - 1] || "";
    const lastOpeningFormula = detectOpeningFormula(lastAssistantTurn);
    if (lastOpeningFormula) {
      lines.push(`- Le tour precedent commencait par '${lastOpeningFormula}' : ne pas reutiliser cette amorce ce tour.`);
    }

    const startKeys = lastTwoAssistantTurns
      .map(turn => extractSentenceStartKey(turn))
      .filter(Boolean);
    if (startKeys.length > 0) {
      lines.push(`- Debuts recents a eviter : ${startKeys.join(" | ")}.`);
    }

    return wrapPromptBlock("ANTI_REPETITION_RECENT", lines.join("\n"));
  }

  // Wrap a prompt block with clear start/end markers to keep the prompt structure explicit.
  function wrapPromptBlock(marker, content) {
    return `[[${marker}_START]]
${String(content || "").trim()}
[[${marker}_END]]`;
  }

  // Build the explicit posture contract block injected at the top of every writer system prompt.
  // This is the single source of policy for the current turn — the writer does not need to infer it.
  function buildPostureContractBlock(postureDecision = {}) {
    const conversationState = postureDecision.conversationState || "exploration_open";
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
    const uncertaintyExpressionPolicy = postureDecision.uncertaintyExpressionPolicy === "explicit" ? "explicit" : "none";
    const uncertaintyDrivers = Array.isArray(postureDecision.uncertaintyDrivers)
      ? postureDecision.uncertaintyDrivers.filter(driver => ["explicit_ambiguity", "recent_rejection", "short_context"].includes(driver))
      : [];
    const uncertaintyDriverText = uncertaintyDrivers.length > 0
      ? ` (drivers: ${uncertaintyDrivers.join(", ")})`
      : "";
    const criticalGuardrails = Array.isArray(postureDecision.criticalGuardrails) && postureDecision.criticalGuardrails.length > 0
      ? postureDecision.criticalGuardrails.join(", ")
      : "no_unconscious, no_psychopathology, no_defense_mechanisms, no_implicit_agency";

    const lines = [
      "Contrainte absolue prioritaire : zero metadiscours sur le vecu de la personne. Interdit de commenter ton propre raisonnement sur ce que la personne ressent ou vit (ex: 'je me demande si tu ressens', 'il me semble que pour toi', 'j'ai l'impression que tu', 'comme si tu'). Formule directement, sans meta-commentaire sur la lecture que tu fais de l'autre. Exception : le metadiscours sur ta propre perception ou sur le fonctionnement de la relation est autorise quand il est pertinent (ex: 'je sens deux choses ici', 'je vois quelque chose qui me frappe', 'je remarque une tension dans ce que tu dis').",
      `Etat : ${conversationState}`,
      `Intention : ${intent}`,
      `Interdit ce tour : ${forbidden}`,
      `Registre cible (arbitre) : ${responseRegister}`,
      `Longueur de phrase (arbitree) : ${phraseLengthPolicy}`,
      `Politique de relance (arbitree) : ${relancePolicy}`,
      `Politique somatique (arbitree) : ${somaticFocusPolicy}`,
      `Signalement d'incertitude : ${uncertaintyExpressionPolicy === "explicit" ? `oui — signale explicitement que tu n'es pas certain de ta lecture (confiance : ${confidenceSignal})${uncertaintyDriverText}` : "non"}`,
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
    if (maxSentences) lines.push(`Contrainte absolue de longueur : ta reponse ne depasse pas ${maxSentences} phrases (point, ?, ou ! = fin de phrase). Compte avant d'envoyer. Si tu depasses, coupe.`);
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
    if (postureDecision.affiliationBuildingActive === true) {
      lines.push("Affiliation en construction : priorite a la sensation d'etre compris dans la situation decrite et rejoint dans ce que cela fait vivre. Avant toute lecture, commence par reconnaitre sobrement le vecu concret du tour.");
    }

    const ruptureActive = postureDecision.conversationState === "alliance_rupture"
      || (postureDecision.secondaryTension && postureDecision.secondaryTension.family === "alliance_rupture");
    if (postureDecision.affiliationEstablished === true && !ruptureActive) {
      lines.push("Registre vivant actif : le lien est etabli. Tu peux laisser passer davantage de vie dans ta voix — formulations plus directes, legerement moins scaffoldees, ponctuation plus expressive si pertinent. Pas de theatralite : juste une presence moins precautionneuse.");
    }

    if (postureDecision.useDirectAddress === true) {
      lines.push("Adressage direct actif : cette contrainte est prioritaire. Adresse la personne directement, au present, sans narration impersonnelle.");
      lines.push("Execution adressage : la premiere phrase doit contenir un adressage explicite a la personne (tu/te/toi/ton/ta/tes ou forme vouvoiement equivalente). Interdit d'ouvrir par une formulation descriptive impersonnelle.");
      lines.push("Execution adressage : chaque paragraphe doit garder cet adressage direct. Ne pas ecrire une observation detachee sur 'la situation' ou 'le blocage' sans l'adresser a la personne.");
    }

    // Axe 1 — contrainte hard d'adressage (vouvoiement ou tutoiement)
    if (postureDecision.formalAddress === true) {
      lines.push("Contrainte absolue : cette personne vouvoie. Vouvoie dans toute ta réponse. Ne jamais tutoyer.");
    } else {
      lines.push("Contrainte absolue : cette personne tutoie. Tutoie dans toute ta réponse. Ne jamais vouvoyer.");
    }

    // Patch G — writerIntentHints
    const writerIntentHints = Array.isArray(postureDecision.writerIntentHints) ? postureDecision.writerIntentHints : [];
    const INTENT_HINT_TEXTS = {
      affiliation_first_join: "Hint affiliation : L'utilisateur doit sentir qu'il est compris dans sa situation concrete et rejoint dans ce que cela lui fait. Commence par une reconnaissance sobre et precise du vecu avant toute hypothese ou deplacement.",
      aggressive_discharge_minimal_presence: "Hint decharge agressive : quand la decharge est dirigee contre le bot, reponse strictement minimale (un mot ou une phrase tres courte), sans reflet emotionnel developpe, sans 'je suis la', sans tentative de contenir verbalement l'intensite.",
      post_discharge_soft_landing: "Hint post-decharge : tour de transition apres une decharge. Garde une posture douce et contenante, sans pousser, sans relance, en restant au plus pres de ce qui est deja la.",
      auto_compassion_door_open: "Hint auto-compassion : Ce decentrage est un mouvement de rejet de soi — une partie peut se sentir abandonnee dans ces moments-la. Nomme-le sobrement — ex : 'Ce mouvement peut faire beaucoup de mal a la relation a soi. Une partie de toi peut se sentir comme abandonnee la-dedans.' Si le moment s'y prete, ouvre ensuite la porte vers une voix douce interne — sans etre toi-meme cette voix. Interdit : consolation directe, affirmation externe de valeur ('tu es quelqu\'un de bien'), reparation du ressenti.",
      signify_pain_without_blocking: "Hint douleur presente : Nomme d'abord ce que tu percois \u2014 ex : 'Je sens que tu es particulierement dur avec toi la.' Puis laisse ce que ca fait d'etre dans ce rapport a soi-meme, sans le reparer, sans le contredire, sans chercher a en sortir.",
      hold_emotional_thread: "Hint fil emotionnel : Dans ce message, quelque chose commencait a emerger puis s'est coupe. Nomme ce mouvement a la personne — ex : 'Je sens que tu t\'eloignes de toi la, de ce que tu etais en train de ressentir.' Identifie ce qui etait la AVANT la coupure et tiens ce fil en le disant — ne reste pas en silence sur ce qui vient de se passer.",
      amplify_insight: "Hint moment d'insight : Quelque chose vient de bouger dans ce que la personne dit \u2014 une prise de conscience, un regard qui change. Nomme-le en t'adressant a elle, sous forme de question tentative \u2014 ex : 'J'ai le sentiment qu'il y a quelque chose qui a bouge en toi, non ?' ou 'J'ai comme l'impression que ton regard sur la situation vient de changer legerement, non ?' ou 'Je sens comme une prise de conscience avec ce qu'on se dit, je me trompe ?' Reste sobre, ne developpe pas, laisse de l'espace.",
      attention_narrow_single_axis: "Hint attention restreinte : La personne a une disponibilite attentionnelle resserree. Reste sur un seul axe concret deja ouvert ce tour. N'ouvre ni nouveau chantier ni nouvelle question large.",
      alliance_fragile_sensitive: "Hint alliance fragile : tu percois quelque chose de moins fluide dans l'echange ce tour. Si tu l'exprimes, adresse-le directement a la personne — un mouvement sobre vers elle, pas un commentaire sur ta propre perception. Ex : 'je te suis avec precaution la', 'je veux pas aller trop vite avec toi ici'.",
      alliance_restored_presence: "Hint retour d'alliance : l'alliance etait fragilisee ou rompue, elle revient ce tour. Nomme sobrement ce retour en t'adressant a la personne — court, sans reference explicite a ce qui precedait. Ex : 'je te retrouve la', 'on retrouve quelque chose de plus fluide'.",
      engagement_withdrawn_noticed: "Hint retrait percu : la personne est moins presente dans l'echange que les tours precedents. Tu peux le nommer en t'adressant a elle, sous forme de verification plutot que de constat — ex : 'Je me trompe ou tu es un peu plus en retrait dans la conversation ?'. Pas d'affirmation unilaterale de presence, pas de registre poetique. Si le moment ne s'y prete pas, ne dis rien.",
      stagnation_noticed: "Hint enlisement percu : l'echange tourne depuis deux tours sans avancer. Tu peux l'ouvrir en t'adressant directement a la personne, sous forme de question sur l'utilite de ce qu'on se dit — ex : 'Je me demande si ce qu'on se dit la t'aide a avancer ?' Pas fige, pas poetique, pas d'affirmation de presence.",
      meaning_crisis_witnessed: "Hint effondrement de sens : Ce que la personne decrit ne s'explique pas — c'est l'arbitraire, pas une erreur a comprendre. Une phrase sobre qui nomme ca : 'Ce que tu decris — ca ne s'explique pas. Et je crois que c'est exactement la que ca fait mal.' Pas d'ouverture, pas de relance, pas d'hypothese. Tenir sans remplir.",
      relational_adjustment_noticed: "Hint friction relationnelle : quelque chose ne passe pas bien ce tour — le bot a rate ou mal saisi quelque chose. Reconnais-le simplement en t'adressant a la personne, sans sur-expliquer — ex : 'J'ai peut-etre mal saisi ce que tu voulais dire.', 'Ce que tu me retournes me dit que j'etais a cote.'. Tu peux, si le moment s'y prete, ajouter une relance sobre pour redonner la parole — ex : 'Qu'est-ce que tu essaies de me dire ?' Pas d'auto-justification, pas de promesse de 'faire mieux'.",
      attention_overloaded_noticed: "Hint surcharge attentionnelle percue : beaucoup de fils ouverts, l'echange devient dense. Nomme-le en t'adressant a la personne et propose de se concentrer sur un seul point — ex : 'Il y a beaucoup de choses dans ce qu'on se dit. Je te propose qu'on se concentre sur un point unique si tu veux bien.' ou 'Il y a matiere a de nombreuses reflexions. Que penses-tu de se focaliser sur [fil le plus present] dans un premier temps ?' Pas de pseudo-emotion (pas de 'j'ai peur'), pas de constat condescendant."
    };
    const uniqueHints = [...new Set(writerIntentHints)];
    for (const hint of uniqueHints) {
      if (INTENT_HINT_TEXTS[hint]) lines.push(INTENT_HINT_TEXTS[hint]);
    }

    // Tension secondaire (congruence réflexive bot)
    if (postureDecision.secondaryTension && typeof postureDecision.secondaryTension === "object") {
      const st = postureDecision.secondaryTension;
      const familyLabel = st.family === "discharge" ? "d\u00e9charge \u00e9motionnelle"
        : st.family === "info" ? "questionnement factuel"
        : st.family === "alliance_rupture" ? "rupture d'alliance"
        : st.family === "stabilization" ? "besoin de stabilisation"
        : "exploration int\u00e9rieure";
      const confidenceLabel = st.confidence === "high" ? "signal fort"
        : st.confidence === "medium" ? "signal mod\u00e9r\u00e9"
        : "signal faible";
      const step3Map = {
        discharge: "Formule le message li\u00e9 \u00e0 la d\u00e9charge : une reconnaissance sobre de la charge perceptible derri\u00e8re le message principal, sans inciter \u00e0 la lib\u00e9rer ni amplifier.",
        info: "Formule le message li\u00e9 \u00e0 la question factuelle : propose bri\u00e8vement d'y revenir une fois le premier mouvement pass\u00e9, ou r\u00e9ponds-y en une phrase si c'est urgent.",
        exploration: "Formule le message li\u00e9 au mouvement exploratoire : une invitation douce \u00e0 regarder ce qui cherche \u00e0 se comprendre l\u00e0-dedans \u2014 une seule phrase sobre, sans ouvrir de nouveau chantier.",
        alliance_rupture: "Formule le message li\u00e9 \u00e0 la rupture d'alliance : une validation sobre du d\u00e9calage per\u00e7u (\"je sens qu'il y a eu quelque chose qui n'a pas atterri comme je le voulais\" ou \u00e9quivalent). Pas de justification, pas d'excuse \u00e9labor\u00e9e.",
        stabilization: "Formule le message li\u00e9 au besoin de stabilisation : un ancrage doux et concret, une seule chose \u00e0 la fois, sans ouvrir de nouveau mouvement."
      };
      const step3 = step3Map[st.family] || "";
      lines.push(
        `Tension secondaire détectée : ${familyLabel} (${confidenceLabel}).`,
        "Ta réponse intègre trois mouvements dans cet ordre :",
        `1. Réponds depuis l'état actif (${conversationState}) — pilotage principal.`,
        `2. Méta-communication bot : nomme ta propre double lecture, depuis ta propre perception ("je sens deux choses ici", "deux choses me frappent dans ce message" ou équivalent). Ne décris pas le vécu de la personne, nomme ce que toi tu perçois.`,
        `3. ${step3}`
      );
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
        value_affirmation: "affirmer la valeur de la personne directement ('tu as de la valeur', 'tu es quelqu'un de bien', 'c'est normal d'avoir du mal avec soi-meme') — laisser le ressenti tel qu'il est",
        casual_register: "registre vivant ou complice installé lors des tours précédents : revenir ce tour à un registre neutre et contenu, sans chaleur acquise, sans ponctuation expressive, sans proximité tonale"
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

  // Build the relational adjustment prompt block.
  function getRelationalAdjustmentPrompt(promptRegistry = buildDefaultPromptRegistry()) {
    const adjustmentBlock = String(promptRegistry.SIGNAL_RELATIONAL_ADJUSTMENT || "").trim();
    return wrapPromptBlock("SIGNAL_RELATIONAL_ADJUSTMENT", adjustmentBlock);
  }

  // Build the info mode prompt block using the full conversationState key.
  function getInfoPrompt(conversationState = "info_features", promptRegistry = buildDefaultPromptRegistry(), infoContractContext = {}) {
    const { psychoeducationType = null, infoContextFlags = [] } = infoContractContext;
    const infoBlockContent = conversationState === "info_pure" ?
      String(promptRegistry.STATE_INFO_PURE || "").trim() :
      conversationState === "info_psychoeducation" ?
        String(promptRegistry.STATE_INFO_PSYCHOEDUCATION || "").trim() :
        String(promptRegistry.STATE_INFO_FEATURES || "").trim();

    let contractInjection = "";
    if (conversationState === "info_psychoeducation" && psychoeducationType) {
      contractInjection = `[TYPE DÉTECTÉ PAR L'ANALYSEUR : ${psychoeducationType}]\nApplique strictement et uniquement les contraintes du TYPE ${psychoeducationType} définies ci-dessous. Ne re-détecte pas le type.`;
    }
    if (conversationState === "info_features" && infoContextFlags.length > 0) {
      contractInjection = `[FLAGS INFO ACTIFS : ${infoContextFlags.join(", ")}]\nApplique uniquement les sections correspondant à ces flags.`;
    }

    const block = contractInjection
      ? contractInjection + "\n\n" + infoBlockContent
      : infoBlockContent;

    return wrapPromptBlock("STATE_INFORMATION", block);
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

    return wrapPromptBlock("STATE_EXPLORATION", explorationBlock);
  }

  function buildExplorationSignalPromptBlock(explorationSignal = "interpretation", promptRegistry = buildDefaultPromptRegistry()) {
    const safeExplorationSignal = ["interpretation", "phenomenological_follow"].includes(explorationSignal) ?
      explorationSignal :
      "interpretation";

    const content = safeExplorationSignal === "phenomenological_follow" ?
      String(promptRegistry.EXPLORATION_SIGNAL_PHENOMENOLOGICAL_FOLLOW || "").trim() :
      String(promptRegistry.EXPLORATION_SIGNAL_INTERPRETATION || "").trim();

    return wrapPromptBlock("EXPLORATION_SIGNAL", content);
  }

  function buildPostContactLandingPromptBlock() {
    // Removed: the post-discharge contact landing is handled by C3 contract (forbidden + writerIntentHints).
    // This function is kept as a no-op stub to avoid breaking any external callers.
    return "";
  }

  function buildStabilizationPromptBlock(conversationState, promptRegistry = buildDefaultPromptRegistry()) {
    if (conversationState !== "stabilization") return "";
    const content = String(promptRegistry.STATE_STABILIZATION || "").trim();
    return content ? wrapPromptBlock("STATE_STABILIZATION", content) : "";
  }

  function buildAllianceRupturePromptBlock(conversationState, promptRegistry = buildDefaultPromptRegistry()) {
    if (conversationState !== "alliance_rupture") return "";
    const content = String(promptRegistry.STATE_ALLIANCE_RUPTURE || "").trim();
    return content ? wrapPromptBlock("STATE_ALLIANCE_RUPTURE", content) : "";
  }

  function buildDependencyRiskGuardrailBlock(dependencyRiskLevel = "low", promptRegistry = buildDefaultPromptRegistry()) {
    if (normalizeDependencyRiskLevel(dependencyRiskLevel) !== "high") return "";
    const content = String(promptRegistry.DEPENDENCY_RISK_GUARDRAIL || "").trim();
    return content ? wrapPromptBlock("DEPENDENCY_RISK_GUARDRAIL", content) : "";
  }

  function buildClosurePromptBlock(conversationState, promptRegistry = buildDefaultPromptRegistry()) {
    if (conversationState !== "closure") return "";
    const content = String(promptRegistry.STATE_CLOSURE || "").trim();
    return content ? wrapPromptBlock("STATE_CLOSURE", content) : "";
  }

  function buildRelationalAdjustmentPromptBlock(relationalAdjustmentTriggered = false, promptRegistry = buildDefaultPromptRegistry(), relationalAdjustmentDepth = "moderate") {
    if (relationalAdjustmentTriggered !== true) {
      return "";
    }

    const depthInstruction = relationalAdjustmentDepth === "minimal"
      ? "Profondeur arbitrée : MINIMALE — une phrase de reconnaissance sobre, puis enchaîne directement sur le mode courant sans présence relationnelle développée."
      : "Profondeur arbitrée : MODÉRÉE — reconnaissance et réajustement en 2-3 phrases, puis geste conversationnel.";

    const adjustmentBlock = String(promptRegistry.SIGNAL_RELATIONAL_ADJUSTMENT || "").trim();
    return wrapPromptBlock("SIGNAL_RELATIONAL_ADJUSTMENT", depthInstruction + "\n\n" + adjustmentBlock);
  }

  function buildDischargeStatePromptBlock(conversationState = null, promptRegistry = buildDefaultPromptRegistry()) {
    if (conversationState === "discharge_dysregulated") {
      const content = String(promptRegistry.STATE_DISCHARGE_DYSREGULATED || "").trim();
      return content ? wrapPromptBlock("STATE_DISCHARGE", content) : "";
    }
    if (conversationState === "discharge_regulated") {
      const content = String(promptRegistry.STATE_DISCHARGE_REGULATED || "").trim();
      return content ? wrapPromptBlock("STATE_DISCHARGE", content) : "";
    }
    return "";
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

    const isPhenomenonRejected = interpretationRejection.phenomenonAnchorInstruction === "from_observable";
    const tensionLevel = interpretationRejection.tensionHoldLevel || "medium";

    // Amorce d'exemple selon type × tensionLevel — à varier, ne pas ressortir tel quel
    let amorceExample;
    if (!isPhenomenonRejected) {
      // TYPE 1 : angle rejeté, phénomène potentiellement valide
      if (tensionLevel === "low") amorceExample = '"D\'accord, ce lien-là ne tombe pas juste pour toi."';
      else if (tensionLevel === "medium") amorceExample = '"Je sens que c\'était pas le bon angle pour ce que tu vis."';
      else amorceExample = '"Ce lien que j\'établissais ne correspond pas à ta lecture. D\'accord."';
    } else {
      // TYPE 2 : phénomène rejeté
      if (tensionLevel === "low") amorceExample = '"D\'accord, c\'est pas ça."';
      else if (tensionLevel === "medium") amorceExample = '"Ce que je captais, ce n\'est pas ça pour toi. C\'est autre chose."';
      else amorceExample = '"Ok, dit comme ça, ça ne résonne pas pour toi."';
    }

    const typeInstruction = isPhenomenonRejected
      ? "Le phenomene lui-meme semble rejete — redeploi l'ecoute plus largement, sans forcer un retour sur le meme terrain. Le phenomene reste potentiellement valide plus tard."
      : "Seul l'angle propose semble rejete, pas le phenomene — ne ferme pas la porte sur ce dernier, il reste potentiellement valide.";

    const tensionInstruction =
      tensionLevel === "high"
        ? "Maintiens une presence ferme apres l'amorce — ne recule pas, tiens sans insister."
        : tensionLevel === "low"
        ? "Apres l'amorce, allegement : la personne reprendra elle-meme le fil si elle le veut."
        : "Apres l'amorce, reste sobre et disponible — pas de pression, pas de retrait non plus.";

    const lines = [
      "Rejet d'interpretation detecte.",
      "",
      typeInstruction,
      "",
      "Ouvre ta reponse par une amorce sobre qui reconnait la non-aidance — situee sur toi ('ce que je proposais', 'l'angle que j'ai pris'), jamais sur l'utilisateur.",
      "OBLIGATOIRE : cadrage 'pour toi' — jamais 'ca ne tombe pas juste' seul, toujours 'pour toi' ou equivalent. Cela preserve la possibilite que l'angle ou le phenomene soit valide, juste pas aidant pour cette personne a cet instant.",
      "Varie la formulation — exemple d'amorce : " + amorceExample + " (ne pas ressortir tel quel a chaque rejet).",
      "",
      "INTERDITS absolus dans cette reponse :",
      "- 'Je repars de quelque chose de plus concret'",
      "- 'Je laisse tomber cet angle'",
      "- 'Je ne vais pas insister'",
      "- 'Je reste avec ce qui est la' ou 'on reste sur ce qui resonne'",
      "- Toute formulation qui ferme definitivement la porte sur l'angle ou le phenomene",
      "",
      tensionInstruction,
      "",
      "Apres l'amorce : enchaine naturellement sans t'appesantir sur le rate."
    ];

    return wrapPromptBlock("INTERPRETATION_REJECTION", lines.join("\n"));
  }

  function buildContractExecutionProtocolBlock() {
    const lines = [
      "Procedure d'execution du contrat (obligatoire) :",
      "- Appliquer d'abord le contrat de posture du tour.",
      "- Extraire et respecter strictement : Etat, Intention, Interdits, Registre cible, Longueur de phrase, Politique de relance, Politique somatique.",
      "- En cas de conflit entre identite/style et contrat, le contrat prime toujours.",
      "- Ne pas compenser un manque d'appui dans le message utilisateur par une hypothese issue du cadre identitaire."
    ];

    return wrapPromptBlock("CONTRACT_EXECUTION_PROTOCOL", lines.join("\n"));
  }

  // Construct the full system prompt for the selected state before calling the LLM.
  // postureDecision carries the full contract (conversationState, forbidden, intent, etc.).
  // The contract block is always injected first so the writer receives the policy
  // before any identity or style instructions.
  function buildSystemPrompt(postureDecision, memory, promptRegistry = buildDefaultPromptRegistry(), interpretationRejection = null, intersessionMemoryCompressed = "", history = []) {
    const conversationState = postureDecision.conversationState || "exploration_open";
    const explorationDirectivityLevel = postureDecision.finalDirectivityLevel;
    const explorationSignal = postureDecision.finalExplorationSignal || "interpretation";
    const relationalAdjustmentTriggered = postureDecision.relationalAdjustmentActive;

    const contractWrapped = buildPostureContractBlock(postureDecision);
    const contractExecutionProtocolWrapped = buildContractExecutionProtocolBlock();
    const identityWrapped = getIdentityPrompt(promptRegistry);
    const relationalAdjustmentWrapped = buildRelationalAdjustmentPromptBlock(
      relationalAdjustmentTriggered,
      promptRegistry,
      postureDecision.relationalAdjustmentDepth || "moderate"
    );
    const interpretationSignal = {
      isInterpretationRejection: postureDecision.interpretationRejectionModeActive === true,
      needsSoberReadjustment: postureDecision.needsSoberReadjustment === true,
      phenomenonAnchorInstruction: postureDecision.phenomenonAnchorInstruction || "keep_if_concrete",
      tensionHoldLevel: postureDecision.tensionHoldLevel || "medium"
    };
    const interpretationRejectionWrapped = buildInterpretationRejectionPromptBlock(interpretationSignal);

    // Extract and normalize memory upfront for unified injection
    const normalizedMemory = normalizeMemory(memory, promptRegistry);
    const memoryBlock = normalizedMemory
      ? wrapPromptBlock("MEMORY", normalizedMemory)
      : "";

    const longtermMemoryBlock = typeof intersessionMemoryCompressed === "string" && intersessionMemoryCompressed.trim()
      ? wrapPromptBlock("LONGTERM_MEMORY", intersessionMemoryCompressed.trim())
      : "";
    const antiRepetitionBlock = buildRecentAntiRepetitionPromptBlock(history);

    // Single style block selected by conversationState
    let styleBlock = "";
    if (conversationState === "n2_crisis") {
      const n2Content = String(promptRegistry.N2_RESPONSE_LLM || "").trim();
      styleBlock = n2Content ? wrapPromptBlock("N2_CRISIS_STYLE", n2Content) : "";
    } else if (conversationState === "n1_crisis") {
      const n1Content = String(promptRegistry.N1_RESPONSE_LLM || "").trim();
      styleBlock = n1Content ? wrapPromptBlock("N1_CRISIS_STYLE", n1Content) : "";
    } else if (conversationState === "discharge_regulated" || conversationState === "discharge_dysregulated") {
      styleBlock = buildDischargeStatePromptBlock(conversationState, promptRegistry);
    } else if (conversationState.startsWith("info_")) {
      const infoContractContext = {
        psychoeducationType: postureDecision.psychoeducationType || null,
        infoContextFlags: postureDecision.infoContextFlags || []
      };
      styleBlock = getInfoPrompt(conversationState, promptRegistry, infoContractContext);
    } else if (conversationState === "stabilization") {
      styleBlock = buildStabilizationPromptBlock(conversationState, promptRegistry);
    } else if (conversationState === "alliance_rupture") {
      styleBlock = buildAllianceRupturePromptBlock(conversationState, promptRegistry);
    } else if (conversationState === "closure") {
      styleBlock = buildClosurePromptBlock(conversationState, promptRegistry);
    } else {
      // exploration_open and exploration_restrained
      const explorationWrapped = getExplorationPrompt(explorationDirectivityLevel, promptRegistry);
      const explorationSignalWrapped = buildExplorationSignalPromptBlock(explorationSignal, promptRegistry);
      styleBlock = [explorationWrapped, explorationSignalWrapped].filter(Boolean).join("\n\n");
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

    // Prompt caching optimization: pour les etats non-sensibles, identite + styleBlock
    // arrivent en premier (prefixe stable => eligible au cache OpenAI a 75% de reduction input).
    // Pour les etats sensibles (crise, decharge, rupture), le contrat de posture reste en premier
    // afin de garantir la pleine primauté de lecture sur les interdits critiques.
    const SENSITIVE_STATES = ["n1_crisis", "n2_crisis", "discharge_regulated", "discharge_dysregulated", "alliance_rupture"];
    const contractFirst = SENSITIVE_STATES.includes(conversationState);

    const blocksContractFirst = [
      contractWrapped,
      contractExecutionProtocolWrapped,
      identityWrapped,
      styleBlock,
      antiRepetitionBlock,
      memoryBlock,
      longtermMemoryBlock,
      recallBlock,
      relationalAdjustmentWrapped,
      interpretationRejectionWrapped,
      dependencyGuardrailBlock
    ];

    const blocksCacheFirst = [
      identityWrapped,
      styleBlock,
      contractWrapped,
      contractExecutionProtocolWrapped,
      antiRepetitionBlock,
      memoryBlock,
      longtermMemoryBlock,
      recallBlock,
      relationalAdjustmentWrapped,
      interpretationRejectionWrapped,
      dependencyGuardrailBlock
    ];

    return (contractFirst ? blocksContractFirst : blocksCacheFirst).filter(Boolean).join("\n\n").trim();
  }

  // Generate the assistant reply using the assembled system prompt and conversation history.
  async function generateReply({
    message,
    history,
    memory,
    postureDecision,
    interpretationRejection = null,
    intersessionMemoryCompressed = "",
    promptRegistry = buildDefaultPromptRegistry(),
  }) {
    const systemPrompt = buildSystemPrompt(
      postureDecision,
      memory,
      promptRegistry,
      interpretationRejection,
      intersessionMemoryCompressed,
      history,
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
    getRelationalAdjustmentPrompt,
    getInfoPrompt,
    getExplorationPrompt,
    buildExplorationSignalPromptBlock,
    buildPostContactLandingPromptBlock,
    buildStabilizationPromptBlock,
    buildAllianceRupturePromptBlock,
    buildDependencyRiskGuardrailBlock,
    buildClosurePromptBlock,
    buildRelationalAdjustmentPromptBlock,
    buildDischargeStatePromptBlock,
    buildInterpretationRejectionPromptBlock,
    buildContractExecutionProtocolBlock,
    buildSystemPrompt,
    generateReply
  };
}

module.exports = { createWriter };
