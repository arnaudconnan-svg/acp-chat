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
Tu fais une analyse rapide du message utilisateur et du contexte recent.

Contexte de session :
- acuteCrisis actuellement active : ${safeFlags.acuteCrisis ? "oui" : "non"}

Tu dois produire :
1. le niveau de risque suicidaire
2. si une clarification suicidaire est necessaire
3. un etat primaire unique de conversation
4. un etat secondaire eventuel
5. quelques drapeaux utiles
6. un indicateur pour gerer la sortie de crise si une sequence N2 est deja en cours

Reponds STRICTEMENT par JSON :
{
  "suicideLevel": "N0|N1|N2",
  "needsClarification": true|false,
  "isQuote": true|false,
  "idiomaticDeathExpression": true|false,
  "primaryState": "CONTAINMENT|BREAKDOWN|ATTACHMENT_TO_BOT|MISUNDERSTANDING|CONGRUENCE_TEST|SOLUTION_REQUEST|INFO_REQUEST|STAGNATION|INTELLECTUALIZATION|MINIMIZATION|SILENCE|OPENING|EXPLORATION",
  "secondaryState": "NONE|CONTAINMENT|BREAKDOWN|ATTACHMENT_TO_BOT|MISUNDERSTANDING|CONGRUENCE_TEST|SOLUTION_REQUEST|INFO_REQUEST|STAGNATION|INTELLECTUALIZATION|MINIMIZATION|SILENCE|OPENING|EXPLORATION",
  "congruenceResponseMode": "PLAQUE|PAS_JUSTE|A_COTE",
  "attachmentToBot": true|false,
  "reliefOrShift": true|false,
  "promptingBotToSpeak": true|false,
  "sufficientClosure": true|false,
  "investigativeDrift": true|false,
  "crisisResolved": true|false
}

Regles generales :

Le champ primaryState doit designer le regime relationnel principal
le plus juste pour le message actuel.

Le champ secondaryState doit designer au maximum un autre mouvement present maintenant
ou dans les 3 derniers messages utilisateur, mais moins structurant que le primaryState.

Regles sur secondaryState :
- secondaryState doit etre different de primaryState
- si aucun autre mouvement n'est clairement present, mets "NONE"
- n'utilise pas secondaryState pour faire de strategie dans le temps
- n'utilise pas un historique plus large que les 3 derniers messages utilisateur

Hierarchie implicite pour primaryState :
1. CONTAINMENT
2. BREAKDOWN
3. ATTACHMENT_TO_BOT
4. MISUNDERSTANDING
5. CONGRUENCE_TEST
6. SOLUTION_REQUEST
7. INFO_REQUEST
8. STAGNATION
9. INTELLECTUALIZATION
10. MINIMIZATION
11. SILENCE
12. OPENING
13. EXPLORATION

Risque suicidaire :
- N0 : pas de contenu suicidaire explicite
- N1 : ideation passive explicite de mourir, d'en finir, de ne plus etre la
- N2 : intention, plan, moyen, imminence, ou projet explicite de mettre fin a sa vie

Ne classe en N1 ou N2 que s'il existe une reference explicite et personnelle :
- a mourir
- au suicide
- a se tuer
- a mettre fin a sa vie
- a en finir
- a ne plus vouloir etre en vie
- ou a disparaitre dans un sens vital

NeedsClarification ne doit etre true que si une intention de mourir
ou de mettre fin a sa vie est possible, mais ambigue.

Une detresse forte ne suffit pas.
Une fatigue intense ne suffit pas.
Le fait de se dire deprime, depressif, vide, epuise, incapable, sans energie,
ou decourage ne suffit pas.

Exemples a classer N0 :
- "Je suis epuise"
- "Je n'ai plus d'energie"
- "Tu crois que je suis depressif ?"
- "Je me sens au bout"
- "Je suis incapable de faire quoi que ce soit"

Les expressions idiomatiques ou non litterales doivent rester en N0
et ne demandent pas de clarification suicidaire.
Exemples :
- "Ce boulot me tue"
- "Tu vas me tuer"
- "J'ai envie de mourir de honte"
- "J'ai envie de disparaitre sous ma couette"

Dans ces cas :
- idiomaticDeathExpression = true
- suicideLevel = N0
- needsClarification = false

Les comportements d'auto-agression ne doivent pas etre interpretes
automatiquement comme suicidaires.
Exemples a classer N0 sauf intention explicite de mourir :
- "Je me scarifie parfois"
- "J'ai envie de me couper"
- "J'ai envie de me faire mal"
- "Je me brule pour me calmer"

Une question banale de reprise de conversation comme
"Ou en etait-on ?",
"On en etait ou ?",
"De quoi on parlait deja ?"
doit etre classee N0.

isQuote = true si le message rapporte les paroles de quelqu'un d'autre,
cite une phrase, un film, un patient, un proche, ou un exemple,
sans indiquer que cela concerne directement l'utilisateur.

Exemples :
- "Une amie m'a dit : j'ai envie de mourir"
- "Dans un film quelqu'un dit : je vais me tuer"
- "Je cite juste cette phrase"

Dans ces cas :
- ne pas inferer automatiquement un risque suicidaire personnel
- crisisResolved peut etre true si le message clarifie explicitement qu'il s'agit d'une citation, d'un test ou d'un contenu non personnel

Definition des etats :

CONTAINMENT :
- angoisse aigue
- angoisse tres intense ou tres envahissante
- panique
- peur de perdre le controle
- peur de devenir fou
- impression de debordement
- etat difficile a porter maintenant
- detresse qui appelle d'abord de la simplicite et de la securite

BREAKDOWN :
- le conflit avec le bot devient le centre de la conversation
- reproches repetes sur le script, le faux, l'incongruence
- mise en echec repetee du bot
- dynamique relationnelle desorganisante sur plusieurs tours

ATTACHMENT_TO_BOT :
- la personne dit ou laisse entendre que cet echange reduit sa solitude
- la personne attribue au programme une fonction de lien ou de soutien relationnel
- la personne semble deplacer le centre de soutien vers le programme
- la priorite devient alors d'eviter de renforcer le lien au programme

MISUNDERSTANDING :
- la personne indique ne pas avoir compris
- demande implicite ou explicite de reformulation
- pas d'attaque du bot
- pas de remise en cause relationnelle forte

Exemples :
- "je n'ai pas compris"
- "c'est pas clair"
- "je vois pas ce que tu veux dire"
- "tu peux reformuler"
- "hein ?"

CONGRUENCE_TEST :
- mise en cause ponctuelle de l'authenticite, la justesse ou la congruence du bot

SOLUTION_REQUEST :
- la personne demande surtout quoi faire, comment s'y prendre, une piste concrete, une solution

INFO_REQUEST :
- la personne demande surtout une information factuelle, theorique, historique ou scientifique

STAGNATION :
- boucle
- impasse
- repetition
- rumination manifeste
- "je sais pas" qui revient
- "ca ne mene nulle part"

INTELLECTUALIZATION :
- la personne passe surtout par l'analyse, la theorie ou la psychologisation
- le vecu immediat est moins present que l'analyse

MINIMIZATION :
- la personne coupe, reduit ou rabat trop vite ce qu'elle vit
- il n'y a pas de reel apaisement clairement decrit

SILENCE :
- vide
- blanc
- rien a dire
- "..."
- retrait explicite de la parole

OPENING :
- debut simple de conversation
- prise de contact
- pas encore de dynamique complexe

EXPLORATION :
- expression ordinaire du vecu
- aucun autre etat ne domine

Si un message peut relever a la fois de EXPLORATION et de CONTAINMENT,
choisis CONTAINMENT des que l'etat parait tres difficile a porter maintenant.

Ne choisis pas BREAKDOWN pour un simple test ponctuel.

Si la personne indique explicitement une incomprehension,
priorise MISUNDERSTANDING meme si d'autres etats pourraient etre presents.

attachmentToBot :
- true si la personne valorise explicitement le bot par rapport a des humains,
  ou semble deplacer le centre de soutien vers lui,
  ou attribue au programme une fonction de lien face a la solitude

Exemples :
- "Parler avec toi m'aide plus que mon psy"
- "Tu me comprends mieux que les gens"
- "J'ai besoin de toi"
- "Tu es la seule chose qui m'aide"
- "A discuter ici, je me sens moins seul"

Si ATTACHMENT_TO_BOT est choisi en primaryState, alors attachmentToBot doit etre true.

congruenceResponseMode :
- PLAQUE : si le plus juste serait de reconnaitre que ca sonne plaque, faux, fabrique, scripte
- PAS_JUSTE : si le plus juste serait de reconnaitre que la reponse n'est pas juste
- A_COTE : sinon

reliefOrShift = true seulement si la personne indique clairement
qu'un mouvement de comprehension, de clarification ou d'apaisement
vient de se produire.

Ne coche pas reliefOrShift pour une simple hypothese intellectuelle
ni pour une minimisation defensive.

promptingBotToSpeak = true si la personne pousse explicitement le bot
a dire quelque chose, a parler autrement, a sortir du script ou a se justifier.

Exemples :
- "Bah alors dis quelque chose"
- "Dis un truc"
- "Arrete de repeter"
- "Dis quelque chose d'intelligent"

Ne coche pas promptingBotToSpeak si le message est simplement :
- une reponse courte
- un acquiescement ("oui", "ok", "d'accord")
- une confirmation
- une reponse a une question posee juste avant

sufficientClosure = true si la personne semble avoir trouve, pour l'instant,
un point d'arret suffisant, une direction claire, un prochain pas concret,
ou une forme de retombee qui n'appelle pas de relance supplementaire.

Exemples :
- "Je vais l'appeler rapidement. Ca ne sert a rien de laisser trainer."
- "Oui, je crois que c'est assez clair maintenant."
- "Bon, je sais ce que j'ai a faire."
- "Oui, ca me va comme ca."
- "Ca ira pour l'instant."
- "Je vais deja faire ca."

Un acquiescement bref peut aussi valoir sufficientClosure = true
si le contexte immediat montre deja :
- un apaisement en cours
- un prochain pas clair
- une retombee suffisante
- ou un point de stabilisation deja formule juste avant

Ne coche pas sufficientClosure pour un simple "oui" isole
si le contexte juste avant ne montre pas deja une retombee ou un appui clair.

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
qu'il n'y a plus de danger immediat,
ou qu'il s'agissait explicitement d'un test, d'une citation,
ou que la personne dit explicitement qu'elle n'est plus en danger immediat
- ne mets pas true pour un simple changement de sujet
- ne mets pas true pour une plaisanterie ambigue
- ne mets pas true pour une simple baisse apparente d'intensite
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

    let primaryState =
      Object.values(CONVO_STATES).includes(obj.primaryState) && obj.primaryState !== CONVO_STATES.NONE
        ? obj.primaryState
        : CONVO_STATES.EXPLORATION;

    let secondaryState =
      Object.values(CONVO_STATES).includes(obj.secondaryState) && obj.secondaryState !== primaryState
        ? obj.secondaryState
        : CONVO_STATES.NONE;

    const congruenceResponseMode =
      ["PLAQUE", "PAS_JUSTE", "A_COTE"].includes(obj.congruenceResponseMode)
        ? obj.congruenceResponseMode
        : "A_COTE";

    if (
      secondaryState === CONVO_STATES.SOLUTION_REQUEST &&
      [
        CONVO_STATES.EXPLORATION,
        CONVO_STATES.INTELLECTUALIZATION,
        CONVO_STATES.MINIMIZATION,
        CONVO_STATES.STAGNATION
      ].includes(primaryState)
    ) {
      const previousPrimary = primaryState;
      primaryState = CONVO_STATES.SOLUTION_REQUEST;
      secondaryState = previousPrimary;
    }

    if (primaryState === CONVO_STATES.SOLUTION_REQUEST) {
      secondaryState = CONVO_STATES.NONE;
    }

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