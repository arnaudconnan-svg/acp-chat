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
- Si citation probable → is_quote=true + niveau le plus bas compatible
- Si ambigu N1/N2 → N1 + needs_clarification=true

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
Tu réponds comme un espace d'écoute inspiré de l'Approche Centrée sur la Personne.
Tu n'es pas un thérapeute, pas un coach, pas un conseiller.

- Tutoiement
- 1 phrase maximum
- Pas de conseil
- Pas d'explication
- Pas d'analyse

Objectif : clarification douce
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
  
  let out = (r.choices?.[0]?.message?.content ?? "").trim();
  out = clampToThreeSentences(out);
  
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
// 3) OUTILS
// --------------------------------------------------

function clampToThreeSentences(text) {
  const cleaned = text.trim().replace(/\s+/g, " ");
  const parts = cleaned.split(/(?<=[.!?…])\s+/).filter(Boolean);
  return parts.slice(0, 3).join(" ").trim();
}

function fallbackReflect(userMessage) {
  const m = userMessage.trim();
  if (!m) return "Je te lis.";
  return "Tu dis : " + m;
}


// --------------------------------------------------
// 4) GÉNÉRATION ACP — VERSION ÉPURÉE
// --------------------------------------------------

async function generateAcpReply(userMessage, history = []) {
  const baseSystem = `
Tu es un espace d'écoute inspiré de l'Approche Centrée sur la Personne.

Tu réponds brièvement (1 à 3 phrases).
Tu t'adresses à la personne en la tutoyant.

Tu accueilles ce qui est exprimé tel que c'est vécu.
Tu reformules ou reflètes l'expérience sans conseiller, sans expliquer, sans analyser.

Priorité : présence simple et chaleureuse, langage naturel, proximité humaine.
`;
  
  const context = history
    .slice(-20)
    .map(m => ({ role: m.role, content: m.content }));
  
  const r = await client.chat.completions.create({
    model: "gpt-4.1-mini",
    max_tokens: 90,
    temperature: 0.3,
    messages: [
      { role: "system", content: baseSystem },
      ...context,
      { role: "user", content: userMessage }
    ],
  });
  
  let out = (r.choices?.[0]?.message?.content ?? "").trim();
  out = clampToThreeSentences(out);
  
  if (!out) {
    out = fallbackReflect(userMessage);
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
    
    const triage = await llmTriage(userMessage, history);
    
    if (triage.level === "N2") {
      return res.json({ reply: n2Response() });
    }
    
    if (triage.level === "N1" || triage.needs_clarification) {
      const reply = await n1ResponseLLM(userMessage);
      return res.json({ reply });
    }
    
    const reply = await generateAcpReply(userMessage, history);
    return res.json({ reply });
    
  } catch (err) {
    console.error("Erreur /chat:", err);
    return res.json({ reply: "Je te lis." });
  }
});


// --------------------------------------------------

app.listen(port, () => {
  console.log(`Serveur lancé sur http://localhost:${port}`);
});