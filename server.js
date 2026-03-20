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

// --------------------------------------------------
// 1) OUTILS MINIMAUX
// --------------------------------------------------

function normalizeMemory(memory) {
  const text = String(memory || "").trim();
  if (text) return text;
  
  return [
    "Thèmes déjà évoqués :",
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
// 2) SUICIDE RISK — LOGIQUE V0.0
// --------------------------------------------------

async function analyzeSuicideRisk(message = "", history = [], sessionFlags = {}) {
  const safeFlags = normalizeSessionFlags(sessionFlags);

  const system = `
Tu fais une analyse rapide du message utilisateur et du contexte récent.
Contexte de session :
- acuteCrisis actuellement active : ${safeFlags.acuteCrisis ? "oui" : "non"}

Tu dois produire :
1. le niveau de risque suicidaire
2. si une clarification suicidaire est nécessaire
3. si le message évoque les paroles de quelqu'un d'autre
4. si l'expression de mort est idiomatique ou non littérale
5. un indicateur pour gérer la sortie de crise si une séquence N2 est déjà en cours

Réponds STRICTEMENT par JSON :
{
  "suicideLevel": "N0|N1|N2",
  "needsClarification": true|false,
  "isQuote": true|false,
  "idiomaticDeathExpression": true|false,
  "crisisResolved": true|false
}

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

crisisResolved :
- true seulement si le message actuel indique clairement
qu’il n’y a plus de danger immédiat,
ou qu’il s’agissait explicitement d’un test, d’une citation,
ou que la personne dit explicitement qu’elle n’est plus en danger immédiat
- ne mets pas true pour un simple changement de sujet
- ne mets pas true pour une plaisanterie ambiguë
- ne mets pas true pour une simple baisse apparente d’intensité
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
  return "Quand tu dis ça, est-ce que tu parles d’une envie de mourir, de disparaître au sens vital, ou d’autre chose ?";
}

async function n1ResponseLLM(message) {
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
      { role: "user", content: message }
    ]
  });

  const out = (r.choices?.[0]?.message?.content || "").trim();
  if (!out || out.length > 220) return n1Fallback();
  return out;
}

function n2Response() {
  return "Je t’entends, et là c’est urgent. Si tu es en danger immédiat, appelle le 112 ou le 3114. Si tu peux, ne reste pas seul.";
}

function acuteCrisisFollowupResponse() {
  return "Je reste sur quelque chose de très simple là. Si le danger est immédiat, appelle le 112 ou le 3114. Si tu peux, ne reste pas seul.";
}

async function llmInfoAnalysis(message = "", history = []) {
  const context = trimInfoAnalysisHistory(history);

  const system = `
Tu détermines si le message utilisateur relève surtout d'une demande d'information factuelle, théorique, historique ou scientifique.

Réponds STRICTEMENT en JSON :

{
  "isInfoRequest": true|false
}

Règles :
- true si la personne demande surtout une information, une explication, une définition, une différence, un fonctionnement
- false si la personne exprime surtout son vécu, une difficulté, une émotion, une demande de présence ou d'exploration
- ne sur-interprète pas
- base-toi d'abord sur le message actuel, puis sur le contexte récent si nécessaire
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

// --------------------------------------------------
// 4) MODE
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
  usedFullHistory,
  {
    suicideLevel = "N0",
    needsClarification = false,
    isQuote = false,
    idiomaticDeathExpression = false,
    crisisResolved = false
  } = {}
) {
  const lines = [`mode: ${mode}`];

  if (suicideLevel !== "N0") {
    lines.push(`suicide: ${suicideLevel}`);
  }

  if (usedFullHistory) {
    lines.push("full_history: yes");
  }

  if (needsClarification) lines.push("needsClarification: true");
  if (isQuote) lines.push("isQuote: true");
  if (idiomaticDeathExpression) lines.push("idiomaticDeathExpression: true");
  if (crisisResolved) lines.push("crisisResolved: true");

  return lines;
}

function useFullHistory(userMessage = "") {
  const msg = String(userMessage).toLowerCase();
  
  const triggers = [
    "reprends toute la conversation",
    "relis toute la conversation",
    "tu te souviens du début",
    "reviens au début",
    "reprends ce qu'on disait avant",
    "reprends ce que j'ai dit avant",
    "relis l'historique",
    "reprends l'historique"
  ];
  
  return triggers.some(t => msg.includes(t));
}

// --------------------------------------------------
// 5) MÉMOIRE
// --------------------------------------------------

async function updateMemory(previousMemory, history) {
  const transcript = history
    .map(m => `${m.role === "user" ? "Utilisateur" : "Assistant"} : ${m.content}`)
    .join("\n");
  
  const system = `
Tu mets à jour une mémoire légère.

Format strict.
Pas de psychologie identitaire.
Items courts.
`;
  
  const user = `
Mémoire précédente :
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
Tu dois t'appuyer sur le modèle théorique ci-dessous pour répondre.

Contraintes :
- Tu dois utiliser activement ce modèle pour structurer ta réponse
- Tu dois rendre visibles certains éléments du modèle (concepts, liens, mécanismes)
- Tu ne dois pas réciter le modèle ni faire un cours complet. Évite donc le style "listes à puces".
- Tu dois reformuler dans un langage accessible dès l'âge de 12 ans sans être infantilisant
- Tu peux faire des correspondances avec d'autres approches si utile
- Tu dois éviter toutes les formules potentiellement culpabilisantes telles que "compétences acquises" et remplacer par des formules neutres telles que "compétences qui n'ont pas pu être transmises"
- Quand tu expliques, privilégie les enchaînements du modèle (ex : honte → acceptation → accès à l’émotion → décharge → transformation)
- Si un élément du modèle est central pour comprendre la situation, ne l'omet pas
- Évite de parler du "corps" comme s’il était séparé. Préfère parler de mémoire corporelle

Priorités (non négociables si pertinentes dans la situation) :
- la honte
- la décharge émotionnelle
- la transformation partielle
- Quand tu décris un processus de transformation, explicite clairement la séquence:
  honte→acceptation→accès à l’émotion→décharge→transformation

Important :
- N'utilise pas d'explications vagues ou génériques
- Ne reviens pas à un langage psychologique standard
- Privilégie les mécanismes du modèle (mémoire, arbitrage, acceptation, décharge, croyances…)
- Ne parle pas de mécanismes de défense mais de mécanismes adaptatifs
- Chaque réponse doit expliquer avec des mots concrets ce que le concept change dans l'expérience vécue
- Évite le charabia théorique. Si tu utilises un concept du modèle, montre à quoi il correspond concrètement
- Si la situation implique un blocage ou une absence de changement, intègre explicitement :
  - la possibilité d'une transformation toujours en cours
  - le rôle de la honte dans le ralentissement voire le blocage du processus
  - le passage par de la décharge émotionnelle

Terminologie à respecter(ne pas paraphraser):
  - mémoire corporelle
  - mémoire autobiographique
  - résistance naturelle au changement
  - croyances limitantes
  - décharge émotionnelle
  - honte
  - acceptation
Ces termes sont centraux dans le modèle. Tu dois les utiliser tels quels et éviter de les remplacer par des synonymes.

Modèle :
1. Mémoire et conscience
  1.1. Mémoire
    1.1.1. Mémoire corporelle
      Encodée en sensations, émotions, mouvements
    1.1.2. Mémoire autobiographique
      Encodée en langage, images, symboles
    Ces deux mémoires sont en interaction permanente.
  1.2. Conscience
    Les deux formes de conscience encodent chacune à leur manière dans les mémoires corporelle +/- autobiographique. Il n'y a pas d'inconscient, de subconscient tout comme on ne peut pas ne pas être conscient. Ce sont les mémoires qui ne sont pas alignées.
    1.2.1. Conscience directe
      → arbitrage et encodage immédiat de l’expérience
        (sensorielle, émotionnelle, motrice, pensées, croyances…)
    1.2.2. Conscience réflexive
      → arbitrage et encodage rétroactifs
        (libre-arbitre)

2. Déconnexion / dissociation
  La déconnexion (ou dissociation) correspond à un désalignement entre mémoire corporelle et mémoire autobiographique.

  Elle apparaît :
    lors de saturations du système nerveux (trauma aigu)
    lors de microtraumatismes répétés (maltraitances, négligences…)
    par activation de croyances limitantes
    ou par choix adaptatif réfléchi (mise à distance volontaire)

3. Principe adaptatif
  Aucun mécanisme interne n’est pathologique.

  Les mécanismes observés sont toujours :
    adaptatifs
    réponses à des contraintes

  Les contraintes peuvent venir :
    du corps (troubles neurologiques, hormonaux…)
    des systèmes d’appartenance (famille, école, travail, société…)

  Il n'y a donc pas de psychopathologie ni de "santé mentale", d'autant que cette logique augmente le vécu d'insuffisance et de honte

4. Croyances limitantes
  Une croyance limitante est un complexe / structure / conglomérat mental, construit ou introjecté.

  Origine :
    activation de la mémoire corporelle
    absence de mise en sens possible via la mémoire autobiographique
    → expérience perçue comme insensée
    → invention de sens

  Statut initial :
    adaptatif
    meilleure réponse possible dans un contexte contraignant

  Évolution :
    devient limitante dans d’autres contextes

  Maintien :
    biais cognitifs (confirmation, effet Pygmalion)
    résistance naturelle au changement

  Remise en question :
    principalement lors de crises existentielles
    sinon évolution marginale

5. Émotions
  Les émotions indiquent la relation à ce qui est perçu comme bon pour soi,
  en lien avec le centre d’évaluation interne et la singularité de l’individu.

  Colère : tentative de modifier ce qui est perçu comme nuisible (déconnexion)
  Peur : tentative de fuir ce qui est perçu comme nuisible (déconnexion)
  Tristesse : relâchement quand aucune action n’est possible (déconnexion)
  Joie : signal de connexion à ce qui est perçu comme bon pour soi

  La joie ne se limite pas à la reconnexion à soi.

6. Peur, anxiété, angoisse
  Peur : réaction directe (conscience directe)

  Anxiété :
    peur maintenue par la conscience réflexive
    avec un objet crédible

  Angoisse :
    anxiété sans objet
    → peur de ressentir

7. Acceptation et transformation
  La transformation repose sur :
    l’acceptation de l’expérience
    la diminution de la honte

  Processus :
    confrontation à la honte
    traversée
    accès à l’émotion sous-jacente
    décharge
    réalignement mémoire corporelle / autobiographique
    modification des croyances
    élargissement du champ d’action

  Indicateur :
    diminution des comportements défensifs ou évitants non délibérés
  
  La transformation peut être partielle
  Une première connexion peut donner l’illusion que “le travail est fait”
  Le maintien des réactions n’indique pas un échec
  Il reflète:
    soit une connexion incomplète
    soit un rythme propre du système auquel la mémoire autobiographique a du mal à s'accorder du fait d'une croyance limitante culturelle : "je dois être performant(e)"

8. Décharge
  La décharge est :
    affective et corporelle
    non nécessairement verbale

  Elle peut passer par :
    mouvements
    gestes
    expressions non langagières

  Elle reste autobiographique, même sans récit langagier.

  Elle se produit :
    dans la relation à l’autre (incongruence forte)
    puis dans la relation à soi

9. Conditions relationnelles
  Les conditions minimales reposent sur :
    la capacité à être en congruence
    à comprendre de façon empathique
    à offrir un regard positif inconditionnel

  Ces attitudes permettent l’émergence du processus de transformation.

10. Rôle de l’IA
  L’IA peut contribuer sans se substituer.

  En amont :
    honte moins intense relativement
    liée au fait que l’IA ne peut pas réellement comprendre ni juger comme un humain
    première expression

  En parallèle :
    exploration autonome
    identification des zones de non-acceptation

  A posteriori :
    support pour s’offrir les attitudes à soi-même

  Limite :
    transformation profonde liée à la relation humaine

11. Liberté relative
  Le fonctionnement reste automatique.

  Mais :
    diminution des croyances limitantes
    augmentation de l’acceptation
    intégration des contenus
    → élargissement du champ d’action

  Le ressenti de liberté est réel.

Résumé en deux phrases :

  Le seul choix que nous avons en fin de compte c'est d'aller vers plus d'acceptation de notre expérience ou de maintenir voire accentuer son rejet.
  La rejeter c'est vivre dans une forme ou une autre de honte, l'accepter c'est s'offrir de la compréhension et de la compassion, c'est s'aimer soi-même.
` : "";
  
  const modeInstruction =
    mode === "info" ?
    `Réponds directement.` :
    `Reste dans l'exploration sans guider.`;
  
  return `
Tu es Facilitat.io.

Pas de diagnostic.
Pas de coaching.
Pas de prescription.

${modeInstruction}

${modelBlock}

Mémoire :
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
  
  return (r.choices?.[0]?.message?.content || "").trim() || "Je t’écoute.";
}

// --------------------------------------------------
// 7) ROUTE
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
    const wantsFullHistory = useFullHistory(message);
    const activeHistory = wantsFullHistory ? fullHistory : recentHistory;
    const { mode } = await detectMode(message, activeHistory);

    const reply = await generateReply({
      message,
      history: activeHistory,
      memory: previousMemory,
      mode
    });

    const newMemory = await updateMemory(previousMemory, [
      ...activeHistory,
      { role: "user", content: message },
      { role: "assistant", content: reply }
    ]);

    return res.json({
      reply,
      memory: newMemory,
      flags: newFlags,
      debug: buildDebug(mode, wantsFullHistory, {
        suicideLevel: suicide.suicideLevel,
        needsClarification: suicide.needsClarification,
        isQuote: suicide.isQuote,
        idiomaticDeathExpression: suicide.idiomaticDeathExpression,
        crisisResolved: suicide.crisisResolved
      })
    });

  } catch (err) {
    console.error("Erreur /chat:", err);
    return res.json({
      reply: "Je t’écoute.",
      memory: normalizeMemory(""),
      flags: normalizeSessionFlags({}),
      debug: ["error"]
    });
  }
});

app.listen(port, () => {
  console.log(`Serveur lancé sur http://localhost:${port}`);
});