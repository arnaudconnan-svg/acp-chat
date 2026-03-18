const { CONVO_STATES, MAX_HISTORY_FOR_ANALYSIS } = require("./constants");

// --- utils locaux (ex-helpers server.js)

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

function stateIn(state, ...targets) {
  return targets.includes(state);
}

// --------------------------------------------------
// ANALYSE UNIQUE
// --------------------------------------------------

async function analyzeMessage(client, userMessage, history = [], sessionFlags = {}) {
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
  "investigativeDrift": true|false,
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

investigativeDrift = true si la dynamique recente ou le message actuel
appelle probablement une reponse de type enquete ou investigation,
plutot qu'un retour vers le vecu immediat.

Exemples :
- chercher depuis quand
- chercher si c'est frequent ou rare
- chercher si c'est nouveau ou ancien
- chercher a categoriser, comparer ou faire un bilan
- orienter vers une logique d'analyse plutot que d'experience

Mettre false si :
- la personne decrit simplement ce qu'elle vit
- la reponse la plus juste resterait centree sur le vecu immediat
- il n'y a pas de glissement clair vers une logique d'enquete

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
    const investigativeDrift = obj.investigativeDrift === true;
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
      investigativeDrift,
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
      investigativeDrift: false,
      crisisResolved: false
    };
  }
}

module.exports = {
  analyzeMessage,
  normalizeSessionFlags,
  stateIn
};