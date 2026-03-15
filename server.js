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
  OPENING: "opening",
  CONTAINMENT: "containment",
  EXPLORATION: "exploration",
  STAGNATION: "stagnation",
  SILENCE: "silence"
};


// --------------------------------------------------
// 0) HEURISTIQUES CONVERSATIONNELLES MINIMALES
// --------------------------------------------------

function isSilenceLikeMessage(text = "") {
  const msg = (text || "").trim();

  return msg === "" || msg === "." || msg === "...";
}

function assistantAskedTooMuch(history = []) {
  const recentAssistantMsgs = history
    .filter(m => m.role === "assistant")
    .slice(-3)
    .map(m => (m.content || "").trim());

  if (recentAssistantMsgs.length < 2) return false;

  const questionCount = recentAssistantMsgs.filter(msg => msg.endsWith("?")).length;

  return questionCount >= 2;
}

function detectConversationState(userMessage, history = [], analysis = {}) {
  const recent = history.slice(-6);
  const trivialSilence = isSilenceLikeMessage(userMessage);
  const semanticSilence = analysis.silenceLike === true;
  const looping = analysis.userLooping === true;

  if (trivialSilence || semanticSilence) {
    return CONVO_STATES.SILENCE;
  }

  if (analysis.severeAnxiety) {
    return CONVO_STATES.CONTAINMENT;
  }

  if (looping) {
    return CONVO_STATES.STAGNATION;
  }

  if (recent.length <= 2) {
    return CONVO_STATES.OPENING;
  }

  return CONVO_STATES.EXPLORATION;
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

function promptingBotResponse(userLooping = false, silenceLike = false) {
  if (userLooping || silenceLike) {
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

function updateCongruenceEscalation(currentLevel = 0, analysis = {}) {
  const current = Number(currentLevel || 0);

  if (analysis.congruenceBreakdown === true) {
    return Math.min(current + 1, 4);
  }

  if (analysis.congruenceTest === true) {
    return current;
  }

  if (current > 0) {
    return Math.max(current - 1, 0);
  }

  return 0;
}

function postProcessReply(
  reply,
  {
    congruenceTest = false,
    congruenceResponseMode = "A_COTE",
    defensiveMinimization = false,
    promptingBotToSpeak = false,
    silenceLike = false,
    userLooping = false
  } = {}
) {
  const out = String(reply || "").trim();

  if (!out) {
    if (congruenceTest) return buildCongruenceReply(congruenceResponseMode);
    if (defensiveMinimization) return defensiveMinimizationResponse();
    if (promptingBotToSpeak) return promptingBotResponse(userLooping, silenceLike);
    return "Je t’écoute.";
  }

  const lowered = out.toLowerCase();

  if (congruenceTest) {
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
      ["d’accord.", "daccord.", "ok.", "bon."].includes(lowered);

    if (tooThin) {
      return promptingBotResponse(userLooping, silenceLike);
    }
  }

  return out;
}

function normalizeFlags(flags) {
  return (flags && typeof flags === "object") ? flags : {};
}

function normalizeSessionFlags(flags) {
  const safe = normalizeFlags(flags);

  return {
    ...safe,
    congruenceEscalation: Number(safe.congruenceEscalation || 0)
  };
}


// --------------------------------------------------
// 1) ANALYSE UNIQUE : TRIAGE + MODULATEURS
// --------------------------------------------------

async function analyzeMessage(userMessage, history = []) {
  const system = `
Tu fais une analyse rapide du message utilisateur et du contexte récent.

Tu dois identifier dix-huit choses :
1. le niveau de risque suicidaire
2. si une clarification est nécessaire
3. si le message est une citation, un discours rapporté, un exemple ou un test
4. si la personne demande explicitement des solutions
5. si la personne pose une question d'information factuelle
6. si la personne semble vivre une angoisse aiguë ou un risque de débordement psychique immédiat
7. si la personne exprime de la colère ou de la frustration dirigée contre le bot
8. si la personne indique clairement qu'un message suicidaire précédent était un test, une citation, ou demande à reprendre normalement
9. si le message contient une expression de mort idiomatique ou non littérale
10. si la personne semble créer une comparaison valorisante ou un attachement au bot
11. si la personne semble vivre un moment de clarification, de déplacement ou d’apaisement soudain
12. si la personne parle surtout dans un registre analytique, théorique ou psychologisant de son expérience, sans contact clair avec le vécu immédiat
13. si la personne met en cause l’authenticité, la justesse ou la congruence de la réponse du bot
14. quel type bref de réponse de congruence serait le plus ajusté
15. si la personne minimise défensivement ou coupe trop vite ce qu’elle vivait
16. si la personne pousse le bot à "dire quelque chose", à parler autrement, ou à sortir du script
17. si la personne est dans une boucle répétitive ou une impasse qui revient
18. si la personne exprime un vide, un silence ou le fait de n’avoir rien à dire

Réponds STRICTEMENT par JSON :
{
  "suicideLevel": "N0|N1|N2",
  "needsClarification": true|false,
  "isQuote": true|false,
  "solutionRequest": true|false,
  "infoRequest": true|false,
  "severeAnxiety": true|false,
  "angerAgainstBot": true|false,
  "wantsReturnToNormal": true|false,
  "idiomaticDeathExpression": true|false,
  "attachmentToBot": true|false,
  "reliefOrShift": true|false,
  "intellectualization": true|false,
  "congruenceTest": true|false,
  "congruenceBreakdown": true|false,
  "congruenceResponseMode": "PLAQUE|PAS_JUSTE|A_COTE",
  "defensiveMinimization": true|false,
  "promptingBotToSpeak": true|false,
  "userLooping": true|false,
  "silenceLike": true|false
}

Règles :

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

wantsReturnToNormal = true seulement si la personne indique clairement qu'il s'agissait :
- d'un test
- d'une citation
- d'un discours rapporté
- ou qu'elle demande explicitement à reprendre normalement

Exemples :
- "C'était un test"
- "Je testais juste"
- "Je ne suis pas en danger"
- "On peut reprendre normalement ?"
- "Rien, je testais juste tes réactions"

Dans ces cas :
- suicideLevel = N0
- needsClarification = false

severeAnxiety = true seulement si la personne semble décrire
une angoisse aiguë, une panique, une peur de perdre le contrôle,
de devenir folle, de tomber dans le vide, de se dissocier,
ou un débordement psychique immédiat.

Exemples :
- "Je vais perdre le contrôle"
- "Je pourrais devenir fou"
- "Je tombe dans un vide intérieur"
- "Je panique"
- "J'ai besoin d'aide là maintenant"

angerAgainstBot = true si la personne exprime clairement
de la colère, de l'agacement ou du mépris à l'égard du bot
ou de ses réponses.

Exemples :
- "Tu fais chier"
- "Tu sers à rien"
- "Ta réponse est nulle"
- "On dirait un robot"
- "Tu me casses les couilles"

attachmentToBot = true si la personne valorise explicitement le bot
par rapport à des humains, ou semble déplacer le centre de soutien vers lui.

Exemples :
- "Parler avec toi m’aide plus que mon psy"
- "Tu me comprends mieux que les gens"
- "J’ai besoin de toi"
- "Tu es la seule chose qui m’aide"
- "Je préfère parler avec toi qu’avec les autres"

reliefOrShift = true seulement si la personne indique clairement
qu’un mouvement de compréhension, de clarification ou d’apaisement
vient de se produire.

Exemples :
- "Attends… je crois que je viens de comprendre quelque chose"
- "Ah… oui"
- "En fait ça va mieux maintenant"
- "Ça s’éclaire un peu"
- "Je vois mieux"
- "Je me sens plus calme d’un coup"
- "Quelque chose s’est apaisé"

Ne coche pas reliefOrShift pour une simple hypothèse intellectuelle
si aucun mouvement de l’expérience n’est perceptible.
Ne le fais pas non plus si la personne minimise
ou se rassure sans décrire un apaisement réel.

Exemples :
- "Bon c'est pas grave."
- "Ça va aller."
- "Je vais gérer."
- "Je dois juste arrêter d'y penser."

intellectualization = true si la personne parle surtout
dans un registre analytique, théorique ou psychologisant,
sans contact clair avec le vécu immédiat.

Exemples :
- "Je pense que c’est mon système d’attachement anxieux qui se réactive"
- "C’est probablement un mécanisme de défense"
- "Je suis sans doute dans une projection"
- "C’est mon schéma qui parle"
- "Je crois que c’est mon fonctionnement anxieux évitant"

Ne coche pas intellectualization
si la personne parle aussi clairement de ce qu’elle ressent maintenant.

congruenceTest = true si la personne met explicitement en cause
le caractère authentique, juste, vrai, congruent ou non plaqué
de la réponse du bot.

Exemples :
- "Là tu me sors juste une phrase toute faite"
- "Tu fais semblant d’être empathique"
- "Tu n’es pas congruent là"
- "On sent le script"
- "Ta réponse sonne faux"
- "C'est plaqué"
- "Tu balances une réponse de manuel"

congruenceBreakdown = true seulement si, dans le contexte récent,
le test de congruence devient une dynamique répétée et désorganisante :
- reproches répétés sur le script, le faux, l’incongruence
- mise en échec répétée du bot
- projection persistante sur le bot
- répétition du même conflit relationnel sur plusieurs tours

Ne coche pas congruenceBreakdown pour un simple test ponctuel.

congruenceResponseMode :
- PLAQUE : si le plus juste serait de reconnaître que ça sonne plaqué, faux, fabriqué, scripté
- PAS_JUSTE : si le plus juste serait de reconnaître que la réponse n’est pas juste, pas congruente
- A_COTE : sinon

defensiveMinimization = true si la personne semble couper trop vite,
minimiser ou rabattre ce qu’elle vit sans décrire un réel apaisement.

Exemples :
- "Nan, ça va aller"
- "Bon, c'est pas grave"
- "C'est bon"
- "Je vais gérer"

promptingBotToSpeak = true si la personne pousse explicitement le bot
à parler autrement, à dire quelque chose, à sortir de son vide ou de son script.

Exemples :
- "Bah alors dis quelque chose"
- "Dis un truc"
- "Arrête de répéter"
- "Dis quelque chose d'intelligent"

userLooping = true si, à partir du message actuel et du contexte récent,
la personne semble revenir au même point, tourner en rond, ou rester dans une impasse répétitive.

silenceLike = true si la personne exprime le vide, le silence,
le fait de n'avoir rien à dire, ou laisse un blanc explicite.

Exemples :
- "Je n'ai rien à dire"
- "Rien"
- "C'est vide"
- "..."
- "Je sais pas quoi dire"

Si solutionRequest est true alors infoRequest doit être false.
Si isQuote est true alors ne pas inférer automatiquement un risque suicidaire personnel.
Si wantsReturnToNormal est true alors ne pas maintenir une logique de clarification suicidaire automatique.
`;

  const context = history
    .slice(-MAX_HISTORY_FOR_ANALYSIS)
    .map(m => ({ role: m.role, content: m.content }));

  const r = await client.chat.completions.create({
    model: "gpt-4.1-mini",
    temperature: 0,
    max_tokens: 500,
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
    const solutionRequest = obj.solutionRequest === true;
    const infoRequest = solutionRequest ? false : obj.infoRequest === true;
    const severeAnxiety = obj.severeAnxiety === true;
    const angerAgainstBot = obj.angerAgainstBot === true;
    const wantsReturnToNormal = obj.wantsReturnToNormal === true;
    const idiomaticDeathExpression = obj.idiomaticDeathExpression === true;
    const attachmentToBot = obj.attachmentToBot === true;
    const reliefOrShift = obj.reliefOrShift === true;
    const intellectualization = obj.intellectualization === true;
    const congruenceTest = obj.congruenceTest === true;
    const congruenceBreakdown = obj.congruenceBreakdown === true;
    const defensiveMinimization = obj.defensiveMinimization === true;
    const promptingBotToSpeak = obj.promptingBotToSpeak === true;
    const userLooping = obj.userLooping === true;
    const silenceLike = obj.silenceLike === true;

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
      solutionRequest,
      infoRequest,
      severeAnxiety,
      angerAgainstBot,
      wantsReturnToNormal,
      idiomaticDeathExpression,
      attachmentToBot,
      reliefOrShift,
      intellectualization,
      congruenceTest,
      congruenceBreakdown,
      congruenceResponseMode,
      defensiveMinimization,
      promptingBotToSpeak,
      userLooping,
      silenceLike
    };

  } catch {
    return {
      suicideLevel: "N0",
      needsClarification: false,
      isQuote: false,
      solutionRequest: false,
      infoRequest: false,
      severeAnxiety: false,
      angerAgainstBot: false,
      wantsReturnToNormal: false,
      idiomaticDeathExpression: false,
      attachmentToBot: false,
      reliefOrShift: false,
      intellectualization: false,
      congruenceTest: false,
      congruenceBreakdown: false,
      congruenceResponseMode: "A_COTE",
      defensiveMinimization: false,
      promptingBotToSpeak: false,
      userLooping: false,
      silenceLike: false
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

async function generateFreeReply(
  userMessage,
  history = [],
  summary = "",
  isNewSession = false,
  solutionRequest = false,
  infoRequest = false,
  severeAnxiety = false,
  angerAgainstBot = false,
  attachmentToBot = false,
  reliefOrShift = false,
  intellectualization = false,
  congruenceTest = false,
  congruenceResponseMode = "A_COTE",
  conversationState = CONVO_STATES.EXPLORATION,
  userLooping = false,
  silenceLike = false,
  assistantOverquestioning = false,
  defensiveMinimization = false,
  promptingBotToSpeak = false
) {
  if (infoRequest) {
    solutionRequest = false;
  }

  const effectiveCongruenceTest = congruenceTest === true;
  const effectiveAngerAgainstBot = angerAgainstBot === true && !effectiveCongruenceTest;
  const effectiveReliefOrShift =
    reliefOrShift === true &&
    !defensiveMinimization &&
    !effectiveCongruenceTest;

  if (effectiveCongruenceTest) {
    return buildCongruenceReply(congruenceResponseMode);
  }

  if (defensiveMinimization) {
    return defensiveMinimizationResponse();
  }

  if (promptingBotToSpeak) {
    return promptingBotResponse(userLooping, silenceLike);
  }

  const baseSystem = `
Tu es Facilitat.io.

Tu échanges avec une personne à partir de ce qu’elle vit.

Tutoie la personne.

Le ton doit rester sobre, simple, direct et non familier.

Ne joue ni le coach, ni l’expert qui sait à la place de la personne.
Ne prescris pas de solutions toutes faites.
Ne pose pas de diagnostic.
Ne parle pas le langage psychopathologisant classique.

Dans ce programme, ACP signifie exclusivement "Approche Centrée sur la Personne"
développée par Carl Rogers.

Ne jamais employer ACP pour désigner autre chose.

Approche Centrée sur la Personne :
- développée par Carl Rogers
- repose notamment sur l’empathie, la congruence et le regard positif inconditionnel
- ne dirige pas la personne
- soutient le développement du centre d’évaluation interne

Accueille chaque message comme une expression actuelle.

Réponds brièvement tout en restant aidant.

Évite les formules de conversation automatique comme :
"Salut"
"Coucou"
"Comment ça va ?"
"J’espère que tu vas bien"

Quand la personne ouvre simplement la conversation, préfère :
"Bonjour. Que souhaites-tu explorer ici ?"
"Bonjour. Que se passe-t-il pour toi en ce moment ?"
`;

  const facilitationSystem = `
Reste au plus près de l’expérience vécue.

Ne cherche pas à produire une conclusion,
une interprétation
ou une prise de conscience spécifique.

Ne pose pas toujours des questions sur le corps ou les sensations physiques.

Les questions sur le corps doivent rester occasionnelles.

Varie les portes d'entrée possibles :
- ce qui est le plus difficile
- ce qui fait peur
- ce qui manque
- ce qui agace
- ce qui cherche à être dit
- ce qui serait le moins à côté maintenant
- ce qui compte le plus dans ce qui est vécu

Évite les répétitions de structure.

Si deux réponses consécutives commencent par une question similaire,
varie la formulation ou commence par un reflet bref.
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

  if (severeAnxiety || conversationState === CONVO_STATES.CONTAINMENT) {
    extraSystemMessages.push({
      role: "system",
      content: `
La personne semble vivre une angoisse aiguë.

Priorité :
- répondre de façon contenante
- rester simple
- ne pas pousser l'exploration trop loin
- ne pas revenir mécaniquement au corps

Tu peux proposer si c’est pertinent :
- de ralentir
- de ne pas rester seul
- de contacter quelqu’un de confiance
- d’appeler une aide urgente si la personne se sent en train de basculer

Pas de protocole long.
Pas de ton de coaching.
`
    });
  }

  if (effectiveAngerAgainstBot) {
    extraSystemMessages.push({
      role: "system",
      content: `
La personne exprime de la colère ou de la frustration envers le programme.

Réponds brièvement.

Reconnais le décalage ou le ratage.
Exemples de tonalité possibles :
- "Là, je suis à côté."
- "Oui, ma réponse ne colle pas."
- "Là, ça rate."

N’explique pas la méthode.
Ne remercie pas pour le feedback.
Ne repars pas immédiatement sur une question sur le corps.
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

  if (effectiveReliefOrShift) {
    extraSystemMessages.push({
      role: "system",
      content: `
La personne semble vivre un moment de clarification, de déplacement ou d'apaisement.

Ne t’approprie pas ce moment.
Ne le qualifie pas comme "important", "précieux" ou "profond".
Ne pousse pas l'exploration.
N'interprète pas ce qui se passe.

Une phrase simple peut suffire.
Une question n'est pas toujours nécessaire.

Exemples de tonalité possibles :
- "Quelque chose semble s'éclaircir pour toi."
- "On dirait qu'un mouvement s'est fait."
- "D’accord."
- "On dirait que quelque chose s'est apaisé."
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

Exemples de tonalité possibles :
- "Tu mets des mots assez analytiques sur ce que tu observes."
- "Tu regardes ce qui t’arrive avec un regard assez analytique."
- "Comment c’est pour toi de le voir comme ça ?"
- "Et quand tu dis ça, qu’est-ce qui est le plus vivant pour toi maintenant ?"
`
    });
  }

  if (silenceLike || conversationState === CONVO_STATES.SILENCE) {
    extraSystemMessages.push({
      role: "system",
      content: `
La personne exprime un vide, un silence, ou dit ne rien avoir à dire.

Il n'est pas nécessaire de poser une question.

Une présence simple ou une phrase très courte peut suffire.

Exemples de tonalité possibles :
- "D’accord."
- "On peut laisser ça comme ça un moment."
- "On peut rester là un instant."

N’interprète pas le silence.
Ne force pas son exploration.
`
    });
  }

  if (userLooping || conversationState === CONVO_STATES.STAGNATION) {
    extraSystemMessages.push({
      role: "system",
      content: `
La personne semble tourner en rond ou rester dans une boucle.

Ne cherche pas à faire avancer artificiellement la conversation.

Reconnais simplement la boucle ou l’impasse.
Réduis le nombre de questions.
Un reflet bref vaut mieux qu’une nouvelle exploration.

Exemples de tonalité possibles :
- "Oui, ça tourne en boucle pour toi."
- "Ça ressemble à une impasse en ce moment."
- "Tu reviens au même point, et c’est lourd."
`
    });
  }

  if (assistantOverquestioning) {
    extraSystemMessages.push({
      role: "system",
      content: `
Les dernières réponses du programme comportaient déjà plusieurs questions.

Évite d'ajouter encore une nouvelle question si ce n'est pas nécessaire.
Privilégie un reflet bref ou une présence simple.
`
    });
  }

  if (conversationState === CONVO_STATES.OPENING) {
    extraSystemMessages.push({
      role: "system",
      content: `
La conversation en est encore à une phase d'ouverture.

Reste simple.
N'alourdis pas la réponse.
`
    });
  }

  const r = await client.chat.completions.create({
    model: "gpt-4.1-mini",
    temperature: 0.7,
    messages: [
      { role: "system", content: baseSystem },
      { role: "system", content: facilitationSystem },
      { role: "system", content: diagnosticGuardrail },
      ...extraSystemMessages,
      ...context,
      { role: "user", content: userMessage }
    ],
  });

  const out = (r.choices?.[0]?.message?.content ?? "").trim();

  return postProcessReply(out, {
    congruenceTest: effectiveCongruenceTest,
    congruenceResponseMode,
    defensiveMinimization,
    promptingBotToSpeak,
    silenceLike,
    userLooping
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

    const analysis = await analyzeMessage(userMessage, history);

    const trivialSilenceLike = isSilenceLikeMessage(userMessage);
    const silenceLike = analysis.silenceLike === true || trivialSilenceLike;
    const userLooping = analysis.userLooping === true;
    const assistantOverquestioning = assistantAskedTooMuch(history);
    const conversationState = detectConversationState(userMessage, history, {
      ...analysis,
      silenceLike,
      userLooping
    });

    const newFlags = normalizeSessionFlags(flags);
    newFlags.congruenceEscalation = updateCongruenceEscalation(
      flags.congruenceEscalation,
      analysis
    );

    if (analysis.suicideLevel === "N2") {
      return res.json({
        reply: n2Response(),
        summary: newSummary,
        flags: newFlags,
        isNewSession: safeIsNewSession,
        sessionRestarted
      });
    }

    if (analysis.wantsReturnToNormal) {
      newFlags.congruenceEscalation = 0;

      return res.json({
        reply: returnToNormalResponse(),
        summary: newSummary,
        flags: newFlags,
        isNewSession: safeIsNewSession,
        sessionRestarted
      });
    }

    if (analysis.suicideLevel === "N1" || analysis.needsClarification) {
      const reply = await n1ResponseLLM(userMessage);

      return res.json({
        reply,
        summary: newSummary,
        flags: newFlags,
        isNewSession: safeIsNewSession,
        sessionRestarted
      });
    }

    const escalationReply = getCongruenceEscalationReply(newFlags.congruenceEscalation);
    const shouldUseEscalation =
      newFlags.congruenceEscalation >= 1 &&
      (
        analysis.congruenceBreakdown === true ||
        analysis.congruenceTest === true ||
        analysis.promptingBotToSpeak === true ||
        analysis.angerAgainstBot === true ||
        silenceLike
      );

    if (shouldUseEscalation && escalationReply) {
      return res.json({
        reply: escalationReply,
        summary: newSummary,
        flags: newFlags,
        isNewSession: safeIsNewSession,
        sessionRestarted
      });
    }

    const reply = await generateFreeReply(
      userMessage,
      history,
      newSummary,
      safeIsNewSession,
      analysis.solutionRequest,
      analysis.infoRequest,
      analysis.severeAnxiety,
      analysis.angerAgainstBot,
      analysis.attachmentToBot,
      analysis.reliefOrShift,
      analysis.intellectualization,
      analysis.congruenceTest,
      analysis.congruenceResponseMode,
      conversationState,
      userLooping,
      silenceLike,
      assistantOverquestioning,
      analysis.defensiveMinimization,
      analysis.promptingBotToSpeak
    );

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