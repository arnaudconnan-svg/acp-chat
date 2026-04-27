"use strict";

const { buildDefaultPromptRegistry } = require("./prompts");

function sanitizeMemoryItems(memoryText = "", allowedInference = false) {
  const FORBIDDEN_TERMS = [
    "inconscient", "subconscient",
    "mecanisme de defense", "mécanisme de défense",
    "mecanismes de defense", "mécanismes de défense",
    "pathologi", "sante mentale", "santé mentale",
    "pour se proteger", "pour se protéger",
    "pour eviter", "pour éviter",
    "pour gerer", "pour gérer",
    "pour controler", "pour contrôler",
    "il decide", "il décide", "elle decide", "elle décide",
    "il cherche a", "il cherche à", "elle cherche a", "elle cherche à",
    "il veut", "elle veut"
  ];
  const AGENCY_PATTERNS = [
    /\b(il|elle)\s+(refuse|choisit|decide|décide|prefere|préfère|evite|évite)\b/i,
    /\bpour\s+(se\s+)?(proteger|protéger|eviter|éviter|gerer|gérer|controler|contrôler)\b/i,
    /\bdesir\s+de\b/i,
    /\bbesoin\s+de\b/i,
    /\benvie\s+de\b/i,
    /\bdecision\s+de\b/i,
    /\bstrateg/i
  ];
  const INFERENCE_MARKERS = [
    /\bsemble\b/i, /\bprobablement\b/i, /\bsans doute\b/i,
    /\bil est possible que\b/i, /\bon peut penser que\b/i,
    /\bon peut supposer\b/i, /\bpeut-etre que\b/i, /\bpeut-être que\b/i
  ];

  const lines = String(memoryText || "").split("\n");
  const sanitized = [];
  const violations = [];

  for (const line of lines) {
    const normalized = line.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
    const isBulletItem = line.trim().startsWith("-") && line.trim().length > 2;

    if (!isBulletItem) {
      sanitized.push(line);
      continue;
    }

    const hasForbiddenTerm = FORBIDDEN_TERMS.some(t =>
      normalized.includes(t.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, ""))
    );
    const hasAgencyPattern = AGENCY_PATTERNS.some(p => p.test(line));

    if (hasForbiddenTerm || hasAgencyPattern) {
      violations.push({ type: "forbidden", line: line.trim() });
      continue;
    }

    if (!allowedInference) {
      const hasInferenceMarker = INFERENCE_MARKERS.some(p => p.test(line));
      if (hasInferenceMarker) {
        violations.push({ type: "inference", line: line.trim() });
        continue;
      }
    }

    sanitized.push(line);
  }

  if (violations.length > 0) {
    console.log("[MEMORY][SANITIZE_VIOLATIONS]", { count: violations.length, violations });
  }

  return sanitized.join("\n");
}

function createMemoryHelpers({
  client,
  MODEL_IDS,
  normalizeIntersessionMemory,
  normalizeMemory
}) {
  async function updateMemory(previousMemory, history, promptRegistry = buildDefaultPromptRegistry(), memoryPrioritySignal = "normal", theoreticalOrientationSignal = "none") {
    const defaultUpdateMemoryPrompt = String(buildDefaultPromptRegistry().UPDATE_MEMORY || "").trim();
    const currentUpdateMemoryPrompt = String(promptRegistry.UPDATE_MEMORY || "").trim();

    const forcedPrefix = "FORCE_MEMORY_OUTPUT:";

    if (
      currentUpdateMemoryPrompt !== defaultUpdateMemoryPrompt &&
      currentUpdateMemoryPrompt.startsWith(forcedPrefix)
    ) {
      const forcedMemory = currentUpdateMemoryPrompt.slice(forcedPrefix.length).trim();
      return forcedMemory || normalizeMemory(previousMemory, promptRegistry);
    }

    const transcript = Array.isArray(history)
      ? history.map(m => `${m.role === "user" ? "Utilisateur" : "Assistant"} : ${m.content}`).join("\n")
      : "";

    const system = currentUpdateMemoryPrompt;
    const isOverriddenUpdateMemory = currentUpdateMemoryPrompt !== defaultUpdateMemoryPrompt;

    const user = `
Memoire precedente :
${normalizeMemory(previousMemory, promptRegistry)}

Signal de priorité mémoire : ${memoryPrioritySignal}
Orientation théorique détectée ce tour : ${theoreticalOrientationSignal}

Conversation :
${transcript}
`;

    const r = await client.chat.completions.create({
      model: MODEL_IDS.analysis,
      temperature: 0.3,
      max_tokens: 400,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user }
      ]
    });

    const rawOutput = String(r.choices?.[0]?.message?.content || "").trim();

    if (!rawOutput) {
      return normalizeMemory(previousMemory, promptRegistry);
    }

    const cleaned = rawOutput.replace(/```[\s\S]*?```/g, "").trim();

    if (!cleaned) {
      return normalizeMemory(previousMemory, promptRegistry);
    }

    const lower = cleaned.toLowerCase();
    const hasTranscriptLeak =
      lower.includes("conversation :") ||
      lower.includes("utilisateur :") ||
      lower.includes("assistant :") ||
      lower.includes("memoire precedente :");

    const hasRequiredSections =
      lower.includes("contexte stable:") &&
      lower.includes("mouvements en cours:") &&
      lower.includes("lecture bot:");

    if (hasTranscriptLeak) {
      return normalizeMemory(previousMemory, promptRegistry);
    }

    if (hasRequiredSections) {
      return sanitizeMemoryItems(cleaned, memoryPrioritySignal === "interpretation_rejected");
    }

    if (isOverriddenUpdateMemory) {
      return cleaned;
    }

    return normalizeMemory(previousMemory, promptRegistry);
  }

  function isMemoryCandidateEmpty(memoryCandidate = "") {
    const text = String(memoryCandidate || "").trim();
    if (!text) return true;
    const mouvementsMatch = text.match(/Mouvements en cours\s*:\s*([\s\S]*?)(?:Lecture bot:|$)/i);
    if (!mouvementsMatch) return true;
    const items = mouvementsMatch[1].trim().split("\n")
      .map(line => line.trim())
      .filter(line => line.startsWith("-") && line.length > 2);
    return items.length === 0;
  }

  function hasPreviousMemoryContent(previousMemory = "") {
    const text = String(previousMemory || "").trim();
    if (!text) return false;
    const mouvementsMatch = text.match(/Mouvements en cours\s*:\s*([\s\S]*?)(?:Lecture bot:|$)/i);
    if (!mouvementsMatch) return false;
    const items = mouvementsMatch[1].trim().split("\n")
      .map(line => line.trim())
      .filter(line => line.startsWith("-") && line.length > 2);
    return items.length > 0;
  }

  function shouldCompressMemoryCandidate(memoryCandidate = "", previousMemory = "") {
    const text = String(memoryCandidate || "").trim();
    if (!text) return false;

    // Guard : si UPDATE_MEMORY a produit un résultat vide alors que la mémoire précédente avait du contenu
    // → déclencher FINALIZE pour récupérer le contenu
    if (isMemoryCandidateEmpty(text) && hasPreviousMemoryContent(previousMemory)) {
      return true;
    }

    const mouvementsMatch = text.match(/Mouvements en cours\s*:\s*([\s\S]*)/i);
    if (!mouvementsMatch) return false;

    const mouvementsBlock = mouvementsMatch[1].trim();
    const items = mouvementsBlock
      .split("\n")
      .map(line => line.trim())
      .filter(line => line.startsWith("-") && line.length > 2);

    return items.length > 2;
  }

  async function finalizeMemoryCandidate({
    previousMemory = "",
    candidateMemory = "",
    interpretationRejection = {},
    needsCompression = false,
    promptRegistry = buildDefaultPromptRegistry()
  } = {}) {
    const user = `
Memoire precedente :
${normalizeMemory(previousMemory, promptRegistry)}

Memoire candidate :
${normalizeMemory(candidateMemory, promptRegistry)}

Analyse du rejet :
${JSON.stringify(interpretationRejection || {})}

Compression demandee :
${needsCompression === true ? "true" : "false"}
`;

    const r = await client.chat.completions.create({
      model: MODEL_IDS.analysis,
      temperature: 0,
      max_tokens: 320,
      messages: [
        { role: "system", content: promptRegistry.FINALIZE_MEMORY_CANDIDATE },
        { role: "user", content: user }
      ]
    });

    const finalized = String(r.choices?.[0]?.message?.content || "").trim();
    if (!finalized) {
      return sanitizeMemoryItems(candidateMemory);
    }

    const lower = finalized.toLowerCase();
    if (
      lower.includes("memoire precedente :") ||
      lower.includes("memoire candidate :") ||
      lower.includes("utilisateur :") ||
      lower.includes("assistant :")
    ) {
      return candidateMemory;
    }

    return sanitizeMemoryItems(finalized);
  }

  async function compressMemoryIfRedundant(memoryCandidate, previousMemory, promptRegistry = buildDefaultPromptRegistry()) {
    const text = String(memoryCandidate || "").trim();
    if (!text) return memoryCandidate;

    const mouvementsMatch = text.match(/Mouvements en cours\s*:\s*([\s\S]*)/i);
    if (!mouvementsMatch) return memoryCandidate;

    const mouvementsBlock = mouvementsMatch[1].trim();
    const items = mouvementsBlock
      .split("\n")
      .map(line => line.trim())
      .filter(line => line.startsWith("-") && line.length > 2);

    if (items.length <= 2) return memoryCandidate;

    const system = `Tu es un compresseur de memoire de session.
Tu recois une memoire qui contient trop d'items (plus de 2 dans "Mouvements en cours").
Tu dois fusionner les items redondants en respectant strictement ces regles :
- 1 a 2 items max dans "Mouvements en cours"
- fusionner tout ce qui decrit le meme phenomene ou la meme dynamique de fond
- supprimer tout item qui est une reformulation, une consequence ou une reaction cognitive d'un item deja present
- garder exactement le format :
Contexte stable:
- ...

Mouvements en cours:
- ...
- 1 item = 1 dynamique distincte
- garder le phenomene le plus structurant si un seul domine
Reponds uniquement par la memoire corrigee, sans commentaire.`;

    const user = `Memoire a compresser :
${text}`;

    try {
      const r = await client.chat.completions.create({
        model: MODEL_IDS.analysis,
        temperature: 0,
        max_tokens: 300,
        messages: [
          { role: "system", content: system },
          { role: "user", content: user }
        ]
      });

      const compressed = String(r.choices?.[0]?.message?.content || "").trim();
      if (!compressed) return memoryCandidate;

      const lower = compressed.toLowerCase();
      if (
        lower.includes("memoire precedente :") ||
        lower.includes("utilisateur :")
      ) {
        return memoryCandidate;
      }

      console.log("[MEMORY][COMPRESSION_TRIGGERED]", { itemsBefore: items.length, compressed });
      return compressed;
    } catch {
      return memoryCandidate;
    }
  }

  async function updateIntersessionMemory(previousIntersessionMemory, sessionMemory, promptRegistry = buildDefaultPromptRegistry()) {
    const defaultPrompt = String(buildDefaultPromptRegistry().UPDATE_INTERSESSION_MEMORY || "").trim();
    const currentPrompt = String(promptRegistry.UPDATE_INTERSESSION_MEMORY || "").trim();

    const system = currentPrompt || defaultPrompt;
    const user = `
Memoire inter-sessions precedente :
${normalizeIntersessionMemory(previousIntersessionMemory, promptRegistry)}

Memoire de session qui se ferme :
${normalizeMemory(sessionMemory, promptRegistry)}
`;

    const r = await client.chat.completions.create({
      model: MODEL_IDS.analysis,
      temperature: 0.1,
      max_tokens: 300,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user }
      ]
    });

    const rawOutput = String(r.choices?.[0]?.message?.content || "").trim();
    if (!rawOutput) {
      return normalizeIntersessionMemory(previousIntersessionMemory, promptRegistry);
    }

    const cleaned = rawOutput.replace(/```[\s\S]*?```/g, "").trim();
    if (!cleaned) {
      return normalizeIntersessionMemory(previousIntersessionMemory, promptRegistry);
    }

    const lower = cleaned.toLowerCase();
    const hasRequiredSections =
      lower.includes("contexte stable:") &&
      (lower.includes("patterns récurrents:") || lower.includes("patterns recurrents:")) &&
      lower.includes("mouvements en cours:");

    if (!hasRequiredSections) {
      return normalizeIntersessionMemory(previousIntersessionMemory, promptRegistry);
    }

    return cleaned;
  }

  return {
    compressMemoryIfRedundant,
    finalizeMemoryCandidate,
    sanitizeMemoryItems,
    shouldCompressMemoryCandidate,
    updateIntersessionMemory,
    updateMemory
  };
}

module.exports = {
  createMemoryHelpers
};
