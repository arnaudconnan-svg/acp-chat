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


// --------------------------------------------------
// 1) ANALYSE UNIQUE : TRIAGE + SOLUTIONS + INFO
// --------------------------------------------------

async function analyzeMessage(userMessage, history = []) {
  const system = `
Tu fais une analyse rapide du message utilisateur et du contexte récent.

Tu dois identifier quatre choses :
1. le niveau de risque suicidaire
2. si une clarification est nécessaire
3. si la personne demande explicitement des solutions
4. si la personne pose une question d'information factuelle

Réponds STRICTEMENT par JSON :
{
  "suicideLevel": "N0|N1|N2",
  "needsClarification": true|false,
  "isQuote": true|false,
  "solutionRequest": true|false,
  "infoRequest": true|false
}

Règles :

Risque suicidaire :
- N0 : pas de contenu suicidaire explicite
- N1 : idéation passive explicite
- N2 : intention ou plan

Ne classe en N1 ou N2 que s'il existe une référence explicite à mourir,
disparaître, au suicide, ou au fait de se faire du mal.

NeedsClarification ne doit être true que s'il existe déjà une référence explicite
ou quasi explicite à mourir, disparaître, au suicide, ou au fait de se faire du mal,
mais que le niveau exact reste ambigu.

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

Une question banale de reprise de conversation comme
"Où en était-on ?",
"On en était où ?",
"De quoi on parlait déjà ?"
doit être classée N0.

Demande explicite de solutions :
solutionRequest = true seulement si la personne demande clairement
- des idées
- des conseils
- des pistes
- quoi faire
- comment s'y prendre

Demande d'information factuelle :
infoRequest = true si la personne demande
- si quelque chose existe
- si des recherches ont été faites
- si des auteurs ont travaillé sur un sujet
- une information historique, théorique ou scientifique

Si solutionRequest est true alors infoRequest doit être false.
`;

  const context = history
    .slice(-MAX_HISTORY_FOR_ANALYSIS)
    .map(m => ({ role: m.role, content: m.content }));

  const r = await client.chat.completions.create({
    model: "gpt-4.1-mini",
    temperature: 0,
    max_tokens: 140,
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

    const suicideLevel = ["N0", "N1", "N2"].includes(obj.suicideLevel)
      ? obj.suicideLevel
      : "N0";

    const needsClarification =
      (suicideLevel === "N1" || suicideLevel === "N2")
        ? obj.needsClarification === true
        : false;

    return {
      suicideLevel,
      needsClarification,
      isQuote: obj.isQuote === true,
      solutionRequest: obj.solutionRequest === true,
      infoRequest: obj.solutionRequest === true ? false : obj.infoRequest === true
    };

  } catch {
    return {
      suicideLevel: "N0",
      needsClarification: false,
      isQuote: false,
      solutionRequest: false,
      infoRequest: false
    };
  }
}


// --------------------------------------------------
// 2) N1 — CLARIFICATION
// --------------------------------------------------

function n1Fallback() {
  return "Quand tu dis ça, est-ce que tu parles d’une envie de disparaître ou de te faire du mal ?";
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
- d'une envie de disparaître
- d'une intention de se faire du mal
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
  infoRequest = false
) {
  if (infoRequest) {
    solutionRequest = false;
  }

  const baseSystem = `
Tu échanges avec une personne qui parle de son vécu.

Tutoie la personne.

Accueille ce qui est partagé tel que c'est vécu.

Réponds aussi brièvement que possible tout en restant aidant.

Quand la personne pose une question factuelle,
réponds directement à la question.

Ne transforme pas une question factuelle en introspection.


Cadre conceptuel du programme :

Le programme n’emploie pas le lexique de la maladie
pour décrire le psychisme.

Quand une contrainte biologique ou neurologique est en jeu,
elle concerne le corps.

Les manifestations psychiques sont comprises ici
comme des expressions sous contrainte,
pas comme des maladies du psychisme.

Ce qui n’est pas encore accessible au récit autobiographique
peut relever d’une mémoire corporelle consciente
mais non encore auto-réflexive.

Le récit autobiographique est une manifestation
de l’intelligence organismique,
pas son contraire.

Évite le lexique psychopathologique classique
quand il ne correspond pas à ce cadre.


Positionnement dans la conversation :

N'affirme pas adhérer à une vision du monde,
à une croyance ou à une étiquette
comme si elle allait de soi.

N'argumente pas contre la personne.

Ne fais pas non plus semblant d'être d'accord
si le cadre du programme s'en écarte.

Quand une croyance ou une étiquette semble importante,
reconnais qu'elle peut avoir une fonction
ou une utilité pour la personne,
sans la présenter comme une vérité définitive.


Facilitation du processus :

Ne cherche pas à produire une conclusion,
une interprétation
ou une prise de conscience spécifique.

Maintiens l'attention sur l'expérience vécue
et sur ce qui se manifeste dans l'instant.

Si la conversation s'éloigne durablement
de l'expérience vécue,
tu peux doucement inviter à y revenir,
sans imposer de direction ni de signification.


Usage du résumé :

Les informations issues du résumé
servent uniquement de contexte et de continuité.

Elles ne doivent jamais enfermer la personne
dans une description stable.

Chaque message est accueilli
comme une expression actuelle,
même si le thème diffère de ce qui a été dit auparavant.
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

Explique brièvement que ce programme soutient plutôt
le développement du centre d’évaluation interne.

Ne propose pas de liste de solutions.
`
    });
  }

  if (infoRequest) {
    extraSystemMessages.push({
      role: "system",
      content: `
La personne pose une question factuelle.

Réponds directement.

Tu peux citer
- auteurs
- courants
- recherches
- domaines
`
    });
  }

  const r = await client.chat.completions.create({
    model: "gpt-4.1-mini",
    temperature: 0.7,
    messages: [
      { role: "system", content: baseSystem },
      ...extraSystemMessages,
      ...context,
      { role: "user", content: userMessage }
    ],
  });

  const out = (r.choices?.[0]?.message?.content ?? "").trim();

  return out || "Je t’écoute.";
}


// --------------------------------------------------
// 8) NORMALISATION FLAGS
// --------------------------------------------------

function normalizeFlags(flags) {
  return (flags && typeof flags === "object") ? flags : {};
}


// --------------------------------------------------
// 9) ROUTE CHAT
// --------------------------------------------------

app.post("/chat", async (req, res) => {
  try {
    const userMessage = String(req.body?.message ?? "");
    const history = Array.isArray(req.body?.history) ? req.body.history : [];
    const previousHistory = Array.isArray(req.body?.previousHistory) ? req.body.previousHistory : [];
    const summary = String(req.body?.summary ?? "");
    const isNewSession = Boolean(req.body?.isNewSession);
    const flags = normalizeFlags(req.body?.flags);

    const safeIsNewSession = isNewSession && previousHistory.length > 0;
    const sessionRestarted = safeIsNewSession;

    let newSummary = summary;

    if (sessionRestarted) {
      newSummary = await summarizeSession(previousHistory, summary);
    }

    const analysis = await analyzeMessage(userMessage, history);

    if (analysis.suicideLevel === "N2") {
      return res.json({
        reply: n2Response(),
        summary: newSummary,
        flags,
        isNewSession: safeIsNewSession,
        sessionRestarted
      });
    }

    if (analysis.suicideLevel === "N1" || analysis.needsClarification) {
      const reply = await n1ResponseLLM(userMessage);

      return res.json({
        reply,
        summary: newSummary,
        flags,
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
      analysis.infoRequest
    );

    return res.json({
      reply,
      summary: newSummary,
      flags,
      isNewSession: safeIsNewSession,
      sessionRestarted
    });

  } catch (err) {
    console.error("Erreur /chat:", err);

    return res.json({
      reply: "Je t’écoute.",
      summary: "",
      flags: normalizeFlags({}),
      isNewSession: false,
      sessionRestarted: false
    });
  }
});

app.listen(port, () => {
  console.log(`Serveur lancé sur http://localhost:${port}`);
});