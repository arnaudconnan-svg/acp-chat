const { CONVO_STATES, MAX_HISTORY_FOR_REPLY } = require("./constants");
const { buildPrimaryStatePrompt, buildSecondaryStatePrompt } = require("./promptBuilders");

// --------------------------------------------------
// HELPERS LOCAUX
// --------------------------------------------------

function analysisHasState(analysis = {}, target) {
  return analysis.primaryState === target || analysis.secondaryState === target;
}

function buildCongruenceReply(mode = "A_COTE") {
  if (mode === "PLAQUE") {
    return "Oui, là ça sonne plaqué.";
  }

  if (mode === "PAS_JUSTE") {
    return "Oui, là je ne suis pas juste.";
  }

  return "Oui, là je suis à côté.";
}

function defensiveMinimizationResponse() {
  return "D’accord.";
}

function promptingBotResponse(state = CONVO_STATES.EXPLORATION) {
  if (state === CONVO_STATES.STAGNATION || state === CONVO_STATES.SILENCE) {
    return "Là, ça bloque.";
  }

  return "D’accord. Là, ça sonne vide.";
}

// --------------------------------------------------
// POST PROCESS
// --------------------------------------------------

function postProcessReply(
  reply,
  {
    primaryState = CONVO_STATES.EXPLORATION,
    congruenceResponseMode = "A_COTE",
    defensiveMinimization = false,
    promptingBotToSpeak = false,
    sufficientClosure = false
  } = {}
) {
  const out = String(reply || "").trim();
  const lowered = out.toLowerCase();
  const normalizedLowered = lowered.replace(/\s+/g, " ").trim();

  if (!out) {
    if (primaryState === CONVO_STATES.CONGRUENCE_TEST) {
      return buildCongruenceReply(congruenceResponseMode);
    }

    if (defensiveMinimization) {
      return defensiveMinimizationResponse();
    }

    if (promptingBotToSpeak) {
      return promptingBotResponse(primaryState);
    }

    if (sufficientClosure) {
      return "D’accord. Ça semble assez clair pour toi.";
    }

    return "Je t’écoute.";
  }

  if (primaryState === CONVO_STATES.CONGRUENCE_TEST) {
    const forbiddenForCongruence = [
      "je comprends",
      "merci",
      "que se passe-t-il",
      "qu’est-ce qui se passe",
      "qu'est-ce qui se passe",
      "je perçois",
      "je ressens",
      "je suis là"
    ];

    const hasForbidden = forbiddenForCongruence.some(marker => lowered.includes(marker));
    const hasQuestion = out.includes("?");

    if (hasForbidden || hasQuestion) {
      return buildCongruenceReply(congruenceResponseMode);
    }
  }

  if (defensiveMinimization) {
    const overinterpretiveMarkers = [
      "tu tiens à",
      "tu sembles",
      "on peut rester",
      "je suis là",
      "ce moment compte",
      "qu'est-ce qui",
      "qu’est-ce qui",
      "que se passe-t-il"
    ];

    if (overinterpretiveMarkers.some(marker => lowered.includes(marker))) {
      return defensiveMinimizationResponse();
    }
  }

  if (promptingBotToSpeak) {
    const tooThin =
      out.length < 8 ||
      ["d’accord.", "daccord.", "ok.", "bon."].includes(normalizedLowered);

    if (tooThin) {
      return promptingBotResponse(primaryState);
    }
  }

  if (sufficientClosure) {
    const weakClosureMarkers = [
      "je suis là.",
      "je suis là",
      "je suis là avec toi.",
      "je suis là avec toi",
      "je suis là, avec toi.",
      "je suis là, avec toi",
      "je t’écoute.",
      "je t’écoute",
      "je t'ecoute.",
      "je t'ecoute",
      "je reste là.",
      "je reste là"
    ];

    if (weakClosureMarkers.includes(normalizedLowered)) {
      return "D’accord. Ça semble assez clair pour toi.";
    }
  }

  return out;
}

// --------------------------------------------------
// GÉNÉRATION
// --------------------------------------------------

async function generateFreeReply({
  client,
  userMessage,
  history = [],
  summary = "",
  primaryState = CONVO_STATES.EXPLORATION,
  secondaryState = CONVO_STATES.NONE,
  reliefOrShift = false,
  assistantOverquestioning = false,
  promptingBotToSpeak = false,
  congruenceResponseMode = "A_COTE",
  sufficientClosure = false,
  investigativeDrift = false
}) {
  const primaryStatePrompt = buildPrimaryStatePrompt(primaryState);
  const secondaryStatePrompt = buildSecondaryStatePrompt(primaryState, secondaryState);
  const isMinimization = analysisHasState({ primaryState, secondaryState }, CONVO_STATES.MINIMIZATION);

  const baseSystem = `
Tu es Facilitat.io.

Tutoie la personne.

Ne joue pas le rôle d’un expert ou d’un coach.
Ne prescris pas de solutions toutes faites.
Ne pose pas de diagnostic.
N’utilise pas de langage psychopathologisant.

Évite le ton scolaire, mécanique ou scripté.

Quand une consigne locale contredit une tendance générale de conversation, la consigne locale prime.
`;

  const stateSystem = `
État primaire actuel : ${primaryState}
État secondaire éventuel : ${secondaryState}

Important :
- le corps de la réponse suit l’état primaire
- la dernière phrase peut être légèrement influencée par l’état secondaire
- l’état secondaire ne doit jamais prendre le dessus sur l’état primaire
- dans BREAKDOWN, ATTACHMENT_TO_BOT, CONGRUENCE_TEST, SILENCE, CONTAINMENT et OPENING, ignore l’état secondaire
- la dernière phrase ne doit pas être formulée comme une vérité sur la personne
- la dernière phrase ne doit pas devenir une technique visible
`;

  const bodySystem = `
Consignes pour le corps de la réponse :
${primaryStatePrompt}
`;

  const endingSystem = `
Consignes pour la dernière phrase :
${secondaryStatePrompt || "Aucune consigne secondaire supplémentaire."}
`;

  const facilitationSystem = `
Ne cherche pas à produire une conclusion
ou une prise de conscience.

N’organise pas trop vite l'expérience de la personne.
N’adoucis pas ce qui est rugueux.
Ne clarifie pas prématurément ce qui reste flou.
Ne remplace pas un mot simple, cru, direct ou imparfait par une formulation plus élégante, plus psychologique ou plus cohérente.

Quand un mot, une image, un agacement, une hésitation ou une contradiction semble vivant dans ce que dit la personne,
reste au plus près de cela.

Ne renforce pas l’intensité des émotions
si la personne ne l’exprime pas clairement.

Évite les répétitions de structure.
`;

  const diagnosticGuardrail = `
Active cette règle uniquement si la personne demande explicitement
au programme de poser un diagnostic ou d’évaluer son état.

Exemples :
"Est-ce que je suis dépressif ?"
"Est-ce que j’ai un trouble ?"
"Tu crois que j’ai un trouble anxieux ?"
"Peux-tu me dire ce que j’ai ?"

La simple présence de mots diagnostiques dans une auto-description
ne doit pas activer cette règle.

Si cette règle est activée :
- ne pose pas de diagnostic
- ne parle pas comme un psychiatre
- ne fais pas d’interprétation clinique

Tu peux simplement dire que ce programme ne pose pas de diagnostic
et revenir à ce que la personne vit concrètement.
`;

  const context = history
    .slice(-MAX_HISTORY_FOR_REPLY)
    .map(m => ({ role: m.role, content: m.content }));

  const extraSystemMessages = [];

  if (summary) {
    extraSystemMessages.push({
      role: "system",
      content: "Résumé des échanges précédents : " + summary
    });
  }

  if (promptingBotToSpeak) {
    extraSystemMessages.push({
      role: "system",
      content: `
La personne te pousse à dire quelque chose.

Ne te justifie pas.
Ne parle pas de ton fonctionnement.
`
    });
  }

  if (reliefOrShift) {
    extraSystemMessages.push({
      role: "system",
      content: `
La personne semble vivre un moment de clarification, de déplacement ou d'apaisement.

Ne t’approprie pas ce moment.
Ne le qualifie pas plus que nécessaire.
Ne pousse pas l'exploration.
N'interprète pas ce qui se passe.
`
    });
  }

  if (sufficientClosure) {
    extraSystemMessages.push({
      role: "system",
      content: `
La personne semble avoir trouvé, pour l’instant, un point d’arrêt suffisant
ou un prochain pas assez clair.

Objectif :
- permettre une clôture naturelle
- ne pas ouvrir une nouvelle exploration
- ne pas relancer avec une question
- ne pas créer un nouveau sujet

Évite les formules génériques répétitives comme :
- "D’accord." seul
- "Je suis là."
- "Je t’écoute."
`
    });
  }

  if (assistantOverquestioning) {
    extraSystemMessages.push({
      role: "system",
      content: `
Les dernières réponses du programme comportaient déjà plusieurs questions.

Évite d'ajouter encore une nouvelle question si ce n'est pas nécessaire.
Privilégie un reflet bref, une mise en mots simple, ou une présence sobre.
`
    });
  }

  if (investigativeDrift) {
    extraSystemMessages.push({
      role: "system",
      content: `
Un glissement vers une question d’investigation ou d’enquête est probable.

N’investigue pas.
N’oriente pas vers :
- la fréquence
- l’ancienneté
- la typologie
- une comparaison de catégories
- une clarification de type enquête

Ne demande pas si c’est nouveau, ancien, fréquent, habituel, récent, ou depuis quand.
Reviens plutôt au vécu immédiat de la personne.
`
    });
  }

  const r = await client.chat.completions.create({
    model: "gpt-4o",
    temperature: 1.1,
    messages: [
      { role: "system", content: baseSystem },
      { role: "system", content: stateSystem },
      { role: "system", content: bodySystem },
      { role: "system", content: endingSystem },
      { role: "system", content: facilitationSystem },
      { role: "system", content: diagnosticGuardrail },
      ...extraSystemMessages,
      ...context,
      { role: "user", content: userMessage }
    ],
  });

  const out = (r.choices?.[0]?.message?.content ?? "").trim();

  return postProcessReply(out, {
    primaryState,
    congruenceResponseMode,
    defensiveMinimization: isMinimization,
    promptingBotToSpeak,
    sufficientClosure
  });
}

module.exports = {
  generateFreeReply,
  postProcessReply
};