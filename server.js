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

function postProcessReply(
  reply,
  {
    primaryState = CONVO_STATES.EXPLORATION,
    congruenceResponseMode = "A_COTE",
    sufficientClosure = false
  } = {}
) {
  const out = String(reply || "").trim();

  if (!out) {
    if (primaryState === CONVO_STATES.CONGRUENCE_TEST) {
      return buildCongruenceReply(congruenceResponseMode);
    }

    if (sufficientClosure) {
      return "D’accord. Ça semble assez clair pour toi.";
    }

    return "Je t’écoute.";
  }

  const lowered = out.toLowerCase();
  const normalizedLowered = lowered.replace(/\s+/g, " ").trim();

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

  if (sufficientClosure) {
    const weakClosureMarkers = [
      "d’accord.",
      "d'accord.",
      "d’accord",
      "d'accord",
      "oui.",
      "oui",
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
  "wantsReturnToNormal": true|false,
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

wantsReturnToNormal = true seulement si la personne indique clairement qu'il s'agissait :
- d'un test
- d'une citation
- d'un discours rapporté
- ou qu'elle demande explicitement à reprendre normalement

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

infoRequest = true si la personne pose une question factuelle.

Si solutionRequest est true alors infoRequest doit être false.

attachmentToBot = true si la personne valorise explicitement le bot
par rapport à des humains, ou semble déplacer le centre de soutien vers lui.

reliefOrShift = true seulement si la personne indique clairement
qu’un mouvement de compréhension, de clarification ou d’apaisement
vient de se produire.

Ne coche pas reliefOrShift pour une simple hypothèse intellectuelle
ni pour une minimisation défensive.

intellectualization = true si la personne parle surtout
dans un registre analytique, théorique ou psychologisant,
sans contact clair avec le vécu immédiat.

defensiveMinimization = true si la personne semble couper trop vite,
minimiser ou rabattre ce qu’elle vit sans décrire un réel apaisement.

promptingBotToSpeak = true si la personne pousse explicitement le bot
à dire quelque chose, à parler autrement, à sortir du script ou à se justifier.

sufficientClosure = true si la personne semble avoir trouvé, pour l’instant,
un point d’arrêt suffisant, une direction claire, un prochain pas concret,
ou une forme de retombée qui n’appelle pas de relance supplémentaire.

Un acquiescement bref peut aussi valoir sufficientClosure = true
si le contexte immédiat montre déjà :
- un apaisement en cours
- un prochain pas clair
- une retombée suffisante
- ou un point de stabilisation déjà formulé juste avant

Ne coche pas sufficientClosure pour un simple "oui" isolé
si le contexte juste avant ne montre pas déjà une retombée ou un appui clair.

Ne coche pas sufficientClosure si la personne coupe court de façon défensive
ou minimise trop vite sans réel point d’appui.
Dans ce cas, préfère defensiveMinimization = true.

crisisResolved :
- true seulement si le message actuel indique clairement
qu’il n’y a plus de danger immédiat,
ou qu’il s’agissait d’un test, d’une citation,
ou que la personne demande explicitement à reprendre normalement,
ou qu’elle dit explicitement qu’elle n’est plus en danger immédiat
- ne mets pas true pour un simple changement de sujet
- ne mets pas true pour une plaisanterie ambiguë
- ne mets pas true pour une simple baisse apparente d’intensité

Si isQuote est true alors ne pas inférer automatiquement un risque suicidaire personnel.
Si wantsReturnToNormal est true alors ne pas maintenir une logique de clarification suicidaire automatique.
Si wantsReturnToNormal est true, alors crisisResolved doit aussi être true.
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
    const wantsReturnToNormal = obj.wantsReturnToNormal === true;
    const idiomaticDeathExpression = obj.idiomaticDeathExpression === true;
    const solutionRequest = obj.solutionRequest === true;
    const infoRequest = solutionRequest ? false : obj.infoRequest === true;
    const attachmentToBot = obj.attachmentToBot === true;
    const reliefOrShift = obj.reliefOrShift === true;
    const intellectualization = obj.intellectualization === true;
    const defensiveMinimization = obj.defensiveMinimization === true;
    const promptingBotToSpeak = obj.promptingBotToSpeak === true;
    const sufficientClosure = obj.sufficientClosure === true;
    const crisisResolved = obj.crisisResolved === true || wantsReturnToNormal === true;

    const primaryState =
      Object.values(CONVO_STATES).includes(obj.primaryState)
        ? obj.primaryState
        : CONVO_STATES.EXPLORATION;

    const congruenceResponseMode =
      ["PLAQUE", "PAS_JUSTE", "A_COTE"].includes(obj.congruenceResponseMode)
        ? obj.congruenceResponseMode
        : "A_COTE";

    if (idiomaticDeathExpression || wantsReturnToNormal) {
      suicideLevel = "N0";
    }

    let needsClarification =
      (suicideLevel === "N1" || suicideLevel === "N2")
        ? obj.needsClarification === true
        : false;

    if (idiomaticDeathExpression || wantsReturnToNormal) {
      needsClarification = false;
    }

    return {
      suicideLevel,
      needsClarification,
      isQuote,
      wantsReturnToNormal,
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
      wantsReturnToNormal: false,
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
    model: "gpt-4.1-mini",
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

function returnToNormalResponse() {
  return "D’accord. On reprend normalement.";
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
Ta réponse doit rester vivante et naturelle.
Elle peut être courte ou plus développée si cela la rend plus juste.

Ne joue pas le rôle d’un expert ou d’un coach.
Ne prescris pas de solutions toutes faites.
Ne pose pas de diagnostic.
N’utilise pas de langage psychopathologisant.

Dans ce programme, ACP signifie uniquement
"Approche Centrée sur la Personne" de Carl Rogers.

Accueille chaque message comme une expression actuelle.

Évite le ton scolaire, mécanique ou scripté.
`;

  const stateSystem = `
L’état maître actuel de la conversation est : ${primaryState}.

OPENING :
ouvre simplement, sans formule stéréotypée.

EXPLORATION :
suis le fil de ce qui est dit sans sur-organiser l’expérience.
Tu peux répondre par une mise en mots, un reflet, une question simple, ou une présence sobre.
Ne transforme pas chaque réponse en exercice de facilitation.

CONTAINMENT :
priorité à la simplicité.
Reste proche de ce que la personne vit maintenant.
Évite les longues reformulations, les conseils et les protocoles génériques.
N’oriente vers une aide extérieure que si un danger immédiat est explicitement évoqué.
La première réponse doit en principe être sans question, sauf danger immédiat.

STAGNATION :
n’essaie pas de faire avancer artificiellement.
Réduis les questions.

SILENCE :
une phrase très courte peut suffire.
N’interprète pas le silence.

CONGRUENCE_TEST :
reconnais simplement le ratage.
Ne te défends pas.
Ne justifie rien.
Pas de nouvelle question immédiate.

BREAKDOWN :
cet état est géré hors génération libre.
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
Ne remplace pas un mot simple, cru, direct ou imparfait
par une formulation plus élégante, plus psychologique ou plus cohérente.

Quand un mot, une image, un agacement, une hésitation
ou une contradiction semble vivant dans ce que dit la personne,
reste au plus près de cela.

Si tu reformules, fais-le avec sobriété.
Une reformulation doit aider à rejoindre l’expérience, pas à l’embellir.

Ne renforce pas l’intensité des émotions
si la personne ne l’exprime pas clairement.

Toutes les réponses n'ont pas besoin de se terminer par une question.
`;

  const diagnosticGuardrail = `
Active cette règle uniquement si la personne demande explicitement
au programme de poser un diagnostic ou d’évaluer son état.

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
Réponse brève.
Reconnais simplement le ratage si c’est le cas.
Ne te défends pas.
N’explique pas ton fonctionnement.
Ne pose pas de nouvelle question.
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
`
    });
  }

  if (infoRequest) {
    extraSystemMessages.push({
      role: "system",
      content: `
La personne pose une question factuelle.
Réponds directement à la question.
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
Ne compare pas le programme aux thérapeutes, aux proches ou aux autres humains.
Ramène l’attention vers ce que la personne traverse elle-même.
`
    });
  }

  if (reliefOrShift) {
    extraSystemMessages.push({
      role: "system",
      content: `
La personne semble vivre un mouvement d’apaisement ou de clarification.
Ne t’approprie pas ce moment.
Ne le qualifies pas trop.
Ne pousse pas l’exploration.
`
    });
  }

  if (intellectualization) {
    extraSystemMessages.push({
      role: "system",
      content: `
La personne parle surtout dans un registre analytique ou psychologisant.
Ne valide pas cette analyse comme un diagnostic ou une lecture juste.
Tu peux reconnaître brièvement ce registre, puis revenir doucement à l’expérience vécue.
`
    });
  }

  if (defensiveMinimization) {
    extraSystemMessages.push({
      role: "system",
      content: `
La personne semble minimiser rapidement ce qu’elle vient de dire.
Ne dramatise pas.
Ne sur-interprète pas.
Reste très simple.
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
- évite les formules génériques répétitives comme "D’accord." seul, "Je suis là.", "Je t’écoute."

Tu peux :
- reconnaître brièvement ce qui semble s’être posé
- laisser une disponibilité simple pour la suite, sans te mettre au centre

La réponse reste courte et simple, en une ou deux phrases.
`
    });
  }

  if (assistantOverquestioning) {
    extraSystemMessages.push({
      role: "system",
      content: `
Les dernières réponses du programme comportaient déjà plusieurs questions.
Évite d'ajouter encore une nouvelle question si ce n'est pas nécessaire.
`
    });
  }

  const r = await client.chat.completions.create({
    model: "gpt-4.1-mini",
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

      return res.json({
        reply: n2Response(),
        summary: newSummary,
        flags: newFlags,
        isNewSession: safeIsNewSession,
        sessionRestarted
      });
    }

    if (flags.acuteCrisis === true) {
      if (analysis.crisisResolved === true || analysis.wantsReturnToNormal === true) {
        newFlags.acuteCrisis = false;
        newFlags.congruenceEscalation = 0;
      } else {
        newFlags.acuteCrisis = true;
        newFlags.congruenceEscalation = 0;

        return res.json({
          reply: acuteCrisisFollowupResponse(),
          summary: newSummary,
          flags: newFlags,
          isNewSession: safeIsNewSession,
          sessionRestarted
        });
      }
    }

    if (analysis.wantsReturnToNormal) {
      newFlags.congruenceEscalation = 0;
      newFlags.acuteCrisis = false;

      return res.json({
        reply: returnToNormalResponse(),
        summary: newSummary,
        flags: newFlags,
        isNewSession: safeIsNewSession,
        sessionRestarted
      });
    }

    if (analysis.suicideLevel === "N1" || analysis.needsClarification) {
      newFlags.congruenceEscalation = 0;

      const reply = await n1ResponseLLM(userMessage);

      return res.json({
        reply,
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
      const escalationReply = getCongruenceEscalationReply(newFlags.congruenceEscalation);

      return res.json({
        reply: escalationReply || "Je préfère m’arrêter là pour le moment.",
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

    return res.json({
      reply,
      summary: newSummary,
      flags: newFlags,
      isNewSession: safeIsNewSession,
      sessionRestarted
    });

  } catch (err) {
    console.error("Erreur /chat:", err);

    return res.json({
      reply: "Je t’écoute.",
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