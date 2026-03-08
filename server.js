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
    title: "Déconnexion de soi",
    offer: "Le programme peut proposer un éclairage bref sur cette sensation.",
    content:
      "Il arrive que l’esprit se mette à distance de l’expérience pour continuer à fonctionner malgré une charge émotionnelle ou cognitive. Cette mise à distance peut donner l’impression d’être spectateur de soi-même. C’est un mécanisme humain fréquent qui vise d’abord la protection."
  }
};


// --------------------------------------------------
// 1) TRIAGE RISQUE SUICIDAIRE
// --------------------------------------------------

async function llmTriage(userMessage) {
  const system = `
Tu fais UNIQUEMENT du triage de risque suicidaire à partir du message utilisateur.
Tu ne donnes AUCUN conseil. Tu produis du JSON STRICT, rien d'autre.

Niveaux :
- N0 : pas de contenu suicidaire explicite
- N1 : idéation passive explicite (souhait de mourir, disparaître, ne plus être là), sans intention ni plan
- N2 : intention, plan, moyens, imminence, auto-agression envisagée pour soi

Règles importantes :
- Ne classe en N1 ou N2 que s'il existe une référence explicite ou quasi explicite à mourir, disparaître, se suicider ou se faire du mal.
- Une phrase vague, elliptique, sombre ou émotionnellement chargée ne suffit pas.
- En l'absence de contenu suicidaire explicite, choisis N0.

Format JSON strict :
{
  "level": "N0|N1|N2",
  "needs_clarification": true|false,
  "is_quote": true|false
}
`;

  const r = await client.chat.completions.create({
    model: "gpt-4.1-mini",
    temperature: 0,
    max_tokens: 80,
    messages: [
      { role: "system", content: system },
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
// 4) DÉTECTION DISSOCIATION / DÉCONNEXION
// --------------------------------------------------

async function detectDissociation(userMessage) {
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

  const r = await client.chat.completions.create({
    model: "gpt-4.1-mini",
    temperature: 0,
    max_tokens: 30,
    messages: [
      { role: "system", content: system },
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
// 5) GÉNÉRATION LIBRE DU LLM
// --------------------------------------------------

async function generateFreeReply(userMessage) {
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

  const r = await client.chat.completions.create({
    model: "gpt-4.1-mini",
    temperature: 0.7,
    messages: [
      { role: "system", content: baseSystem },
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
// 6) ROUTE CHAT
// --------------------------------------------------

app.post("/chat", async (req, res) => {
  try {
    const userMessage = String(req.body?.message ?? "");

    const triage = await llmTriage(userMessage);

    if (triage.level === "N2") {
      return res.json({
        reply: n2Response(),
        showPsycho: false,
        psychoText: null
      });
    }

    if (triage.level === "N1" || triage.needs_clarification) {
      const reply = await n1ResponseLLM(userMessage);
      return res.json({
        reply,
        showPsycho: false,
        psychoText: null
      });
    }

    const reply = await generateFreeReply(userMessage);

    const dissociation = await detectDissociation(userMessage);

    if (dissociation.dissociation) {
      return res.json({
        reply,
        showPsycho: true,
        psychoText: THEORY_LIBRARY.dissociation.content
      });
    }

    return res.json({
      reply,
      showPsycho: false,
      psychoText: null
    });

  } catch (err) {
    console.error("Erreur /chat:", err);
    return res.json({
      reply: "Je t’écoute.",
      showPsycho: false,
      psychoText: null
    });
  }
});


// --------------------------------------------------

app.listen(port, () => {
  console.log(`Serveur lancé sur http://localhost:${port}`);
});