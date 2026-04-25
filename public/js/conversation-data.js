// conversation-data.js
// Pure helpers for conversation data normalization and selection.
// No DOM dependencies. Loadable both in browser (<script src>) and Node.js (require).
//
// In browser: function declarations become globals, used by the inline script.
// In Node.js: require() returns the exports object (for unit testing).

// Greeting strings that mark the opening of a session or conversation.
// These must stay in sync with SESSION_OPENING_GREETING and
// CONVERSATION_OPENING_GREETING in the main inline script.
var OPENING_GREETINGS = [
  "Bienvenue dans cette nouvelle session. Que veux-tu explorer aujourd'hui ?",
  "Bienvenue dans cette nouvelle conversation. Que veux-tu explorer aujourd'hui ?"
];

function isOpeningGreetingMessage(content) {
  var text = String(content || "").trim();
  return OPENING_GREETINGS.indexOf(text) !== -1;
}

function defaultMemory() {
  return [
    "Themes deja evoques :",
    "- ",
    "",
    "Points de vigilance relationnels :",
    "- ",
    "",
    "Questions encore ouvertes :",
    "- "
  ].join("\n");
}

function normalizeStoredFlags(flags) {
  if (!flags || typeof flags !== "object" || Array.isArray(flags)) {
    return {};
  }
  return flags;
}

function normalizeStoredStateSnapshot(snapshot) {
  if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) {
    return null;
  }
  return {
    memory: typeof snapshot.memory === "string" && snapshot.memory.trim() ?
      snapshot.memory :
      defaultMemory(),
    flags: normalizeStoredFlags(snapshot.flags || {})
  };
}

function normalizeStoredMessages(messages) {
  if (!Array.isArray(messages)) {
    return [];
  }
  return messages;
}

function buildSafeConversationData(data) {
  if (data === undefined || data === null) data = {};
  return {
    messages: normalizeStoredMessages(data.messages),
    memory: typeof data.memory === "string" && data.memory.trim() ?
      data.memory :
      defaultMemory(),
    flags: normalizeStoredFlags(data.flags),
    updatedAt: Number(data.updatedAt || Date.now()),
    isPrivate: data.isPrivate === true
  };
}

function countMeaningfulConversationMessages(messages) {
  if (!Array.isArray(messages)) {
    return 0;
  }
  return messages.filter(function(item) {
    return item && !isOpeningGreetingMessage(item.content);
  }).length;
}

function selectPreferredConversationData(primaryData, fallbackData) {
  var safePrimary = buildSafeConversationData(primaryData || {});
  var safeFallback = buildSafeConversationData(fallbackData || {});

  var primaryMeaningful = countMeaningfulConversationMessages(safePrimary.messages);
  var fallbackMeaningful = countMeaningfulConversationMessages(safeFallback.messages);

  if (fallbackMeaningful > primaryMeaningful) {
    return safeFallback;
  }

  if (fallbackMeaningful === primaryMeaningful && safeFallback.updatedAt > safePrimary.updatedAt) {
    return safeFallback;
  }

  return safePrimary;
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    OPENING_GREETINGS: OPENING_GREETINGS,
    isOpeningGreetingMessage: isOpeningGreetingMessage,
    defaultMemory: defaultMemory,
    normalizeStoredFlags: normalizeStoredFlags,
    normalizeStoredStateSnapshot: normalizeStoredStateSnapshot,
    normalizeStoredMessages: normalizeStoredMessages,
    buildSafeConversationData: buildSafeConversationData,
    countMeaningfulConversationMessages: countMeaningfulConversationMessages,
    selectPreferredConversationData: selectPreferredConversationData
  };
}
