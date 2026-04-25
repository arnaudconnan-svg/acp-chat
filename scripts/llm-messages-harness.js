"use strict";

/**
 * Harness — buildLLMUserTurns (lib/llm-messages.js)
 *
 * Vérifie que la construction du tableau de turns envoyé au LLM
 * ne produit jamais de doublon utilisateur consécutif.
 *
 * Usage : node scripts/llm-messages-harness.js
 */

const { buildLLMUserTurns } = require("../lib/llm-messages");

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

function lastRole(turns) {
  return turns.length > 0 ? turns[turns.length - 1].role : null;
}

function countConsecutiveDuplicateUserTurns(turns) {
  let count = 0;
  for (let i = 1; i < turns.length; i++) {
    if (turns[i].role === "user" && turns[i - 1].role === "user") count++;
  }
  return count;
}

// --- Cas 1 : historique vide → un seul turn user ajouté
{
  const turns = buildLLMUserTurns("Bonjour", []);
  assert("empty history → 1 user turn", turns.length === 1);
  assert("empty history → role is user", turns[0].role === "user");
  assert("empty history → correct content", turns[0].content === "Bonjour");
}

// --- Cas 2 : historique sans doublon
{
  const history = [
    { role: "user", content: "Premier message" },
    { role: "assistant", content: "Réponse bot" },
  ];
  const turns = buildLLMUserTurns("Deuxième message", history);
  assert("normal history → correct length", turns.length === 3);
  assert("normal history → last role is user", lastRole(turns) === "user");
  assert("normal history → last content is new message", turns[turns.length - 1].content === "Deuxième message");
  assert("normal history → no consecutive user turns", countConsecutiveDuplicateUserTurns(turns) === 0);
}

// --- Cas 3 : historique qui se termine déjà par le même message user (le bug original)
{
  const history = [
    { role: "assistant", content: "Réponse bot" },
    { role: "user", content: "Message répété" },
  ];
  const turns = buildLLMUserTurns("Message répété", history);
  assert("history ends with same user msg → no duplicate added", turns.length === 2);
  assert("history ends with same user msg → no consecutive user turns", countConsecutiveDuplicateUserTurns(turns) === 0);
  assert("history ends with same user msg → last content unchanged", turns[turns.length - 1].content === "Message répété");
}

// --- Cas 4 : même message mais whitespace différent → dédupliqué aussi
{
  const history = [
    { role: "user", content: "  Avec espaces  " },
  ];
  const turns = buildLLMUserTurns("Avec espaces", history);
  assert("whitespace normalization → no duplicate", turns.length === 1);
}

// --- Cas 5 : contenu similaire mais rôle différent → PAS de déduplication (c'est le bot qui a parlé en dernier)
{
  const history = [
    { role: "user", content: "Ma question" },
    { role: "assistant", content: "Ma question" }, // contenu identique mais bot
  ];
  const turns = buildLLMUserTurns("Ma question", history);
  assert("same content but different role → user turn added normally", turns.length === 3);
  assert("same content but different role → last role is user", lastRole(turns) === "user");
}

// --- Cas 6 : historique null/undefined → graceful
{
  const turns1 = buildLLMUserTurns("Message", null);
  assert("null history → 1 user turn", turns1.length === 1);

  const turns2 = buildLLMUserTurns("Message", undefined);
  assert("undefined history → 1 user turn", turns2.length === 1);
}

// --- Cas 7 : message vide
{
  const turns = buildLLMUserTurns("", []);
  assert("empty message → 1 user turn with empty content", turns.length === 1 && turns[0].content === "");
}

// --- Cas 8 : historique long avec le current message au milieu (pas la fin) → ajouté normalement
{
  const history = [
    { role: "user", content: "Répété" },
    { role: "assistant", content: "Ok" },
    { role: "user", content: "Autre" },
    { role: "assistant", content: "Ok aussi" },
  ];
  const turns = buildLLMUserTurns("Répété", history);
  assert("current msg matches older entry but not last → still appended", turns.length === 5);
  assert("current msg matches older entry → no consecutive user turns", countConsecutiveDuplicateUserTurns(turns) === 0);
}

// --- Cas 9 : propriétés extra dans l'historique ne passent pas (sécurité de surface)
{
  const history = [
    { role: "assistant", content: "Bot", extra: "injected", __proto__: null },
  ];
  const turns = buildLLMUserTurns("Test", history);
  assert("extra props stripped from history turns", !("extra" in turns[0]));
}

// --- Summary
console.log("");
if (failed === 0) {
  console.log(`llm-messages-harness: ${passed}/${passed + failed} passed`);
} else {
  console.log(`llm-messages-harness: ${passed}/${passed + failed} passed, ${failed} FAILED`);
  process.exit(1);
}
