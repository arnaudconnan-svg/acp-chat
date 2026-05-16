"use strict";

const { buildDefaultPromptRegistry } = require("./prompts");

const MEMORY_INACTIVITY_TTL_MS = 3 * 60 * 60 * 1000;
const MAX_ONGOING_MOVEMENTS = 2;
const MEMORY_UPDATE_BASE_MAX_COMPLETION_TOKENS = 1200;
const MEMORY_UPDATE_RETRY_MAX_COMPLETION_TOKENS = 2200;

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

  return {
    sessionStableContext,
    onGoingMovements,
    ancientMovements
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
  nowMs = Date.now(),
  lastActivityMs = null,
  ttlMs = MEMORY_INACTIVITY_TTL_MS
} = {}) {
  const nowIso = safeIsoString(nowMs);
  const normalizedPrevious = normalizeMemoryStateShape(previousMemoryState, "", nowMs);
  const purgeResult = applyInactivityPurge(normalizedPrevious, { nowMs, lastActivityMs, ttlMs });
  const base = purgeResult.memoryState;

  const extractedStableContext = parseMemorySectionBullets(finalizedMemoryText, "Contexte stable")
    .map(normalizeBulletText)
    .filter(Boolean);
  const sessionStableContext = dedupeDeterministicTexts([
    ...base.sessionStableContext,
    ...extractedStableContext
  ]);
  const nextOngoingTexts = parseMemorySectionBullets(finalizedMemoryText, "Mouvements en cours")
    .map(normalizeBulletText)
    .filter(Boolean);
  const nextOngoingUniqueTexts = dedupeDeterministicTexts(nextOngoingTexts, MAX_ONGOING_MOVEMENTS);

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

  // Deterministic reactivation guard: prevent ongoing items from being ancient movements
  // without explicit justification in the current user message (guard will signal if triggered).
  let reactivatedCount = 0;
  let reactivatedItems = [];
  if (nextOngoingUniqueTexts.length > 0 && ancientMovements.length > 0) {
    const ancientKeys = new Set(
      ancientMovements
        .map((item) => canonicalMemoryTextKey(String(item?.text || "")))
        .filter(Boolean)
    );
    reactivatedItems = nextOngoingUniqueTexts
      .map((text) => ({ text, key: canonicalMemoryTextKey(text) }))
      .filter(({ key }) => key && ancientKeys.has(key))
      .map(({ text }) => text)
      .slice(0, 3);
    reactivatedCount = reactivatedItems.length;
  }

  const onGoingMovements = nextOngoingUniqueTexts.map((text, idx) => ({
    id: buildMovementId({ text, nowMs, index: idx }),
    text,
    createdAt: nowIso,
    archivedAt: null
  }));

  const nextState = normalizeMemoryStateShape({
    sessionStableContext,
    onGoingMovements,
    ancientMovements
  }, "", nowMs);

  return {
    memoryState: nextState,
    memoryText: renderMemoryTextFromState(nextState),
    purgedByInactivity: purgeResult.purged === true,
    reactivationGuardTriggered: reactivatedCount > 0,
    reactivatedItems: reactivatedItems.slice(0, 3)
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

function parsePotentialJsonObject(raw = "") {
  const text = String(raw || "").trim();
  if (!text) return null;

  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return null;

  const candidate = text.slice(start, end + 1);
  try {
    return JSON.parse(candidate);
  } catch {
    // Minor deterministic repairs only.
    const repaired = candidate
      .replace(/[\u2018\u2019]/g, "'")
      .replace(/[\u201C\u201D]/g, '"')
      .replace(/,\s*([}\]])/g, "$1")
      .replace(/([{,]\s*)'([^'\\]+?)'\s*:/g, '$1"$2":')
      .replace(/:\s*'([^'\\]*?)'(\s*[,}])/g, ': "$1"$2');
    try {
      return JSON.parse(repaired);
    } catch {
      return null;
    }
  }
}

function parseJsonStringArrayField(rawOutput = "", fieldCandidates = [], maxItems = Infinity) {
  const cleaned = String(rawOutput || "").replace(/```json|```/gi, "").trim();
  if (!cleaned) return [];
  const parsed = parsePotentialJsonObject(cleaned);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return [];
  }

  const candidates = Array.isArray(fieldCandidates) ? fieldCandidates : [];
  for (const fieldName of candidates) {
    const candidate = parsed[fieldName];
    if (!Array.isArray(candidate)) continue;
    return dedupeDeterministicTexts(
      candidate.filter(item => typeof item === "string"),
      maxItems
    );
  }

  return [];
}

function extractItemsFromRawOutput(rawOutput = "", { maxItems = Infinity } = {}) {
  const items = parseJsonStringArrayField(
    rawOutput,
    ["items", "stableItems", "ongoingItems", "sessionStableContext", "onGoingMovements"],
    maxItems
  );
  if (items.length > 0) return items;

  const lines = String(rawOutput || "")
    .replace(/```json|```/gi, "")
    .split("\n")
    .map(line => line.trim())
    .filter(line => /^[-*]\s+/.test(line) || /^\d+\.\s+/.test(line))
    .map(line => line.replace(/^([-*]|\d+\.)\s+/, "").trim());

  return dedupeDeterministicTexts(lines, maxItems);
}

function extractDeleteAncientIdsFromRawOutput(rawOutput = "") {
  return parseJsonStringArrayField(
    rawOutput,
    [
      "deleteAncientIds",
      "deleteAncientMovementsById",
      "deleteAncientMovementIds",
      "ancientMovementsDeleteIds"
    ]
  );
}

function extractLastUserMessage(history = []) {
  if (!Array.isArray(history)) return "";
  for (let i = history.length - 1; i >= 0; i -= 1) {
    const item = history[i];
    if (item && item.role === "user" && typeof item.content === "string") {
      return item.content;
    }
  }
  return "";
}

function buildMemoryTextForMerge({ sessionStableContext = [], onGoingMovements = [] } = {}) {
  const stableLines = Array.isArray(sessionStableContext) && sessionStableContext.length > 0
    ? sessionStableContext.map(item => `- ${item}`).join("\n")
    : "-";
  const ongoingLines = Array.isArray(onGoingMovements) && onGoingMovements.length > 0
    ? onGoingMovements.map(item => `- ${item}`).join("\n")
    : "-";

  return [
    "Contexte stable:",
    stableLines,
    "",
    "Mouvements en cours:",
    ongoingLines,
    "",
    "Anciens mouvements:",
    "-"
  ].join("\n").trim();
}

function createMemoryHelpers({
  client,
  MODEL_IDS,
  normalizeIntersessionMemory,
  normalizeMemory
}) {
  async function requestMemoryUpdateCompletion(system, user, maxCompletionTokens) {
    return client.chat.completions.create({
      model: MODEL_IDS.memoryUpdate || MODEL_IDS.analysis,
      max_completion_tokens: maxCompletionTokens,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user }
      ]
    });
  }

  async function updateMemory(
    previousMemory,
    history,
    promptRegistry = buildDefaultPromptRegistry(),
    memoryPrioritySignal = "normal",
    intersessionMemoryForTurn = "",
    memoryClinicalSignals = null,
    memoryState = null
  ) {
    const defaults = buildDefaultPromptRegistry();
    const ongoingSystemPrompt = String(promptRegistry.EXTRACT_ONGOING_MOVEMENTS || defaults.EXTRACT_ONGOING_MOVEMENTS || "").trim();
    const stableSystemPrompt = String(promptRegistry.EXTRACT_STABLE_CONTEXT || defaults.EXTRACT_STABLE_CONTEXT || "").trim();
    const cleanupSystemPrompt = String(promptRegistry.CLEANUP_ANCIENT_DUPLICATES || defaults.CLEANUP_ANCIENT_DUPLICATES || "").trim();

    const previousNormalizedMemory = normalizeMemory(previousMemory, promptRegistry);
    const previousStable = dedupeDeterministicTexts(
      parseMemorySectionBullets(previousNormalizedMemory, "Contexte stable")
    );
    const latestUserMessage = extractLastUserMessage(history);

    async function runMemoryPrompt(promptName, system, userPayload) {
      let response = await requestMemoryUpdateCompletion(system, userPayload, MEMORY_UPDATE_BASE_MAX_COMPLETION_TOKENS);
      let raw = String(response?.choices?.[0]?.message?.content || "").trim();
      const shouldRetryAfterLengthExhaustion = !raw && String(response?.choices?.[0]?.finish_reason || "").toLowerCase() === "length";
      if (shouldRetryAfterLengthExhaustion) {
        response = await requestMemoryUpdateCompletion(system, userPayload, MEMORY_UPDATE_RETRY_MAX_COMPLETION_TOKENS);
        raw = String(response?.choices?.[0]?.message?.content || "").trim();
      }
      return {
        raw,
        meta: {
          prompt: promptName,
          responseId: typeof response?.id === "string" ? response.id : null,
          model: typeof response?.model === "string" ? response.model : null,
          finishReason: typeof response?.choices?.[0]?.finish_reason === "string" ? response.choices[0].finish_reason : null,
          contentLength: raw.length,
          hadContent: raw.length > 0,
          hadRefusal: !!(response?.choices?.[0]?.message && Object.prototype.hasOwnProperty.call(response.choices[0].message, "refusal") && response.choices[0].message.refusal),
          retriedAfterLengthExhaustion: shouldRetryAfterLengthExhaustion
        }
      };
    }

    const stablePromptPayload = `
[MESSAGE_UTILISATEUR]
${latestUserMessage}

[CONTRAT]
Reponds strictement en JSON: {"items": ["..."]}
`;

    const ongoingPromptPayload = `
[MESSAGE_UTILISATEUR]
${latestUserMessage}

[CONTRAT]
Reponds strictement en JSON: {"items": ["...", "..."]}
Max 2 items.
`;

    const stablePromise = runMemoryPrompt("extract_stable_context", stableSystemPrompt, stablePromptPayload);
    const ongoingResult = await runMemoryPrompt("extract_ongoing_movements", ongoingSystemPrompt, ongoingPromptPayload);

    const extractedOngoing = extractItemsFromRawOutput(ongoingResult.raw, { maxItems: MAX_ONGOING_MOVEMENTS });

    let cleanupResult = { raw: "", meta: null };
    if (extractedOngoing.length > 0 && Array.isArray(memoryState?.ancientMovements) && memoryState.ancientMovements.length > 0) {
      const ancientSnapshot = memoryState.ancientMovements.slice(-30).map((item) => ({
        id: String(item?.id || "").trim(),
        text: String(item?.text || "").trim()
      })).filter((item) => item.id && item.text);

      const cleanupPayload = `
[ONGOING_ITEMS]
${JSON.stringify(extractedOngoing)}

[ANCIENT_MOVEMENTS]
${JSON.stringify(ancientSnapshot)}

[CONTRAT]
Reponds strictement en JSON: {"deleteAncientIds": ["id_1", "id_2"]}
`;

      cleanupResult = await runMemoryPrompt("cleanup_ancient_duplicates", cleanupSystemPrompt, cleanupPayload);
    }

    const stableResult = await stablePromise;
    const extractedStable = extractItemsFromRawOutput(stableResult.raw);
    const mergedStable = dedupeDeterministicTexts([...previousStable, ...extractedStable]);

    const memoryText = buildMemoryTextForMerge({
      sessionStableContext: mergedStable,
      onGoingMovements: extractedOngoing
    });

    const deleteAncientMovementsById = extractDeleteAncientIdsFromRawOutput(cleanupResult.raw);
    if (deleteAncientMovementsById.length > 0) {
      console.log("[MEMORY][DELETE_SUGGESTIONS_RECEIVED]", {
        count: deleteAncientMovementsById.length,
        ids: deleteAncientMovementsById
      });
    }

    return {
      memoryText,
      deleteAncientMovementsById,
      source: "split_prompts_v1",
      memoryBeforeSanitization: null,
      llmMeta: {
        steps: [
          ongoingResult.meta,
          stableResult.meta,
          cleanupResult.meta
        ].filter(Boolean),
        memoryPrioritySignal,
        hasIntersessionMemory: Boolean(String(intersessionMemoryForTurn || "").trim()),
        hasClinicalSignals: Boolean(memoryClinicalSignals && typeof memoryClinicalSignals === "object")
      }
    };
  }

  async function updateIntersessionMemory(previousIntersessionMemory, sessionMemory, promptRegistry = buildDefaultPromptRegistry()) {
    const defaultPrompt = String(buildDefaultPromptRegistry().UPDATE_INTERSESSION_MEMORY || "").trim();
    const currentPrompt = String(promptRegistry.UPDATE_INTERSESSION_MEMORY || "").trim();

    const system = currentPrompt || defaultPrompt;
    const previousSource = String(previousIntersessionMemory || "")
      .replace(/^m[ée]moire\s+inter-?session\s*:\s*/i, "")
      .trim();
    const user = `
Memoire inter-sessions precedente :
  ${previousSource || "(vide)"}

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
      return previousSource;
    }

    const cleaned = rawOutput
      // Keep fenced content and remove only fence marker lines.
      .replace(/^\s*```[a-zA-Z0-9_-]*\s*$/gm, "")
      .trim();
    if (!cleaned) {
      return previousSource;
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
      return previousSource;
    }

    const withoutHeader = cleaned.replace(/^m[ée]moire\s+inter-?session\s*:\s*/i, "").trim();
    return withoutHeader || previousSource;
  }

  return {
    MEMORY_INACTIVITY_TTL_MS,
    applyInactivityPurge,
    mergeMemoryStateWithFinalizedText,
    normalizeMemoryStateShape,
    renderMemoryTextFromState,
    updateIntersessionMemory,
    updateMemory
  };
}

module.exports = {
  createMemoryHelpers
};
