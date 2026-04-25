"use strict";

const { buildDefaultPromptRegistry } = require("./prompts");

function createMemoryHelpers({
  client,
  MODEL_IDS,
  normalizeIntersessionMemory,
  normalizeMemory
}) {
  async function updateMemory(previousMemory, history, promptRegistry = buildDefaultPromptRegistry()) {
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
      lower.includes("mouvements en cours:");

    if (hasTranscriptLeak) {
      return normalizeMemory(previousMemory, promptRegistry);
    }

    if (hasRequiredSections) {
      return cleaned;
    }

    if (isOverriddenUpdateMemory) {
      return cleaned;
    }

    return normalizeMemory(previousMemory, promptRegistry);
  }

  function shouldCompressMemoryCandidate(memoryCandidate = "") {
    const text = String(memoryCandidate || "").trim();
    if (!text) return false;

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
      return candidateMemory;
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

    return finalized;
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
      max_tokens: 220,
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
      lower.includes("mouvements en cours:");

    if (!hasRequiredSections) {
      return normalizeIntersessionMemory(previousIntersessionMemory, promptRegistry);
    }

    return cleaned;
  }

  return {
    compressMemoryIfRedundant,
    finalizeMemoryCandidate,
    shouldCompressMemoryCandidate,
    updateIntersessionMemory,
    updateMemory
  };
}

module.exports = {
  createMemoryHelpers
};
