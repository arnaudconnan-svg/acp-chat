"use strict";

const { normalizeGuardText } = require("./pipeline");
const { buildDefaultPromptRegistry } = require("./prompts");

// ─── Pure sync heuristics ─────────────────────────────────────────────────────

// Detect procedural/instrumental tone in a reply (sync check).
// Used to decide whether the human-field guard should trigger CRITIC_PASS.
function isProceduralInstrumentalReply(reply = "") {
  const text = normalizeGuardText(reply);

  const hasProceduralTone = /voici quelques pistes|pour avancer|si ce n'est pas possible|tu peux aussi|tu peux |on peut |il existe|commence par|essaie de|reviens en arriere|decris brievement|cibler ensemble|copier-coller|isoler|extraire|utilise|ouvre|voir comment|contourner|repartir de|sans passer par|sans repasser par/.test(text);
  const hasInstrumentalObjects = /outil|interface|plateforme|systeme|procedure|manipulation|parametr|reglage|historique|version|fichier|document|section|portion|partie|support|editeur|application/.test(text);
  const hasListStructure = /^\s*[-•]\s/m.test(reply) || /^\s*\d+\.\s/m.test(reply);

  return (hasProceduralTone && hasInstrumentalObjects) || (hasListStructure && hasInstrumentalObjects);
}

// Detect agency injunctions in a reply (sync check).
// Patterns like "tu pourrais", "essaie de" inject implicit agency onto the user.
function hasAgencyInjectionInReply(reply = "") {
  const text = (reply || "").toLowerCase();
  const patterns = [
    "tu pourrais", "essaie de", "il faudrait", "tu devrais",
    "pourquoi ne pas", "je t'encourage", "je te conseille",
    "n'hesite pas a", "n'hésite pas à", "tu devrais peut-etre",
    "tu devrais peut-être"
  ];
  return patterns.some(p => text.includes(p));
}

// Heuristic pre-check: detect tutoiement in a reply when vouvoiement is required.
// Used to trigger CRITIC_PASS when formalAddress is active.
function hasTutoiementInReply(reply = "") {
  return /\btu\b|\btoi\b/.test((reply || "").toLowerCase());
}

// Heuristic pre-check for theoretical violations to decide if CRITIC_PASS should be triggered.
// This avoids an unnecessary LLM call when the reply is clearly clean.
function hasTheoreticalViolationHeuristic(reply = "") {
  const text = (reply || "").toLowerCase();
  const patterns = [
    "inconscient", "subconscient", "non-conscient",
    "mecanisme de defense", "mécanisme de défense",
    "psychopathologie", "santé mentale", "sante mentale",
    "tu évites", "tu evites", "tu résistes", "tu resistes",
    "il y a une résistance", "il y a une resistance",
    "tu refuses de", "tu fais tout pour ne pas"
  ];
  return patterns.some(p => text.includes(p));
}

// ─── Factory ──────────────────────────────────────────────────────────────────

// Creates applySelectiveCritic bound to a specific OpenAI client and model config.
// Pattern mirrors createAnalyzers / createMemoryHelpers used elsewhere in the project.
function createCritic({ client, MODEL_IDS }) {
  // Phase 4 (couche 5): Selective critic — detects and corrects agency injunctions,
  // over-clinicalization, and hollow presence formulas when triggered by a strong signal.
  // Receives postureDecision to enforce the active contract (writerMode + forbidden).
  // It does NOT discover policy — it only corrects violations of an already-decided contract.
  async function applySelectiveCritic({
    reply = "",
    message = "",
    history = [],
    postureDecision = {},
    promptRegistry = buildDefaultPromptRegistry()
  }) {
    const writerMode = postureDecision.writerMode || null;
    const forbidden = Array.isArray(postureDecision.forbidden) && postureDecision.forbidden.length > 0
      ? postureDecision.forbidden
      : [];
    const maxSentences = Number.isFinite(postureDecision.maxSentences) && postureDecision.maxSentences > 0
      ? postureDecision.maxSentences
      : null;
    const humanFieldGuardActive = postureDecision.humanFieldGuardActive === true;
    const formalAddress = postureDecision.formalAddress === true;

    const contractLine = writerMode
      ? `Contrat actif : mode ${writerMode}${forbidden.length ? `, interdit ce tour : ${forbidden.join(", ")}` : ""}`
      : null;
    const contractLengthLine = maxSentences ? `Longueur contractuelle : max ${maxSentences} phrases` : null;
    const contractHumanFieldLine = humanFieldGuardActive ? "Human field guard actif : eviter tout ton procedural/instrumental" : null;
    const contractFormalAddressLine = formalAddress ? "Vouvoiement obligatoire : l'utilisateur s'adresse au bot en vouvoyant — la reponse doit utiliser exclusivement le vouvoiement (vous/votre/vos). Toute occurrence de tu/toi/ton/ta/tes est une violation." : null;

    const userParts = [
      contractLine,
      contractLengthLine,
      contractHumanFieldLine,
      contractFormalAddressLine,
      `Message utilisateur :\n${message}`,

      `Contexte recent :\n${(history || []).map(m => `${m.role === "user" ? "Utilisateur" : "Assistant"} : ${m.content}`).join("\n")}`,
      `Reponse a relire et corriger si necessaire :\n${reply}`
    ].filter(Boolean);
    const user = userParts.join("\n\n");

    const r = await client.chat.completions.create({
      model: MODEL_IDS.analysis,
      temperature: 0,
      max_tokens: 600,
      messages: [
        { role: "system", content: promptRegistry.CRITIC_PASS },
        { role: "user", content: user }
      ]
    });
    try {
      const raw = (r.choices?.[0]?.message?.content || "").replace(/```json|```/g, "").trim();
      const parsed = JSON.parse(raw);
      return {
        reply: typeof parsed.reply === "string" && parsed.reply.trim() ? parsed.reply.trim() : reply,
        criticIssues: Array.isArray(parsed.issues) ? parsed.issues.filter(i => typeof i === "string") : []
      };
    } catch {
      return { reply, criticIssues: [] };
    }
  }

  return { applySelectiveCritic };
}

module.exports = {
  createCritic,
  hasAgencyInjectionInReply,
  hasTutoiementInReply,
  hasTheoreticalViolationHeuristic,
  isProceduralInstrumentalReply
};
