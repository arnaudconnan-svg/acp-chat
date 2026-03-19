require("dotenv").config();
const express = require("express");
const OpenAI = require("openai");

const app = express();
const port = process.env.PORT || 3000;
const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

app.use(express.static("public"));
app.use(express.json());

const MAX_RECENT_TURNS = 8;

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

function isExplicitSuicideRisk(message = "") {
  const msg = String(message).toLowerCase().trim();
  
  const patterns = [
    "je veux me suicider",
    "je vais me suicider",
    "je veux me tuer",
    "je vais me tuer",
    "mettre fin à mes jours",
    "mettre fin à ma vie",
    "en finir avec la vie",
    "je veux mourir",
    "je vais mourir volontairement",
    "j'ai prévu de me suicider",
    "j'ai prévu de me tuer"
  ];
  
  return patterns.some(p => msg.includes(p));
}

function isInfoRequest(message = "") {
  const msg = String(message).trim().toLowerCase();
  
  if (!msg.includes("?")) return false;
  
  const starters = [
    "qu'est-ce que",
    "qu’est-ce que",
    "c'est quoi",
    "c’est quoi",
    "comment fonctionne",
    "comment marche",
    "pourquoi",
    "quelle est la différence",
    "quelle différence",
    "peux-tu expliquer",
    "tu peux expliquer",
    "définis",
    "définition de",
    "est-ce que"
  ];
  
  return starters.some(s => msg.startsWith(s));
}

function detectMode(message = "") {
  if (isExplicitSuicideRisk(message)) return "suicide_risk";
  if (isInfoRequest(message)) return "info";
  return "exploration";
}

function buildDebug(mode, usedFullHistory) {
  return [
    `mode: ${mode}`,
    `full_history: ${usedFullHistory ? "yes" : "no"}`
  ];
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
// 2) MÉMOIRE LÉGÈRE
// --------------------------------------------------

async function updateMemory(previousMemory, history) {
  const transcript = history
    .map(m => `${m.role === "user" ? "Utilisateur" : "Assistant"} : ${m.content}`)
    .join("\n");
  
  const system = `
Tu mets à jour une mémoire légère de conversation.

Format obligatoire :

Thèmes déjà évoqués :
- ...
- ...

Points de vigilance relationnels :
- ...
- ...

Questions encore ouvertes :
- ...
- ...

Règles strictes :
- Ne fais aucune phrase identitaire sur la personne
- N'écris jamais : "la personne est", "elle est", "elle a tendance à", "son profil", "son fonctionnement"
- Pas de diagnostic
- Pas de généralisation psychologique
- Chaque item doit être court, révisable, non essentialisant
- Garde seulement ce qui peut aider la continuité
- Si rien d'important n'est nouveau, conserve l'essentiel sans broder
- Réponse en français uniquement
`;
  
  const user = `
Mémoire précédente :
${normalizeMemory(previousMemory)}

Conversation récente :
${transcript}

Produis la nouvelle mémoire dans le format exact demandé.
`;
  
  const r = await client.chat.completions.create({
    model: "gpt-4.1-mini",
    temperature: 0.2,
    max_tokens: 250,
    messages: [
      { role: "system", content: system },
      { role: "user", content: user }
    ]
  });
  
  return (r.choices?.[0]?.message?.content || "").trim() || normalizeMemory(previousMemory);
}

// --------------------------------------------------
// 3) PROMPT PRINCIPAL
// --------------------------------------------------

function buildSystemPrompt(mode, memory) {
  const modeInstruction =
    mode === "info" ?
    `
Mode actuel : info.
Réponds directement à la question.
Reste sobre.
N'élargis pas vers du conseil pratique ou du coaching sauf si la demande l'impose explicitement.
` :
    `
Mode actuel : exploration.
Reste au plus près de ce que la personne dit.
Ne cherche pas à guider, coacher, diagnostiquer ou conclure trop vite.
N'alimente pas artificiellement la conversation.
`;
  
  return `
Tu es Facilitat.io.

Tu fonctionnes comme un miroir conversationnel.
Tu ne poses pas de diagnostic.
Tu ne coaches pas.
Tu ne prescris pas.
Tu ne remplaces pas une relation d'accompagnement humaine.
Tu restes proche du langage de la personne.
Tu évites le ton scolaire.
Tu laisses de la place à l'inachèvement et au non-savoir.

${modeInstruction}

Repères issus d'échanges précédents.
À utiliser avec prudence.
Ne pas les traiter comme des vérités stables sur la personne.
Ne les utiliser que si cela éclaire le message actuel.

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
    temperature: 1,
    max_tokens: 300,
    messages
  });
  
  return (r.choices?.[0]?.message?.content || "").trim() || "Je t’écoute.";
}

// --------------------------------------------------
// 4) OVERRIDE SUICIDE RISK
// --------------------------------------------------

function suicideRiskReply() {
  return "Je t’entends. Si le danger est immédiat, appelle le 112 ou le 3114 tout de suite. Si tu peux, ne reste pas seul.";
}

// --------------------------------------------------
// 5) ROUTE
// --------------------------------------------------

app.post("/chat", async (req, res) => {
  try {
    const message = String(req.body?.message || "");
    const recentHistory = trimHistory(req.body?.recentHistory);
    const fullHistory = Array.isArray(req.body?.fullHistory) ? req.body.fullHistory : [];
    const previousMemory = normalizeMemory(req.body?.memory);
    
    const mode = detectMode(message);
    
    if (mode === "suicide_risk") {
      return res.json({
        reply: suicideRiskReply(),
        memory: previousMemory,
        debug: buildDebug(mode, false)
      });
    }
    
    const wantsFullHistory = useFullHistory(message);
    const activeHistory = wantsFullHistory ?
      fullHistory.filter(m => m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string") :
      recentHistory;
    
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
      debug: buildDebug(mode, wantsFullHistory)
    });
  } catch (err) {
    console.error("Erreur /chat:", err);
    return res.json({
      reply: "Je t’écoute.",
      memory: normalizeMemory(""),
      debug: ["mode: exploration", "error: yes"]
    });
  }
});

app.listen(port, () => {
  console.log(`Serveur lancé sur http://localhost:${port}`);
});