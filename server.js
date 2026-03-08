require("dotenv").config();

const express = require("express");
const OpenAI = require("openai");

const app = express();
const port = process.env.PORT || 3000;

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

app.use(express.static("public"));
app.use(express.json());


// --------------------------------------------------
// 0) TRIAGE RISQUE SUICIDAIRE
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
// 1) N1 — CLARIFICATION DOUCE
// --------------------------------------------------

function n1Fallback() {
  return "Tu dis avoir envie de mourir. Est-ce plutôt une envie de disparaître sans te faire du mal, ou une intention de te suicider ?";
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
// 2) N2 — URGENCE
// --------------------------------------------------

function n2Response() {
  return "Je t’entends, et là c’est urgent. Si tu es en danger immédiat, appelle le 112 (ou le 15). En France tu peux aussi appeler le 3114. Si tu peux, ne reste pas seul.";
}


// --------------------------------------------------
// 3) RÉSUMÉ INTER-SESSIONS
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
// 4) GÉNÉRATION LIBRE DU LLM AVEC CADRE ÉPURÉ
// --------------------------------------------------

async function generateFreeReply(userMessage, history = [], summary = "", isNewSession = false) {
  const baseSystem = `
Tu échanges avec une personne qui parle de son vécu.

Tutoie la personne.

Accueille ce qui est partagé tel que c'est vécu.
Soutiens l'exploration personnelle et le questionnement.
Reste du côté de l'expérience plutôt que des solutions.

Privilégie les reformulations et les affirmations ouvertes.
Quand tu invites à approfondir, préfère souvent une phrase qui laisse de l’espace plutôt qu’une question directe.

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
// 5) ROUTE CHAT
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
    return res.json({ reply, summary: newSummary, flags });

  } catch (err) {
    console.error("Erreur /chat:", err);
    return res.json({ reply: "Je t’écoute." });
  }
});


// --------------------------------------------------

app.listen(port, () => {
  console.log(`Serveur lancé sur http://localhost:${port}`);
});