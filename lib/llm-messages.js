"use strict";

/**
 * Pure helper — builds the conversation turns array for an LLM call.
 *
 * Prevents the common bug where the frontend sends recentHistory that already
 * ends with the current user message, causing it to be duplicated in the prompt.
 *
 * @param {string} message  — current user message
 * @param {Array}  history  — prior turns [{role, content}, ...]
 * @returns {Array} flat turns array ready to spread after the system prompt
 */
function buildLLMUserTurns(message, history) {
  const safeHistory = Array.isArray(history) ? history : [];
  const safeMessage = String(message || "");
  const lastEntry = safeHistory.length > 0 ? safeHistory[safeHistory.length - 1] : null;
  const alreadyEnded =
    lastEntry !== null &&
    lastEntry.role === "user" &&
    String(lastEntry.content || "").trim() === safeMessage.trim();

  return [
    ...safeHistory.map(m => {
      const content = String(m.content || "");
      const signals = typeof m.signals === "string" ? m.signals.trim() : "";
      const annotatedContent =
        m.role === "assistant" && signals
          ? content + "\n[signaux: " + signals + "]"
          : content;
      return { role: m.role, content: annotatedContent };
    }),
    ...(alreadyEnded ? [] : [{ role: "user", content: safeMessage }]),
  ];
}

function formatHistoryForTextPrompt(history) {
  const safeHistory = Array.isArray(history) ? history : [];

  return safeHistory
    .map(m => `${m.role === "user" ? "Utilisateur" : "Assistant"} : ${String(m.content || "")}`)
    .join("\n");
}

module.exports = { buildLLMUserTurns, formatHistoryForTextPrompt };
