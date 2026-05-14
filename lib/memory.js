"use strict";

const { buildDefaultPromptRegistry } = require("./prompts");

const MEMORY_INACTIVITY_TTL_MS = 3 * 60 * 60 * 1000;
const MAX_ONGOING_MOVEMENTS = 2;

function normalizeBulletText(text = "") {
  return String(text || "")
    .replace(/\s+/g, " ")
    .trim();
}

function canonicalMemoryTextKey(text = "") {
  return normalizeBulletText(text)
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}

function dedupeDeterministicTexts(texts = [], maxItems = Infinity) {
  const seen = new Set();
  const kept = [];
  for (const raw of texts) {
    const normalized = normalizeBulletText(raw);
    if (!normalized) continue;
    const key = canonicalMemoryTextKey(normalized);
    if (seen.has(key)) continue;
    seen.add(key);
    kept.push(normalized);
    if (kept.length >= maxItems) break;
  }
  return kept;
}

function safeIsoString(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return new Date().toISOString();
  return date.toISOString();
}

function shortStableHash(input = "") {
  const text = String(input || "");
  let h = 0;
  for (let i = 0; i < text.length; i += 1) {
    h = ((h << 5) - h) + text.charCodeAt(i);
    h |= 0;
  }
  return Math.abs(h).toString(36).slice(0, 4) || "0000";
}

function buildMovementId({ text = "", nowMs = Date.now(), index = 0 } = {}) {
  const d = new Date(nowMs);
  const yyyy = String(d.getUTCFullYear());
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  const hh = String(d.getUTCHours()).padStart(2, "0");
  const mi = String(d.getUTCMinutes()).padStart(2, "0");
  const ss = String(d.getUTCSeconds()).padStart(2, "0");
  const suffix = shortStableHash(`${text}|${index}|${nowMs}`);
  return `${yyyy}${mm}${dd}-${hh}${mi}${ss}-${suffix}`;
}

function parseMemorySectionBullets(memoryText = "", sectionLabel = "") {
  const label = String(sectionLabel || "").trim();
  if (!label) return [];
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const text = String(memoryText || "");
  const match = text.match(new RegExp(`${escaped}\\s*:\\s*([\\s\\S]*?)(?:\\n[A-ZÀ-Ü][^:\\n]*:|$)`, "i"));
  if (!match) return [];
  return String(match[1] || "")
    .split("\n")
    .map(line => line.trim())
    .filter(line => line.startsWith("-") && line.replace(/^[-\s]+/, "").trim())
    .map(line => line.replace(/^[-\s]+/, "").trim());
}

function normalizeMovementItem(value, fallbackNowIso = safeIsoString(Date.now())) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const text = typeof value.text === "string" ? value.text.trim() : "";
  const idRaw = String(value.id || "").trim();
  if (!idRaw && !text) return null;
  const id = idRaw || buildMovementId({ text: text || "vide", nowMs: Date.now() });
  return {
    id,
    text,
    createdAt: safeIsoString(value.createdAt || fallbackNowIso),
    archivedAt: value.archivedAt ? safeIsoString(value.archivedAt) : null
  };
}

function normalizeMemoryStateShape(memoryState = null, _fallbackMemoryText = "", nowMs = Date.now()) {
  const nowIso = safeIsoString(nowMs);

  const safe = memoryState && typeof memoryState === "object" && !Array.isArray(memoryState)
    ? memoryState
    : {};

  const sessionStableContext = Array.isArray(safe.sessionStableContext)
    ? safe.sessionStableContext
      .map(line => String(line || "").trim())
      .filter(Boolean)
    : [];

  const onGoingMovements = Array.isArray(safe.onGoingMovements)
    ? safe.onGoingMovements
      .map(item => normalizeMovementItem(item, nowIso))
      .filter(Boolean)
      .slice(0, MAX_ONGOING_MOVEMENTS)
    : [];

  const ancientMovements = Array.isArray(safe.ancientMovements)
    ? safe.ancientMovements
      .map(item => normalizeMovementItem(item, nowIso))
      .filter(Boolean)
    : [];

  const pastSignals = safe.pastSignals && typeof safe.pastSignals === "object" && !Array.isArray(safe.pastSignals)
    ? { ...safe.pastSignals }
    : {};

  return {
    sessionStableContext,
    onGoingMovements,
    ancientMovements,
    pastSignals
  };
}

function renderMemoryTextFromState(memoryState = {}) {
  const safe = normalizeMemoryStateShape(memoryState);
  const stableLines = safe.sessionStableContext.length > 0
    ? safe.sessionStableContext.map(item => `- ${item}`).join("\n")
    : "-";
  const ongoingLines = safe.onGoingMovements.length > 0
    ? safe.onGoingMovements.map(item => `- ${item.text}`).join("\n")
    : "-";
  const ancientLines = safe.ancientMovements.length > 0
    ? safe.ancientMovements.map(item => `- ${item.text}`).join("\n")
    : "-";

  return [
    "Contexte stable:",
    stableLines,
    "",
    "Mouvements en cours:",
    ongoingLines,
    "",
    "Anciens mouvements:",
    ancientLines
  ].join("\n").trim();
}

function applyInactivityPurge(memoryState = {}, { nowMs = Date.now(), lastActivityMs = null, ttlMs = MEMORY_INACTIVITY_TTL_MS } = {}) {
  const safe = normalizeMemoryStateShape(memoryState, "", nowMs);
  if (!Number.isFinite(lastActivityMs) || lastActivityMs <= 0) {
    return { memoryState: safe, purged: false };
  }

  if ((nowMs - lastActivityMs) <= ttlMs) {
    return { memoryState: safe, purged: false };
  }

  return {
    memoryState: {
      ...safe,
      onGoingMovements: [],
      ancientMovements: []
    },
    purged: true
  };
}

function mergeMemoryStateWithFinalizedText({
  previousMemoryState = {},
  finalizedMemoryText = "",
  deleteAncientMovementsById = [],
  pastSignals = {},
  nowMs = Date.now(),
  lastActivityMs = null,
  ttlMs = MEMORY_INACTIVITY_TTL_MS
} = {}) {
  const nowIso = safeIsoString(nowMs);
  const normalizedPrevious = normalizeMemoryStateShape(previousMemoryState, "", nowMs);
  const purgeResult = applyInactivityPurge(normalizedPrevious, { nowMs, lastActivityMs, ttlMs });
  const base = purgeResult.memoryState;

  const sessionStableContext = parseMemorySectionBullets(finalizedMemoryText, "Contexte stable")
    .map(normalizeBulletText)
    .filter(Boolean);
  const nextOngoingTexts = parseMemorySectionBullets(finalizedMemoryText, "Mouvements en cours")
    .map(normalizeBulletText)
    .filter(Boolean);
  const sanitizedOngoingTexts = dedupeDeterministicTexts(nextOngoingTexts, MAX_ONGOING_MOVEMENTS);

  const archivedFromPrevious = base.onGoingMovements.map((item) => ({
    ...item,
    archivedAt: nowIso
  }));

  let ancientMovements = [...base.ancientMovements, ...archivedFromPrevious];

  const deleteIds = Array.isArray(deleteAncientMovementsById)
    ? deleteAncientMovementsById.map(id => String(id || "").trim()).filter(Boolean).slice(0, 2)
    : [];
  if (deleteIds.length > 0) {
    ancientMovements = ancientMovements.filter(item => !deleteIds.includes(String(item.id || "").trim()));
  }

  const onGoingMovements = sanitizedOngoingTexts.map((text, idx) => ({
    id: buildMovementId({ text, nowMs, index: idx }),
    text,
    createdAt: nowIso,
    archivedAt: null
  }));

  const nextState = normalizeMemoryStateShape({
    sessionStableContext,
    onGoingMovements,
    ancientMovements,
    pastSignals: pastSignals && typeof pastSignals === "object" && !Array.isArray(pastSignals)
      ? {
          ...pastSignals,
          updatedAt: nowIso
        }
      : {
          updatedAt: nowIso
        }
  }, "", nowMs);

  return {
    memoryState: nextState,
    memoryText: renderMemoryTextFromState(nextState),
    purgedByInactivity: purgeResult.purged === true
  };
}

function extractSectionBlock(memoryText = "", sectionLabel = "") {
  const label = String(sectionLabel || "").trim();
  if (!label) return null;
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const text = String(memoryText || "");
  const match = text.match(new RegExp(`(${escaped}\\s*:\\s*)([\\s\\S]*?)(?=\\n[A-ZÀ-Ü][^:\\n]*:|$)`, "i"));
  if (!match) return null;
  return {
    fullMatch: match[0],
    header: match[1],
    body: match[2]
  };
}

function normalizeStableContextSelectivity(memoryText = "") {
  const section = extractSectionBlock(memoryText, "Contexte stable");
  if (!section) return String(memoryText || "");

  const lines = String(section.body || "")
    .split("\n")
    .map(line => line.trim())
    .filter(line => line.startsWith("-") && line.replace(/^[-\s]+/, "").trim())
    .map(line => line.replace(/^[-\s]+/, "").trim());

  const DYNAMIC_MARKERS = [
    /\baujourd['’]hui\b/i,
    /\ben ce moment\b/i,
    /\bactuellement\b/i,
    /\bmaintenant\b/i,
    /\bces jours-ci\b/i,
    /\bderniers? jours?\b/i,
    /\bje sens\b/i,
    /\bje ressens\b/i,
    /\bje me sens\b/i,
    /\bça\b|\bca\b/i,
    /\bangoiss|anxie|triste|col[eè]re|pleur|panique|peur\b/i,
    /\bmouvement|d[eé]charge|acceptation|d[eé]connexion|d[eé]salign|croyance\b/i,
    /\bpoint d['’]appui|trajectoire|manifestation\b/i
  ];

  const STABLE_ANCHORS = [
    /\bl['’']utilisateur\s+dit\s+avoir\b/i,
    /\bl['’']utilisateur\s+se\s+d[eé]crit\s+comme\b/i,
    /\btravail|emploi|profession|etudes?|formation\b/i,
    /\bfamille|couple|partenaire|enfant|parent\b/i,
    /\bville|logement|domicile|trajet\b/i,
    /\brythme\s+de\s+vie|organisation\s+de\s+vie\b/i,
    /\bcontrainte\s+(pro|familiale|materielle)\b/i
  ];

  const kept = [];
  for (const item of lines) {
    const hasDynamicMarker = DYNAMIC_MARKERS.some(rx => rx.test(item));
    const hasStableAnchor = STABLE_ANCHORS.some(rx => rx.test(item));
    if (hasDynamicMarker || !hasStableAnchor) {
      continue;
    }
    kept.push(item);
  }

  const rendered = kept.length > 0
    ? kept.map(item => `- ${item}`).join("\n")
    : "-";

  return String(memoryText || "").replace(section.fullMatch, `${section.header}\n${rendered}\n`);
}

function parsePotentialJsonObject(raw = "") {
  const text = String(raw || "").trim();
  if (!text) return null;

  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return null;

  const candidate = text.slice(start, end + 1);
  try {
    return JSON.parse(candidate);
  } catch (_err) {
    // Minor deterministic repairs only.
    const repaired = candidate
      .replace(/[\u2018\u2019]/g, "'")
      .replace(/[\u201C\u201D]/g, '"')
      .replace(/,\s*([}\]])/g, "$1")
      .replace(/([{,]\s*)'([^'\\]+?)'\s*:/g, '$1"$2":')
      .replace(/:\s*'([^'\\]*?)'(\s*[,}])/g, ': "$1"$2');
    try {
      return JSON.parse(repaired);
    } catch (_err2) {
      return null;
    }
  }
}

function extractMemoryUpdateContract(rawOutput = "") {
  const raw = String(rawOutput || "").trim();
  if (!raw) {
    return { memoryText: "", deleteAncientMovementsById: [], source: "empty", memoryBeforeSanitization: null };
  }

  const withoutCodeFenceMarkers = raw.replace(/```json|```/gi, "").trim();
  const parsed = parsePotentialJsonObject(withoutCodeFenceMarkers);

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return {
      memoryText: withoutCodeFenceMarkers,
      deleteAncientMovementsById: [],
      source: "plain_text",
      memoryBeforeSanitization: withoutCodeFenceMarkers
    };
  }

  const memoryCandidates = [
    parsed.memory,
    parsed.updatedMemory,
    parsed.memoire,
    parsed.sessionMemory
  ];
  const memoryText = memoryCandidates.find(v => typeof v === "string" && v.trim()) || "";

  const deleteCandidates = [
    parsed.deleteAncientMovementsById,
    parsed.deleteAncientMovementIds,
    parsed.ancientMovementsDeleteIds,
    parsed.deleteAncientIds
  ];

  const deleteAncientMovementsById = [];
  for (const candidate of deleteCandidates) {
    if (!Array.isArray(candidate)) continue;
    for (const id of candidate) {
      const normalized = String(id || "").trim();
      if (!normalized) continue;
      if (deleteAncientMovementsById.includes(normalized)) continue;
      deleteAncientMovementsById.push(normalized);
      if (deleteAncientMovementsById.length >= 2) break;
    }
    if (deleteAncientMovementsById.length >= 2) break;
  }

  return {
    memoryText,
    deleteAncientMovementsById,
    source: "json_contract",
    memoryBeforeSanitization: memoryText || null
  };
}

function sanitizeMemoryItems(memoryText = "") {
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
    "il veut", "elle veut",
    // Défensivité et agentivité — interdits sans exception
    "refoul",
    "defensif", "defensive",
    "bouclier",
    "surprot",
    "latent",
    "repli",
    "en ser",
    "raison",
    "retir",
    "evit",
    "argument",
    "vouloir"
  ];
  const AGENCY_PATTERNS = [
    /\b(il|elle)\s+(refuse|choisit|decide|décide|prefere|préfère|evite|évite)\b/i,
    /\bpour\s+(se\s+)?(proteger|protéger|eviter|éviter|gerer|gérer|controler|contrôler)\b/i,
    /\bdesir\s+de\b/i,
    /\bdecision\s+de\b/i,
    /\bstrateg/i,
    /\bse\s+d[ée]fend/i,
    /\brepli/i,
    /\b(?:s'|s\u2019)?en\s+ser/i,
    /\braison/i,
    /\bretir/i,
    /\b[ée]vit/i,
    /\bargument/i,
    /\bvouloir/i
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

    sanitized.push(line);
  }

  if (violations.length > 0) {
    console.log("[MEMORY][SANITIZE_VIOLATIONS]", { count: violations.length, violations });
  }

  return normalizeStableContextSelectivity(sanitized.join("\n"));
}

function createMemoryHelpers({
  client,
  MODEL_IDS,
  normalizeIntersessionMemory,
  normalizeMemory
}) {
  async function updateMemory(
    previousMemory,
    history,
    promptRegistry = buildDefaultPromptRegistry(),
    memoryPrioritySignal = "normal",
    intersessionMemoryForTurn = "",
    memoryClinicalSignals = null,
    memoryState = null
  ) {
    const defaultUpdateMemoryPrompt = String(buildDefaultPromptRegistry().UPDATE_MEMORY || "").trim();
    const currentUpdateMemoryPrompt = String(promptRegistry.UPDATE_MEMORY || "").trim();

    const forcedPrefix = "FORCE_MEMORY_OUTPUT:";

    if (
      currentUpdateMemoryPrompt !== defaultUpdateMemoryPrompt &&
      currentUpdateMemoryPrompt.startsWith(forcedPrefix)
    ) {
      const forcedMemory = currentUpdateMemoryPrompt.slice(forcedPrefix.length).trim();
      return {
        memoryText: forcedMemory || normalizeMemory(previousMemory, promptRegistry),
        deleteAncientMovementsById: [],
        source: "forced_override",
        memoryBeforeSanitization: null,
        llmMeta: null
      };
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
${intersessionMemoryForTurn ? `\n[LONGTERM_MEMORY]\n${String(intersessionMemoryForTurn).slice(0, 500)}` : ""}
  ${memoryClinicalSignals && typeof memoryClinicalSignals === "object" ? `\n[CLINICAL_SIGNALS]\n${JSON.stringify(memoryClinicalSignals)}` : ""}
  ${Array.isArray(memoryState?.ancientMovements) && memoryState.ancientMovements.length > 0 ? `\n[ANCIENT_MOVEMENTS_INDEX]\n${memoryState.ancientMovements.slice(-20).map(item => `- id: ${String(item.id || "").trim()} | text: ${String(item.text || "").trim()}`).join("\n")}` : ""}

Conversation :
${transcript}
`;

    const r = await client.chat.completions.create({
      model: MODEL_IDS.memoryUpdate || MODEL_IDS.analysis,
      max_completion_tokens: 400,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user }
      ]
    });

    const rawOutput = String(r.choices?.[0]?.message?.content || "").trim();
    const llmMeta = {
      responseId: typeof r?.id === "string" ? r.id : null,
      model: typeof r?.model === "string" ? r.model : null,
      finishReason: typeof r?.choices?.[0]?.finish_reason === "string" ? r.choices[0].finish_reason : null,
      contentLength: rawOutput.length,
      hadContent: rawOutput.length > 0,
      hadRefusal: !!(r?.choices?.[0]?.message && Object.prototype.hasOwnProperty.call(r.choices[0].message, "refusal") && r.choices[0].message.refusal)
    };

    if (!rawOutput) {
      return {
        memoryText: normalizeMemory(previousMemory, promptRegistry),
        deleteAncientMovementsById: [],
        source: "empty",
        memoryBeforeSanitization: null,
        llmMeta
      };
    }

    const contract = extractMemoryUpdateContract(rawOutput);
    const cleaned = String(contract.memoryText || "").trim();

    if (!cleaned) {
      return {
        memoryText: normalizeMemory(previousMemory, promptRegistry),
        deleteAncientMovementsById: [],
        source: contract.source,
        memoryBeforeSanitization: null,
        llmMeta
      };
    }

    if (contract.source === "json_contract" && contract.deleteAncientMovementsById.length > 0) {
      console.log("[MEMORY][DELETE_SUGGESTIONS_RECEIVED]", {
        count: contract.deleteAncientMovementsById.length,
        ids: contract.deleteAncientMovementsById
      });
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
      lower.includes("anciens mouvements:");

    if (hasTranscriptLeak) {
      return {
        memoryText: normalizeMemory(previousMemory, promptRegistry),
        deleteAncientMovementsById: [],
        source: "transcript_leak_fallback",
        memoryBeforeSanitization: null,
        llmMeta
      };
    }

    if (hasRequiredSections) {
      return {
        memoryText: sanitizeMemoryItems(cleaned),
        deleteAncientMovementsById: contract.deleteAncientMovementsById,
        source: contract.source,
        memoryBeforeSanitization: contract.memoryBeforeSanitization || cleaned,
        llmMeta
      };
    }

    if (isOverriddenUpdateMemory) {
      return {
        memoryText: cleaned,
        deleteAncientMovementsById: contract.deleteAncientMovementsById,
        source: "prompt_override",
        memoryBeforeSanitization: contract.memoryBeforeSanitization || cleaned,
        llmMeta
      };
    }

    return {
      memoryText: normalizeMemory(previousMemory, promptRegistry),
      deleteAncientMovementsById: [],
      source: "fallback",
      memoryBeforeSanitization: null,
      llmMeta
    };
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
      max_completion_tokens: 300,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user }
      ]
    });

    const rawOutput = String(r.choices?.[0]?.message?.content || "").trim();
    if (!rawOutput) {
      return normalizeIntersessionMemory(previousIntersessionMemory, promptRegistry);
    }

    const cleaned = rawOutput
      // Keep fenced content and remove only fence marker lines.
      .replace(/^\s*```[a-zA-Z0-9_-]*\s*$/gm, "")
      .trim();
    if (!cleaned) {
      return normalizeIntersessionMemory(previousIntersessionMemory, promptRegistry);
    }

    const lower = cleaned.toLowerCase();
    const hasTranscriptLeak =
      lower.includes("conversation :") ||
      lower.includes("utilisateur :") ||
      lower.includes("assistant :") ||
      lower.includes("memoire inter-sessions precedente :") ||
      lower.includes("memoire de session qui se ferme :") ||
      lower.includes("mémoire de session qui se ferme :");

    if (hasTranscriptLeak) {
      return normalizeIntersessionMemory(previousIntersessionMemory, promptRegistry);
    }

    const hasRequiredSections =
      lower.includes("memoire inter-session:") ||
      lower.includes("mémoire inter-session:");

    if (!hasRequiredSections) {
      return normalizeIntersessionMemory(previousIntersessionMemory, promptRegistry);
    }

    const normalized = normalizeIntersessionMemory(cleaned, promptRegistry);
    const section = extractSectionBlock(normalized, "Memoire inter-session") || extractSectionBlock(normalized, "Mémoire inter-session");
    if (!section) {
      return normalizeIntersessionMemory(previousIntersessionMemory, promptRegistry);
    }

    return normalized;
  }

  return {
    MEMORY_INACTIVITY_TTL_MS,
    applyInactivityPurge,
    mergeMemoryStateWithFinalizedText,
    normalizeMemoryStateShape,
    renderMemoryTextFromState,
    sanitizeMemoryItems,
    updateIntersessionMemory,
    updateMemory
  };
}

module.exports = {
  createMemoryHelpers
};
