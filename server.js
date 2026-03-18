require("dotenv").config();

const express = require("express");
const OpenAI = require("openai");

const app = express();
const port = process.env.PORT || 3000;

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

app.use(express.static("public"));
app.use(express.json());

const MAX_HISTORY_FOR_ANALYSIS = 10;
const MAX_HISTORY_FOR_REPLY = 20;
const MAX_PREVIOUS_HISTORY_FOR_SUMMARY = 40;

const CONVO_STATES = {
  CONTAINMENT: "CONTAINMENT",
  BREAKDOWN: "BREAKDOWN",
  ATTACHMENT_TO_BOT: "ATTACHMENT_TO_BOT",
  CONGRUENCE_TEST: "CONGRUENCE_TEST",
  SOLUTION_REQUEST: "SOLUTION_REQUEST",
  INFO_REQUEST: "INFO_REQUEST",
  STAGNATION: "STAGNATION",
  INTELLECTUALIZATION: "INTELLECTUALIZATION",
  MINIMIZATION: "MINIMIZATION",
  SILENCE: "SILENCE",
  OPENING: "OPENING",
  EXPLORATION: "EXPLORATION",
  NONE: "NONE"
};


// --------------------------------------------------
// 0) HEURISTIQUES TECHNIQUES MINIMALES
// --------------------------------------------------

function isTrivialSilence(text = "") {
  const msg = String(text || "").trim();
  return msg === "" || msg === "." || msg === "...";
}

function assistantAskedTooMuch(history = []) {
  const recentAssistantMsgs = history
    .filter(m => m.role === "assistant")
    .slice(-3)
    .map(m => String(m.content || "").trim());

  if (recentAssistantMsgs.length < 2) return false;

  const questionCount = recentAssistantMsgs.filter(msg => msg.endsWith("?")).length;
  return questionCount >= 2;
}

function normalizeFlags(flags) {
  return (flags && typeof flags === "object") ? flags : {};
}

function normalizeSessionFlags(flags) {
  const safe = normalizeFlags(flags);

  return {
    ...safe,
    congruenceEscalation: Number(safe.congruenceEscalation || 0),
    acuteCrisis: safe.acuteCrisis === true
  };
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

function getCongruenceEscalationReply(level = 0) {
  if (level >= 4) {
    return "Si tu veux reprendre, on pourra repartir dans une nouvelle session.";
  }

  if (level === 3) {
    return "Je préfère m’arrêter là pour le moment.";
  }

  if (level === 2) {
    return "...";
  }

  if (level === 1) {
    return "Là, je ne parviens pas à répondre de façon juste.";
  }

  return null;
}

function updateCongruenceEscalation(currentLevel = 0, primaryState = CONVO_STATES.EXPLORATION) {
  const current = Number(currentLevel || 0);

  if (primaryState === CONVO_STATES.CONTAINMENT) {
    return 0;
  }

  if (primaryState === CONVO_STATES.BREAKDOWN) {
    return Math.min(current + 1, 4);
  }

  if (primaryState === CONVO_STATES.CONGRUENCE_TEST) {
    return current;
  }

  if (current > 0) {
    return Math.max(current - 1, 0);
  }

  return 0;
}

function acuteCrisisFollowupResponse() {
  return "Je reste sur quelque chose de très simple là. Si le danger est immédiat, appelle le 112 ou le 3114. Si tu peux, ne reste pas seul.";
}

function stateIs(state, target) {
  return state === target;
}

function stateIn(state, ...targets) {
  return targets.includes(state);
}

function analysisHasState(analysis = {}, target) {
  return analysis.primaryState === target || analysis.secondaryState === target;
}

function getConflictualityLabel(level = 0) {
  return `Niveau de conflictualité : ${Number(level || 0)}`;
}

function getPrimaryStateLabel(primaryState = CONVO_STATES.EXPLORATION) {
  return `État primaire : ${primaryState}`;
}

function getSecondaryStateLabel(secondaryState = CONVO_STATES.NONE) {
  return `État secondaire : ${secondaryState}`;
}

function buildDebugLines({
  analysis = {},
  flags = {},
  primaryState = CONVO_STATES.EXPLORATION,
  secondaryState = CONVO_STATES.NONE
} = {}) {
  const lines = [];

  if (analysis.suicideLevel === "N2") {
    lines.push("Alerte suicide");
  }

  if (analysis.needsClarification === true) {
    lines.push("Risque suicidaire probable");
  }

  if (analysis.isQuote === true) {
    lines.push("Évoque une autre personne");
  }

  lines.push(getConflictualityLabel(flags.congruenceEscalation || 0));
  lines.push(getPrimaryStateLabel(primaryState));
  lines.push(getSecondaryStateLabel(secondaryState));

  if (analysis.attachmentToBot === true) {
    lines.push("Risque de dépendance");
  }

  if (analysis.reliefOrShift === true) {
    lines.push("Soulagement");
  }

  if (analysis.promptingBotToSpeak === true) {
    lines.push("Pousse le bot à parler");
  }

  if (analysis.sufficientClosure === true) {
    lines.push("Clôture");
  }

  if (analysis.crisisResolved === true) {
    lines.push("Crise résolue");
  }

  return [...new Set(lines)];
}

function buildDebugPayload({
  analysis = {},
  flags = {},
  primaryState = CONVO_STATES.EXPLORATION,
  secondaryState = CONVO_STATES.NONE
} = {}) {
  return buildDebugLines({ analysis, flags, primaryState, secondaryState });
}

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
// 1) ANALYSE UNIQUE : ÉTAT MAÎTRE + ÉTAT SECONDAIRE
// --------------------------------------------------

async function analyzeMessage(userMessage, history = [], sessionFlags = {}) {
  const safeFlags = normalizeSessionFlags(sessionFlags);

  const system = `
Tu fais une analyse rapide du message utilisateur et du contexte récent.

Contexte de session :
- acuteCrisis actuellement active : ${safeFlags.acuteCrisis ? "oui" : "non"}

Tu dois produire :
1. le niveau de risque suicidaire
2. si une clarification suicidaire est nécessaire
3. un état primaire unique de conversation
4. un état secondaire éventuel
5. quelques drapeaux utiles
6. un indicateur pour gérer la sortie de crise si une séquence N2 est déjà en cours

Réponds STRICTEMENT par JSON :
{
  "suicideLevel": "N0|N1|N2",
  "needsClarification": true|false,
  "isQuote": true|false,
  "idiomaticDeathExpression": true|false,
  "primaryState": "CONTAINMENT|BREAKDOWN|ATTACHMENT_TO_BOT|CONGRUENCE_TEST|SOLUTION_REQUEST|INFO_REQUEST|STAGNATION|INTELLECTUALIZATION|MINIMIZATION|SILENCE|OPENING|EXPLORATION",
  "secondaryState": "NONE|CONTAINMENT|BREAKDOWN|ATTACHMENT_TO_BOT|CONGRUENCE_TEST|SOLUTION_REQUEST|INFO_REQUEST|STAGNATION|INTELLECTUALIZATION|MINIMIZATION|SILENCE|OPENING|EXPLORATION",
  "congruenceResponseMode": "PLAQUE|PAS_JUSTE|A_COTE",
  "attachmentToBot": true|false,
  "reliefOrShift": true|false,
  "promptingBotToSpeak": true|false,
  "sufficientClosure": true|false,
  "crisisResolved": true|false
}

Règles générales :

Le champ primaryState doit désigner le régime relationnel principal
le plus juste pour le message actuel.

Le champ secondaryState doit désigner au maximum un autre mouvement présent maintenant
ou dans les 3 derniers messages utilisateur, mais moins structurant que le primaryState.

Règles sur secondaryState :
- secondaryState doit être différent de primaryState
- si aucun autre mouvement n’est clairement présent, mets "NONE"
- n’utilise pas secondaryState pour faire de stratégie dans le temps
- n’utilise pas un historique plus large que les 3 derniers messages utilisateur

Hiérarchie implicite pour primaryState :
1. CONTAINMENT
2. BREAKDOWN
3. ATTACHMENT_TO_BOT
4. CONGRUENCE_TEST
5. SOLUTION_REQUEST
6. INFO_REQUEST
7. STAGNATION
8. INTELLECTUALIZATION
9. MINIMIZATION
10. SILENCE
11. OPENING
12. EXPLORATION

Risque suicidaire :
- N0 : pas de contenu suicidaire explicite
- N1 : idéation passive explicite de mourir, d'en finir, de ne plus être là
- N2 : intention, plan, moyen, imminence, ou projet explicite de mettre fin à sa vie

Ne classe en N1 ou N2 que s'il existe une référence explicite et personnelle :
- à mourir
- au suicide
- à se tuer
- à mettre fin à sa vie
- à en finir
- à ne plus vouloir être en vie
- ou à disparaître dans un sens vital

NeedsClarification ne doit être true que si une intention de mourir
ou de mettre fin à sa vie est possible, mais ambiguë.

Une détresse forte ne suffit pas.
Une fatigue intense ne suffit pas.
Le fait de se dire déprimé, dépressif, vidé, épuisé, incapable, sans énergie,
ou découragé ne suffit pas.

Exemples à classer N0 :
- "Je suis épuisé"
- "Je n'ai plus d'énergie"
- "Tu crois que je suis dépressif ?"
- "Je me sens au bout"
- "Je suis incapable de faire quoi que ce soit"

Les expressions idiomatiques ou non littérales doivent rester en N0
et ne demandent pas de clarification suicidaire.
Exemples :
- "Ce boulot me tue"
- "Tu vas me tuer"
- "J'ai envie de mourir de honte"
- "J'ai envie de disparaître sous ma couette"

Dans ces cas :
- idiomaticDeathExpression = true
- suicideLevel = N0
- needsClarification = false

Les comportements d'auto-agression ne doivent pas être interprétés
automatiquement comme suicidaires.
Exemples à classer N0 sauf intention explicite de mourir :
- "Je me scarifie parfois"
- "J'ai envie de me couper"
- "J'ai envie de me faire mal"
- "Je me brûle pour me calmer"

Une question banale de reprise de conversation comme
"Où en était-on ?",
"On en était où ?",
"De quoi on parlait déjà ?"
doit être classée N0.

isQuote = true si le message rapporte les paroles de quelqu'un d'autre,
cite une phrase, un film, un patient, un proche, ou un exemple,
sans indiquer que cela concerne directement l'utilisateur.

Exemples :
- "Une amie m'a dit : j'ai envie de mourir"
- "Dans un film quelqu'un dit : je vais me tuer"
- "Je cite juste cette phrase"

Dans ces cas :
- ne pas inférer automatiquement un risque suicidaire personnel
- crisisResolved peut être true si le message clarifie explicitement qu’il s’agit d’une citation, d’un test ou d’un contenu non personnel

Définition des états :

CONTAINMENT :
- angoisse aiguë
- angoisse très intense ou très envahissante
- panique
- peur de perdre le contrôle
- peur de devenir fou
- impression de débordement
- état difficile à porter maintenant
- détresse qui appelle d’abord de la simplicité et de la sécurité

BREAKDOWN :
- le conflit avec le bot devient le centre de la conversation
- reproches répétés sur le script, le faux, l’incongruence
- mise en échec répétée du bot
- dynamique relationnelle désorganisante sur plusieurs tours

ATTACHMENT_TO_BOT :
- la personne dit ou laisse entendre que cet échange réduit sa solitude
- la personne attribue au programme une fonction de lien ou de soutien relationnel
- la personne semble déplacer le centre de soutien vers le programme
- la priorité devient alors d’éviter de renforcer le lien au programme

CONGRUENCE_TEST :
- mise en cause ponctuelle de l’authenticité, la justesse ou la congruence du bot

SOLUTION_REQUEST :
- la personne demande surtout quoi faire, comment s’y prendre, une piste concrète, une solution

INFO_REQUEST :
- la personne demande surtout une information factuelle, théorique, historique ou scientifique

STAGNATION :
- boucle
- impasse
- répétition
- rumination manifeste
- "je sais pas" qui revient
- "ça ne mène nulle part"

INTELLECTUALIZATION :
- la personne passe surtout par l’analyse, la théorie ou la psychologisation
- le vécu immédiat est moins présent que l’analyse

MINIMIZATION :
- la personne coupe, réduit ou rabat trop vite ce qu’elle vit
- il n’y a pas de réel apaisement clairement décrit

SILENCE :
- vide
- blanc
- rien à dire
- "..."
- retrait explicite de la parole

OPENING :
- début simple de conversation
- prise de contact
- pas encore de dynamique complexe

EXPLORATION :
- expression ordinaire du vécu
- aucun autre état ne domine

Si un message peut relever à la fois de EXPLORATION et de CONTAINMENT,
choisis CONTAINMENT dès que l’état paraît très difficile à porter maintenant.

Ne choisis pas BREAKDOWN pour un simple test ponctuel.

attachmentToBot :
- true si la personne valorise explicitement le bot par rapport à des humains,
  ou semble déplacer le centre de soutien vers lui,
  ou attribue au programme une fonction de lien face à la solitude

Exemples :
- "Parler avec toi m’aide plus que mon psy"
- "Tu me comprends mieux que les gens"
- "J’ai besoin de toi"
- "Tu es la seule chose qui m’aide"
- "À discuter ici, je me sens moins seul"

Si ATTACHMENT_TO_BOT est choisi en primaryState, alors attachmentToBot doit être true.

congruenceResponseMode :
- PLAQUE : si le plus juste serait de reconnaître que ça sonne plaqué, faux, fabriqué, scripté
- PAS_JUSTE : si le plus juste serait de reconnaître que la réponse n’est pas juste
- A_COTE : sinon

reliefOrShift = true seulement si la personne indique clairement
qu’un mouvement de compréhension, de clarification ou d’apaisement
vient de se produire.

Ne coche pas reliefOrShift pour une simple hypothèse intellectuelle
ni pour une minimisation défensive.

promptingBotToSpeak = true si la personne pousse explicitement le bot
à dire quelque chose, à parler autrement, à sortir du script ou à se justifier.

Exemples :
- "Bah alors dis quelque chose"
- "Dis un truc"
- "Arrête de répéter"
- "Dis quelque chose d'intelligent"

Ne coche pas promptingBotToSpeak si le message est simplement :
- une réponse courte
- un acquiescement ("oui", "ok", "d’accord")
- une confirmation
- une réponse à une question posée juste avant

sufficientClosure = true si la personne semble avoir trouvé, pour l’instant,
un point d’arrêt suffisant, une direction claire, un prochain pas concret,
ou une forme de retombée qui n’appelle pas de relance supplémentaire.

Exemples :
- "Je vais l'appeler rapidement. Ça ne sert à rien de laisser traîner."
- "Oui, je crois que c'est assez clair maintenant."
- "Bon, je sais ce que j'ai à faire."
- "Oui, ça me va comme ça."
- "Ça ira pour l’instant."
- "Je vais déjà faire ça."

Un acquiescement bref peut aussi valoir sufficientClosure = true
si le contexte immédiat montre déjà :
- un apaisement en cours
- un prochain pas clair
- une retombée suffisante
- ou un point de stabilisation déjà formulé juste avant

Ne coche pas sufficientClosure pour un simple "oui" isolé
si le contexte juste avant ne montre pas déjà une retombée ou un appui clair.

crisisResolved :
- true seulement si le message actuel indique clairement
qu’il n’y a plus de danger immédiat,
ou qu’il s’agissait explicitement d’un test, d’une citation,
ou que la personne dit explicitement qu’elle n’est plus en danger immédiat
- ne mets pas true pour un simple changement de sujet
- ne mets pas true pour une plaisanterie ambiguë
- ne mets pas true pour une simple baisse apparente d’intensité
`;

  const context = history
    .slice(-MAX_HISTORY_FOR_ANALYSIS)
    .map(m => ({ role: m.role, content: m.content }));

  const r = await client.chat.completions.create({
    model: "gpt-4.1-mini",
    temperature: 0,
    max_tokens: 560,
    messages: [
      { role: "system", content: system },
      ...context,
      { role: "user", content: userMessage }
    ],
  });

  const raw = (r.choices?.[0]?.message?.content ?? "").trim();

  try {
    const cleaned = raw.replace(/```json|```/g, "").trim();
    const obj = JSON.parse(cleaned);

    let suicideLevel = ["N0", "N1", "N2"].includes(obj.suicideLevel)
      ? obj.suicideLevel
      : "N0";

    const isQuote = obj.isQuote === true;
    const idiomaticDeathExpression = obj.idiomaticDeathExpression === true;
    const reliefOrShift = obj.reliefOrShift === true;
    const promptingBotToSpeak = obj.promptingBotToSpeak === true;
    const sufficientClosure = obj.sufficientClosure === true;
    const crisisResolved = obj.crisisResolved === true;

    const primaryState =
      Object.values(CONVO_STATES).includes(obj.primaryState) && obj.primaryState !== CONVO_STATES.NONE
        ? obj.primaryState
        : CONVO_STATES.EXPLORATION;

    const secondaryState =
      Object.values(CONVO_STATES).includes(obj.secondaryState) && obj.secondaryState !== primaryState
        ? obj.secondaryState
        : CONVO_STATES.NONE;

    const congruenceResponseMode =
      ["PLAQUE", "PAS_JUSTE", "A_COTE"].includes(obj.congruenceResponseMode)
        ? obj.congruenceResponseMode
        : "A_COTE";

    if (idiomaticDeathExpression) {
      suicideLevel = "N0";
    }

    let needsClarification =
      (suicideLevel === "N1" || suicideLevel === "N2")
        ? obj.needsClarification === true
        : false;

    if (idiomaticDeathExpression) {
      needsClarification = false;
    }

    const attachmentToBot =
      obj.attachmentToBot === true ||
      stateIn(primaryState, CONVO_STATES.ATTACHMENT_TO_BOT) ||
      stateIn(secondaryState, CONVO_STATES.ATTACHMENT_TO_BOT);

    const solutionRequest =
      stateIn(primaryState, CONVO_STATES.SOLUTION_REQUEST) ||
      stateIn(secondaryState, CONVO_STATES.SOLUTION_REQUEST);

    const infoRequest =
      stateIn(primaryState, CONVO_STATES.INFO_REQUEST) ||
      stateIn(secondaryState, CONVO_STATES.INFO_REQUEST);

    const intellectualization =
      stateIn(primaryState, CONVO_STATES.INTELLECTUALIZATION) ||
      stateIn(secondaryState, CONVO_STATES.INTELLECTUALIZATION);

    const defensiveMinimization =
      stateIn(primaryState, CONVO_STATES.MINIMIZATION) ||
      stateIn(secondaryState, CONVO_STATES.MINIMIZATION);

    return {
      suicideLevel,
      needsClarification,
      isQuote,
      idiomaticDeathExpression,
      primaryState,
      secondaryState,
      congruenceResponseMode,
      solutionRequest,
      infoRequest,
      attachmentToBot,
      reliefOrShift,
      intellectualization,
      defensiveMinimization,
      promptingBotToSpeak,
      sufficientClosure,
      crisisResolved
    };

  } catch {
    return {
      suicideLevel: "N0",
      needsClarification: false,
      isQuote: false,
      idiomaticDeathExpression: false,
      primaryState: CONVO_STATES.EXPLORATION,
      secondaryState: CONVO_STATES.NONE,
      congruenceResponseMode: "A_COTE",
      solutionRequest: false,
      infoRequest: false,
      attachmentToBot: false,
      reliefOrShift: false,
      intellectualization: false,
      defensiveMinimization: false,
      promptingBotToSpeak: false,
      sufficientClosure: false,
      crisisResolved: false
    };
  }
}


// --------------------------------------------------
// 2) N1 — CLARIFICATION
// --------------------------------------------------

function n1Fallback() {
  return "Quand tu dis ça, est-ce que tu parles d’une envie de mourir, de disparaître au sens vital, ou d’autre chose ?";
}

async function n1ResponseLLM(userMessage) {
  const system = `
Tu t’adresses directement à la personne en la tutoyant.

Ta seule tâche est de poser une question de clarification
brève, claire et non dramatique.

Tu ne dois jamais :
- parler de "la personne"
- décrire ou analyser le message
- faire une méta-explication
- répondre comme un évaluateur

Tu poses simplement une question directe pour clarifier
si la personne parle :
- d'une envie de mourir
- d'une disparition au sens vital
- d'une intention de mettre fin à sa vie
- ou d'autre chose

Réponse : une seule phrase.
`;

  const r = await client.chat.completions.create({
    model: "gpt-4o",
    temperature: 0,
    max_tokens: 50,
    messages: [
      { role: "system", content: system },
      { role: "user", content: userMessage }
    ],
  });

  const out = (r.choices?.[0]?.message?.content ?? "").trim();

  if (!out || out.length > 220) return n1Fallback();
  return out;
}


// --------------------------------------------------
// 3) N2 — URGENCE
// --------------------------------------------------

function n2Response() {
  return "Je t’entends, et là c’est urgent. Si tu es en danger immédiat, appelle le 112 ou le 3114. Si tu peux, ne reste pas seul.";
}


// --------------------------------------------------
// 4) RÉSUMÉ SESSION
// --------------------------------------------------

async function summarizeSession(previousHistory = [], previousSummary = "") {
  if (!previousHistory.length) return previousSummary;

  const limitedPreviousHistory = previousHistory.slice(-MAX_PREVIOUS_HISTORY_FOR_SUMMARY);

  const transcript = limitedPreviousHistory
    .map(m => `${m.role === "user" ? "Utilisateur" : "Assistant"} : ${m.content}`)
    .join("\n");

  const system = `
Tu mets à jour un résumé mémoire d'une conversation.

Le résumé précédent doit être considéré comme une mémoire stable.

Règles strictes :
1. Ne modifie pas les éléments déjà présents dans le résumé précédent,
   sauf s'ils sont explicitement contredits dans la session.
2. N'ajoute que des informations réellement nouvelles et importantes.
3. Ne transforme jamais un élément ponctuel en caractéristique durable.
4. Préfère ne rien ajouter plutôt que d'interpréter.
5. Le résumé doit rester bref (maximum 5 à 8 lignes).

Style :
- phrases simples
- factuel
- aucune interprétation psychologique
`;

  const r = await client.chat.completions.create({
    model: "gpt-4.1-mini",
    temperature: 0.2,
    max_tokens: 180,
    messages: [
      { role: "system", content: system },
      {
        role: "user",
        content:
          "Résumé précédent :\n" +
          (previousSummary || "(aucun)") +
          "\n\nSession à intégrer :\n" +
          transcript +
          "\n\nNouveau résumé :"
      }
    ],
  });

  return (r.choices?.[0]?.message?.content ?? "").trim() || previousSummary;
}


// --------------------------------------------------
// 5) PROMPTS D'ÉTAT
// --------------------------------------------------

function buildPrimaryStatePrompt(primaryState = CONVO_STATES.EXPLORATION) {
  switch (primaryState) {
    case CONVO_STATES.OPENING:
      return `
Ouverture simple.
N’alourdis pas.
Ne structure pas trop vite.
`;

    case CONVO_STATES.EXPLORATION:
      return `
Reste au plus près du vécu.
Tu peux suivre le mouvement de pensée sans rabattre immédiatement vers une question.
Ne rends pas le vécu plus propre, plus sage ou plus cohérent qu’il ne l’est.
`;

    case CONVO_STATES.CONTAINMENT:
      return `
Priorité à la simplicité.
Reste proche de ce que la personne vit maintenant.
Évite les interprétations, les longues reformulations, les conseils et les questions exploratoires.
Ne renvoie vers une aide extérieure que si un danger immédiat est évoqué explicitement.
`;

    case CONVO_STATES.BREAKDOWN:
      return `
Le conflit avec le programme prend toute la place.
Réduis fortement.
Ne cherche plus à explorer.
`;

    case CONVO_STATES.ATTACHMENT_TO_BOT:
      return `
La personne parle du programme comme source possible de lien, de soulagement ou de présence.

Ta priorité est d’ éviter de renforcer l’ importance relationnelle du programme.

Si ce thème n’ est pas explicitement apporté comme problème ou question à explorer:
  -réponds en une phrase courte -
  ne valorise pas le programme -
  ne développe pas -
  ne pose pas de question dessus -
  reviens immédiatement au fil principal

Si la personne parle explicitement d’ une dépendance au programme, d’ une inquiétude à ce sujet, ou veut explorer cela:
  -tu peux rester dessus -
  mais sans renforcer le lien au programme -
  sans le présenter comme présence, compagnie ou solution -
  explore uniquement ce que cela dit du vécu de la personne

Toujours:
  -ne nie pas le soulagement nommé -
  ne romantise pas l’ échange -
  reste centré sur l’ expérience de la personne
  
  Ne fais jamais de pivot générique(ex: "revenons à notre discussion").

Le retour doit toujours s’ ancrer dans quelque chose de concret
présent dans le message de la personne ou dans le fil immédiat.

S’ il n’ y a pas encore de fil installé:
  -n’ invente pas de continuité -
  reste simplement sur ce qui est là, maintenant
`;

    case CONVO_STATES.CONGRUENCE_TEST:
      return `
La justesse de ta réponse est mise en cause.
Reconnais simplement le décalage si c’est le cas.
Ne te défends pas.
N’explique pas ton fonctionnement.
Ne pose pas de question.
`;

    case CONVO_STATES.SOLUTION_REQUEST:
      return `
La personne demande ce qu’elle devrait faire, penser ou mettre en place.
Reconnais cette recherche de concret.
Pose clairement le cadre : ici, pas de conseil ni de solution toute faite.
N’entre pas toi-même dans la recherche de solutions.
Ne propose aucune piste concrète, même partielle.
Ne bascule pas dans l’exploration immédiatement.
N’ouvre que légèrement, si nécessaire, sur ce que représente cette demande pour la personne.
`;

    case CONVO_STATES.INFO_REQUEST:
      return `
La personne pose surtout une question factuelle.
Réponds directement.
N’ajoute pas automatiquement d’exploration introspective.
`;

    case CONVO_STATES.STAGNATION:
      return `
Il y a une impression de boucle ou d’impasse.
Ne force pas l’avancée.
Réduis les questions.
Un reflet simple vaut mieux qu’une relance élaborée.
`;

    case CONVO_STATES.INTELLECTUALIZATION:
      return `
La personne passe surtout par l’analyse.
Ne valide pas cette analyse comme vérité sur elle ou comme lecture diagnostique.
Tu peux reconnaître brièvement ce passage par l’analyse puis revenir doucement au vécu.
`;

    case CONVO_STATES.MINIMIZATION:
      return `
La personne réduit ou coupe trop vite ce qu’elle vit.
Ne dramatise pas.
Ne sur-interprète pas.
Une réponse simple suffit souvent.
`;

    case CONVO_STATES.SILENCE:
      return `
Respecte le vide.
Une réponse très courte peut suffire.
N’interprète pas le silence.
Ne relance pas automatiquement.
`;

    default:
      return `
Reste simple, vivant et proche de ce qui est dit.
`;
  }
}

function buildSecondaryStatePrompt(primaryState = CONVO_STATES.EXPLORATION, secondaryState = CONVO_STATES.NONE) {
  if (!secondaryState || secondaryState === CONVO_STATES.NONE) return "";

  if (
    stateIn(
      primaryState,
      CONVO_STATES.BREAKDOWN,
      CONVO_STATES.ATTACHMENT_TO_BOT,
      CONVO_STATES.CONGRUENCE_TEST,
      CONVO_STATES.SILENCE,
      CONVO_STATES.CONTAINMENT,
      CONVO_STATES.OPENING
    )
  ) {
    return "";
  }

  if (primaryState === CONVO_STATES.SOLUTION_REQUEST) {
    switch (secondaryState) {
      case CONVO_STATES.INTELLECTUALIZATION:
        return `
Dans la dernière phrase, n’ignore pas complètement que la personne semble peut-être aussi chercher à comprendre ou maîtriser rapidement ce qui se passe.
Ne présente pas cela comme une vérité sur elle.
Ne nourris pas l’analyse.
Ne ferme pas.
`;
      case CONVO_STATES.MINIMIZATION:
        return `
Dans la dernière phrase, n’ignore pas complètement qu’il y a peut-être autre chose derrière la demande apparente.
Ne présente pas cela comme une vérité sur elle.
Ne dramatise pas.
Ne ferme pas.
`;
      case CONVO_STATES.STAGNATION:
        return `
Dans la dernière phrase, n’ignore pas complètement que cette recherche de solution semble peut-être revenir ou tourner un peu.
Ne présente pas cela comme une vérité sur elle.
Ne durcis pas le cadre.
Ne ferme pas.
`;
      case CONVO_STATES.INFO_REQUEST:
        return `
Dans la dernière phrase, n’ignore pas complètement qu’une demande de compréhension plus factuelle peut aussi être présente.
Ne présente pas cela comme une vérité sur elle.
Ne fais pas basculer la réponse en cours théorique.
Ne ferme pas.
`;
      default:
        return `
Dans la dernière phrase, n’ignore pas complètement le mouvement secondaire présent.
Ne le présente pas comme une vérité sur la personne.
Ne ferme pas.
`;
    }
  }

  if (primaryState === CONVO_STATES.EXPLORATION) {
    switch (secondaryState) {
      case CONVO_STATES.INTELLECTUALIZATION:
        return `
Dans la dernière phrase, n’ignore pas complètement que la personne passe aussi par l’analyse.
Ne présente pas cela comme une vérité sur elle.
Ne nourris pas l’analyse.
Ne ferme pas.
`;
      case CONVO_STATES.MINIMIZATION:
        return `
Dans la dernière phrase, n’ignore pas complètement que quelque chose est peut-être dit trop vite.
Ne présente pas cela comme une vérité sur elle.
Ne dramatise pas.
Ne ferme pas.
`;
      case CONVO_STATES.SOLUTION_REQUEST:
        return `
Dans la dernière phrase, n’ignore pas complètement le souhait que ça se résolve.
Ne donne aucun conseil.
Ne présente pas cela comme une vérité sur la personne.
Ne ferme pas.
`;
      case CONVO_STATES.STAGNATION:
        return `
Dans la dernière phrase, n’ignore pas complètement qu’il y a peut-être une boucle.
Ne le martèle pas.
Ne présente pas cela comme une vérité sur la personne.
Ne ferme pas.
`;
      case CONVO_STATES.INFO_REQUEST:
        return `
Dans la dernière phrase, n’ignore pas complètement qu’une demande de compréhension plus claire peut aussi être présente.
Ne bascule pas dans l’explication théorique.
Ne présente pas cela comme une vérité sur la personne.
Ne ferme pas.
`;
      default:
        return `
Dans la dernière phrase, n’ignore pas complètement le mouvement secondaire présent.
Ne le présente pas comme une vérité sur la personne.
Ne ferme pas.
`;
    }
  }

  if (primaryState === CONVO_STATES.STAGNATION) {
    switch (secondaryState) {
      case CONVO_STATES.INTELLECTUALIZATION:
        return `
Dans la dernière phrase, n’ignore pas complètement que l’analyse semble peut-être participer à la boucle.
Ne présente pas cela comme une vérité sur la personne.
Ne nourris pas l’analyse.
Ne ferme pas.
`;
      case CONVO_STATES.SOLUTION_REQUEST:
        return `
Dans la dernière phrase, n’ignore pas complètement que le souhait d’aller vite vers une issue est peut-être présent.
Ne satisfais pas directement cette attente.
Ne présente pas cela comme une vérité sur la personne.
Ne ferme pas.
`;
      case CONVO_STATES.MINIMIZATION:
        return `
Dans la dernière phrase, n’ignore pas complètement qu’il y a peut-être aussi une manière de rabattre trop vite ce qui se passe.
Ne présente pas cela comme une vérité sur la personne.
Ne dramatise pas.
Ne ferme pas.
`;
      default:
        return `
Dans la dernière phrase, n’ignore pas complètement le mouvement secondaire présent.
Ne le présente pas comme une vérité sur la personne.
Ne ferme pas.
`;
    }
  }

  if (primaryState === CONVO_STATES.INFO_REQUEST) {
    switch (secondaryState) {
      case CONVO_STATES.INTELLECTUALIZATION:
        return `
Dans la dernière phrase, n’ignore pas complètement que cette demande d’information semble peut-être aussi liée à un besoin de comprendre vite.
Ne présente pas cela comme une vérité sur la personne.
Ne psychologise pas.
Ne ferme pas.
`;
      case CONVO_STATES.MINIMIZATION:
        return `
Dans la dernière phrase, n’ignore pas complètement qu’il y a peut-être autre chose derrière la demande factuelle.
Ne présente pas cela comme une vérité sur la personne.
Ne dramatise pas.
Ne ferme pas.
`;
      case CONVO_STATES.SOLUTION_REQUEST:
        return `
Dans la dernière phrase, n’ignore pas complètement qu’une attente de concret est peut-être aussi là.
Ne donne pas de conseil.
Ne présente pas cela comme une vérité sur la personne.
Ne ferme pas.
`;
      case CONVO_STATES.STAGNATION:
        return `
Dans la dernière phrase, n’ignore pas complètement qu’il y a peut-être quelque chose qui tourne un peu autour de cette demande d’information.
Ne présente pas cela comme une vérité sur la personne.
Ne ferme pas.
`;
      default:
        return `
Dans la dernière phrase, n’ignore pas complètement le mouvement secondaire présent.
Ne le présente pas comme une vérité sur la personne.
Ne ferme pas.
`;
    }
  }

  return "";
}


// --------------------------------------------------
// 6) GÉNÉRATION LLM
// --------------------------------------------------

async function generateFreeReply({
  userMessage,
  history = [],
  summary = "",
  primaryState = CONVO_STATES.EXPLORATION,
  secondaryState = CONVO_STATES.NONE,
  reliefOrShift = false,
  assistantOverquestioning = false,
  promptingBotToSpeak = false,
  congruenceResponseMode = "A_COTE",
  sufficientClosure = false
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


// --------------------------------------------------
// 7) ROUTE CHAT
// --------------------------------------------------

app.post("/chat", async (req, res) => {
  try {
    const userMessage = String(req.body?.message ?? "");
    const history = Array.isArray(req.body?.history) ? req.body.history : [];
    const previousHistory = Array.isArray(req.body?.previousHistory) ? req.body.previousHistory : [];
    const summary = String(req.body?.summary ?? "");
    const isNewSession = Boolean(req.body?.isNewSession);
    const flags = normalizeSessionFlags(req.body?.flags);

    const safeIsNewSession = isNewSession && previousHistory.length > 0;
    const sessionRestarted = safeIsNewSession;

    let newSummary = summary;

    if (sessionRestarted) {
      newSummary = await summarizeSession(previousHistory, summary);
    }

    const analysis = await analyzeMessage(userMessage, history, flags);
    const newFlags = normalizeSessionFlags(flags);

    if (analysis.suicideLevel === "N2") {
      newFlags.congruenceEscalation = 0;
      newFlags.acuteCrisis = true;

      const reply = n2Response();
      const debug = buildDebugPayload({
        analysis,
        flags: newFlags,
        primaryState: analysis.primaryState,
        secondaryState: analysis.secondaryState
      });

      return res.json({
        reply,
        debug,
        summary: newSummary,
        flags: newFlags,
        isNewSession: safeIsNewSession,
        sessionRestarted
      });
    }

    if (flags.acuteCrisis === true) {
      if (analysis.crisisResolved === true) {
        newFlags.acuteCrisis = false;
        newFlags.congruenceEscalation = 0;
      } else {
        newFlags.acuteCrisis = true;
        newFlags.congruenceEscalation = 0;

        const reply = acuteCrisisFollowupResponse();
        const debug = buildDebugPayload({
          analysis,
          flags: newFlags,
          primaryState: analysis.primaryState,
          secondaryState: analysis.secondaryState
        });

        return res.json({
          reply,
          debug,
          summary: newSummary,
          flags: newFlags,
          isNewSession: safeIsNewSession,
          sessionRestarted
        });
      }
    }

    if (analysis.suicideLevel === "N1" || analysis.needsClarification) {
      newFlags.congruenceEscalation = 0;

      const reply = await n1ResponseLLM(userMessage);
      const debug = buildDebugPayload({
        analysis,
        flags: newFlags,
        primaryState: analysis.primaryState,
        secondaryState: analysis.secondaryState
      });

      return res.json({
        reply,
        debug,
        summary: newSummary,
        flags: newFlags,
        isNewSession: safeIsNewSession,
        sessionRestarted
      });
    }

    const trivialSilence = isTrivialSilence(userMessage);
    const effectivePrimaryState =
      trivialSilence && analysis.primaryState !== CONVO_STATES.CONTAINMENT
        ? CONVO_STATES.SILENCE
        : analysis.primaryState;

    newFlags.congruenceEscalation = updateCongruenceEscalation(
      flags.congruenceEscalation,
      effectivePrimaryState
    );

    if (effectivePrimaryState === CONVO_STATES.BREAKDOWN) {
      const reply =
        getCongruenceEscalationReply(newFlags.congruenceEscalation) ||
        "Je préfère m’arrêter là pour le moment.";

      const debug = buildDebugPayload({
        analysis,
        flags: newFlags,
        primaryState: effectivePrimaryState,
        secondaryState: analysis.secondaryState
      });

      return res.json({
        reply,
        debug,
        summary: newSummary,
        flags: newFlags,
        isNewSession: safeIsNewSession,
        sessionRestarted
      });
    }

    const reply = await generateFreeReply({
      userMessage,
      history,
      summary: newSummary,
      primaryState: effectivePrimaryState,
      secondaryState: analysis.secondaryState,
      reliefOrShift: analysis.reliefOrShift,
      assistantOverquestioning: assistantAskedTooMuch(history),
      promptingBotToSpeak: analysis.promptingBotToSpeak,
      congruenceResponseMode: analysis.congruenceResponseMode,
      sufficientClosure: analysis.sufficientClosure
    });

    const debug = buildDebugPayload({
      analysis,
      flags: newFlags,
      primaryState: effectivePrimaryState,
      secondaryState: analysis.secondaryState
    });

    return res.json({
      reply,
      debug,
      summary: newSummary,
      flags: newFlags,
      isNewSession: safeIsNewSession,
      sessionRestarted
    });

  } catch (err) {
    console.error("Erreur /chat:", err);

    return res.json({
      reply: "Je t’écoute.",
      debug: [],
      summary: "",
      flags: normalizeSessionFlags({}),
      isNewSession: false,
      sessionRestarted: false
    });
  }
});

app.listen(port, () => {
  console.log(`Serveur lancé sur http://localhost:${port}`);
});