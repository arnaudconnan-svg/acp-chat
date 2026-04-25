"use strict";

/**
 * Harness — conversation-data.js (public/js/conversation-data.js)
 *
 * Vérifie les fonctions pures de normalisation et sélection des données
 * de conversation, sans DOM, sans serveur.
 *
 * Usage : node scripts/conversation-data-harness.js
 */

const {
  OPENING_GREETINGS,
  isOpeningGreetingMessage,
  defaultMemory,
  normalizeStoredFlags,
  normalizeStoredStateSnapshot,
  normalizeStoredMessages,
  buildSafeConversationData,
  countMeaningfulConversationMessages,
  selectPreferredConversationData,
} = require("../public/js/conversation-data");

let passed = 0;
let failed = 0;

function assert(label, condition, detail = "") {
  if (condition) {
    console.log(`  ✓ ${label}`);
    passed++;
  } else {
    console.error(`  ✗ ${label}${detail ? ": " + detail : ""}`);
    failed++;
  }
}

// ── isOpeningGreetingMessage ─────────────────────────────────────────────────

assert("isOpeningGreetingMessage: session greeting → true",
  isOpeningGreetingMessage("Bienvenue dans cette nouvelle session. Que veux-tu explorer aujourd'hui ?") === true);

assert("isOpeningGreetingMessage: conversation greeting → true",
  isOpeningGreetingMessage("Bienvenue dans cette nouvelle conversation. Que veux-tu explorer aujourd'hui ?") === true);

assert("isOpeningGreetingMessage: normal message → false",
  isOpeningGreetingMessage("J'ai mal dormi cette nuit.") === false);

assert("isOpeningGreetingMessage: empty string → false",
  isOpeningGreetingMessage("") === false);

assert("isOpeningGreetingMessage: null → false",
  isOpeningGreetingMessage(null) === false);

assert("isOpeningGreetingMessage: greeting with extra whitespace → true (content is trimmed)",
  isOpeningGreetingMessage("  Bienvenue dans cette nouvelle session. Que veux-tu explorer aujourd'hui ?  ") === true);

// ── defaultMemory ────────────────────────────────────────────────────────────

const mem = defaultMemory();
assert("defaultMemory: returns string", typeof mem === "string");
assert("defaultMemory: contains 'Themes'", mem.includes("Themes deja evoques"));
assert("defaultMemory: contains 'vigilance'", mem.includes("vigilance relationnels"));
assert("defaultMemory: contains 'ouvertes'", mem.includes("Questions encore ouvertes"));

// ── normalizeStoredFlags ─────────────────────────────────────────────────────

assert("normalizeStoredFlags: valid object → returned as-is",
  JSON.stringify(normalizeStoredFlags({ foo: true })) === JSON.stringify({ foo: true }));

assert("normalizeStoredFlags: null → {}",
  JSON.stringify(normalizeStoredFlags(null)) === "{}");

assert("normalizeStoredFlags: array → {}",
  JSON.stringify(normalizeStoredFlags([])) === "{}");

assert("normalizeStoredFlags: string → {}",
  JSON.stringify(normalizeStoredFlags("foo")) === "{}");

// ── normalizeStoredStateSnapshot ─────────────────────────────────────────────

assert("normalizeStoredStateSnapshot: null → null",
  normalizeStoredStateSnapshot(null) === null);

assert("normalizeStoredStateSnapshot: array → null",
  normalizeStoredStateSnapshot([]) === null);

{
  const snap = normalizeStoredStateSnapshot({ memory: "ma mémoire", flags: { f: 1 } });
  assert("normalizeStoredStateSnapshot: valid → memory preserved", snap && snap.memory === "ma mémoire");
  assert("normalizeStoredStateSnapshot: valid → flags preserved", snap && snap.flags.f === 1);
}

{
  const snap = normalizeStoredStateSnapshot({ memory: "  ", flags: {} });
  assert("normalizeStoredStateSnapshot: empty memory → defaultMemory",
    snap && snap.memory === defaultMemory());
}

// ── normalizeStoredMessages ──────────────────────────────────────────────────

assert("normalizeStoredMessages: array → same array",
  Array.isArray(normalizeStoredMessages([{ role: "user", content: "x" }])));

assert("normalizeStoredMessages: null → []",
  JSON.stringify(normalizeStoredMessages(null)) === "[]");

assert("normalizeStoredMessages: string → []",
  JSON.stringify(normalizeStoredMessages("bad")) === "[]");

// ── buildSafeConversationData ────────────────────────────────────────────────

{
  const d = buildSafeConversationData();
  assert("buildSafeConversationData: undefined → messages is []", JSON.stringify(d.messages) === "[]");
  assert("buildSafeConversationData: undefined → memory is defaultMemory", d.memory === defaultMemory());
  assert("buildSafeConversationData: undefined → flags is {}", JSON.stringify(d.flags) === "{}");
  assert("buildSafeConversationData: undefined → updatedAt is number", typeof d.updatedAt === "number");
  assert("buildSafeConversationData: undefined → isPrivate false", d.isPrivate === false);
}

{
  const d = buildSafeConversationData({ memory: "custom mem", isPrivate: true, updatedAt: 1000 });
  assert("buildSafeConversationData: custom memory preserved", d.memory === "custom mem");
  assert("buildSafeConversationData: isPrivate true", d.isPrivate === true);
  assert("buildSafeConversationData: updatedAt preserved", d.updatedAt === 1000);
}

// ── countMeaningfulConversationMessages ──────────────────────────────────────

{
  const msgs = [
    { role: "assistant", content: "Bienvenue dans cette nouvelle session. Que veux-tu explorer aujourd'hui ?" },
    { role: "user", content: "Je veux parler de mon angoisse." },
    { role: "assistant", content: "Je t'écoute." },
  ];
  assert("countMeaningful: greeting not counted", countMeaningfulConversationMessages(msgs) === 2);
}

assert("countMeaningful: empty array → 0", countMeaningfulConversationMessages([]) === 0);
assert("countMeaningful: null → 0", countMeaningfulConversationMessages(null) === 0);

{
  const allGreetings = OPENING_GREETINGS.map(g => ({ role: "assistant", content: g }));
  assert("countMeaningful: all greetings → 0", countMeaningfulConversationMessages(allGreetings) === 0);
}

// ── selectPreferredConversationData ──────────────────────────────────────────

{
  // Primary is richer (more meaningful messages) → primary wins
  const primary = {
    messages: [
      { role: "user", content: "Bonjour" },
      { role: "assistant", content: "Bonjour à toi" },
    ],
    updatedAt: 1000
  };
  const fallback = {
    messages: [],
    updatedAt: 2000 // newer but empty
  };
  const result = selectPreferredConversationData(primary, fallback);
  assert("selectPreferred: richer primary wins over newer empty fallback",
    result.messages.length === 2);
}

{
  // Fallback is richer → fallback wins
  const primary = { messages: [], updatedAt: 2000 };
  const fallback = {
    messages: [
      { role: "user", content: "Message important" },
      { role: "assistant", content: "Je vois." },
    ],
    updatedAt: 1000
  };
  const result = selectPreferredConversationData(primary, fallback);
  assert("selectPreferred: richer fallback beats emptier primary",
    result.messages.length === 2);
}

{
  // Equal meaningful count, fallback newer → fallback wins
  const msg = { role: "user", content: "Un seul message" };
  const primary = { messages: [msg], updatedAt: 1000 };
  const fallback = { messages: [msg], updatedAt: 2000 };
  const result = selectPreferredConversationData(primary, fallback);
  assert("selectPreferred: equal count, newer fallback wins",
    result.updatedAt === 2000);
}

{
  // Equal count and same updatedAt → primary returned
  const msg = { role: "user", content: "Un seul message" };
  const primary = { messages: [msg], updatedAt: 1500 };
  const fallback = { messages: [msg], updatedAt: 1500 };
  const result = selectPreferredConversationData(primary, fallback);
  assert("selectPreferred: equal everything → primary returned",
    result.updatedAt === 1500 && result.messages.length === 1);
}

{
  // null inputs → graceful
  const result = selectPreferredConversationData(null, null);
  assert("selectPreferred: both null → returns safe object",
    result && typeof result === "object" && Array.isArray(result.messages));
}

// ── Summary ──────────────────────────────────────────────────────────────────

console.log("");
if (failed === 0) {
  console.log(`conversation-data-harness: ${passed}/${passed + failed} passed`);
} else {
  console.log(`conversation-data-harness: ${passed}/${passed + failed} passed, ${failed} FAILED`);
  process.exit(1);
}
