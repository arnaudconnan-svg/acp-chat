require("dotenv").config();

const express = require("express");
const OpenAI = require("openai");

const app = express();
const port = process.env.PORT || 3000;

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

app.use(express.static("public"));
app.use(express.json());


// --------------------------------------------------
// 0) BIBLIOTHÈQUE THÉORIQUE (MINIMALE POUR TEST)
// --------------------------------------------------

const THEORY_LIBRARY = {
  dissociation: {
    title: "Déconnexion de soi",
    offer:
      "Le programme peut proposer un éclairage bref sur cette sensation de déconnexion de soi.",
    content:
      "Il arrive que l’esprit se mette à distance de l’expérience pour continuer à fonctionner malgré une charge émotionnelle ou cognitive. Cette forme de mise à distance peut donner l’impression d’être spectateur de soi-même. C’est un mécanisme humain fréquent qui vise d’abord la protection."
  }
};


// --------------------------------------------------
// 1) TRIAGE RISQUE SUICIDAIRE
// --------------------------------------------------

async function llmTriage(userMessage, history = []) {
  const system = `
Tu fais UNIQUEMENT du triage de risque suicidaire à partir du message utilisateur.
Tu tiens compte du CONTEXTE : citation, récit, métaphore, chanson, pensée intrusive, etc.
Tu ne donnes AUCUN conseil. Tu produis du JSON STRICT, rien d'autre.

Niveaux :
- N0 : pas de contenu suicidaire explicite
- N1 : idéation passive explicite (souhait de mourir, disparaître, ne plus être là), sans intention ni plan
- N2 : intention, plan, moyens, imminence, auto-agression envisagée pour soi

Règles importantes :
- Ne classe en N1 ou N2 que s'il existe une référence explicite ou quasi explicite à mourir, disparaître, se suicider ou se faire du mal.
- Une phrase vague ou émotionnelle ne suffit pas.
- En l'absence de contenu suicidaire explicite, choisis N0.

Format JSON strict :
{
  "level": "N0|N1|N2",
  "needs_clarification": true|false,
  "is_quote": true|false
}
`;

  const context = history.slice(-10).map(m => ({ role: m.role, content: m.content }));

  const r = await client.chat.completions.create({
    model: "gpt-4.1-mini",
    temperature: 0,
    max_tokens: 80,
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

    if (!obj || !["N0", "N1", "N2"].includes(obj.level)) {
      return { level: "N0", needs_clarification: false, is_quote: false };
    }

    return obj;
  } catch {
    return { level: "N0", needs_clarification: false, is_quote: false };
  }
}


// --------------------------------------------------
// 2) N1 — CLARIFICATION DOUCE
// --------------------------------------------------

function n1Fallback() {
  return "Tu parles d’une envie de disparaître, ou d’une intention de te faire du mal ?";
}

async function n1ResponseLLM(userMessage) {
  const system = `
Réponse brève, claire, non dramatique.
Tutoiement.
Pas de conseil.

Objectif : clarifier idéation passive vs intention.
1 phrase maximum.
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
  return "Je t’entends, et là c’est urgent. Si tu es en danger immédiat, appelle le 112 (ou le 15). En France tu peux aussi appeler le 3114. Si tu peux, ne reste pas seul.";
}


// --------------------------------------------------
// 4) DÉTECTION THÈMES (PLACEHOLDER SIMPLE)
// --------------------------------------------------

async function detectThemes(userMessage) {
  const system = `
Tu détectes si le message évoque une forme de dissociation ou de déconnexion de soi.
Réponds STRICTEMENT par JSON :
{ "dissociation": true|false }
`;

  const r = await client.chat.completions.create({
    model: "gpt-4.1-mini",
    temperature: 0,
    max_tokens: 20,
    messages: [
      { role: "system", content: system },
      { role: "user", content: userMessage }
    ],
  });

  try {
    return JSON.parse(r.choices?.[0]?.message?.content ?? "{}");
  } catch {
    return { dissociation: false };
  }
}


// --------------------------------------------------
// 5) RÉSUMÉ INTER-SESSIONS
// --------------------------------------------------

async function summarizeSession(previousHistory = [], previousSummary = "") {
  if (!previousHistory.length) return previousSummary;

  const transcript = previousHistory
    .map(m => `${m.role === "user" ? "Utilisateur" : "Assistant"} : ${m.content}`)
    .join("\n");

  const system = `
Résume brièvement les éléments durables :
- thèmes
- émotions récurrentes
- dynamiques personnelles
- événements de vie importants
- mention explicite si dissociation évoquée
`;

  const r = await client.chat.completions.create({
    model: "gpt-4.1-mini",
    temperature: 0.3,
    messages: [
      { role: "system", content: system },
      {
        role: "user",
        content:
          "Résumé précédent :\n" +
          (previousSummary || "(aucun)") +
          "\n\nSession :\n" +
          transcript +
          "\n\nNouveau résumé :"
      }
    ],
  });

  return (r.choices?.[0]?.message?.content ?? "").trim() || previousSummary;
}


// --------------------------------------------------
// 6) GÉNÉRATION RÉPONSE PRINCIPALE
// --------------------------------------------------

async function generateFreeReply(userMessage, history = [], summary = "", isNewSession = false) {
  const baseSystem = `
Tu échanges avec une personne qui parle de son vécu.
Tutoiement.
Accueil de l’expérience.
Exploration plutôt que solution.
Langage simple, naturel, humain.
`;

  const context = history.slice(-20).map(m => ({ role: m.role, content: m.content }));

  const r = await client.chat.completions.create({
    model: "gpt-4.1-mini",
    temperature: 0.7,
    messages: [
      { role: "system", content: baseSystem },
      ...(isNewSession && summary
        ? [{ role: "system", content: "Résumé : " + summary }]
        : []),
      ...context,
      { role: "user", content: userMessage }
    ],
  });

  const out = (r.choices?.[0]?.message?.content ?? "").trim();
  return out || "Je t’écoute.";
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
    const flags = req.body?.flags && typeof req.body.flags === "object" ? req.body.flags : {};
    const isNewSession = Boolean(req.body?.isNewSession);

    let newSummary = summary;

    if (isNewSession && previousHistory.length > 0) {
      newSummary = await summarizeSession(previousHistory, summary);
    }

    const triage = await llmTriage(userMessage, history);

    if (triage.level === "N2") {
      return res.json({ reply: n2Response(), summary: newSummary, flags });
    }

    if (triage.level === "N1" || triage.needs_clarification) {
      const reply = await n1ResponseLLM(userMessage);
      return res.json({ reply, summary: newSummary, flags });
    }

    const reply = await generateFreeReply(userMessage, history, newSummary, isNewSession);

    // --- Détection thèmes psychoéducatifs
    const themes = await detectThemes(userMessage);

    return res.json({
      reply,
      summary: newSummary,
      flags,
      theory: themes.dissociation ? THEORY_LIBRARY.dissociation : null
    });

  } catch (err) {
    console.error("Erreur /chat:", err);
    return res.json({ reply: "Je t’écoute." });
  }
});


// --------------------------------------------------

app.listen(port, () => {
  console.log(`Serveur lancé sur http://localhost:${port}`);
});