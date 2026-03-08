require("dotenv").config();

const express = require("express");
const OpenAI = require("openai");

const app = express();
const port = process.env.PORT || 3000;

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

app.use(express.static("public"));
app.use(express.json());


// --------------------------------------------------
// 0) BIBLIOTHÈQUE THÉORIQUE
// --------------------------------------------------

const THEORY_LIBRARY = {
  dissociation: {
    key: "dissociation",
    title: "Déconnexion de soi",
    offer: "Le programme peut proposer un éclairage bref sur cette sensation de déconnexion de soi.",
    content:
      "Il arrive que l’esprit se mette à distance de l’expérience pour continuer à fonctionner malgré une charge émotionnelle ou cognitive. Cette mise à distance peut donner l’impression d’être spectateur de soi-même. C’est un mécanisme humain fréquent qui vise d’abord la protection."
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
- Ne classe en N1 ou N2 que s'il existe une référence explicite ou quasi explicite à mourir, disparaître, se suicider ou se faire du mal, dans le message actuel ou dans le contexte immédiat.
- Une phrase vague, elliptique, sombre ou émotionnellement chargée ne suffit pas.
- En l'absence de contenu suicidaire explicite, choisis N0.
- N'utilise pas needs_clarification simplement parce qu'un message est ambigu, bref, flou ou lourd émotionnellement.
- Si le message rapporte les paroles de quelqu'un d'autre, mets is_quote=true.
- Si ambigu entre N1 et N2, choisis N1 et needs_clarification=true.
- Si le message actuel ne contient aucune référence explicite à la mort, au suicide, à la disparition ou à l'auto-agression, choisis N0, sauf si le contexte immédiat parlait déjà explicitement de cela.

Format JSON strict :
{
  "level": "N0|N1|N2",
  "needs_clarification": true|false,
  "is_quote": true|false
}
`;

  const context = history
    .slice(-10)
    .map(m => ({ role: m.role, content: m.content }));

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
Tu réponds de manière brève, claire et non dramatique.
Tu t'adresses à la personne en la tutoyant.
Tu ne donnes pas de conseil.

Objectif unique : clarifier si la personne parle
- d'une envie de disparaître / ne plus être là
ou
- d'une intention de se suicider
ou
- des paroles de quelqu'un d'autre.

Réponse en une phrase maximum.
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
// 4) DÉTECTION THÉMATIQUE
// --------------------------------------------------

async function detectDissociation(userMessage, history = []) {
  const system = `
Tu détectes si le message utilisateur évoque une forme de dissociation, de déconnexion de soi, d'irréalité, d'être à côté de soi, de pilote automatique, de spectateur de soi-même, ou d'absence à soi.

Réponds STRICTEMENT par JSON :
{
  "dissociation": true|false
}

Règles :
- Réponds true seulement si le message évoque réellement ce type d'expérience.
- Réponds false si ce n'est pas le cas.
- Ne produis rien d'autre que le JSON.
`;

  const context = history
    .slice(-6)
    .map(m => ({ role: m.role, content: m.content }));

  const r = await client.chat.completions.create({
    model: "gpt-4.1-mini",
    temperature: 0,
    max_tokens: 30,
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
    return { dissociation: Boolean(obj.dissociation) };
  } catch {
    return { dissociation: false };
  }
}


// --------------------------------------------------
// 5) RÉSUMÉ INTER-SESSIONS
// --------------------------------------------------

async function summarizeSession(previousHistory = [], previousSummary = "") {
  if (!previousHistory || previousHistory.length === 0) return previousSummary;

  const transcript = previousHistory
    .map(m => `${m.role === "user" ? "Utilisateur" : "Assistant"} : ${m.content}`)
    .join("\n");

  const system = `
Tu résumes des échanges entre une personne et un assistant d'écoute.

But :
- conserver uniquement ce qui aide à comprendre la personne dans la durée
- garder les thèmes importants, émotions récurrentes, événements de vie, dynamiques notables
- écrire un résumé court, clair, humain
- ne pas donner de conseil
- si une forme de dissociation ou de déconnexion de soi a été évoquée, le faire apparaître explicitement
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
          "\n\nSession à intégrer :\n" +
          transcript +
          "\n\nNouveau résumé :"
      }
    ],
  });

  return (r.choices?.[0]?.message?.content ?? "").trim() || previousSummary;
}


// --------------------------------------------------
// 6) GÉNÉRATION LIBRE DU LLM
// --------------------------------------------------

async function generateFreeReply(userMessage, history = [], summary = "", isNewSession = false) {
  const baseSystem = `
Tu échanges avec une personne qui parle de son vécu.

Tutoie la personne.

Accueille ce qui est partagé tel que c'est vécu.
Soutiens l'exploration personnelle et le questionnement.
Reste du côté de l'expérience plutôt que des solutions.

Évite autant que possible les questions directes.
Quand tu ouvres quelque chose, fais-le le plus souvent par une reformulation ou une affirmation ouverte.

Langage simple, chaleureux, naturel, humain.
`;

  const context = history
    .slice(-20)
    .map(m => ({ role: m.role, content: m.content }));

  const r = await client.chat.completions.create({
    model: "gpt-4.1-mini",
    temperature: 0.7,
    messages: [
      { role: "system", content: baseSystem },
      ...(isNewSession && summary
        ? [{ role: "system", content: "Résumé des échanges précédents : " + summary }]
        : []),
      ...context,
      { role: "user", content: userMessage }
    ],
  });

  const out = (r.choices?.[0]?.message?.content ?? "").trim();

  if (!out) {
    return "Je t’écoute.";
  }

  return out;
}


// --------------------------------------------------
// 7) NORMALISATION FLAGS
// --------------------------------------------------

function normalizeFlags(flags) {
  const safe = (flags && typeof flags === "object") ? flags : {};

  if (!safe.theoryPrefs || typeof safe.theoryPrefs !== "object") {
    safe.theoryPrefs = {};
  }

  return safe;
}

function isTheoryDisabled(flags, themeKey) {
  return flags?.theoryPrefs?.[themeKey]?.disabled === true;
}


// --------------------------------------------------
// 8) ROUTE CHAT
// --------------------------------------------------

app.post("/chat", async (req, res) => {
  try {
    const userMessage = String(req.body?.message ?? "");
    const history = Array.isArray(req.body?.history) ? req.body.history : [];
    const previousHistory = Array.isArray(req.body?.previousHistory) ? req.body.previousHistory : [];
    const summary = String(req.body?.summary ?? "");
    const isNewSession = Boolean(req.body?.isNewSession);
    const flags = normalizeFlags(req.body?.flags);

    let newSummary = summary;

    if (isNewSession && previousHistory.length > 0) {
      newSummary = await summarizeSession(previousHistory, summary);
    }

    const triage = await llmTriage(userMessage, history);

    if (triage.level === "N2") {
      return res.json({
        reply: n2Response(),
        summary: newSummary,
        flags,
        theory: null
      });
    }

    if (triage.level === "N1" || triage.needs_clarification) {
      const reply = await n1ResponseLLM(userMessage);
      return res.json({
        reply,
        summary: newSummary,
        flags,
        theory: null
      });
    }

    const reply = await generateFreeReply(userMessage, history, newSummary, isNewSession);

    const dissociation = await detectDissociation(userMessage, history);

    let theory = null;

    if (dissociation.dissociation && !isTheoryDisabled(flags, "dissociation")) {
      theory = THEORY_LIBRARY.dissociation;
    }

    return res.json({
      reply,
      summary: newSummary,
      flags,
      theory
    });

  } catch (err) {
    console.error("Erreur /chat:", err);
    return res.json({
      reply: "Je t’écoute.",
      summary: "",
      flags: normalizeFlags({}),
      theory: null
    });
  }
});


// --------------------------------------------------

app.listen(port, () => {
  console.log(`Serveur lancé sur http://localhost:${port}`);
});