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
// 2) N2 — URGENCE
// --------------------------------------------------

function n2Response() {
  return "Je t’entends, et là c’est urgent. Si tu es en danger immédiat, appelle le 112 (ou le 15). En France tu peux aussi appeler le 3114. Si tu peux, ne reste pas seul.";
}


// --------------------------------------------------
// 3) DÉTECTION DISSOCIATION / DÉCONNEXION
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
// 4) GÉNÉRATION LIBRE DU LLM
// --------------------------------------------------

async function generateFreeReply(userMessage, history = []) {
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
    const flags = req.body?.flags && typeof req.body.flags === "object" ? req.body.flags : {};
    
    const triage = await llmTriage(userMessage, history);
    
    if (triage.level === "N2") {
      return res.json({
        reply: n2Response(),
        flags,
        showPsycho: false
      });
    }
    
    if (triage.level === "N1" || triage.needs_clarification) {
      const reply = await n1ResponseLLM(userMessage);
      return res.json({
        reply,
        flags,
        showPsycho: false
      });
    }
    
    const reply = await generateFreeReply(userMessage, history);
    
    const dissociation = await detectDissociation(userMessage, history);
    
    const showPsycho =
      dissociation.dissociation === true &&
      flags.noPsycho !== true;
    
    return res.json({
      reply,
      flags,
      showPsycho
    });
    
  } catch (err) {
    console.error("Erreur /chat:", err);
    return res.json({
      reply: "Je t’écoute.",
      flags: {},
      showPsycho: false
    });
  }
});


// --------------------------------------------------

app.listen(port, () => {
  console.log(`Serveur lancé sur http://localhost:${port}`);
});