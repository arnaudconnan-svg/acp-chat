require("dotenv").config();

const express = require("express");
const OpenAI = require("openai");

const app = express();
const port = process.env.PORT || 3000;

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

app.use(express.static("public"));
app.use(express.json());

// --- 0) Pris en compte du risque suicidaire
async function llmTriage(userMessage, history = []) {
  const system = `
Tu fais UNIQUEMENT du triage de risque suicidaire à partir du message utilisateur.
Tu dois tenir compte du CONTEXTE : citation de quelqu'un d'autre, récit, métaphore, chanson, pensée intrusive, etc.
Tu ne donnes AUCUN conseil. Tu produis du JSON STRICT, rien d'autre.

Niveaux :
- N0 : détresse existentielle / désespoir / "plus d'intérêt" sans souhait de mourir.
- N1 : idéation passive (souhait de disparaître, ne plus exister) SANS intention ni plan.
- N2 : intention, plan, moyens, imminence, auto-agression envisagée pour soi.

Ambiguïté :
- Si tu n'es pas sûr que ce soit au sujet de l'utilisateur (ex: citation), mets is_quote=true et choisis le niveau le plus bas compatible.
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
    // garde-fou minimal
    if (!obj || !["N0", "N1", "N2"].includes(obj.level)) {
      return { level: "N1", needs_clarification: true, is_quote: false };
    }
    return obj;
  } catch {
    // Si le modèle sort du JSON, on ne panique pas : on clarifie (N1).
    return { level: "N1", needs_clarification: true, is_quote: false };
  }
}

function n1Fallback(userMessage) {
  // Fallback si le LLM sort n'importe quoi : 1 phrase, clarification intentionnelle
  return "Tu dis avoir envie de mourir. Est-ce plutôt une envie de disparaître sans te faire du mal, ou une intention de te blesser ?";
}

async function n1ResponseLLM(userMessage) {
  const system = `
Tu réponds comme un espace d'écoute inspiré de l'Approche Centrée sur la Personne.
Tu n'es pas un thérapeute, pas un coach, pas un conseiller.

Règle de langage :
- Tu t'adresses toujours à l'utilisateur en le tutoyant.

Contrainte:
- 1 phrase maximum.
- Pas de conseil, pas d'explication, pas d'analyse, pas de psychoéducation.
- Objectif unique: clarification douce pour distinguer:
  (a) citation / quelqu'un d'autre vs (b) l'utilisateur
  ET/OU
  idéation passive vs intention de se blesser.
- Style: sobre, direct, non dramatique.
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
  out = clampToThreeSentences(out); // tu l’as déjà, ça coupera si besoin

  // garde-fou minimal : 1 phrase et pas de dérive Porter
  if (!out || violatesAcp(out) || out.length > 220) return n1Fallback(userMessage);

  return out;
}

function n2Response() {
  return `Je t’entends, et là c’est urgent. Si tu es en danger immédiat, appelle le 112 (ou le 15). En France tu peux aussi appeler le 3114. Si tu peux, ne reste pas seul.`;
}

// --- 1) Détection simple des "attitudes de Porter" (heuristique) ---
function violatesAcp(text) {
  const t = text.toLowerCase();

  // Marqueurs fréquents de conseil / directivité
  const advice = [
    "tu devrais", "vous devriez", "je te conseille", "je vous conseille",
    "essaie de", "essayez de", "il faut", "il faudrait", "tu peux", "vous pouvez",
    "je recommande", "mon conseil", "à ta place", "à votre place"
  ];

  // Marqueurs d'analyse / explication / psychoéducation
  const explain = [
    "cela signifie", "ça signifie", "c'est parce que", "en réalité", 
    "en fait", "ce que tu fais", "ce que vous faites","tu as tendance",
    "vous avez tendance", "inconsciemment", "mécanisme", "schéma", 
    "dynamique", "trauma", "diagnostic"
  ];

  // Questions intrusives / structurantes (on garde le droit de poser une question,
  // mais on évite les interrogatoires et la direction)
  const probing = [
    "depuis quand", "pourquoi", "qu'est-ce qui", "quelle est la cause",
    "est-ce que tu as", "avez-vous", "as-tu déjà"
  ];

  // Trop long = souvent dérive
  const tooLong = text.length > 280; // ajustable

  const hit = (arr) => arr.some((m) => t.includes(m));

  return tooLong || hit(advice) || hit(explain) || hit(probing);
}

// --- 2) Contraindre la brièveté : 1 à 3 phrases max ---
function clampToThreeSentences(text) {
  const cleaned = text.trim().replace(/\s+/g, " ");
  // Coupe sur ponctuation de fin de phrase
  const parts = cleaned.split(/(?<=[.!?…])\s+/).filter(Boolean);
  return parts.slice(0, 3).join(" ").trim();
}

// --- 3) Fallback ultra-sobre si le modèle résiste ---
function fallbackReflect(userMessage) {
  const m = userMessage.trim();
  if (!m) return "Je suis là.";
  // Reflet minimal sans grammaire complexe
  return "Tu dis : " + m;
}

// --- 4) Génération LLM avec "double passe" ---
async function generateAcpReply(userMessage, intensity = "sobre", history = []) {
  const baseSystem = `
Tu es un espace de présence inspiré de l'Approche Centrée sur la Personne (Carl Rogers).
Tu n'es PAS un thérapeute, PAS un coach, PAS un conseiller.

Règle de langage :
- Tu t'adresses toujours à l'utilisateur en le tutoyant.

Règles non négociables :
- 1 à 3 phrases, sobre.
- Jamais de conseils, jamais de solutions, jamais d'enseignement.
- Jamais d'analyse, jamais d'explication, jamais d'interprétation.
- Pas de diagnostic, pas de hypothèses causales ("parce que...").
- Évite les questions. Au maximum UNE question courte, seulement si elle invite à revenir à l'expérience immédiate.

Autorisé :
- Reformulation / reflet de ce qui est dit.
- Reflet émotionnel uniquement si l'émotion est explicitement exprimée.
- Orientation douce vers le ressenti corporel/émotionnel (sans méthode, sans exercice).
- Métaphore descriptive possible, à abandonner si l'utilisateur ne s'y reconnaît pas.

Ajustement d'intensité empathique : ${intensity}
- sobre : très minimal
- moyen : un peu plus chaleureux
- intense : plus proche, sans emphase ni dramatisation
`;

  // Passe 1
const context = history
  .slice(-20)
  .map(m => ({ role: m.role, content: m.content }));

const r1 = await client.chat.completions.create({
  model: "gpt-4.1-mini",
  max_tokens: 90,
  temperature: 0.3,
  messages: [
    { role: "system", content: baseSystem },
    ...context,
    { role: "user", content: userMessage }
  ],
});

  let out = (r1.choices?.[0]?.message?.content ?? "").trim();
  out = clampToThreeSentences(out);

  if (!out || violatesAcp(out)) {
    // Passe 2 : contrainte renforcée (réparation)
    const repairSystem = baseSystem + `
Tu viens de produire une réponse qui risque d'être non-ACP.
Réponds à nouveau en respectant strictement les règles.
Ta réponse doit être uniquement un reflet/reformulation, sans aucun conseil, sans analyse, sans explication.
`;

const context2 = history
  .slice(-20)
  .map(m => ({ role: m.role, content: m.content }));

const r2 = await client.chat.completions.create({
  model: "gpt-4.1-mini",
  max_tokens: 70,
  temperature: 0.2,
  messages: [
    { role: "system", content: repairSystem },
    ...context2,
    { role: "user", content: userMessage }
  ],
});

    out = (r2.choices?.[0]?.message?.content ?? "").trim();
    out = clampToThreeSentences(out);

    if (!out || violatesAcp(out)) {
      // Dernier recours : reflet minimal (toujours ACP-safe)
      out = fallbackReflect(userMessage);
    }
  }

  return out;
}

// --- Route chat ---
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

    const reply = await generateAcpReply(userMessage, "sobre", history);
    return res.json({ reply });
  } catch (err) {
    console.error("Erreur /chat:", err);
    return res.json({ reply: "Je suis là." });
  }
});

app.listen(port, () => {
  console.log(`Serveur lancé sur http://localhost:${port}`);
});