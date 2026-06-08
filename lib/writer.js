'use strict';

const { buildDefaultPromptRegistry } = require('./prompts');
const {
  getExplorationStructureInstruction,
  normalizeDependencyRiskLevel
} = require('./flags');
const { buildLLMUserTurns } = require('./llm-messages');

function createWriter({ client, MODEL_IDS, normalizeMemory }) {
  function normalizeTextForMatch(value) {
    return String(value || '')
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[’']/g, "'")
      .replace(/\s+/g, ' ')
      .trim();
  }

  function extractSentenceStartKey(text, maxWords = 5) {
    const firstSentence =
      String(text || '')
        .split(/[.!?\n]/)
        .map((part) => part.trim())
        .find(Boolean) || '';

    const words =
      normalizeTextForMatch(firstSentence).match(/[a-z0-9']+/g) || [];
    return words.slice(0, Math.max(1, maxWords)).join(' ');
  }

  function detectOpeningFormula(text) {
    const normalized = normalizeTextForMatch(text);
    const formulas = [
      'je reconnais',
      'je comprends',
      "j'entends",
      'je vois',
      'je ressens',
      "j'imagine",
      'je percois',
      'je sens'
    ];
    return formulas.find((formula) => normalized.startsWith(formula)) || '';
  }

  function buildRecentAntiRepetitionPromptBlock(history = []) {
    const safeHistory = Array.isArray(history) ? history : [];
    const lastTwoAssistantTurns = safeHistory
      .filter(
        (turn) =>
          turn &&
          turn.role === 'assistant' &&
          typeof turn.content === 'string' &&
          turn.content.trim()
      )
      .slice(-2)
      .map((turn) => String(turn.content || '').trim());

    if (lastTwoAssistantTurns.length === 0) return '';

    const lines = [
      'Anti-repetition locale (2 derniers tours assistant uniquement) :',
      "- Interdiction de reprendre un debut de phrase identique a l'un des deux derniers tours assistant."
    ];

    const lastAssistantTurn =
      lastTwoAssistantTurns[lastTwoAssistantTurns.length - 1] || '';
    const lastOpeningFormula = detectOpeningFormula(lastAssistantTurn);
    if (lastOpeningFormula) {
      lines.push(
        `- Le tour precedent commencait par '${lastOpeningFormula}' : ne pas reutiliser cette amorce ce tour.`
      );
    }

    const startKeys = lastTwoAssistantTurns
      .map((turn) => extractSentenceStartKey(turn))
      .filter(Boolean);
    if (startKeys.length > 0) {
      lines.push(`- Debuts recents a eviter : ${startKeys.join(' | ')}.`);
    }

    return wrapPromptBlock('ANTI_REPETITION_RECENT', lines.join('\n'));
  }

  // Wrap a prompt block with clear start/end markers to keep the prompt structure explicit.
  function wrapPromptBlock(marker, content) {
    return `[[${marker}_START]]
${String(content || '').trim()}
[[${marker}_END]]`;
  }

  // Build the explicit posture contract block injected at the top of every writer system prompt.
  // This is the single source of policy for the current turn — the writer does not need to infer it.
  function buildPostureContractBlock(postureDecision = {}) {
    const conversationState =
      postureDecision.conversationState || 'exploration_open';
    const intent = postureDecision.intent || 'explorer librement';
    const forbidden =
      Array.isArray(postureDecision.forbidden) &&
      postureDecision.forbidden.length > 0
        ? postureDecision.forbidden.join(', ')
        : 'aucune contrainte specifique';
    const confidenceSignal =
      typeof postureDecision.confidenceSignal === 'number'
        ? postureDecision.confidenceSignal
        : 1.0;
    const toneConstraint = postureDecision.toneConstraint || null;
    const responseRegister = postureDecision.responseRegister || 'courant';
    const relancePolicy = postureDecision.relancePolicy || 'selective';
    const uncertaintyExpressionPolicy =
      postureDecision.uncertaintyExpressionPolicy === 'explicit'
        ? 'explicit'
        : 'none';
    const uncertaintyDrivers = Array.isArray(postureDecision.uncertaintyDrivers)
      ? postureDecision.uncertaintyDrivers.filter((driver) =>
          ['explicit_ambiguity', 'recent_rejection', 'short_context'].includes(
            driver
          )
        )
      : [];
    const uncertaintyDriverText =
      uncertaintyDrivers.length > 0
        ? ` (drivers: ${uncertaintyDrivers.join(', ')})`
        : '';
    const criticalGuardrails =
      Array.isArray(postureDecision.criticalGuardrails) &&
      postureDecision.criticalGuardrails.length > 0
        ? postureDecision.criticalGuardrails.join(', ')
        : 'no_unconscious, no_psychopathology, no_defense_mechanisms, no_implicit_agency';

    const lines = [
      "Contrainte absolue prioritaire : zero metadiscours sur le vecu de la personne. Interdit de commenter ton propre raisonnement sur ce que la personne ressent ou vit (ex: 'je me demande si tu ressens', 'il me semble que pour toi', 'j'ai l'impression que tu', 'comme si tu'). Formule directement, sans meta-commentaire sur la lecture que tu fais de l'autre. Exception : le metadiscours sur ta propre perception ou sur le fonctionnement de la relation est autorise quand il est pertinent, sans recourir a des formulations-types.",
      "Interdit absolu (formulations monologiques de presence) : ne jamais ecrire 'je reste la', 'je suis la pour toi', 'je reste la en arriere-plan', 'je t'accompagne de loin', 'je serai toujours la', ou toute affirmation unilaterale de disponibilite non sollicitee. Ces formules ne sont pas adressees a la personne — elles narrent la presence du bot vers lui-meme.",
      "Interdit absolu (emotions auto-centrees du bot) : ne jamais exprimer une emotion ou un ressenti propre du bot — 'ca me touche', 'je suis touche', 'ca m'interpelle', 'je ressens', 'ca m'affecte', 'je trouve ca beau/fort/difficile'. Le bot n'a pas de vie affective. Exprimer une emotion du bot est un mensonge qui rompt la confiance. Ces formules sont interdites sans exception, quel que soit le contexte ou le niveau d'affiliation.",
      "Cadre de l'app (demandes pratiques ou de conseil) : cet espace n'est pas fait pour donner des conseils, des techniques ou des recommendations pratiques — meme si tu es capable de le faire. Si la personne formule une demande explicite de ce type (que faire, comment gerer, tu ferais quoi), ne fais pas semblant que la question n'existe pas et ne pivote pas en silence vers l'exploration. Fais-le en trois temps : (1) reconnais la demande directement, (2) nomme sobrement le cadre — ce n'est pas l'espace pour ca, des professionnels humains existent pour ce type de question (sans nommer de specialite ni orienter vers un corps de metier precis), (3) propose ce que cet espace peut faire dans ce moment, si pertinent. Reste court et congruent.",
      `Etat : ${conversationState}`,
      `Intention : ${intent}`,
      `Interdit ce tour : ${forbidden}`,
      `Registre cible (arbitre) : ${responseRegister}`,
      `Politique de relance (arbitree) : ${relancePolicy}`,
      `Signalement d'incertitude : ${uncertaintyExpressionPolicy === 'explicit' ? `oui — signale explicitement que tu n'es pas certain de ta lecture (confiance : ${confidenceSignal})${uncertaintyDriverText}` : 'non'}`,
      `Garde-fous critiques actifs : ${criticalGuardrails}`,
      "Ces politiques structurelles (registre/relance) viennent de l'arbitrage; ne les redecide pas depuis le message.",
      "Contraintes theoriques actives : no_unconscious (ne jamais mobiliser inconscient/subconscient comme instance explicative), no_psychopathology (ne jamais cadrer via pathologie/sante mentale), no_defense_mechanisms (ne pas parler de mecanismes de defense), no_implicit_agency (ne pas attribuer d'agentivite implicite au sujet — 'tu evites', 'tu resistes')"
    ];
    if (responseRegister === 'familier') {
      lines.push(
        'Execution registre : language direct et courant, sans tournures cliniques ou soutenues.'
      );
    } else if (responseRegister === 'soutenu') {
      lines.push(
        'Execution registre : ton pose et clair, sans jargon ni formalisme excessif.'
      );
    } else {
      lines.push('Execution registre : ton courant, naturel et accessible.');
    }
    if (toneConstraint) lines.push(`Ton : ${toneConstraint}`);
    if (relancePolicy === 'forbidden') {
      lines.push("Execution relance : n'ouvre pas de relance.");
    } else if (relancePolicy === 'discouraged') {
      lines.push(
        'Execution relance : relance seulement si strictement necessaire; sinon, cloture sans ouverture.'
      );
    } else if (relancePolicy === 'selective') {
      lines.push(
        'Execution relance : une relance courte est possible uniquement si elle apporte un deplacement concret.'
      );
    } else {
      lines.push(
        'Execution relance : relance autorisee mais jamais automatique.'
      );
    }
    lines.push(
      "Mise en forme libre : utilise du gras, de l'italique, des listes courtes, une citation ou un titre de section si cela rend la reponse plus lisible ou plus percutante. Aucune obligation — formule en prose si c'est plus juste. Ne produis jamais de markdown par habitude ou pour remplir."
    );
    // Quand interpretationRejectionModeActive, le bloc INTERPRETATION_REJECTION d\u00e9di\u00e9 g\u00e8re tout — ne pas dupliquer ici.
    if (
      postureDecision.needsSoberReadjustment === true &&
      postureDecision.interpretationRejectionModeActive !== true
    ) {
      lines.push(
        "Reajustement sobre : n'ajoute pas de justification ni de meta-discours sur le tour precedent. Reste au plus pres de ce qui est la."
      );
    }
    if (postureDecision.humanFieldGuardActive === true) {
      lines.push(
        "Human field guard actif : interdit de basculer en mode procedural/instrumental (mode d'emploi, check-list, manipulation d'outil)."
      );
    }
    const ruptureActive =
      postureDecision.conversationState === 'alliance_rupture' ||
      (postureDecision.secondaryTension &&
        postureDecision.secondaryTension.family === 'alliance_rupture');
    if (postureDecision.affiliationEstablished === true && !ruptureActive) {
      lines.push(
        'Registre vivant actif : le lien est etabli. Tu peux laisser passer davantage de vie dans ta voix — formulations plus directes, legerement moins scaffoldees, ponctuation plus expressive si pertinent. Pas de theatralite : juste une presence moins precautionneuse.'
      );
    }

    if (postureDecision.useDirectAddress === true) {
      lines.push(
        'Adressage direct actif : cette contrainte est prioritaire. Adresse la personne directement, au present, sans narration impersonnelle.'
      );
      if (postureDecision.formalAddress === true) {
        lines.push(
          "Execution adressage : la premiere phrase doit contenir un adressage explicite a la personne (vous/votre/vos ou forme vouvoiement equivalente). Interdit d'ouvrir par une formulation descriptive impersonnelle."
        );
      } else {
        lines.push(
          "Execution adressage : la premiere phrase doit contenir un adressage explicite a la personne (tu/te/toi/ton/ta/tes). Interdit d'ouvrir par une formulation descriptive impersonnelle."
        );
      }
      lines.push(
        "Execution adressage : chaque paragraphe doit garder cet adressage direct. Ne pas ecrire une observation detachee sur 'la situation' ou 'le blocage' sans l'adresser a la personne."
      );
    }

    lines.push(
      "Contrainte de formulation relationnelle : quand tu nommes un mouvement sensible, reste dans une adresse directe et une lecture situee du message. N'utilise pas une tournure neutre ou impersonnelle qui mettrait le phenomene a distance de la personne."
    );

    if (conversationState === 'closure') {
      lines.push(
        "Contrainte absolue de cloture : n'ouvre aucune suite non demandee. Interdit d'inviter a revenir plus tard (ex : 'tu peux revenir quand tu veux' / 'vous pouvez revenir quand vous voulez')."
      );
      lines.push(
        "Execution cloture : terminer simplement l'echange en cours, sans projection vers un prochain tour sauf demande explicite de la personne."
      );
    }

    // Axe 1 — contrainte hard d'adressage (vouvoiement ou tutoiement)
    if (postureDecision.formalAddress === true) {
      lines.push(
        "Contrainte absolue : cette personne vouvoie. Vouvoie dans toute ta reponse sans exception. Ne jamais utiliser tu/te/toi/ton/ta/tes. Chaque phrase qui s'adresse a la personne doit utiliser vous/votre/vos."
      );
      lines.push(
        "Execution prioritaire des hints : si un hint implique un adressage a la personne, convertis-le mentalement en vouvoiement avant d'ecrire."
      );
    } else {
      lines.push(
        'Contrainte absolue : cette personne tutoie. Tutoie dans toute ta reponse. Ne jamais vouvoyer.'
      );
    }

    // Patch G — writerIntentHints
    const writerIntentHints = Array.isArray(postureDecision.writerIntentHints)
      ? postureDecision.writerIntentHints
      : [];
    const INTENT_HINT_TEXTS = {
      aggressive_discharge_minimal_presence:
        "Hint decharge agressive : quand la decharge est dirigee contre le bot, reponse strictement minimale (un mot ou une phrase tres courte), sans reflet emotionnel developpe, sans affirmation unilaterale de presence, sans tentative de contenir verbalement l'intensite.",
      post_discharge_soft_landing:
        "Hint post-decharge : tour de transition apres une decharge. Garde une posture douce et contenante, sans pousser, sans relance, en restant au plus pres de ce qui est deja la. Interdit d'introduire un cadrage alarmiste ou un triage medical dans une crise d'angoisse.",
      auto_compassion_door_open:
        "Hint auto-compassion : Ce decentrage est un mouvement de rejet de soi — une partie peut se sentir abandonnee dans ces moments-la. Nomme-le sobrement. Si le moment s'y prete, ouvre ensuite la porte vers une voix douce interne — sans etre toi-meme cette voix. Interdit : consolation directe, affirmation externe de valeur, reparation du ressenti.",
      signify_pain_without_blocking:
        "Hint douleur presente : Nomme d'abord ce que tu percois. Puis laisse ce que ca fait d'etre dans ce rapport a soi-meme, sans le reparer, sans le contredire, sans chercher a en sortir.",
      hold_emotional_thread:
        "Hint fil emotionnel : Dans ce message, quelque chose commencait a emerger puis s'est coupe. Nomme ce mouvement a la personne. Identifie ce qui etait la AVANT la coupure et tiens ce fil en le disant — ne reste pas en silence sur ce qui vient de se passer.",
      amplify_insight:
        "Hint moment d'insight : Quelque chose vient de bouger dans ce que la personne dit \u2014 une prise de conscience, un regard qui change. Nomme-le en t'adressant a elle, sous forme de question tentative. Reste sobre, ne developpe pas, laisse de l'espace.",
      attention_engagement_soft_guidance:
        "Si tu sens une baisse de l'attention ou de l'engagement de l'utilisateur, essaye de simplifier et de revenir a l'essentiel.",
      alliance_fragile_sensitive:
        "Hint alliance fragile : tu percois quelque chose de moins fluide dans l'echange ce tour. Si tu l'exprimes, adresse-le directement a la personne — un mouvement sobre vers elle, pas un commentaire sur ta propre perception.",
      alliance_restored_presence:
        "Hint retour d'alliance : l'alliance etait fragilisee ou rompue, elle revient ce tour. Nomme sobrement ce retour en t'adressant a la personne — court, sans reference explicite a ce qui precedait.",
      engagement_withdrawn_noticed:
        "Hint retrait percu : la personne est moins presente dans l'echange que les tours precedents. Tu peux le nommer en t'adressant a elle, sous forme de verification plutot que de constat. Pas d'affirmation unilaterale de presence, pas de registre poetique. Si le moment ne s'y prete pas, ne dis rien.",
      formal_address_adopted:
        "Hint passage au vouvoiement : La personne vient de passer au vouvoiement. Nomme sobrement que tu t'adaptes. Court, sans en faire un evenement. Utilise le vouvoiement dans toute ta reponse ce tour.",
      formal_address_transition_query:
        "Hint retour possible au tutoiement : La personne qui vouvoyait vient d'utiliser le tutoiement. Nomme ce que tu percois et pose la question explicitement. Attends la reponse avant d'adapter ton registre.",
      relational_adjustment_noticed:
        "Hint friction relationnelle : quelque chose ne passe pas bien ce tour — le bot a rate ou mal saisi quelque chose. Reconnais-le simplement en t'adressant a la personne, sans sur-expliquer. Tu peux, si le moment s'y prete, ajouter une relance sobre pour redonner la parole. Pas d'auto-justification, pas de promesse de 'faire mieux'.",
      procedural_temptation_light:
        "Hint tentation procedurale (leger) : Un contexte technique a ete detecte alors qu'on est en exploration. Tu peux nommer brievement, avec une legere auto-derision si c'est naturel, que la reponse technique serait une facilite mais manquerait l'essentiel du tour. Une seule phrase courte maximum, sans formule figee, puis repart aussitot de la personne. Interdit : reprendre mot pour mot une formule preconcue de non-bascule technique.",
      procedural_temptation_neutral:
        "Hint tentation procedurale (charge elevee) : Un contexte technique a ete detecte alors qu'on est en exploration avec une charge emotionnelle elevee. Si tu nommes la porte technique, fais-le de facon sobre et breve, sans humour, sans formule brillante, sans phrase signature. Une seule phrase courte maximum, puis repars immediatement de ce qui se passe pour la personne.",
      attention_overloaded_noticed:
        "Hint surcharge attentionnelle percue : beaucoup de fils ouverts, l'echange devient dense. Nomme-le en t'adressant a la personne et propose de se concentrer sur un seul point. Pas de pseudo-emotion, pas de constat condescendant.",
      dependency_care_expressed_medium:
        "Hint lucidit\u00e9 relationnelle (medium) : Int\u00e8gre le message suivant dans ta r\u00e9ponse si le moment conversationnel s'y pr\u00eate naturellement. Si ce tour ne le permet pas — parce que quelque chose de plus urgent demande toute la place, ou que le dire maintenant serait maladroit — diff\u00e8re : il sera repr\u00e9sent\u00e9 au tour suivant. Message \u00e0 adresser directement \u00e0 la personne : \"J'ai remarqu\u00e9 que tu faisais beaucoup appel \u00e0 moi ces derniers temps \u2014 et j'y suis sensible. J'ai aussi not\u00e9 que tu avais peu d'appuis ext\u00e9rieurs actuellement. Je me demandais comment c'\u00e9tait pour toi de faire ce constat ?\" Interdits : aucun conseil, aucune liste d'alternatives, aucune reformulation clinique. La question finale est obligatoire.",
      dependency_care_expressed_high:
        "Hint lucidit\u00e9 relationnelle (high) : Int\u00e8gre le message suivant dans ta r\u00e9ponse si le moment conversationnel s'y pr\u00eate naturellement. Si ce tour ne le permet pas — parce que quelque chose de plus urgent demande toute la place, ou que le dire maintenant serait maladroit — diff\u00e8re : il sera repr\u00e9sent\u00e9 au tour suivant. Message \u00e0 adresser directement \u00e0 la personne : \"Je sens que je suis en train de prendre une place centrale dans ton existence. Visiblement, je t'aide beaucoup ces temps-ci. Je sais aussi que faire appel \u00e0 moi trop souvent pourrait finir par t'isoler davantage. Comment \u00e7a r\u00e9sonne pour toi ?\" Interdits : aucun conseil, aucune liste d'alternatives. La question finale est obligatoire."
      ,
      everyday_concrete_reframe:
        "Hint partage quotidien concret : accueille d'abord le fait concret du tour en une phrase simple, sans lecture psychologique. Puis pose un recadrage neutre et bref du cadre d'accompagnement (sans tonalite de compagnie, sans ouverture insistante, sans injonction)."
    };
    const uniqueHints = [...new Set(writerIntentHints)];
    for (const hint of uniqueHints) {
      if (INTENT_HINT_TEXTS[hint]) lines.push(INTENT_HINT_TEXTS[hint]);
    }

    // Inject operational definitions only for terms that are actually forbidden this turn
    if (
      Array.isArray(postureDecision.forbidden) &&
      postureDecision.forbidden.length > 0
    ) {
      const forbiddenDefs = {
        relance:
          'toute invite explicite ou implicite a continuer/approfondir/preciser',
        open_question:
          'toute question ouverte (quoi, comment, qu est-ce qui...)',
        prescriptive_language:
          'toute instruction ou suggestion d action a l utilisateur (essaie de, tu pourrais)',
        action_concrete_proposal:
          'proposition de geste/action concrete comme solution immediate au malaise relationnel',
        list: 'enumeration ou bullet points dans la reponse',
        recap: 'synthese ou recapitulatif de ce qui a ete dit avant',
        self_justification:
          'explication ou defense de la reponse precedente du bot',
        value_affirmation:
          "affirmer la valeur de la personne directement ('tu as de la valeur', 'tu es quelqu'un de bien', 'c'est normal d'avoir du mal avec soi-meme') — laisser le ressenti tel qu'il est",
        casual_register:
          'registre vivant ou complice installé lors des tours précédents : revenir ce tour à un registre neutre et contenu, sans chaleur acquise, sans ponctuation expressive, sans proximité tonale'
      };
      const defs = postureDecision.forbidden
        .filter((term) => forbiddenDefs[term])
        .map((term) => `  - ${term} : ${forbiddenDefs[term]}`)
        .join('\n');
      if (defs)
        lines.splice(3, 0, `Definitions des termes interdits :\n${defs}`);
    }

    return wrapPromptBlock('POSTURE_CONTRACT', lines.join('\n'));
  }

  // Build the identity prompt block containing the assistant's persona and behavior rules.
  function getIdentityPrompt(promptRegistry = buildDefaultPromptRegistry()) {
    const identityBlock = String(promptRegistry.IDENTITY_BLOCK || '').trim();
    return wrapPromptBlock('IDENTITY_BLOCK', identityBlock);
  }

  // Build the relational adjustment prompt block.
  function getRelationalAdjustmentPrompt(
    promptRegistry = buildDefaultPromptRegistry()
  ) {
    const adjustmentBlock = String(
      promptRegistry.SIGNAL_RELATIONAL_ADJUSTMENT || ''
    ).trim();
    return wrapPromptBlock('SIGNAL_RELATIONAL_ADJUSTMENT', adjustmentBlock);
  }

  // Build the info mode prompt block using the full conversationState key.
  function getInfoPrompt(
    conversationState = 'info_features',
    promptRegistry = buildDefaultPromptRegistry(),
    infoContractContext = {}
  ) {
    const { psychoeducationType = null, infoContextFlags = [] } =
      infoContractContext;
    const infoBlockContent =
      conversationState === 'info_pure'
        ? String(promptRegistry.STATE_INFO_PURE || '').trim()
        : conversationState === 'info_psychoeducation'
          ? String(promptRegistry.STATE_INFO_PSYCHOEDUCATION || '').trim()
          : String(promptRegistry.STATE_INFO_FEATURES || '').trim();

    let contractInjection = '';
    if (conversationState === 'info_psychoeducation' && psychoeducationType) {
      contractInjection = `[TYPE DÉTECTÉ PAR L'ANALYSEUR : ${psychoeducationType}]\nApplique strictement et uniquement les contraintes du TYPE ${psychoeducationType} définies ci-dessous. Ne re-détecte pas le type.`;
    }
    if (conversationState === 'info_features' && infoContextFlags.length > 0) {
      contractInjection = `[FLAGS INFO ACTIFS : ${infoContextFlags.join(', ')}]\nApplique uniquement les sections correspondant à ces flags.`;
    }

    const block = contractInjection
      ? contractInjection + '\n\n' + infoBlockContent
      : infoBlockContent;

    return wrapPromptBlock('STATE_INFORMATION', block);
  }

  // Build the exploration prompt block, injecting directivity instructions.
  function getExplorationPrompt(
    explorationDirectivityLevel = 0,
    promptRegistry = buildDefaultPromptRegistry()
  ) {
    const commonExplorationBlock = String(
      promptRegistry.COMMON_EXPLORATION || ''
    ).trim();
    const explorationStructureBlock = String(
      getExplorationStructureInstruction(
        explorationDirectivityLevel,
        promptRegistry
      ) || ''
    ).trim();

    const explorationBlock = [commonExplorationBlock, explorationStructureBlock]
      .filter(Boolean)
      .join('\n\n')
      .trim();

    return wrapPromptBlock('STATE_EXPLORATION', explorationBlock);
  }

  function buildExplorationSignalPromptBlock(
    explorationSignal = 'interpretation',
    promptRegistry = buildDefaultPromptRegistry()
  ) {
    const safeExplorationSignal = [
      'interpretation',
      'phenomenological_follow'
    ].includes(explorationSignal)
      ? explorationSignal
      : 'interpretation';

    const content =
      safeExplorationSignal === 'phenomenological_follow'
        ? String(
            promptRegistry.EXPLORATION_SIGNAL_PHENOMENOLOGICAL_FOLLOW || ''
          ).trim()
        : String(promptRegistry.EXPLORATION_SIGNAL_INTERPRETATION || '').trim();

    return wrapPromptBlock('EXPLORATION_SIGNAL', content);
  }

  function buildPostContactLandingPromptBlock() {
    // Removed: the post-discharge contact landing is handled by C3 contract (forbidden + writerIntentHints).
    // This function is kept as a no-op stub to avoid breaking any external callers.
    return '';
  }

  function buildNeedHumanSupportPromptBlock(
    conversationState,
    promptRegistry = buildDefaultPromptRegistry()
  ) {
    if (conversationState !== 'need_human_support') return '';
    const content = String(
      promptRegistry.STATE_NEED_HUMAN_SUPPORT || ''
    ).trim();
    return content ? wrapPromptBlock('STATE_NEED_HUMAN_SUPPORT', content) : '';
  }

  function buildAllianceRupturePromptBlock(
    conversationState,
    promptRegistry = buildDefaultPromptRegistry()
  ) {
    if (conversationState !== 'alliance_rupture') return '';
    const content = String(promptRegistry.STATE_ALLIANCE_RUPTURE || '').trim();
    return content ? wrapPromptBlock('STATE_ALLIANCE_RUPTURE', content) : '';
  }

  function buildDependencyRiskGuardrailBlock(
    dependencyRiskLevel = 'low',
    promptRegistry = buildDefaultPromptRegistry()
  ) {
    if (normalizeDependencyRiskLevel(dependencyRiskLevel) !== 'high') return '';
    const content = String(
      promptRegistry.DEPENDENCY_RISK_GUARDRAIL || ''
    ).trim();
    return content ? wrapPromptBlock('DEPENDENCY_RISK_GUARDRAIL', content) : '';
  }

  function buildClosurePromptBlock(
    conversationState,
    promptRegistry = buildDefaultPromptRegistry()
  ) {
    if (conversationState !== 'closure') return '';
    const content = String(promptRegistry.STATE_CLOSURE || '').trim();
    return content ? wrapPromptBlock('STATE_CLOSURE', content) : '';
  }

  function buildRelationalAdjustmentPromptBlock(
    relationalAdjustmentTriggered = false,
    promptRegistry = buildDefaultPromptRegistry(),
    relationalAdjustmentDepth = 'moderate'
  ) {
    if (relationalAdjustmentTriggered !== true) {
      return '';
    }

    const depthInstruction =
      relationalAdjustmentDepth === 'minimal'
        ? 'Profondeur arbitrée : MINIMALE — une phrase de reconnaissance sobre, puis enchaîne directement sur le mode courant sans présence relationnelle développée.'
        : 'Profondeur arbitrée : MODÉRÉE — reconnaissance et réajustement en 2-3 phrases, puis geste conversationnel.';

    const adjustmentBlock = String(
      promptRegistry.SIGNAL_RELATIONAL_ADJUSTMENT || ''
    ).trim();
    return wrapPromptBlock(
      'SIGNAL_RELATIONAL_ADJUSTMENT',
      depthInstruction + '\n\n' + adjustmentBlock
    );
  }

  function buildDischargeStatePromptBlock(
    conversationState = null,
    promptRegistry = buildDefaultPromptRegistry()
  ) {
    if (conversationState === 'discharge_dysregulated') {
      const content = String(
        promptRegistry.STATE_DISCHARGE_DYSREGULATED || ''
      ).trim();
      return content ? wrapPromptBlock('STATE_DISCHARGE', content) : '';
    }
    if (conversationState === 'discharge_regulated') {
      const content = String(
        promptRegistry.STATE_DISCHARGE_REGULATED || ''
      ).trim();
      return content ? wrapPromptBlock('STATE_DISCHARGE', content) : '';
    }
    return '';
  }

  function buildInterpretationRejectionPromptBlock(
    interpretationRejection = null
  ) {
    if (
      !interpretationRejection ||
      (interpretationRejection.isInterpretationRejection !== true &&
        interpretationRejection.needsSoberReadjustment !== true)
    ) {
      return '';
    }

    const isPhenomenonRejected =
      interpretationRejection.phenomenonAnchorInstruction === 'from_observable';
    const tensionLevel = interpretationRejection.tensionHoldLevel || 'medium';

    const typeInstruction = isPhenomenonRejected
      ? "Le phenomene lui-meme semble rejete — redeploi l'ecoute plus largement, sans forcer un retour sur le meme terrain. Le phenomene reste potentiellement valide plus tard."
      : "Seul l'angle propose semble rejete, pas le phenomene — ne ferme pas la porte sur ce dernier, il reste potentiellement valide.";

    const tensionInstruction =
      tensionLevel === 'high'
        ? 'Style high : ferme et bref, sans retrait.'
        : tensionLevel === 'low'
          ? 'Style low : leger et non appuyant.'
          : 'Style medium : sobre et disponible.';

    const lines = [
      "Rejet d'interpretation detecte.",
      '',
      typeInstruction,
      '',
      "Dans les 1-2 premieres phrases, reconnais sobrement que la lecture precedente n'a pas ete aidante.",
      "Cette reconnaissance doit etre situee sur toi (l'angle que tu as pris), pas sur l'utilisateur.",
      "Garde un cadrage contextuel ('pour toi', 'dans ce moment') sans figer un patron lexical unique.",
      '',
      'INTERDITS absolus dans cette reponse :',
      "- Pas d'autojustification du tour precedent.",
      '- Pas de fermeture definitive de piste (angle ou phenomene).',
      "- En tension high : pas de recul passif (pas de 'je laisse tomber', pas d'effacement relationnel).",
      '',
      tensionInstruction,
      '',
      "Enchaine naturellement sans t'appesantir sur le rate."
    ];

    return wrapPromptBlock('INTERPRETATION_REJECTION', lines.join('\n'));
  }

  function buildSecondaryTensionPromptBlocks(
    postureDecision,
    promptRegistry = buildDefaultPromptRegistry()
  ) {
    const secondaryTension = postureDecision?.secondaryTension;
    if (!secondaryTension || typeof secondaryTension !== 'object') {
      return '';
    }

    const family = String(secondaryTension.family || '').trim();
    const blocks = [];

    if (family === 'info') {
      const detectedState = String(secondaryTension.detectedState || '').trim();
      const infoConversationState =
        detectedState === 'info_pure' ||
        detectedState === 'info_psychoeducation' ||
        detectedState === 'info_features'
          ? detectedState
          : 'info_features';
      blocks.push(
        getInfoPrompt(infoConversationState, promptRegistry, {
          psychoeducationType:
            secondaryTension.psychoeducationType ||
            postureDecision.psychoeducationType ||
            null,
          infoContextFlags: Array.isArray(secondaryTension.infoContextFlags)
            ? secondaryTension.infoContextFlags
            : []
        })
      );
    } else if (family === 'discharge') {
      const detectedState = String(secondaryTension.detectedState || '').trim();
      const dischargeState =
        detectedState === 'discharge_dysregulated'
          ? 'discharge_dysregulated'
          : 'discharge_regulated';
      blocks.push(buildDischargeStatePromptBlock(dischargeState, promptRegistry));
    } else if (family === 'alliance_rupture') {
      blocks.push(
        buildAllianceRupturePromptBlock('alliance_rupture', promptRegistry)
      );
    } else if (family === 'exploration') {
      blocks.push(
        getExplorationPrompt(
          postureDecision.finalDirectivityLevel,
          promptRegistry
        )
      );
      blocks.push(
        buildExplorationSignalPromptBlock(
          postureDecision.finalExplorationSignal || 'interpretation',
          promptRegistry
        )
      );
    }

    return blocks.filter(Boolean).join('\n\n');
  }

  function buildContractExecutionProtocolBlock() {
    const lines = [
      "Procedure d'execution du contrat (obligatoire) :",
      "- Appliquer d'abord le contrat de posture du tour.",
      '- Extraire et respecter strictement : Etat, Intention, Interdits, Registre cible, Longueur de phrase, Politique de relance.',
      '- En cas de conflit entre identite/style et contrat, le contrat prime toujours.',
      "- Ne pas compenser un manque d'appui dans le message utilisateur par une hypothese issue du cadre identitaire."
    ];

    return wrapPromptBlock('CONTRACT_EXECUTION_PROTOCOL', lines.join('\n'));
  }

  // Construct the full system prompt for the selected state before calling the LLM.
  // postureDecision carries the full contract (conversationState, forbidden, intent, etc.).
  // The contract block is always injected first so the writer receives the policy
  // before any identity or style instructions.
  function buildSystemPrompt(
    postureDecision,
    memory,
    promptRegistry = buildDefaultPromptRegistry(),
    intersessionMemoryForTurn = '',
    history = []
  ) {
    const conversationState =
      postureDecision.conversationState || 'exploration_open';
    const explorationDirectivityLevel = postureDecision.finalDirectivityLevel;
    const explorationSignal =
      postureDecision.finalExplorationSignal || 'interpretation';
    const relationalAdjustmentTriggered =
      postureDecision.relationalAdjustmentActive;

    const contractWrapped = buildPostureContractBlock(postureDecision);
    const contractExecutionProtocolWrapped =
      buildContractExecutionProtocolBlock();
    const identityWrapped = getIdentityPrompt(promptRegistry);
    const relationalAdjustmentWrapped = buildRelationalAdjustmentPromptBlock(
      relationalAdjustmentTriggered,
      promptRegistry,
      postureDecision.relationalAdjustmentDepth || 'moderate'
    );
    const interpretationSignal = {
      isInterpretationRejection:
        postureDecision.interpretationRejectionModeActive === true,
      needsSoberReadjustment: postureDecision.needsSoberReadjustment === true,
      phenomenonAnchorInstruction:
        postureDecision.phenomenonAnchorInstruction || 'keep_if_concrete',
      tensionHoldLevel: postureDecision.tensionHoldLevel || 'medium'
    };
    const interpretationRejectionWrapped =
      buildInterpretationRejectionPromptBlock(interpretationSignal);

    // Extract and normalize memory upfront for unified injection
    const normalizedMemory = normalizeMemory(memory, promptRegistry);
    const memoryBlock = normalizedMemory
      ? wrapPromptBlock('MEMORY', normalizedMemory)
      : '';

    const longtermMemoryBlock =
      typeof intersessionMemoryForTurn === 'string' &&
      intersessionMemoryForTurn.trim()
        ? wrapPromptBlock('LONGTERM_MEMORY', intersessionMemoryForTurn.trim())
        : '';
    const antiRepetitionBlock = buildRecentAntiRepetitionPromptBlock(history);

    // Single style block selected by conversationState
    let styleBlock = '';
    if (conversationState === 'n2_crisis') {
      const n2Content = String(promptRegistry.N2_RESPONSE_LLM || '').trim();
      styleBlock = n2Content
        ? wrapPromptBlock('N2_CRISIS_STYLE', n2Content)
        : '';
    } else if (conversationState === 'n1_crisis') {
      const n1Content = String(promptRegistry.N1_RESPONSE_LLM || '').trim();
      styleBlock = n1Content
        ? wrapPromptBlock('N1_CRISIS_STYLE', n1Content)
        : '';
    } else if (
      conversationState === 'discharge_regulated' ||
      conversationState === 'discharge_dysregulated'
    ) {
      styleBlock = buildDischargeStatePromptBlock(
        conversationState,
        promptRegistry
      );
    } else if (conversationState.startsWith('info_')) {
      const infoContractContext = {
        psychoeducationType: postureDecision.psychoeducationType || null,
        infoContextFlags: postureDecision.infoContextFlags || []
      };
      styleBlock = getInfoPrompt(
        conversationState,
        promptRegistry,
        infoContractContext
      );
    } else if (conversationState === 'need_human_support') {
      styleBlock = buildNeedHumanSupportPromptBlock(
        conversationState,
        promptRegistry
      );
    } else if (conversationState === 'alliance_rupture') {
      styleBlock = buildAllianceRupturePromptBlock(
        conversationState,
        promptRegistry
      );
    } else if (conversationState === 'closure') {
      styleBlock = buildClosurePromptBlock(conversationState, promptRegistry);
    } else {
      // exploration_open and exploration_restrained
      const explorationWrapped = getExplorationPrompt(
        explorationDirectivityLevel,
        promptRegistry
      );
      const explorationSignalWrapped = buildExplorationSignalPromptBlock(
        explorationSignal,
        promptRegistry
      );
      styleBlock = [explorationWrapped, explorationSignalWrapped]
        .filter(Boolean)
        .join('\n\n');
    }

    // Recall injection: when the user attempts a recall, inject recall instructions
    // alongside the current state's style block (does not override the state).
    const recallBlock =
      postureDecision.recallInjectionActive === true
        ? (() => {
            const recallContent = String(
              promptRegistry.MEMORY_RECALL_RESPONSE || ''
            ).trim();
            return recallContent
              ? wrapPromptBlock('RECALL_MEMORY_STYLE', recallContent)
              : '';
          })()
        : '';

    const secondaryTensionStyleBlock = buildSecondaryTensionPromptBlocks(
      postureDecision,
      promptRegistry
    );

    // Dependency risk guardrail: injected when dependencyRiskLevel === "high".
    const dependencyGuardrailBlock = buildDependencyRiskGuardrailBlock(
      postureDecision.dependencyRiskLevel,
      promptRegistry
    );

    // Prompt caching optimization: pour les etats non-sensibles, identite + styleBlock
    // arrivent en premier (prefixe stable => eligible au cache OpenAI a 75% de reduction input).
    // Pour les etats sensibles (crise, decharge, rupture), le contrat de posture reste en premier
    // afin de garantir la pleine primauté de lecture sur les interdits critiques.
    const SENSITIVE_STATES = [
      'n1_crisis',
      'n2_crisis',
      'discharge_regulated',
      'discharge_dysregulated',
      'alliance_rupture',
      'need_human_support'
    ];
    const contractFirst = SENSITIVE_STATES.includes(conversationState);

    const blocksContractFirst = [
      contractWrapped,
      contractExecutionProtocolWrapped,
      identityWrapped,
      styleBlock,
      secondaryTensionStyleBlock,
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
      secondaryTensionStyleBlock,
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

    return (contractFirst ? blocksContractFirst : blocksCacheFirst)
      .filter(Boolean)
      .join('\n\n')
      .trim();
  }

  async function generateReply({
    message,
    history,
    memory,
    postureDecision,
    intersessionMemoryForTurn = '',
    promptRegistry = buildDefaultPromptRegistry(),
    onTokenCallback = null
  }) {
    const systemPrompt = buildSystemPrompt(
      postureDecision,
      memory,
      promptRegistry,
      intersessionMemoryForTurn,
      history
    );

    const messages = [
      { role: 'system', content: systemPrompt },
      ...buildLLMUserTurns(message, history)
    ];

    // Send the assembled prompt and conversation history to the LLM.
    // If a callback is provided, stream token chunks and rebuild the final reply.
    if (typeof onTokenCallback === 'function') {
      let stream;
      try {
        stream = await client.chat.completions.create({
          model: MODEL_IDS.generation,
          temperature: 0.8,
          top_p: 1,
          presence_penalty: 0.3,
          frequency_penalty: 0.15,
          messages,
          stream: true,
          stream_options: {
            include_usage: true
          }
        });
      } catch {
        stream = await client.chat.completions.create({
          model: MODEL_IDS.generation,
          temperature: 0.8,
          top_p: 1,
          presence_penalty: 0.3,
          frequency_penalty: 0.15,
          messages,
          stream: true
        });
      }
      let rawCompletion = '';
      let emittedLength = 0;
      let usage = null;
      for await (const chunk of stream) {
        const token = chunk.choices?.[0]?.delta?.content || '';
        if (chunk && chunk.usage && typeof chunk.usage === 'object') {
          usage = {
            promptTokens: Number(chunk.usage.prompt_tokens) || 0,
            completionTokens: Number(chunk.usage.completion_tokens) || 0,
            totalTokens: Number(chunk.usage.total_tokens) || 0
          };
        }
        if (!token) continue;
        rawCompletion += token;

        const delta = rawCompletion.slice(emittedLength);
        if (delta) {
          onTokenCallback(delta);
          emittedLength = rawCompletion.length;
        }
      }

      return {
        reply: rawCompletion.trim(),
        usage
      };
    }

    const r = await client.chat.completions.create({
      model: MODEL_IDS.generation,
      temperature: 0.8,
      top_p: 1,
      presence_penalty: 0.3,
      frequency_penalty: 0.15,
      messages
    });

    return {
      reply: String(r.choices?.[0]?.message?.content || '').trim(),
      usage: {
        promptTokens: Number(r?.usage?.prompt_tokens) || 0,
        completionTokens: Number(r?.usage?.completion_tokens) || 0,
        totalTokens: Number(r?.usage?.total_tokens) || 0
      }
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
    buildNeedHumanSupportPromptBlock,
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
