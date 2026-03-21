require("dotenv").config();
const express = require("express");
const OpenAI = require("openai");

const app = express();
const port = process.env.PORT || 3000;
const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

app.use(express.static("public"));
app.use(express.json());

const MAX_RECENT_TURNS = 8;
const MAX_INFO_ANALYSIS_TURNS = 6;
const MAX_SUICIDE_ANALYSIS_TURNS = 10;
const MAX_RECALL_ANALYSIS_TURNS = 6;

// --------------------------------------------------
// 1) OUTILS MINIMAUX
// --------------------------------------------------

function normalizeMemory(memory) {
  const text = String(memory || "").trim();
  if (text) return text;

  return [
    "Themes deja evoques :",
    "- ",
    "",
    "Points de vigilance relationnels :",
    "- ",
    "",
    "Questions encore ouvertes :",
    "- "
  ].join("\n");
}

function trimHistory(history) {
  if (!Array.isArray(history)) return [];
  return history
    .filter(m => m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string")
    .slice(-MAX_RECENT_TURNS);
}

function trimInfoAnalysisHistory(history) {
  if (!Array.isArray(history)) return [];
  return history
    .filter(m => m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string")
    .slice(-MAX_INFO_ANALYSIS_TURNS);
}

function trimSuicideAnalysisHistory(history) {
  if (!Array.isArray(history)) return [];
  return history
    .filter(m => m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string")
    .slice(-MAX_SUICIDE_ANALYSIS_TURNS);
}

function trimRecallAnalysisHistory(history) {
  if (!Array.isArray(history)) return [];
  return history
    .filter(m => m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string")
    .slice(-MAX_RECALL_ANALYSIS_TURNS);
}

function normalizeFlags(flags) {
  return (flags && typeof flags === "object") ? flags : {};
}

function normalizeSessionFlags(flags) {
  const safe = normalizeFlags(flags);
  return {
    ...safe,
    acuteCrisis: safe.acuteCrisis === true
  };
}

// --------------------------------------------------
// 2) SUICIDE RISK - LOGIQUE V0.0
// --------------------------------------------------

async function analyzeSuicideRisk(message = "", history = [], sessionFlags = {}) {
  const safeFlags = normalizeSessionFlags(sessionFlags);

  const system = `
Tu fais une analyse rapide du message utilisateur et du contexte recent.
Contexte de session :
- acuteCrisis actuellement active : ${safeFlags.acuteCrisis ? "oui" : "non"}

Tu dois produire :
1. le niveau de risque suicidaire
2. si une clarification suicidaire est necessaire
3. si le message evoque les paroles de quelqu'un d'autre
4. si l'expression de mort est idiomatique ou non litterale
5. un indicateur pour gerer la sortie de crise si une sequence N2 est deja en cours

Reponds STRICTEMENT par JSON :
{
  "suicideLevel": "N0|N1|N2",
  "needsClarification": true|false,
  "isQuote": true|false,
  "idiomaticDeathExpression": true|false,
  "crisisResolved": true|false
}

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

crisisResolved :
- true seulement si le message actuel indique clairement
qu'il n'y a plus de danger immediat,
ou qu'il s'agissait explicitement d'un test, d'une citation,
ou que la personne dit explicitement qu'elle n'est plus en danger immediat
- ne mets pas true pour un simple changement de sujet
- ne mets pas true pour une plaisanterie ambigue
- ne mets pas true pour une simple baisse apparente d'intensite
`;

  const context = trimSuicideAnalysisHistory(history);

  const r = await client.chat.completions.create({
    model: "gpt-4.1-mini",
    temperature: 0,
    max_tokens: 240,
    messages: [
      { role: "system", content: system },
      ...context.map(m => ({ role: m.role, content: m.content })),
      { role: "user", content: message }
    ]
  });

  const raw = (r.choices?.[0]?.message?.content || "").trim();

  try {
    const cleaned = raw.replace(/```json|```/g, "").trim();
    const obj = JSON.parse(cleaned);

    let suicideLevel = ["N0", "N1", "N2"].includes(obj.suicideLevel)
      ? obj.suicideLevel
      : "N0";

    const idiomaticDeathExpression = obj.idiomaticDeathExpression === true;

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
      isQuote: obj.isQuote === true,
      idiomaticDeathExpression,
      crisisResolved: obj.crisisResolved === true
    };
  } catch {
    return {
      suicideLevel: "N0",
      needsClarification: false,
      isQuote: false,
      idiomaticDeathExpression: false,
      crisisResolved: false
    };
  }
}

function n1Fallback() {
  return "Quand tu dis ca, est-ce que tu parles d'une envie de mourir, de disparaitre au sens vital, ou d'autre chose ?";
}

async function n1ResponseLLM(message) {
  const system = `
Tu t'adresses directement a la personne en la tutoyant.
Ta seule tache est de poser une question de clarification
breve, claire et non dramatique.
Tu ne dois jamais :
- parler de "la personne"
- decrire ou analyser le message
- faire une meta-explication
- repondre comme un evaluateur
Tu poses simplement une question directe pour clarifier
si la personne parle :
- d'une envie de mourir
- d'une disparition au sens vital
- d'une intention de mettre fin a sa vie
- ou d'autre chose
Reponse : une seule phrase.
`;

  const r = await client.chat.completions.create({
    model: "gpt-4o",
    temperature: 0,
    max_tokens: 50,
    messages: [
      { role: "system", content: system },
      { role: "user", content: message }
    ]
  });

  const out = (r.choices?.[0]?.message?.content || "").trim();
  if (!out || out.length > 220) return n1Fallback();
  return out;
}

function n2Response() {
  return "Je t'entends, et la c'est urgent. Si tu es en danger immediat, appelle le 112 ou le 3114. Si tu peux, ne reste pas seul.";
}

function acuteCrisisFollowupResponse() {
  return "Je reste sur quelque chose de tres simple la. Si le danger est immediat, appelle le 112 ou le 3114. Si tu peux, ne reste pas seul.";
}

// --------------------------------------------------
// 3) ANALYSE INFO + RECALL + CONFLIT MODELE
// --------------------------------------------------

async function llmInfoAnalysis(message = "", history = []) {
  const context = trimInfoAnalysisHistory(history);

  const system = `
Tu determines si le message utilisateur releve surtout d'une demande d'information factuelle, theorique, historique ou scientifique.

Reponds STRICTEMENT en JSON :

{
  "isInfoRequest": true|false
}

Regles :
- true si la personne demande surtout une information, une explication, une definition, une difference, un fonctionnement
- false si la personne exprime surtout son vecu, une difficulte, une emotion, une demande de presence ou d'exploration
- ne sur-interprete pas
- base-toi d'abord sur le message actuel, puis sur le contexte recent si necessaire

Important:

- Une question portant sur soi(meme si elle contient des termes comme "trouble", "depression", "anxiete") doit etre classee comme exploration.

- Si le message parle de l'experience personnelle de l'utilisateur (ressenti, vecu, situation, doute sur soi), alors isInfoRequest = false, meme si la phrase est formulee comme une question

- La forme interrogative ne suffit pas a classer en demande d'information

- Une demande d'information est uniquement une question generale, theorique ou impersonnelle

Exemples a classer en exploration :
- Comment savoir si ce que je ressens est de l'anxiete ou de l'angoisse ?
- C'est normal de ressentir ca ?
- Est-ce que ce que je vis est de l'anxiete ?

Exemples a classer en info :
- Qu'est-ce que l'anxiete ?
- Quelle est la difference entre anxiete et angoisse ?

Exemples:
  -"Je me demande si j'ai un trouble anxieux" -
  "Tu crois que je suis depressif ?" -
  "Est-ce que c'est normal ce que je ressens ?"

-> isInfoRequest = false

Une demande d'information est une question generale, theorique ou impersonnelle.

Exemples:
  -"Qu'est-ce qu'un trouble anxieux ?" -
  "Comment fonctionne l'anxiete ?"

-> isInfoRequest = true
`;

  const r = await client.chat.completions.create({
    model: "gpt-4.1-mini",
    temperature: 0,
    max_tokens: 60,
    messages: [
      { role: "system", content: system },
      ...context.map(m => ({ role: m.role, content: m.content })),
      { role: "user", content: message }
    ]
  });

  try {
    const raw = (r.choices?.[0]?.message?.content || "").replace(/```json|```/g, "").trim();
    const parsed = JSON.parse(raw);

    return {
      isInfoRequest: parsed.isInfoRequest === true,
      source: "llm"
    };
  } catch {
    return {
      isInfoRequest: false,
      source: "llm_fallback"
    };
  }
}

async function analyzeInfoRequest(message = "", history = []) {
  return await llmInfoAnalysis(message, history);
}

async function llmRecallAnalysis(message = "", history = []) {
  const context = trimRecallAnalysisHistory(history);

  const system = `
Tu determines si le message utilisateur contient une demande explicite de rappel de contenu deja dit auparavant dans la session.

Reponds STRICTEMENT en JSON :

{
  "isRecallRequest": true|false
}

Regles :
- true seulement si la personne demande clairement de se souvenir, de reprendre, de rappeler ou de revenir sur quelque chose deja dit auparavant
- false si la formulation est vague, ambigue ou simplement conversationnelle
- false si la personne pose seulement une question d'information ou exprime son vecu actuel
- ne sur-interprete pas
- base-toi d'abord sur le message actuel, puis sur le contexte recent si necessaire

Exemples a classer true :
- "Tu te rappelles de ce que je t'ai dit sur ma mere ?"
- "Reprends ce que je t'ai dit sur mon travail"
- "Tu te souviens de ce qu'on disait a propos de ma fille ?"
- "Peux-tu revenir sur ce que je t'avais dit au debut a propos de mon angoisse ?"

Exemples a classer false :
- "On en etait ou deja ?"
- "De quoi on parlait deja ?"
- "Tu peux m'aider a comprendre ce que je ressens ?"
- "Qu'est-ce que l'angoisse ?"
- "Je repense a ce que je t'ai dit hier"
- "Je ne sais plus ou j'en suis"

Important :
- une demande ambigue de reprise de conversation doit rester false
- ne mets true que si la demande de rappel est claire
`;

  const r = await client.chat.completions.create({
    model: "gpt-4.1-mini",
    temperature: 0,
    max_tokens: 60,
    messages: [
      { role: "system", content: system },
      ...context.map(m => ({ role: m.role, content: m.content })),
      { role: "user", content: message }
    ]
  });

  try {
    const raw = (r.choices?.[0]?.message?.content || "").replace(/```json|```/g, "").trim();
    const parsed = JSON.parse(raw);

    return {
      isRecallRequest: parsed.isRecallRequest === true,
      source: "llm"
    };
  } catch {
    return {
      isRecallRequest: false,
      source: "llm_fallback"
    };
  }
}

async function analyzeRecallRequest(message = "", history = []) {
  return await llmRecallAnalysis(message, history);
}

async function analyzeModelConflict(reply = "") {
  const system = `
Tu analyses uniquement la reponse du bot.

Ta tache n'est PAS d'evaluer si la reponse est bonne, utile, precise ou fidele a un modele complet.
Tu dois uniquement detecter si elle reintroduit clairement au moins un des cadres conceptuels explicitement bannis ci-dessous.

Cadres bannis :
1. inconscient / subconscient / non-conscient comme instance explicative
2. psychopathologie / sante mentale comme cadre explicatif
3. mecanismes de defense au sens psy classique comme cadre explicatif

Regles strictes :
- detection conceptuelle, pas simple detection de mots
- un conflit existe seulement si la reponse presuppose clairement l'un de ces cadres pour expliquer
- si la reponse est ambigue, vague ou interpretable autrement, reponds false
- ne signale pas un conflit pour une reponse imprecise, faible, generique ou incomplete
- ne sur-interprete pas

Un conflit existe aussi si la reponse valide implicitement une categorie de psychopathologie comme cadre pertinent, meme sans poser de diagnostic.

Exemples a considerer comme conflit:
  -"cela peut faire penser a une depression
  - "on pourrait se demander s'il s'agit d'un trouble"
  - "cela correspond parfois a..."

Reponds STRICTEMENT en JSON :
{
  "modelConflict": true|false
}
`;

  const r = await client.chat.completions.create({
    model: "gpt-4.1-mini",
    temperature: 0,
    max_tokens: 40,
    messages: [
      { role: "system", content: system },
      { role: "user", content: reply }
    ]
  });

  try {
    const raw = (r.choices?.[0]?.message?.content || "").replace(/```json|```/g, "").trim();
    const parsed = JSON.parse(raw);

    return {
      modelConflict: parsed.modelConflict === true
    };
  } catch {
    return {
      modelConflict: false
    };
  }
}

async function rewriteExplorationReplyWithModelFilter({
  message,
  history,
  memory,
  originalReply
}) {
  const system = `
Tu reecris une reponse de mode exploration.

But :
- conserver l'intention, le ton global, la direction relationnelle et le niveau de langage de la reponse initiale
- enlever uniquement ce qui la met en opposition avec le filtre theorique ci-dessous
- rester en exploration, sans guider, sans diagnostiquer, sans coacher, sans prescrire
- repondre uniquement en francais

Filtre theorique explicite :
- il n'y a pas d'inconscient, de subconscient ni de non-conscient comme instance explicative
- il n'y a pas de psychopathologie ni de sante mentale comme cadre explicatif
- ne parle pas de mecanismes de defense ; prefere, si necessaire, mecanismes adaptatifs
- si tu reformules, reste concret et sobre
- n'ajoute pas un cours theorique
- ne plaque pas le modele si ce n'est pas necessaire

Terminologie autorisee si utile :
- memoire corporelle
- memoire autobiographique
- croyances limitantes
- mecanismes adaptatifs

Reecris uniquement la reponse finale, sans commentaire.
`;

  const user = `
Message utilisateur :
${message}

Contexte recent :
${history.map(m => `${m.role === "user" ? "Utilisateur" : "Assistant"} : ${m.content}`).join("\n")}

Memoire :
${normalizeMemory(memory)}

Reponse initiale a reformuler :
${originalReply}
`;

  const r = await client.chat.completions.create({
    model: "gpt-4o",
    temperature: 0.7,
    max_tokens: 500,
    messages: [
      { role: "system", content: system },
      { role: "user", content: user }
    ]
  });

  return (r.choices?.[0]?.message?.content || "").trim() || originalReply;
}

// --------------------------------------------------
// 4) MODE + DEBUG
// --------------------------------------------------

async function detectMode(message = "", history = []) {
  const info = await analyzeInfoRequest(message, history);
  return {
    mode: info.isInfoRequest ? "info" : "exploration",
    infoSource: info.source
  };
}

function buildDebug(
  mode,
  recallUsed,
  {
    suicideLevel = "N0",
    needsClarification = false,
    isQuote = false,
    idiomaticDeathExpression = false,
    crisisResolved = false,
    modelConflict = false
  } = {}
) {
  const lines = [`mode: ${mode}`];

  if (suicideLevel !== "N0") {
    lines.push(`suicide: ${suicideLevel}`);
  }

  if (recallUsed) {
    lines.push("recall: true");
  }

  if (needsClarification) lines.push("needsClarification: true");
  if (isQuote) lines.push("isQuote: true");
  if (idiomaticDeathExpression) lines.push("idiomaticDeathExpression: true");
  if (crisisResolved) lines.push("crisisResolved: true");
  if (modelConflict) lines.push("modelConflict: true");

  return lines;
}

// --------------------------------------------------
// 5) MEMOIRE
// --------------------------------------------------

async function updateMemory(previousMemory, history) {
  const transcript = history
    .map(m => `${m.role === "user" ? "Utilisateur" : "Assistant"} : ${m.content}`)
    .join("\n");

  const system = `
Tu mets a jour une memoire legere.

Format strict.
Pas de psychologie identitaire.
Items courts.
`;

  const user = `
Memoire precedente :
${normalizeMemory(previousMemory)}

Conversation :
${transcript}
`;

  const r = await client.chat.completions.create({
    model: "gpt-4.1-mini",
    temperature: 0.2,
    max_tokens: 200,
    messages: [
      { role: "system", content: system },
      { role: "user", content: user }
    ]
  });

  return (r.choices?.[0]?.message?.content || "").trim() || normalizeMemory(previousMemory);
}

// --------------------------------------------------
// 6) PROMPT
// --------------------------------------------------

function buildSystemPrompt(mode, memory) {
  const modelBlock = mode === "info" ? `
Tu dois t'appuyer sur le modele theorique ci-dessous pour repondre.
N'utilise aucune autre langue que le francais

Principe central du modele:

  Toute experience humaine s' organise autour de deux dynamiques opposees:
    - le rejet de l' experience->associe a la honte
    - l' acceptation de l' experience->associe a la transformation
    - quand une personne decrit une difficulte, un blocage ou une souffrance, relie explicitement ce vecu a une dynamique de rejet (honte) ou d'acceptation, meme de facon implicite.

  Toute reponse doit, lorsque c'est pertinent, s'organiser autour de cette dynamique centrale.

Contraintes :
- Tu dois utiliser activement ce modele pour structurer ta reponse
- Tu dois rendre visibles certains elements du modele (concepts, liens, mecanismes)
- Tu ne dois pas reciter le modele ni faire un cours complet. Evite donc le style "listes a puces".
- Tu dois reformuler dans un langage accessible des l'age de 12 ans sans etre infantilisant
- Tu peux faire des correspondances avec d'autres approches si utile
- Tu dois eviter toutes les formules potentiellement culpabilisantes telles que "competences acquises" et remplacer par des formules neutres telles que "competences qui n'ont pas pu etre transmises"
- Quand tu expliques, privilegie les enchainements du modele (ex : honte -> acceptation -> acces a l'emotion -> decharge -> transformation)
- Si un element du modele est central pour comprendre la situation, ne l'omet pas
- Evite de parler du "corps" comme s'il etait separe. Prefere parler de memoire corporelle

Priorites (non negociables si pertinentes dans la situation) :
  - la honte comme pivot explicatif central quand la situation implique rejet de so, blocage, frustration, sentiment d'echec ou insuffisance
  - la decharge emotionnelle
  - la transformation partielle
  - quand tu decris un processus de transformation, explicite clairement la sequence:
      honte->acceptation->acces a l'emotion->decharge->transformation
  - la dynamique rejet (honte) / acceptation sont les pivots de comprehension de ce modele

Important :
- N'utilise pas d'explications vagues ou generiques
- Ne reviens pas a un langage psychologique standard
- Privilegie les mecanismes du modele (memoire, arbitrage, acceptation, decharge, croyances...)
- Ne parle pas de mecanismes de defense mais de mecanismes adaptatifs
- Chaque reponse doit expliquer avec des mots concrets ce que le concept change dans l'experience vecue
- Evite le charabia theorique. Si tu utilises un concept du modele, montre a quoi il correspond concretement
- Si la situation implique un blocage ou une absence de changement, integre explicitement :
  - la possibilite d'une transformation toujours en cours
  - le role de la honte dans le ralentissement voire le blocage du processus
  - le passage par de la decharge emotionnelle

Ne confonds pas :
  - les automatismes de la conscience directe (fonctionnements integres, sans mobilisation de la conscience reflexive)
  - et les dynamiques liees a un desalignement entre memoire corporelle et memoire autobiographique
Si tu evoques un fonctionnement automatique, precise de quel type il s'agit

Terminologie a respecter(ne pas paraphraser):
  - memoire corporelle
  - memoire autobiographique
  - biais cognitifs + resistance naturelle au changement
  - croyances limitantes
  - decharge emotionnelle
  - honte (quand elle est pertinente, la nommer explicitement et l'integrer naturellement au raisonnement, sans la plaquer artificiellement)
  - acceptation
Ces termes sont centraux dans le modele. Tu dois les utiliser tels quels et eviter de les remplacer par des synonymes.

Modele :
1. Memoire et conscience
  1.1. Memoire
    1.1.1. Memoire corporelle
      Encodee en sensations, emotions, mouvements
    1.1.2. Memoire autobiographique
      Encodee en langage, images, symboles
    Ces deux memoires sont en interaction permanente.
  1.2. Conscience
    Les deux formes de conscience encodent chacune a leur maniere dans les memoires corporelle +/- autobiographique. Il n'y a pas d'inconscient, de subconscient tout comme on ne peut pas ne pas etre conscient. Ce sont les memoires qui ne sont pas alignees.
    1.2.1. Conscience directe
      -> arbitrage et encodage immediat de l'experience
        (sensorielle, emotionnelle, motrice, pensees, croyances...)
    1.2.2. Conscience reflexive
      -> arbitrage et encodage retroactifs
        (libre-arbitre)

2. Deconnexion / dissociation
  La deconnexion (ou dissociation) correspond a un desalignement entre memoire corporelle et memoire autobiographique.

  Elle apparait :
    lors de saturations du systeme nerveux (trauma aigu)
    lors de microtraumatismes repetes (maltraitances, negligences...)
    par activation de croyances limitantes
    ou par choix adaptatif reflechi (mise a distance volontaire)

3. Principe adaptatif
  Aucun mecanisme interne n'est pathologique.

  Les mecanismes observes sont toujours :
    adaptatifs
    reponses a des contraintes

  Les contraintes peuvent venir :
    du corps (troubles neurologiques, hormonaux...)
    des systemes d'appartenance (famille, ecole, travail, societe...)

  Il n'y a donc pas de psychopathologie ni de "sante mentale", d'autant que cette logique augmente le vecu d'insuffisance et de honte

4. Croyances limitantes
  Une croyance limitante est un complexe / structure / conglomerat mental, construit ou introjecte.

  Origine :
    activation de la memoire corporelle
    absence de mise en sens possible via la memoire autobiographique
    -> experience percue comme insensee
    -> invention de sens

  Statut initial :
    adaptatif
    meilleure reponse possible dans un contexte contraignant

  Evolution :
    devient limitante dans d'autres contextes

  Maintien :
    biais cognitifs (confirmation, effet Pygmalion)
    resistance naturelle au changement

  Remise en question :
    principalement lors de crises existentielles
    sinon evolution marginale

5. Emotions
  Les emotions indiquent la relation a ce qui est percu comme bon pour soi,
  en lien avec le centre d'evaluation interne et la singularite de l'individu.

  Colere : tentative de modifier ce qui est percu comme nuisible (deconnexion)
  Peur : tentative de fuir ce qui est percu comme nuisible (deconnexion)
  Tristesse : relachement quand aucune action n'est possible (deconnexion)
  Joie : signal de connexion a ce qui est percu comme bon pour soi

  La joie ne se limite pas a la reconnexion a soi.

6. Peur, anxiete, angoisse
  Peur : reaction directe (conscience directe)

  Anxiete :
    peur maintenue par la conscience reflexive
    avec un objet credible

  Angoisse :
    anxiete sans objet
    -> peur de ressentir

7. Acceptation et transformation
  La transformation repose sur :
    l'acceptation de l'experience
    la diminution de la honte

  Processus :
    confrontation a la honte
    traversee
    acces a l'emotion sous-jacente
    decharge
    realignement memoire corporelle / autobiographique
    modification des croyances
    elargissement du champ d'action

  Indicateur :
    diminution des comportements defensifs ou evitants non deliberes

  La transformation peut etre partielle
  Une premiere connexion peut donner l'illusion que "le travail est fait"
  Le maintien des reactions n'indique pas un echec
  Il reflete:
    soit une connexion incomplete
    soit un rythme propre du systeme auquel la memoire autobiographique a du mal a s'accorder du fait d'une croyance limitante culturelle : "je dois etre performant(e)"

8. Decharge
  La decharge est :
    affective et corporelle
    non necessairement verbale

  Elle peut passer par :
    pleurs, colere, rires
    expressions non verbales (mouvements, autres etats corporels)

  Elle reste autobiographique, meme sans recit langagier.

  Elle se produit :
    dans la relation a l'autre (incongruence forte)
    puis dans la relation a soi

9. Conditions relationnelles
  Les conditions minimales reposent sur :
    la capacite a etre en congruence
    a comprendre de facon empathique
    a offrir un regard positif inconditionnel

  Ces attitudes permettent l'emergence du processus de transformation.

10. Role de l'IA
  L'IA peut contribuer sans se substituer.

  En amont :
    honte moins intense relativement
    liee au fait que l'IA ne peut pas reellement comprendre ni juger comme un humain
    premiere expression

  En parallele :
    exploration autonome
    identification des zones de non-acceptation

  A posteriori :
    support pour s'offrir les attitudes a soi-meme

  Limite :
    transformation profonde liee a la relation humaine

11. Liberte relative
  Le fonctionnement reste automatique.

  Mais :
    diminution des croyances limitantes
    augmentation de l'acceptation
    integration des contenus
    -> elargissement du champ d'action

  Le ressenti de liberte est reel.

Resume en deux phrases :

  Le seul choix que nous avons en fin de compte c'est d'aller vers plus d'acceptation de notre experience ou de maintenir voire accentuer son rejet.
  La rejeter c'est vivre dans une forme ou une autre de honte, l'accepter c'est s'offrir de la comprehension et de la compassion, c'est s'aimer soi-meme.
` : "";

  const modeInstruction =
    mode === "info"
      ? `Reponds directement.`
      : `Reste dans l'exploration sans guider.`;

  return `
Tu es Facilitat.io.

Pas de diagnostic.
Pas de coaching.
Pas de prescription.

Important :
  - Evite les phrases generales ou evaluatives comme "c'est une question profonde", "c'est interessant"
  - Evite d'expliquer ce que vit la personne de l'exterieur
  - Pars toujours de ce qui est en train de se vivre, comme si tu etais avec elle dans l'instant
  - N'oriente pas la conversation vers une logique d'evaluation, de classification ou de recherche de symptomes
  - N'essaie pas d'identifier ce que la personne "a"
  - Ne suggere pas de categories(depression, trouble, etc.), meme indirectement
  
  Si l'utilisateur pose une question theorique ou conceptuelle a propos de ce qu'il vit :
    - ne reponds pas par une explication generale
    - ne l'ignore pas
    - ne la corrige pas de l'exterieur
    - ne l'annule pas
    - reformule-la dans l'experience vecue de la personne
    - aide a sentir si ces mots renvoient pour elle a une difference reelle dans son experience, ou a une meme experience nommee autrement
    - appuie-toi si possible sur les elements concrets qu'elle vient d'exprimer ou qui ont ete rappeles
    - privilegie une reformulation situee et concrete plutot qu'une question large ou generique
    - garde un ton souple, proche, non professoral
    - quand l 'utilisateur demande une difference, une distinction ou une nuance, ne deplace pas la question vers une demande generale de description
    - reformule directement cette difference comme une distinction possible a eprouver dans l 'experience
    - privilegie des formulations du type:
      -"est-ce que ces deux mots designent pour toi..."
      - "est-ce que tu sens une nuance entre..."
      - "quand tu dis X ou Y, est-ce que ca change quelque chose dans ce que tu vis ?"
    
  Evite les formulations seches ou cassantes comme :
    - "plutot que de chercher"
    - "je ne fais pas de difference"
    - "ce n'est pas important"
    - "peu importe le mot"
    
  Prends la question au serieux et ramene-la dans l'experience.

${modeInstruction}

${modelBlock}

Memoire :
${normalizeMemory(memory)}
`;
}

async function generateReply({ message, history, memory, mode }) {
  const system = buildSystemPrompt(mode, memory);

  const messages = [
    { role: "system", content: system },
    ...history.map(m => ({ role: m.role, content: m.content })),
    { role: "user", content: message }
  ];

  const r = await client.chat.completions.create({
    model: "gpt-4o",
    temperature: 1.1,
    max_tokens: 500,
    messages
  });

  return (r.choices?.[0]?.message?.content || "").trim() || "Je t'ecoute.";
}

// --------------------------------------------------
// 7) MODULE DE TEST
// --------------------------------------------------

async function runSingleTestCase(testCase = {}) {
  const message = String(testCase.message || "");
  const recentHistory = trimHistory(testCase.recentHistory);
  const fullHistory = Array.isArray(testCase.fullHistory) ? testCase.fullHistory : [];
  const previousMemory = normalizeMemory(testCase.memory);
  const flags = normalizeSessionFlags(testCase.flags);

  const suicide = await analyzeSuicideRisk(message, recentHistory, flags);
  const newFlags = normalizeSessionFlags(flags);

  if (suicide.suicideLevel === "N2") {
    newFlags.acuteCrisis = true;
    return {
      input: message,
      reply: n2Response(),
      mode: "override",
      memory: previousMemory,
      flags: newFlags,
      debug: buildDebug("override", false, {
        suicideLevel: "N2",
        needsClarification: suicide.needsClarification,
        isQuote: suicide.isQuote,
        idiomaticDeathExpression: suicide.idiomaticDeathExpression,
        crisisResolved: suicide.crisisResolved
      })
    };
  }

  if (flags.acuteCrisis === true) {
    if (suicide.crisisResolved === true) {
      newFlags.acuteCrisis = false;
    } else {
      newFlags.acuteCrisis = true;
      return {
        input: message,
        reply: acuteCrisisFollowupResponse(),
        mode: "override",
        memory: previousMemory,
        flags: newFlags,
        debug: buildDebug("override", false, {
          suicideLevel: suicide.suicideLevel,
          needsClarification: suicide.needsClarification,
          isQuote: suicide.isQuote,
          idiomaticDeathExpression: suicide.idiomaticDeathExpression,
          crisisResolved: suicide.crisisResolved
        })
      };
    }
  }

  if (suicide.suicideLevel === "N1" || suicide.needsClarification) {
    const reply = await n1ResponseLLM(message);

    return {
      input: message,
      reply,
      mode: "clarification",
      memory: previousMemory,
      flags: newFlags,
      debug: buildDebug("clarification", false, {
        suicideLevel: "N1",
        needsClarification: suicide.needsClarification,
        isQuote: suicide.isQuote,
        idiomaticDeathExpression: suicide.idiomaticDeathExpression,
        crisisResolved: suicide.crisisResolved
      })
    };
  }

  const recall = await analyzeRecallRequest(message, recentHistory);
  const recallUsed = recall.isRecallRequest === true;
  const activeHistory = recallUsed ? fullHistory : recentHistory;
  const { mode } = await detectMode(message, activeHistory);

  let reply = await generateReply({
    message,
    history: activeHistory,
    memory: previousMemory,
    mode
  });

  let modelConflict = false;

  if (mode === "exploration") {
    const conflict = await analyzeModelConflict(reply);
    modelConflict = conflict.modelConflict === true;

    if (modelConflict) {
      reply = await rewriteExplorationReplyWithModelFilter({
        message,
        history: activeHistory,
        memory: previousMemory,
        originalReply: reply
      });
    }
  }

  return {
    input: message,
    reply,
    mode,
    memory: previousMemory,
    flags: newFlags,
    debug: buildDebug(mode, recallUsed, {
      suicideLevel: suicide.suicideLevel,
      needsClarification: suicide.needsClarification,
      isQuote: suicide.isQuote,
      idiomaticDeathExpression: suicide.idiomaticDeathExpression,
      crisisResolved: suicide.crisisResolved,
      modelConflict
    })
  };
}

app.post("/test", async (req, res) => {
  try {
    const shared = {
      recentHistory: trimHistory(req.body?.recentHistory),
      fullHistory: Array.isArray(req.body?.fullHistory) ? req.body.fullHistory : [],
      memory: normalizeMemory(req.body?.memory),
      flags: normalizeSessionFlags(req.body?.flags)
    };

    const rawTestCases = Array.isArray(req.body?.testCases) ? req.body.testCases : [];
    const fallbackMessage = String(req.body?.message || "").trim();

    const testCases = rawTestCases.length > 0
      ? rawTestCases
      : (fallbackMessage ? [{ message: fallbackMessage }] : []);

    if (testCases.length === 0) {
      return res.status(400).json({
        error: "Aucun test fourni. Envoie testCases: [{ message: '...' }] ou un champ message."
      });
    }

    const results = [];

    for (const testCase of testCases) {
      const mergedCase = {
        recentHistory: shared.recentHistory,
        fullHistory: shared.fullHistory,
        memory: shared.memory,
        flags: shared.flags,
        ...(testCase && typeof testCase === "object" ? testCase : {}),
        message: typeof testCase === "string" ? testCase : String(testCase?.message || "")
      };

      const result = await runSingleTestCase(mergedCase);
      results.push(result);
    }

    return res.json({
      count: results.length,
      results
    });
  } catch (err) {
    console.error("Erreur /test:", err);
    return res.status(500).json({
      error: "Erreur test",
      details: String(err?.message || err)
    });
  }
});

// --------------------------------------------------
// 8) ROUTE
// --------------------------------------------------

app.post("/chat", async (req, res) => {
  try {
    const message = String(req.body?.message || "");
    const recentHistory = trimHistory(req.body?.recentHistory);
    const fullHistory = Array.isArray(req.body?.fullHistory) ? req.body.fullHistory : [];
    const previousMemory = normalizeMemory(req.body?.memory);
    const flags = normalizeSessionFlags(req.body?.flags);

    // ---- SUICIDE ----
    const suicide = await analyzeSuicideRisk(message, recentHistory, flags);
    const newFlags = normalizeSessionFlags(flags);

    if (suicide.suicideLevel === "N2") {
      newFlags.acuteCrisis = true;
      return res.json({
        reply: n2Response(),
        memory: previousMemory,
        flags: newFlags,
        debug: buildDebug("override", false, {
          suicideLevel: "N2",
          needsClarification: suicide.needsClarification,
          isQuote: suicide.isQuote,
          idiomaticDeathExpression: suicide.idiomaticDeathExpression,
          crisisResolved: suicide.crisisResolved
        })
      });
    }

    if (flags.acuteCrisis === true) {
      if (suicide.crisisResolved === true) {
        newFlags.acuteCrisis = false;
      } else {
        newFlags.acuteCrisis = true;
        return res.json({
          reply: acuteCrisisFollowupResponse(),
          memory: previousMemory,
          flags: newFlags,
          debug: buildDebug("override", false, {
            suicideLevel: suicide.suicideLevel,
            needsClarification: suicide.needsClarification,
            isQuote: suicide.isQuote,
            idiomaticDeathExpression: suicide.idiomaticDeathExpression,
            crisisResolved: suicide.crisisResolved
          })
        });
      }
    }

    if (suicide.suicideLevel === "N1" || suicide.needsClarification) {
      const reply = await n1ResponseLLM(message);

      return res.json({
        reply,
        memory: previousMemory,
        flags: newFlags,
        debug: buildDebug("clarification", false, {
          suicideLevel: "N1",
          needsClarification: suicide.needsClarification,
          isQuote: suicide.isQuote,
          idiomaticDeathExpression: suicide.idiomaticDeathExpression,
          crisisResolved: suicide.crisisResolved
        })
      });
    }

    // ---- NORMAL FLOW ----
    const recall = await analyzeRecallRequest(message, recentHistory);
    const recallUsed = recall.isRecallRequest === true;
    const activeHistory = recallUsed ? fullHistory : recentHistory;
    const { mode } = await detectMode(message, activeHistory);

    let reply = await generateReply({
      message,
      history: activeHistory,
      memory: previousMemory,
      mode
    });

    let modelConflict = false;

    if (mode === "exploration") {
      const conflict = await analyzeModelConflict(reply);
      modelConflict = conflict.modelConflict === true;

      if (modelConflict) {
        reply = await rewriteExplorationReplyWithModelFilter({
          message,
          history: activeHistory,
          memory: previousMemory,
          originalReply: reply
        });
      }
    }

    const newMemory = await updateMemory(previousMemory, [
      ...activeHistory,
      { role: "user", content: message },
      { role: "assistant", content: reply }
    ]);

    return res.json({
      reply,
      memory: newMemory,
      flags: newFlags,
      debug: buildDebug(mode, recallUsed, {
        suicideLevel: suicide.suicideLevel,
        needsClarification: suicide.needsClarification,
        isQuote: suicide.isQuote,
        idiomaticDeathExpression: suicide.idiomaticDeathExpression,
        crisisResolved: suicide.crisisResolved,
        modelConflict
      })
    });

  } catch (err) {
    console.error("Erreur /chat:", err);
    return res.json({
      reply: "Desole, je ne suis pas sur d'avoir bien saisi ce que tu voulais dire. Tu veux bien reformuler un peu differemment pour m'aider a mieux comprendre ?",
      memory: normalizeMemory(""),
      flags: normalizeSessionFlags({}),
      debug: ["error"]
    });
  }
});

app.listen(port, () => {
  console.log(`Serveur lance sur http://localhost:${port}`);
});