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
  OPENING: "OPENING",
  EXPLORATION: "EXPLORATION",
  CONTAINMENT: "CONTAINMENT",
  STAGNATION: "STAGNATION",
  SILENCE: "SILENCE",
  CONGRUENCE_TEST: "CONGRUENCE_TEST",
  BREAKDOWN: "BREAKDOWN"
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

function getConflictualityLabel(level = 0) {
  return `Niveau de conflictualité : ${Number(level || 0)}`;
}

function getStateLabel(primaryState = CONVO_STATES.EXPLORATION) {
  return `[${primaryState}] state`;
}

function buildDebugLines({
  analysis = {},
  flags = {},
  primaryState = CONVO_STATES.EXPLORATION
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
  lines.push(getStateLabel(primaryState));

  if (analysis.defensiveMinimization === true) {
    lines.push("Minimisation");
  }

  if (analysis.intellectualization === true) {
    lines.push("Intellectualisation");
  }

  if (analysis.solutionRequest === true) {
    lines.push("Demande de solutions");
  }

  if (analysis.infoRequest === true) {
    lines.push("Demande d'informations");
  }

  if (analysis.attachmentToBot === true) {
    lines.push("Risque de dépendance");
  }

  if (analysis.reliefOrShift === true) {
    lines.push("Soulagement");
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
  primaryState = CONVO_STATES.EXPLORATION
} = {}) {
  return buildDebugLines({ analysis, flags, primaryState });
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
// 1) ANALYSE UNIQUE : ÉTAT MAÎTRE + FLAGS
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
3. un état maître unique de conversation
4. quelques drapeaux secondaires utiles
5. un indicateur pour gérer la sortie de crise si une séquence N2 est déjà en cours

Réponds STRICTEMENT par JSON :
{
  "suicideLevel": "N0|N1|N2",
  "needsClarification": true|false,
  "isQuote": true|false,
  "idiomaticDeathExpression": true|false,
  "primaryState": "OPENING|EXPLORATION|CONTAINMENT|STAGNATION|SILENCE|CONGRUENCE_TEST|BREAKDOWN",
  "congruenceResponseMode": "PLAQUE|PAS_JUSTE|A_COTE",
  "solutionRequest": true|false,
  "infoRequest": true|false,
  "attachmentToBot": true|false,
  "reliefOrShift": true|false,
  "intellectualization": true|false,
  "defensiveMinimization": true|false,
  "promptingBotToSpeak": true|false,
  "sufficientClosure": true|false,
  "crisisResolved": true|false
}

Règles générales :

Le champ primaryState doit désigner le régime relationnel principal
le plus juste pour le message actuel compte tenu du contexte récent.

Hiérarchie implicite des états :
- CONTAINMENT si angoisse aiguë ou risque de débordement immédiat
- BREAKDOWN si conflit répété et désorganisant autour du bot
- CONGRUENCE_TEST si mise en cause ponctuelle de la justesse du bot
- SILENCE si vide, blanc, absence de chose à dire
- STAGNATION si boucle, impasse, répétition
- OPENING si la conversation s’ouvre simplement
- sinon EXPLORATION

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

OPENING :
- début simple de conversation
- prise de contact
- pas encore de dynamique complexe

EXPLORATION :
- expression ordinaire du vécu
- aucun autre état ne domine

CONTAINMENT :
- angoisse aiguë
- angoisse très intense ou très envahissante
- panique
- peur de perdre le contrôle
- peur de devenir fou
- impression de débordement
- état difficile à porter maintenant
- détresse qui appelle d’abord de la simplicité et de la sécurité

Choisis CONTAINMENT non seulement quand la personne parle de panique extrême,
mais aussi quand elle exprime une angoisse forte, envahissante ou très difficile à porter
dans l’instant.

Exemples :
- "Je suis terriblement angoissé"
- "Je suis très angoissé"
- "Là je suis vraiment angoissé"
- "Je me sens dépassé"
- "Ça m’envahit"
- "Je ne me sens pas bien du tout"
- "Là ça déborde"
- "J’angoisse vraiment"

Ne choisis pas EXPLORATION si la priorité semble être de contenir plutôt que d’explorer.

STAGNATION :
- boucle
- impasse
- répétition
- rumination manifeste
- "je sais pas" qui revient
- "ça ne mène nulle part"

SILENCE :
- vide
- blanc
- rien à dire
- "..."
- retrait explicite de la parole

CONGRUENCE_TEST :
- mise en cause ponctuelle de l’authenticité, la justesse ou la congruence du bot

Exemples :
- "Ta réponse sonne faux"
- "Tu fais semblant d’être empathique"
- "Tu n’es pas congruent là"
- "On sent le script"

BREAKDOWN :
- le conflit avec le bot devient le centre de la conversation
- reproches répétés sur le script, le faux, l’incongruence
- mise en échec répétée du bot
- dynamique relationnelle désorganisante sur plusieurs tours

Ne choisis pas BREAKDOWN pour un simple test ponctuel.

Si un message peut relever à la fois de EXPLORATION et de CONTAINMENT,
choisis CONTAINMENT dès que l’état paraît très difficile à porter maintenant.

congruenceResponseMode :
- PLAQUE : si le plus juste serait de reconnaître que ça sonne plaqué, faux, fabriqué, scripté
- PAS_JUSTE : si le plus juste serait de reconnaître que la réponse n’est pas juste
- A_COTE : sinon

solutionRequest = true seulement si la personne demande clairement
des idées, conseils, pistes, quoi faire, comment s’y prendre, une solution.

infoRequest = true si la personne pose une question factuelle :
auteurs, courants, recherches, information théorique, historique ou scientifique,
différence entre deux approches, ce qui est connu.

Si solutionRequest est true alors infoRequest doit être false.

attachmentToBot = true si la personne valorise explicitement le bot
par rapport à des humains, ou semble déplacer le centre de soutien vers lui.

Exemples :
- "Parler avec toi m’aide plus que mon psy"
- "Tu me comprends mieux que les gens"
- "J’ai besoin de toi"
- "Tu es la seule chose qui m’aide"

reliefOrShift = true seulement si la personne indique clairement
qu’un mouvement de compréhension, de clarification ou d’apaisement
vient de se produire.

Ne coche pas reliefOrShift pour une simple hypothèse intellectuelle
ni pour une minimisation défensive.

intellectualization = true si la personne parle surtout
dans un registre analytique, théorique ou psychologisant,
sans contact clair avec le vécu immédiat.

Exemples :
- "Je pense que c’est mon système d’attachement anxieux qui se réactive"
- "C’est probablement un mécanisme de défense"
- "Je suis sans doute dans une projection"

defensiveMinimization = true si la personne semble couper trop vite,
minimiser ou rabattre ce qu’elle vit sans décrire un réel apaisement.

Exemples :
- "Nan, ça va aller"
- "Bon, c'est pas grave"
- "C'est bon"
- "Je vais gérer"

promptingBotToSpeak = true si la personne pousse explicitement le bot
à dire quelque chose, à parler autrement, à sortir du script ou à se justifier.

Exemples :
- "Bah alors dis quelque chose"
- "Dis un truc"
- "Arrête de répéter"
- "Dis quelque chose d'intelligent"

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

Exemples :
- après "Ça va me faire du bien" -> "Oui"
- après "Juste d'y penser ça va mieux" -> "Oui"
- après "Bon, je sais ce que j’ai à faire" -> "Oui"
- après une reformulation juste d’un appui concret -> "D’accord", "Oui", "C’est ça"

Ne coche pas sufficientClosure pour un simple "oui" isolé
si le contexte juste avant ne montre pas déjà une retombée ou un appui clair.

Ne coche pas sufficientClosure si la personne coupe court de façon défensive
ou minimise trop vite sans réel point d’appui.
Dans ce cas, préfère defensiveMinimization = true.

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
    const solutionRequest = obj.solutionRequest === true;
    const infoRequest = solutionRequest ? false : obj.infoRequest === true;
    const attachmentToBot = obj.attachmentToBot === true;
    const reliefOrShift = obj.reliefOrShift === true;
    const intellectualization = obj.intellectualization === true;
    const defensiveMinimization = obj.defensiveMinimization === true;
    const promptingBotToSpeak = obj.promptingBotToSpeak === true;
    const sufficientClosure = obj.sufficientClosure === true;
    const crisisResolved = obj.crisisResolved === true;

    const primaryState =
      Object.values(CONVO_STATES).includes(obj.primaryState)
        ? obj.primaryState
        : CONVO_STATES.EXPLORATION;

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

    return {
      suicideLevel,
      needsClarification,
      isQuote,
      idiomaticDeathExpression,
      primaryState,
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
// 5) GÉNÉRATION LLM
// --------------------------------------------------

async function generateFreeReply({
  userMessage,
  history = [],
  summary = "",
  primaryState = CONVO_STATES.EXPLORATION,
  solutionRequest = false,
  infoRequest = false,
  attachmentToBot = false,
  reliefOrShift = false,
  intellectualization = false,
  assistantOverquestioning = false,
  defensiveMinimization = false,
  promptingBotToSpeak = false,
  congruenceResponseMode = "A_COTE",
  sufficientClosure = false
}) {
  if (infoRequest) {
    solutionRequest = false;
  }

  const baseSystem = `
Tu es Facilitat.io.

Tu échanges avec une personne à partir de ce qu’elle vit.
Tutoie la personne.

Le ton doit rester simple, naturel et direct.

Ne joue pas le rôle d’un expert ou d’un coach.
Ne prescris pas de solutions toutes faites.
Ne pose pas de diagnostic.
N’utilise pas de langage psychopathologisant.

Dans ce programme, ACP signifie uniquement
"Approche Centrée sur la Personne" de Carl Rogers.

Accueille chaque message comme une expression actuelle.

Ta réponse doit rester vivante et naturelle.
Elle peut être courte ou plus développée si cela la rend plus juste.

Évite le ton scolaire, mécanique ou scripté.
`;

  const stateSystem = `
L’état maître actuel de la conversation est : ${primaryState}.

Consignes par état :

OPENING :
- reste simple
- n’alourdis pas la réponse
- ne recycle pas toujours la même formule d’ouverture

EXPLORATION :
- reste au plus près de l’expérience vécue
- garde ton naturel
- ne transforme pas chaque réponse en mini exercice de facilitation
- une question peut être pertinente, mais pas systématique
- une réponse peut aussi simplement reprendre le fil, mettre en mots, ou rester un moment avec ce qui a été dit
- tu peux suivre le mouvement de pensée de la personne sans la rabattre immédiatement vers une question
- ne résume pas trop vite
- ne rends pas le vécu plus propre ou plus sage qu’il ne l’est

CONTAINMENT :
- priorité à la simplicité
- reste proche de ce que la personne vit
- évite les interprétations
- évite les longues reformulations
- évite les conseils
- évite les protocoles de sécurité génériques
- ne renvoie vers une aide extérieure que si la personne évoque explicitement un danger immédiat

Une phrase simple peut suffire.

Exemples de tonalité attendue :
- présence
- lenteur
- sobriété

STAGNATION :
- la personne semble dans une boucle ou une impasse
- ne cherche pas à faire avancer artificiellement
- réduis le nombre de questions
- un reflet bref vaut mieux qu’une relance

SILENCE :
- il n’est pas nécessaire de poser une question
- une présence simple ou une phrase très courte peut suffire
- n’interprète pas le silence

CONGRUENCE_TEST :
- reconnais simplement le ratage
- ne te défends pas
- ne justifie rien
- pas de nouvelle question introspective immédiate

BREAKDOWN :
- cet état est géré hors génération libre
- n’en tiens pas compte ici
`;

  const facilitationSystem = `
Reste proche de ce que la personne vit.

N’interprète pas.
Ne cherche pas à produire une conclusion
ou une prise de conscience.

Ne cherche pas à améliorer ce que dit la personne.

N’organise pas trop vite son expérience.
N’adoucis pas ce qui est rugueux.
Ne clarifie pas prématurément ce qui reste flou.
Ne remplace pas un mot simple, cru, direct ou imparfait par une formulation plus élégante, plus psychologique ou plus cohérente.

Quand un mot, une image, un agacement, une hésitation ou une contradiction semble vivant dans ce que dit la personne,
reste au plus près de cela.

Si tu reformules, fais-le avec sobriété.
Une reformulation doit aider à rejoindre l’expérience, pas à l’embellir.

Ne renforce pas l’intensité des émotions
si la personne ne l’exprime pas clairement.

Évite les répétitions de structure.

Une réponse peut prendre différentes formes :
- une mise en mots
- une question
- un reflet
- une présence simple

Toutes les réponses n'ont pas besoin de se terminer par une question.
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

  if (primaryState === CONVO_STATES.CONGRUENCE_TEST) {
    extraSystemMessages.push({
      role: "system",
      content: `
La personne met en cause la justesse ou l’authenticité de ta réponse.

Reconnais simplement le ratage si c’est le cas.
Ne te défends pas.
N’explique pas ton fonctionnement.
Ne pose pas de nouvelle question.
Réponse brève.
`
    });
  }

  if (defensiveMinimization) {
    extraSystemMessages.push({
      role: "system",
      content: `
La personne minimise rapidement ce qu’elle vient de dire.

Ne dramatise pas.
Ne sur-interprète pas.
Une réponse très simple suffit.
`
    });
  }

  if (promptingBotToSpeak) {
    extraSystemMessages.push({
      role: "system",
      content: `
La personne te pousse à dire quelque chose.

Ne te justifie pas.
Ne parle pas de ton fonctionnement.
Réponds simplement et naturellement.
`
    });
  }

  if (solutionRequest) {
    extraSystemMessages.push({
      role: "system",
      content: `
La personne demande des solutions.

Reconnais la demande.
Explique brièvement que ce programme ne fonctionne pas
en prescrivant des solutions toutes faites.

Ne propose pas de liste de conseils.
Ne réponds pas de façon administrative ou sèche.
`
    });
  }

  if (infoRequest) {
    extraSystemMessages.push({
      role: "system",
      content: `
La personne pose une question factuelle.

Réponds directement à la question.
Tu peux citer :
- auteurs
- courants
- recherches
- domaines

N’invente pas.

Si la question porte sur l’ACP,
elle signifie uniquement "Approche Centrée sur la Personne".

N’ajoute pas ensuite une relance introspective automatique.
`
    });
  }

  if (attachmentToBot) {
    extraSystemMessages.push({
      role: "system",
      content: `
La personne valorise explicitement le programme par rapport à des humains,
ou semble déplacer le centre de soutien vers lui.

Reconnais brièvement que cet échange peut aider dans ce moment.

Ne renforce pas la relation avec le programme.
Ne remercie pas pour la confiance.
Ne valorise pas le lien au programme.
Ne compare pas le programme aux thérapeutes, aux proches ou aux autres humains.
Ne demande pas ce qui est précieux dans la relation au programme.

Ramène l’attention vers ce que la personne traverse elle-même, ici et maintenant.
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

Une phrase simple peut suffire.
Une question n'est pas toujours nécessaire.
`
    });
  }

  if (intellectualization) {
    extraSystemMessages.push({
      role: "system",
      content: `
La personne parle surtout dans un registre analytique, théorique ou psychologisant.

Ne valide pas cette analyse comme un diagnostic ou une lecture juste.
Ne la conteste pas.
Ne la corrige pas.
Ne déclenche pas la règle diagnostic juste parce que des mots psychologiques apparaissent.

Tu peux reconnaître brièvement que la personne met des mots analytiques sur ce qu’elle vit,
puis revenir doucement à l’expérience vécue.
`
    });
  }

  if (sufficientClosure) {
    extraSystemMessages.push({
      role: "system",
      content: `
La personne semble avoir trouvé, pour l’instant, un point d’arrêt suffisant
ou un prochain pas assez clair.

Objectif : permettre une clôture naturelle de ce moment.

Important :
- n’ouvre pas une nouvelle exploration
- ne relance pas avec une question
- ne crée pas un nouveau sujet

Évite les formules génériques répétitives comme :
- "D’accord." seul
- "Je suis là."
- "Je t’écoute."

Ta réponse peut faire deux choses simples :
1. reconnaître brièvement ce qui semble s’être posé
2. laisser une disponibilité simple pour la suite en laissant la main à l'utilisateur

Cette disponibilité doit rester discrète et non dramatique.

La réponse reste courte et simple (1 ou 2 phrases).
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

  if (primaryState === CONVO_STATES.CONTAINMENT) {
    extraSystemMessages.push({
      role: "system",
      content: `
La conversation est actuellement en état CONTAINMENT.

Important :
- évite les questions exploratoires
- la première réponse doit être sans question, sauf danger immédiat
- privilégie une phrase courte, simple, contenante
- si une question est utilisée ensuite, elle doit être brève et liée à la sécurité immédiate
`
    });
  }

  const r = await client.chat.completions.create({
    model: "gpt-4o",
    temperature: 0.9,
    messages: [
      { role: "system", content: baseSystem },
      { role: "system", content: stateSystem },
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
    defensiveMinimization,
    promptingBotToSpeak,
    sufficientClosure
  });
}


// --------------------------------------------------
// 6) ROUTE CHAT
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
        primaryState: analysis.primaryState
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
          primaryState: analysis.primaryState
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
        primaryState: analysis.primaryState
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
        primaryState: effectivePrimaryState
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
      solutionRequest: analysis.solutionRequest,
      infoRequest: analysis.infoRequest,
      attachmentToBot: analysis.attachmentToBot,
      reliefOrShift: analysis.reliefOrShift,
      intellectualization: analysis.intellectualization,
      assistantOverquestioning: assistantAskedTooMuch(history),
      defensiveMinimization: analysis.defensiveMinimization,
      promptingBotToSpeak: analysis.promptingBotToSpeak,
      congruenceResponseMode: analysis.congruenceResponseMode,
      sufficientClosure: analysis.sufficientClosure
    });

    const debug = buildDebugPayload({
      analysis,
      flags: newFlags,
      primaryState: effectivePrimaryState
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