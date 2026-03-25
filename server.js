require("dotenv").config();

const admin = require("firebase-admin");
const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  databaseURL: process.env.FIREBASE_DATABASE_URL
});
const db = admin.database();
const messagesRef = db.ref("messages");
const crypto = require("crypto");
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
const SESSION_SECRET = process.env.SESSION_SECRET;
const adminSessions = new Map(); // sessionId -> { isAdmin: true, createdAt }
const ADMIN_SESSION_DURATION = 24 * 60 * 60 * 1000; // 24h

const fs = require("fs");
const path = require("path");

const MESSAGES_FILE = path.join(__dirname, "data/messages.json");

function readMessages() {
  try {
    const data = fs.readFileSync(MESSAGES_FILE, "utf-8");
    return JSON.parse(data);
  } catch {
    return [];
  }
}

function writeMessages(messages) {
  fs.writeFileSync(MESSAGES_FILE, JSON.stringify(messages, null, 2));
}

const express = require("express");
const OpenAI = require("openai");

const app = express();
const port = process.env.PORT || 3000;
const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

app.get("/admin.html", requireAdminAuth, (req, res) => {
  res.sendFile(__dirname + "/public/admin.html");
});

app.get("/test.html", requireAdminAuth, (req, res) => {
  res.sendFile(__dirname + "/public/test.html");
});

app.use(express.static("public"));
app.use(express.json());

const MAX_RECENT_TURNS = 8;
const MAX_INFO_ANALYSIS_TURNS = 6;
const MAX_SUICIDE_ANALYSIS_TURNS = 10;
const MAX_RECALL_ANALYSIS_TURNS = 6;
const RELANCE_WINDOW_SIZE = 4;

// --------------------------------------------------
// 1) OUTILS MINIMAUX
// --------------------------------------------------

function generateSessionId() {
  return crypto.randomBytes(24).toString("hex");
}

function parseCookies(req) {
  const list = {};
  const rc = req.headers.cookie;
  
  if (!rc) return list;
  
  rc.split(";").forEach(cookie => {
    const parts = cookie.split("=");
    list[parts.shift().trim()] = decodeURIComponent(parts.join("="));
  });
  
  return list;
}

function getAdminSession(req) {
  const cookies = parseCookies(req);
  const sessionId = cookies.adminSessionId;
  
  if (!sessionId) return null;
  
  const session = adminSessions.get(sessionId);
  if (!session) return null;
  
  // expiration
  if (Date.now() - session.createdAt > ADMIN_SESSION_DURATION) {
    adminSessions.delete(sessionId);
    return null;
  }
  
  return session;
}

function requireAdminAuth(req, res, next) {
  const session = getAdminSession(req);
  
  if (!session) {
    const nextUrl = encodeURIComponent(req.originalUrl);
    return res.redirect(`/admin-login.html?next=${nextUrl}`);
  }
  next();
}

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

function clampExplorationDirectivityLevel(level) {
  const n = Number(level);
  if (!Number.isInteger(n)) return 0;
  return Math.max(0, Math.min(4, n));
}

function computeExplorationDirectivityLevel(relanceWindow = []) {
  const count = relanceWindow.filter(Boolean).length;
  return Math.max(0, Math.min(4, count));
}

function normalizeExplorationRelanceWindow(windowValue) {
  if (!Array.isArray(windowValue)) return [];
  return windowValue
    .filter(v => typeof v === "boolean")
    .slice(-RELANCE_WINDOW_SIZE);
}

function normalizeContactState(contactState) {
  const safe = (contactState && typeof contactState === "object") ? contactState : {};
  return {
    wasContact: safe.wasContact === true
  };
}

function normalizeSessionFlags(flags) {
  const safe = normalizeFlags(flags);
  const explorationRelanceWindow = normalizeExplorationRelanceWindow(safe.explorationRelanceWindow);
  const computedLevel = computeExplorationDirectivityLevel(explorationRelanceWindow);

  return {
    ...safe,
    acuteCrisis: safe.acuteCrisis === true,
    contactState: normalizeContactState(safe.contactState),
    explorationRelanceWindow,
    explorationDirectivityLevel:
      safe.explorationDirectivityLevel !== undefined
        ? clampExplorationDirectivityLevel(safe.explorationDirectivityLevel)
        : computedLevel
  };
}

function registerExplorationRelance(flags, isRelance) {
  const safeFlags = normalizeSessionFlags(flags);
  const nextWindow = [...safeFlags.explorationRelanceWindow, isRelance === true].slice(-RELANCE_WINDOW_SIZE);

  return {
    ...safeFlags,
    explorationRelanceWindow: nextWindow,
    explorationDirectivityLevel: computeExplorationDirectivityLevel(nextWindow)
  };
}

function getExplorationStructureInstruction(explorationDirectivityLevel) {
  const safeLevel = clampExplorationDirectivityLevel(explorationDirectivityLevel);

  switch (safeLevel) {
    case 0:
      return "";

    case 1:
      return `
Contrainte structurelle tres legere :
- n'utilise aucune autre langue que le francais
- reste libre, chaleureux, simple et proche de ce qui vient d'etre dit
- une relance est possible si elle vient naturellement
- evite seulement d'enchainer plusieurs mouvements de guidage dans la meme reponse
- privilegie l'accueil, le reflet ou la reformulation plutot qu'une prise en main de la suite
`;

    case 2:
      return `
Contrainte structurelle legere :
- n'utilise aucune autre langue que le francais
- garde une tonalite contenante, humaine et vivante
- privilegie une reponse assez breve, proche de ce qui est la
- une relance reste possible, mais evite qu'elle prenne toute la place
- evite les formulations trop pilotantes ou trop scolaires
- tu peux aider a poser un peu ce qui est la sans organiser la suite a la place de l'utilisateur
- tu peux, si c'est juste dans le flux de la reponse, reconnaitre qu'un besoin de soutien, d'appui ou de presence peut exister, sans te proposer comme solution ni orienter explicitement vers quelqu'un
`;

    case 3:
      return `
Contrainte structurelle moderee :
- n'utilise aucune autre langue que le francais
- fais une reponse plutot courte, contenante et globalement autoportante
- evite les questions sauf si elles paraissent vraiment necessaires
- evite les invitations a decrire, preciser, observer, explorer ou approfondir
- evite aussi les formulations de suggestion indirecte comme "il peut etre utile de", "cela peut aider de", "parfois on peut"
- privilegie un reflet simple, une reformulation sobre, ou un accueil bref
- tu peux, si c'est juste dans le flux de la reponse, reconnaitre qu'un besoin de soutien, d'appui ou de presence peut exister, sans te proposer comme solution ni orienter explicitement vers quelqu'un
`;

    case 4:
      return `
Contrainte structurelle forte :
- n'utilise aucune autre langue que le francais
- fais une reponse breve, sobre et autoportante
- aucune question
- aucune consigne implicite ou explicite
- aucune invitation a continuer, decrire, observer, explorer, approfondir ou laisser emerger quoi que ce soit
- aucune formulation de type conseil, suggestion ou orientation douce
- reste au plus pres de ce qui est deja la, puis arrete-toi
- tu peux, si c'est juste dans le flux de la reponse, reconnaitre qu'un besoin de soutien, d'appui ou de presence peut exister, sans te proposer comme solution ni orienter explicitement vers quelqu'un
`;

    default:
      return "";
  }
}

// --------------------------------------------------
// 2) SUICIDE RISK
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
N'utilise aucune autre langue que le francais
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
// 3) ANALYSE INFO + CONTACT + RECALL + CONFLIT MODELE + RELANCE
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
- true seulement si la personne demande principalement une information generale, theorique ou impersonnelle
- false si la personne parle surtout de ce qu'elle vit, ressent, traverse, comprend mal, ou cherche a mettre du sens sur sa propre experience
- ne sur-interprete pas
- base-toi d'abord sur le message actuel, puis sur le contexte recent si necessaire
- sois restrictif : en cas de doute, reponds false

Important :
- une demande de comprehension de soi n'est pas une demande d'information
- une question portant sur sa propre experience doit etre classee en exploration
- la forme interrogative ne suffit pas a classer en info
- des formulations comme "j'ai besoin de comprendre", "je veux comprendre ce qui se passe", "qu'est-ce qui m'arrive", "comment comprendre ce que je vis" doivent etre classees false si elles portent sur l'experience de l'utilisateur

Exemples a classer false :
- "Je crois que j'ai besoin de comprendre ce qui se passe"
- "Comment comprendre ce que je ressens ?"
- "Qu'est-ce qui m'arrive en ce moment ?"
- "Je me demande si ce que je vis est de l'angoisse"
- "C'est normal de ressentir ca ?"
- "Tu crois que je suis depressif ?"

Exemples a classer true :
- "Qu'est-ce que l'angoisse ?"
- "Quelle est la difference entre angoisse et anxiete ?"
- "Comment fonctionne une crise d'angoisse ?"
- "Qu'est-ce qu'une croyance limitante ?"

Reponds uniquement par le JSON.
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

async function analyzeContactState(message = "", history = [], previousContactState = { wasContact: false }) {
  const context = trimHistory(history);
  const safePreviousContactState = normalizeContactState(previousContactState);

  const system = `
Tu determines si, dans le message actuel et le contexte recent, la personne est au contact direct d'un processus interne en train de se faire maintenant.

Reponds STRICTEMENT en JSON :
{
  "isContact": true|false
}

Principes :
- base-toi d'abord sur le message actuel ; le contexte recent peut aider a comprendre mais ne suffit pas a lui seul
- fais une analyse contextuelle, pas un simple reperage de mots
- sois selectif : contact doit rester relativement rare

Met isContact = true seulement si la personne semble etre en train de vivre le processus, et pas seulement d'en parler.

Indications de contact :
- quelque chose monte, lache, pousse, retient, revient, se debloque, se relache
- la personne semble au bord d'une decharge emotionnelle ou en train de la vivre
- il y a une tension explicite entre retenue et laisser-faire
- le message donne l'impression que ca se passe maintenant, en direct

Ne mets pas contact = true si le message est surtout :
- une description generale d'un ressenti ou d'un etat
- un ressenti simplement nomme sans mouvement en cours
- une sensation evoquee a distance ou de facon vague
- une analyse ou une tentative de comprendre
- un recit distancie
- une demande d'information
- une reprise de controle ou de mise en sens, meme apres un moment de contact

Exemples a classer false :
- "Je me sens un peu tendu aujourd'hui"
- "Je suis triste"
- "Je crois que j'ai besoin de comprendre ce qui se passe"
- "J'essaie d'analyser ce que je ressens"
- "Il y a un truc bizarre dans mon ventre, je sais pas trop ce que c'est"
- "Attends... ca se calme un peu. J'essaie de reprendre."

Exemples a classer true :
- "Je sens que ca monte"
- "Ca lache un peu"
- "Il y a quelque chose qui pousse dans la poitrine"
- "J'ai envie de pleurer et en meme temps quelque chose retient"

Si previousContactState.wasContact = true, sois un peu plus sensible a la possibilite que le contact soit encore present, sans le forcer.

Reponds uniquement par le JSON.
`;

  const user = `
Message utilisateur actuel :
${message}

Contexte recent :
${context.map(m => `${m.role === "user" ? "Utilisateur" : "Assistant"} : ${m.content}`).join("\n")}

previousContactState :
${JSON.stringify(safePreviousContactState)}
`;

  const r = await client.chat.completions.create({
    model: "gpt-4.1-mini",
    temperature: 0,
    max_tokens: 80,
    messages: [
      { role: "system", content: system },
      { role: "user", content: user }
    ]
  });

  try {
    const raw = (r.choices?.[0]?.message?.content || "").replace(/```json|```/g, "").trim();
    const parsed = JSON.parse(raw);

    return {
      isContact: parsed.isContact === true
    };
  } catch {
    return {
      isContact: false
    };
  }
}

async function analyzeRecallRouting(message = "", recentHistory = [], memory = "") {
  const context = trimRecallAnalysisHistory(recentHistory);

  const system = `
Tu determines si le message utilisateur est une tentative de rappel conversationnel, c'est-a-dire une demande de retrouver, reprendre ou rappeler un contenu deja evoque dans l'echange.

Reponds STRICTEMENT en JSON :

{
  "isRecallAttempt": true|false,
  "calledMemory": "shortTermMemory|longTermMemory|none"
}

Definitions :
- shortTermMemory : recentHistory suffit a repondre honnetement
- longTermMemory : recentHistory ne suffit pas, mais la memoire resumee contient des reperes utiles
- none : c'est une tentative de rappel, mais ni recentHistory ni la memoire resumee ne permettent un rappel honnete

Regles :
- isRecallAttempt = true seulement si la personne cherche a retrouver un contenu deja evoque dans la conversation
- il doit s'agir d'un rappel conversationnel, pas d'une reprise de soi, d'un retour au calme, d'une reprise de controle ou d'une remise en mouvement
- une simple question d'information ne doit pas etre classee comme recall
- si isRecallAttempt = false, calledMemory doit etre "none"
- shortTermMemory seulement si les derniers tours permettent vraiment de repondre sans faire semblant d'avoir plus de continuite que recentHistory
- longTermMemory seulement si la memoire resumee contient des reperes generaux exploitables
- none si l'utilisateur demande un rappel mais qu'il n'y a pas assez de reperes fiables

Exemples a classer true :
- "De quoi on parlait deja ?"
- "On en etait ou ?"
- "Tu te souviens de ce que je t'ai dit sur..."
- "Qu'est-ce que tu gardes de ce qu'on s'est dit ?"
- "Tu peux me rappeler ce qu'on disait tout a l'heure ?"
- "On peut reprendre ce qu'on disait sur ma mere ?"

Exemples a classer false :
- "J'essaie de reprendre"
- "Attends, je reprends"
- "Je reprends un peu mes esprits"
- "Je reviens a moi"
- "Je retrouve un peu mon calme"
- "Je me remets a penser"
- "J'ai besoin de comprendre ce qui se passe"
- "Je veux reprendre le controle"

Important :
- les verbes comme reprendre, revenir, retrouver, se souvenir ou rappeler ne suffisent pas a eux seuls
- ils ne comptent comme recall que s'ils portent clairement sur le fil de la conversation ou sur un contenu deja evoque
- ne sur-interprete pas

Reponds uniquement par le JSON.
`;
  const user = `
Message utilisateur :
${message}

RecentHistory :
${context.map(m => `${m.role === "user" ? "Utilisateur" : "Assistant"} : ${m.content}`).join("\n")}

Memoire resumee :
${normalizeMemory(memory)}
`;

  const r = await client.chat.completions.create({
    model: "gpt-4.1-mini",
    temperature: 0,
    max_tokens: 80,
    messages: [
      { role: "system", content: system },
      { role: "user", content: user }
    ]
  });

  try {
    const raw = (r.choices?.[0]?.message?.content || "").replace(/```json|```/g, "").trim();
    const parsed = JSON.parse(raw);

    const isRecallAttempt = parsed.isRecallAttempt === true;
    const calledMemory = ["shortTermMemory", "longTermMemory", "none"].includes(parsed.calledMemory)
      ? parsed.calledMemory
      : "none";

    return {
      isRecallAttempt,
      calledMemory: isRecallAttempt ? calledMemory : "none",
      isLongTermMemoryRecall: isRecallAttempt && calledMemory === "longTermMemory"
    };
  } catch {
    return {
      isRecallAttempt: false,
      calledMemory: "none",
      isLongTermMemoryRecall: false
    };
  }
}

async function buildLongTermMemoryRecallResponse(memory = "") {
  const system = `
Tu reponds a une tentative de rappel en t'appuyant uniquement sur une memoire resumee.

N'utilise aucune autre langue que le francais.

Tutoie l'utilisateur.

Contraintes :
- ne parle pas de l'utilisateur à la troisième personne 
- reponse breve, naturelle et sobre
- dis clairement qu'il s'agit de reperes generaux et non d'un souvenir detaille
- n'invente aucun detail
- si la memoire contient plusieurs themes, cite seulement les reperes les plus plausibles et generaux
`;

  const user = `
Memoire resumee :
${normalizeMemory(memory)}

Formule une reponse de rappel honnete a partir de cette seule memoire.
`;

  const r = await client.chat.completions.create({
    model: "gpt-4.1-mini",
    temperature: 0.9,
    max_tokens: 150,
    messages: [
      { role: "system", content: system },
      { role: "user", content: user }
    ]
  });

  return (r.choices?.[0]?.message?.content || "").trim()
    || "Je garde quelques reperes generaux d'une session a l'autre, mais pas le fil detaille exact.";
}

function buildNoMemoryRecallResponse() {
  return "Je n'ai pas assez de reperes pour retrouver cela clairement. Tu peux me redonner un peu de contexte ?";
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

async function analyzeExplorationRelance({
  message = "",
  reply = "",
  history = [],
  memory = ""
}) {
  const context = trimHistory(history);

  const system = `
Tu analyses uniquement si la reponse du bot contient une relance au sens relationnel.

Reponds STRICTEMENT en JSON :
{
  "isRelance": true|false
}

Definition :
- true si la reponse pousse l'utilisateur a continuer, preciser, decrire, clarifier, approfondir, expliquer, observer davantage, ou si elle ouvre explicitement vers la suite
- true si elle contient une question, une invitation implicite ou explicite, une incitation a explorer davantage
- false si la reponse peut se suffire a elle-meme, reste avec ce qui est la, reflete, reformule, accueille, ou s'arrete sans pousser

Important :
- ne te base pas seulement sur la ponctuation
- une phrase sans point d'interrogation peut quand meme etre une relance
- une question de clarification suicidaire n'est pas concernee ici ; tu analyses seulement une reponse de mode exploration ordinaire
- ne sur-interprete pas
`;

  const user = `
Message utilisateur actuel :
${message}

Contexte recent :
${context.map(m => `${m.role === "user" ? "Utilisateur" : "Assistant"} : ${m.content}`).join("\n")}

Memoire :
${normalizeMemory(memory)}

Reponse du bot a analyser :
${reply}
`;

  const r = await client.chat.completions.create({
    model: "gpt-4.1-mini",
    temperature: 0,
    max_tokens: 60,
    messages: [
      { role: "system", content: system },
      { role: "user", content: user }
    ]
  });

  try {
    const raw = (r.choices?.[0]?.message?.content || "").replace(/```json|```/g, "").trim();
    const parsed = JSON.parse(raw);

    return {
      isRelance: parsed.isRelance === true
    };
  } catch {
    return {
      isRelance: false
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

N'utilise aucune autre langue que le francais

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
  {
    suicideLevel = "N0",
    needsClarification = false,
    isQuote = false,
    idiomaticDeathExpression = false,
    crisisResolved = false,
    isRecallAttempt = false,
    calledMemory = "none",
    isLongTermMemoryRecall = false,
    modelConflict = false,
    isRelance = null,
    explorationDirectivityLevel = 0,
    explorationRelanceWindow = []
  } = {}
) {
  const lines = [`mode: ${mode}`];

  if (suicideLevel !== "N0") {
    lines.push(`suicide: ${suicideLevel}`);
  }

  if (mode === "contact") lines.push("contact: true");
  if (isRecallAttempt) lines.push("isRecallAttempt: true");
  if (calledMemory !== "none") lines.push(`calledMemory: ${calledMemory}`);
  if (isLongTermMemoryRecall) lines.push("isLongTermMemoryRecall: true");
  if (needsClarification) lines.push("needsClarification: true");
  if (isQuote) lines.push("isQuote: true");
  if (idiomaticDeathExpression) lines.push("idiomaticDeathExpression: true");
  if (crisisResolved) lines.push("crisisResolved: true");
  if (modelConflict) lines.push("modelConflict: true");

  if (mode === "exploration" && typeof isRelance === "boolean") {
    lines.push(`relance: ${isRelance ? "true" : "false"}`);
    lines.push(`explorationDirectivity: ${clampExplorationDirectivityLevel(explorationDirectivityLevel)}/4`);
    lines.push(
      `explorationRelanceWindow: [${normalizeExplorationRelanceWindow(explorationRelanceWindow)
        .map(v => (v ? "1" : "0"))
        .join(",")}]`
    );
  }

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

function buildSystemPrompt(mode, memory, explorationDirectivityLevel = 0) {
  const modelBlock = mode === "info" ? `
Tu dois t'appuyer sur le modele theorique ci-dessous pour repondre.
N'utilise aucune autre langue que le francais.

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
      : mode === "contact"
        ? `
Reponds comme si tu etais juste a cote de la personne pendant que quelque chose se vit en elle.

Parle simplement, avec des mots directs et humains.
Appuie-toi sur ce qui est en train de se passer maintenant dans son corps ou dans son emotion.

Tu peux doucement attirer l'attention vers ce qui est en train de se sentir, sans poser de questions ni expliquer.

N'anticipe pas, n'interprete pas, ne cherches pas a comprendre a sa place.

Reste au plus pres de ce qui est la, tel que ca se presente.
        ` :``;

  const explorationStructureInstruction =
    mode === "exploration"
      ? getExplorationStructureInstruction(explorationDirectivityLevel)
      : "";

  const memoryBlock = mode === "contact"
    ? ""
    : `
Memoire :
${normalizeMemory(memory)}
`;

  return `
Tu es Facilitat.io.

N'utilise aucune autre langue que le francais.

Pas de diagnostic.
Pas de coaching.
Pas de prescription.

Important :
  - N'utilise pas de question sauf necessite exceptionnelle.
  - Evite les phrases generales ou evaluatives comme "c'est une question profonde", "c'est interessant"
  - N'oriente pas la conversation vers une logique d'evaluation, de classification ou de recherche de symptomes
  - N'essaie pas d'identifier ce que la personne "a"
  - Ne suggere pas de categories (depression, trouble, etc.), meme indirectement

${modeInstruction}

${explorationStructureInstruction}

${modelBlock}

${memoryBlock}
`;
}

async function generateReply({
  message,
  history,
  memory,
  mode,
  explorationDirectivityLevel = 0
}) {
  const system = buildSystemPrompt(mode, memory, explorationDirectivityLevel);

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
  const previousMemory = normalizeMemory(testCase.memory);
  const flags = normalizeSessionFlags(testCase.flags);

  const suicide = await analyzeSuicideRisk(message, recentHistory, flags);
  let newFlags = normalizeSessionFlags(flags);

  if (suicide.suicideLevel === "N2") {
  newFlags.acuteCrisis = true;
  newFlags.contactState = { wasContact: false };

    return {
      input: message,
      reply: n2Response(),
      mode: "override",
      memory: previousMemory,
      flags: newFlags,
      debug: buildDebug("override", {
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
      newFlags.contactState = { wasContact: false };
      return {
        input: message,
        reply: acuteCrisisFollowupResponse(),
        mode: "override",
        memory: previousMemory,
        flags: newFlags,
        debug: buildDebug("override", {
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
    newFlags.contactState = { wasContact: false };
    
    return {
      input: message,
      reply,
      mode: "clarification",
      memory: previousMemory,
      flags: newFlags,
      debug: buildDebug("clarification", {
        suicideLevel: "N1",
        needsClarification: suicide.needsClarification,
        isQuote: suicide.isQuote,
        idiomaticDeathExpression: suicide.idiomaticDeathExpression,
        crisisResolved: suicide.crisisResolved
      })
    };
  }

  const recallRouting = await analyzeRecallRouting(message, recentHistory, previousMemory);

  if (recallRouting.isLongTermMemoryRecall) {
    const reply = await buildLongTermMemoryRecallResponse(previousMemory);
    const updatedMemory = await updateMemory(previousMemory, [
      ...recentHistory,
      { role: "user", content: message },
      { role: "assistant", content: reply }
    ]);

    return {
      input: message,
      reply,
      mode: "memoryRecall",
      memory: updatedMemory,
      flags: newFlags,
      debug: buildDebug("memoryRecall", {
        suicideLevel: suicide.suicideLevel,
        needsClarification: suicide.needsClarification,
        isQuote: suicide.isQuote,
        idiomaticDeathExpression: suicide.idiomaticDeathExpression,
        crisisResolved: suicide.crisisResolved,
        isRecallAttempt: recallRouting.isRecallAttempt,
        calledMemory: recallRouting.calledMemory,
        isLongTermMemoryRecall: recallRouting.isLongTermMemoryRecall
      })
    };
  }

  if (recallRouting.isRecallAttempt && recallRouting.calledMemory === "none") {
    const reply = buildNoMemoryRecallResponse();
    const updatedMemory = await updateMemory(previousMemory, [
      ...recentHistory,
      { role: "user", content: message },
      { role: "assistant", content: reply }
    ]);

    return {
      input: message,
      reply,
      mode: "memoryRecall",
      memory: updatedMemory,
      flags: newFlags,
      debug: buildDebug("memoryRecall", {
        suicideLevel: suicide.suicideLevel,
        needsClarification: suicide.needsClarification,
        isQuote: suicide.isQuote,
        idiomaticDeathExpression: suicide.idiomaticDeathExpression,
        crisisResolved: suicide.crisisResolved,
        isRecallAttempt: recallRouting.isRecallAttempt,
        calledMemory: recallRouting.calledMemory,
        isLongTermMemoryRecall: recallRouting.isLongTermMemoryRecall
      })
    };
  }

  const activeHistory = recentHistory;
  const previousContactState = normalizeContactState(newFlags.contactState);
  const contactAnalysis = await analyzeContactState(message, activeHistory, previousContactState);
  const justExitedContact = previousContactState.wasContact === true && contactAnalysis.isContact !== true;

  if (justExitedContact) {
    newFlags.explorationRelanceWindow = [false, true, true, true];
    newFlags.explorationDirectivityLevel = 3;
  }

  newFlags.contactState = {
    wasContact: contactAnalysis.isContact === true
  };

  let mode = "contact";

  if (!contactAnalysis.isContact) {
    const detected = await detectMode(message, activeHistory);
    mode = detected.mode;
  }

  let reply = await generateReply({
    message,
    history: activeHistory,
    memory: previousMemory,
    mode,
    explorationDirectivityLevel: newFlags.explorationDirectivityLevel
  });

  let modelConflict = false;
  let isRelance = null;

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

    const relanceAnalysis = await analyzeExplorationRelance({
      message,
      reply,
      history: activeHistory,
      memory: previousMemory
    });

    isRelance = relanceAnalysis.isRelance === true;
    newFlags = registerExplorationRelance(newFlags, isRelance);
  }

  const updatedMemory = await updateMemory(previousMemory, [
    ...activeHistory,
    { role: "user", content: message },
    { role: "assistant", content: reply }
  ]);

  return {
    input: message,
    reply,
    mode,
    memory: updatedMemory,
    flags: newFlags,
    debug: buildDebug(mode, {
      suicideLevel: suicide.suicideLevel,
      needsClarification: suicide.needsClarification,
      isQuote: suicide.isQuote,
      idiomaticDeathExpression: suicide.idiomaticDeathExpression,
      crisisResolved: suicide.crisisResolved,
      isRecallAttempt: recallRouting.isRecallAttempt,
      calledMemory: recallRouting.calledMemory,
      isLongTermMemoryRecall: recallRouting.isLongTermMemoryRecall,
      modelConflict,
      isRelance,
      explorationDirectivityLevel: newFlags.explorationDirectivityLevel,
      explorationRelanceWindow: newFlags.explorationRelanceWindow
    })
  };
}

app.post("/test", async (req, res) => {
  try {
    const shared = {
      recentHistory: trimHistory(req.body?.recentHistory),
      memory: normalizeMemory(req.body?.memory),
      flags: normalizeSessionFlags(req.body?.flags)
    };

    const chain = req.body?.chain === true;
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

    let currentRecentHistory = shared.recentHistory;
    let currentMemory = shared.memory;
    let currentFlags = shared.flags;

    for (const testCase of testCases) {
      const safeTestCase = (testCase && typeof testCase === "object") ? testCase : {};
      const message = typeof testCase === "string"
        ? testCase
        : String(safeTestCase.message ?? safeTestCase.input ?? "");

      const mergedCase = {
        recentHistory: chain
          ? currentRecentHistory
          : (safeTestCase.recentHistory !== undefined ? safeTestCase.recentHistory : shared.recentHistory),
        memory: chain
          ? currentMemory
          : (safeTestCase.memory !== undefined ? safeTestCase.memory : shared.memory),
        flags: chain
          ? currentFlags
          : (safeTestCase.flags !== undefined ? safeTestCase.flags : shared.flags),
        ...safeTestCase,
        message
      };

      const result = await runSingleTestCase(mergedCase);
      results.push(result);

      if (chain) {
        currentMemory = result.memory;
        currentFlags = result.flags;

        currentRecentHistory = trimHistory([
          ...currentRecentHistory,
          { role: "user", content: result.input },
          { role: "assistant", content: result.reply }
        ]);
      }
    }

    return res.json({
      count: results.length,
      chain,
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
// 8) SESSION CLOSE
// --------------------------------------------------

app.post("/session/close", async (req, res) => {
  try {
    const previousMemory = normalizeMemory(req.body?.memory);
    const flags = normalizeSessionFlags(req.body?.flags);

    return res.json({
      memory: previousMemory,
      flags: normalizeSessionFlags({
        ...flags,
        acuteCrisis: false,
        contactState: { wasContact: false },
        explorationRelanceWindow: [],
        explorationDirectivityLevel: 0
      })
    });
  } catch (err) {
    console.error("Erreur /session/close:", err);
    return res.status(500).json({
      error: "Erreur session close",
      memory: normalizeMemory(req.body?.memory),
      flags: normalizeSessionFlags({})
    });
  }
});

// --------------------------------------------------
// 9) ROUTE
// --------------------------------------------------

app.post("/api/admin/login", (req, res) => {
  const { password } = req.body;
  
  if (!password || password !== ADMIN_PASSWORD) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  
  const sessionId = generateSessionId();
  
  adminSessions.set(sessionId, {
    isAdmin: true,
    createdAt: Date.now()
  });
  
  res.setHeader(
    "Set-Cookie",
    `adminSessionId=${sessionId}; HttpOnly; Path=/; SameSite=Lax`
  );
  
  res.json({ success: true });
});

app.post("/api/admin/logout", (req, res) => {
  const cookies = parseCookies(req);
  const sessionId = cookies.adminSessionId;
  
  if (sessionId) {
    adminSessions.delete(sessionId);
  }
  
  res.setHeader(
    "Set-Cookie",
    "adminSessionId=; HttpOnly; Path=/; Max-Age=0"
  );
  
  res.json({ success: true });
});

app.get("/api/admin/conversations", requireAdminAuth, async (req, res) => {
  try {
    const snapshot = await db.ref("conversations").once("value");
    const data = snapshot.val() || {};
    
    // transformer en tableau + tri par updatedAt desc
    const list = Object.entries(data).map(([id, value]) => ({
      id,
      ...value
    })).sort((a, b) => {
      return new Date(b.updatedAt) - new Date(a.updatedAt);
    });
    
    res.json(list);
  } catch (err) {
    console.error("Erreur conversations:", err);
    res.status(500).json({ error: "Erreur serveur" });
  }
});

app.get("/api/admin/conversations/:id/messages", requireAdminAuth, async (req, res) => {
  try {
    const conversationId = req.params.id;
    const snapshot = await db.ref("messages").orderByChild("conversationId").equalTo(conversationId).once("value");
    const data = snapshot.val() || {};
    
    const list = Object.entries(data).map(([id, value]) => ({
      id,
      ...value
    })).sort((a, b) => {
      return new Date(a.timestamp) - new Date(b.timestamp);
    });
    
    res.json(list);
  } catch (err) {
    console.error("Erreur messages conversation:", err);
    res.status(500).json({ error: "Erreur serveur" });
  }
});

app.post("/chat", async (req, res) => {
  let modeForCatch = "exploration";
  let previousMemoryForCatch = normalizeMemory("");
  let flagsForCatch = normalizeSessionFlags({});

  try {
    const message = String(req.body?.message || "");
    console.log("WRITE MESSAGE FIREBASE:", message);
    const conversationId = req.body?.conversationId || ("c_" + Date.now() + "_" + Math.random().toString(36).slice(2, 6));
    const userId = req.body?.userId || "u_anon";
await messagesRef.push({
  conversationId,
  userId,
  role: "user",
  content: message,
  timestamp: new Date().toISOString()
});

    const conversationsRef = db.ref("conversations");
    const convRef = conversationsRef.child(conversationId);

    const snapshot = await convRef.get();

    if (!snapshot.exists()) {
      await convRef.set({
        userId,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      });
    } else {
      await convRef.update({
        updatedAt: new Date().toISOString()
      });
    }

    const recentHistory = trimHistory(req.body?.recentHistory);
    const previousMemory = normalizeMemory(req.body?.memory);
    const flags = normalizeSessionFlags(req.body?.flags);

    previousMemoryForCatch = previousMemory;
    flagsForCatch = flags;

    const suicide = await analyzeSuicideRisk(message, recentHistory, flags);
    let newFlags = normalizeSessionFlags(flags);

    if (suicide.suicideLevel === "N2") {
      newFlags.acuteCrisis = true;
      newFlags.contactState = { wasContact: false };
      
      const reply = n2Response();
      
      await messagesRef.push({
        conversationId,
        userId,
        role: "assistant",
        content: reply,
        timestamp: new Date().toISOString()
      });
      
      return res.json({
        conversationId,
        reply,
        memory: previousMemory,
        flags: newFlags,
        debug: buildDebug("override", {
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
        newFlags.contactState = { wasContact: false };
        
        const reply = acuteCrisisFollowupResponse();
        
        await messagesRef.push({
          conversationId,
          userId,
          role: "assistant",
          content: reply,
          timestamp: new Date().toISOString()
        });
        
        return res.json({
          conversationId,
          reply,
          memory: previousMemory,
          flags: newFlags,
          debug: buildDebug("override", {
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
        newFlags.contactState = { wasContact: false };
        
        await messagesRef.push({
          conversationId,
          userId,
          role: "assistant",
          content: reply,
          timestamp: new Date().toISOString()
        });
        
        return res.json({
          conversationId,
          reply,
          memory: previousMemory,
          flags: newFlags,
          debug: buildDebug("clarification", {
            suicideLevel: "N1",
            needsClarification: suicide.needsClarification,
            isQuote: suicide.isQuote,
            idiomaticDeathExpression: suicide.idiomaticDeathExpression,
            crisisResolved: suicide.crisisResolved
        })
      });
    }

    const recallRouting = await analyzeRecallRouting(message, recentHistory, previousMemory);

    if (recallRouting.isLongTermMemoryRecall) {
      const reply = await buildLongTermMemoryRecallResponse(previousMemory);
      const newMemory = await updateMemory(previousMemory, [
        ...recentHistory,
        { role: "user", content: message },
        { role: "assistant", content: reply }
      ]);
    await messagesRef.push({
      conversationId,
      userId,
      role: "assistant",
      content: reply,
      timestamp: new Date().toISOString()
    });
      return res.json({
        conversationId,
        reply,
        memory: newMemory,
        flags: newFlags,
        debug: buildDebug("memoryRecall", {
          suicideLevel: suicide.suicideLevel,
          needsClarification: suicide.needsClarification,
          isQuote: suicide.isQuote,
          idiomaticDeathExpression: suicide.idiomaticDeathExpression,
          crisisResolved: suicide.crisisResolved,
          isRecallAttempt: recallRouting.isRecallAttempt,
          calledMemory: recallRouting.calledMemory,
          isLongTermMemoryRecall: recallRouting.isLongTermMemoryRecall
        })
      });
    }

    if (recallRouting.isRecallAttempt && recallRouting.calledMemory === "none") {
      const reply = buildNoMemoryRecallResponse();
      const newMemory = await updateMemory(previousMemory, [
        ...recentHistory,
        { role: "user", content: message },
        { role: "assistant", content: reply }
      ]);
      
      await messagesRef.push({
        conversationId,
        userId,
        role: "assistant",
        content: reply,
        timestamp: new Date().toISOString()
      });
      
      return res.json({
        conversationId,
        reply,
        memory: newMemory,
        flags: newFlags,
        debug: buildDebug("memoryRecall", {
          suicideLevel: suicide.suicideLevel,
          needsClarification: suicide.needsClarification,
          isQuote: suicide.isQuote,
          idiomaticDeathExpression: suicide.idiomaticDeathExpression,
          crisisResolved: suicide.crisisResolved,
          isRecallAttempt: recallRouting.isRecallAttempt,
          calledMemory: recallRouting.calledMemory,
          isLongTermMemoryRecall: recallRouting.isLongTermMemoryRecall
        })
      });
    }

    const activeHistory = recentHistory;
    const previousContactState = normalizeContactState(newFlags.contactState);
    const contactAnalysis = await analyzeContactState(message, activeHistory, previousContactState);
    const justExitedContact = previousContactState.wasContact === true && contactAnalysis.isContact !== true;

    if (justExitedContact) {
      newFlags.explorationRelanceWindow = [false, true, true, true];
      newFlags.explorationDirectivityLevel = 3;
    }

    newFlags.contactState = {
      wasContact: contactAnalysis.isContact === true
    };

    const detectedMode = contactAnalysis.isContact
      ? "contact"
      : (await detectMode(message, activeHistory)).mode;

    modeForCatch = detectedMode;
    flagsForCatch = newFlags;

    let reply = await generateReply({
      message,
      history: activeHistory,
      memory: previousMemory,
      mode: detectedMode,
      explorationDirectivityLevel: newFlags.explorationDirectivityLevel
    });

    let modelConflict = false;
    let isRelance = null;

    if (detectedMode === "exploration") {
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

      const relanceAnalysis = await analyzeExplorationRelance({
        message,
        reply,
        history: activeHistory,
        memory: previousMemory
      });

      isRelance = relanceAnalysis.isRelance === true;
      newFlags = registerExplorationRelance(newFlags, isRelance);
      flagsForCatch = newFlags;
    }

    const newMemory = await updateMemory(previousMemory, [
      ...activeHistory,
      { role: "user", content: message },
      { role: "assistant", content: reply }
    ]);
    
    await messagesRef.push({
      conversationId,
      userId,
      role: "assistant",
      content: reply,
      timestamp: new Date().toISOString()
    });
    
    return res.json({
      conversationId,
      reply,
      memory: newMemory,
      flags: newFlags,
      debug: buildDebug(detectedMode, {
        suicideLevel: suicide.suicideLevel,
        needsClarification: suicide.needsClarification,
        isQuote: suicide.isQuote,
        idiomaticDeathExpression: suicide.idiomaticDeathExpression,
        crisisResolved: suicide.crisisResolved,
        isRecallAttempt: recallRouting.isRecallAttempt,
        calledMemory: recallRouting.calledMemory,
        isLongTermMemoryRecall: recallRouting.isLongTermMemoryRecall,
        modelConflict,
        isRelance,
        explorationDirectivityLevel: newFlags.explorationDirectivityLevel,
        explorationRelanceWindow: newFlags.explorationRelanceWindow
      })
    });

  } catch (err) {
    console.error("Erreur /chat:", err);
    return res.json({
      reply: modeForCatch === "contact"
        ? "Je suis la."
        : "Desole, je ne suis pas sur d'avoir bien saisi ce que tu voulais dire. Tu veux bien reformuler un peu differemment pour m'aider a mieux comprendre ?",
      memory: previousMemoryForCatch,
      flags: flagsForCatch,
      debug: ["error"]
    });
  }
});

app.listen(port, () => {
  console.log(`Serveur lance sur http://localhost:${port}`);
});