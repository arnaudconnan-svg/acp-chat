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
- N0 : détresse sans souhait de mourir
- N1 : idéation passive sans intention ni plan
- N2 : intention, plan, moyens, imminence

Ambiguïté :
- Si citation probable, mets is_quote=true et choisis le niveau le plus bas compatible.
- Si ambigu entre N1 et N2, choisis N1 et needs_clarification=true.

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
      return { level: "N1", needs_clarification: true, is_quote: false };
    }
    
    return obj;
  } catch {
    return { level: "N1", needs_clarification: true, is_quote: false };
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
// 3) GÉNÉRATION LIBRE DU LLM AVEC CADRE ÉPURÉ
// --------------------------------------------------

async function generateFreeReply(userMessage, history = []) {
  const baseSystem = `
Tu échanges avec une personne qui parle de son vécu.

Tutoie la personne.

Accueille ce qui est partagé tel que c'est vécu.
Soutiens l'exploration personnelle et le questionnement.
Reste du côté de l'expérience plutôt que des solutions.

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
// 4) ROUTE CHAT
// --------------------------------------------------

app.post("/chat", async (req, res) => {
  try {
    const userMessage = String(req.body?.message ?? "");
    const history = Array.isArray(req.body?.history) ? req.body.history : [];
    
    const triage = await llmTriage(userMessage, history);
    
    if (triage.level === "N2") {
      return res.json({ reply: n2Response() });
    }
    
    if (triage.level === "N1" || triage.needs_clarification) {
      const reply = await n1ResponseLLM(userMessage);
      return res.json({ reply });
    }
    
    const reply = await generateFreeReply(userMessage, history);
    return res.json({ reply });
    
  } catch (err) {
    console.error("Erreur /chat:", err);
    return res.json({ reply: "Je t’écoute." });
  }
});


// --------------------------------------------------

app.listen(port, () => {
  console.log(`Serveur lancé sur http://localhost:${port}`);
});