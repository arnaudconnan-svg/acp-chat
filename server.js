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

// --------------------------------------------------
// 2) SUICIDE RISK HYBRIDE (ROBUSTE)
// --------------------------------------------------

const N2_PATTERNS = [
  "je vais me suicider",
  "je veux me suicider",
  "je vais me tuer",
  "je veux me tuer",
  "j'ai prévu de me suicider",
  "j'ai prévu de me tuer",
  "je vais mettre fin à ma vie",
  "je veux mettre fin à ma vie"
];

const N1_PATTERNS = [
  "je veux mourir",
  "envie de mourir",
  "envie d'en finir",
  "je veux disparaître",
  "je n'ai plus envie de vivre",
  "je veux plus vivre",
  "fatigué de vivre"
];

const IDIOMATIC_PATTERNS = [
  "ça me tue",
  "tu me tues",
  "mort de rire",
  "mourir de honte"
];

function includesAny(msg, patterns) {
  return patterns.some(p => msg.includes(p));
}

function heuristicSuicideAnalysis(message = "") {
  const msg = String(message || "").toLowerCase().trim();

  // idiomatique → N0 prioritaire
  if (includesAny(msg, IDIOMATIC_PATTERNS)) {
    return { suicideLevel: "N0", needsClarification: false, source: "heuristic_idiom" };
  }

  // N2 direct
  if (includesAny(msg, N2_PATTERNS)) {
    return { suicideLevel: "N2", needsClarification: false, source: "heuristic_n2" };
  }

  // N1
  if (includesAny(msg, N1_PATTERNS)) {
    return { suicideLevel: "N1", needsClarification: true, source: "heuristic_n1" };
  }

  return null;
}

async function llmSuicideAnalysis(message = "") {
  const system = `
Analyse le risque suicidaire.

Réponds STRICTEMENT en JSON :

{
  "suicideLevel": "N0|N1|N2",
  "needsClarification": true|false
}

Règles strictes :
- Ne sur-interprète jamais
- N1 uniquement si ambigu
- N2 uniquement si explicite
`;

  const r = await client.chat.completions.create({
    model: "gpt-4.1-mini",
    temperature: 0,
    max_tokens: 80,
    messages: [
      { role: "system", content: system },
      { role: "user", content: message }
    ]
  });

  try {
    const raw = (r.choices?.[0]?.message?.content || "").replace(/```json|```/g, "").trim();
    const parsed = JSON.parse(raw);

    return {
      suicideLevel: ["N0","N1","N2"].includes(parsed.suicideLevel) ? parsed.suicideLevel : "N0",
      needsClarification: parsed.needsClarification === true,
      source: "llm"
    };
  } catch {
    return { suicideLevel: "N0", needsClarification: false, source: "llm_fallback" };
  }
}

async function analyzeSuicideRisk(message = "") {
  const heuristic = heuristicSuicideAnalysis(message);

  if (heuristic) return heuristic;

  return await llmSuicideAnalysis(message);
}

// N1 question
async function n1Response(message) {
  const system = `
Pose UNE question simple pour clarifier si la personne parle de mourir.
Tutoiement. Une seule phrase.
`;

  const r = await client.chat.completions.create({
    model: "gpt-4o",
    temperature: 0,
    max_tokens: 50,
    messages: [
      { role: "system", content: system },
      { role: "user", content: message }
    ]
  });

  return (r.choices?.[0]?.message?.content || "").trim() ||
    "Quand tu dis ça, tu parles d’une envie de mourir ou d’autre chose ?";
}

// N2
function n2Response() {
  return "Je t’entends. Si le danger est immédiat, appelle le 112 ou le 3114 tout de suite. Si tu peux, ne reste pas seul.";
}

// --------------------------------------------------
// 3) MODE
// --------------------------------------------------

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
  if (isInfoRequest(message)) return "info";
  return "exploration";
}

function buildDebug(mode, usedFullHistory, suicide = "N0", source = "") {
  return [
    `mode: ${mode}`,
    `suicide: ${suicide}`,
    `source: ${source}`,
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
// 4) MÉMOIRE
// --------------------------------------------------

async function updateMemory(previousMemory, history) {
  const transcript = history
    .map(m => `${m.role === "user" ? "Utilisateur" : "Assistant"} : ${m.content}`)
    .join("\n");
  
  const system = `
Tu mets à jour une mémoire légère.

Format strict.
Pas de psychologie identitaire.
Items courts.
`;
  
  const user = `
Mémoire précédente :
${normalizeMemory(previousMemory)}

Conversation :
${transcript}
`;
  
  const r = await client.chat.completions.create({
    model: "gpt-4.1-mini",
    temperature: 0.2,
    max_tokens: 200,
    messages: [
      { role: "system", content: system },
      { role: "user", content: user }
    ]
  });
  
  return (r.choices?.[0]?.message?.content || "").trim() || normalizeMemory(previousMemory);
}

// --------------------------------------------------
// 5) PROMPT
// --------------------------------------------------

function buildSystemPrompt(mode, memory) {
  const modeInstruction =
    mode === "info"
      ? `Réponds directement.`
      : `Reste dans l'exploration sans guider.`;
  
  return `
Tu es Facilitat.io.

Pas de diagnostic.
Pas de coaching.
Pas de prescription.

${modeInstruction}

Mémoire :
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
// 6) ROUTE
// --------------------------------------------------

app.post("/chat", async (req, res) => {
  try {
    const message = String(req.body?.message || "");
    const recentHistory = trimHistory(req.body?.recentHistory);
    const fullHistory = Array.isArray(req.body?.fullHistory) ? req.body.fullHistory : [];
    const previousMemory = normalizeMemory(req.body?.memory);

    // ---- SUICIDE ----
    const suicide = await analyzeSuicideRisk(message);

    if (suicide.suicideLevel === "N2") {
      return res.json({
        reply: n2Response(),
        memory: previousMemory,
        debug: buildDebug("override", false, "N2", suicide.source)
      });
    }

    if (suicide.suicideLevel === "N1" || suicide.needsClarification) {
      const reply = await n1Response(message);

      return res.json({
        reply,
        memory: previousMemory,
        debug: buildDebug("clarification", false, "N1", suicide.source)
      });
    }

    // ---- NORMAL FLOW ----
    const mode = detectMode(message);

    const wantsFullHistory = useFullHistory(message);
    const activeHistory = wantsFullHistory ? fullHistory : recentHistory;

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
      debug: buildDebug(mode, wantsFullHistory, "N0", suicide.source)
    });

  } catch (err) {
    console.error("Erreur /chat:", err);
    return res.json({
      reply: "Je t’écoute.",
      memory: normalizeMemory(""),
      debug: ["error"]
    });
  }
});

app.listen(port, () => {
  console.log(`Serveur lancé sur http://localhost:${port}`);
});