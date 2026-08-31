'use strict';

const assert = require('assert');
const {
  resolveConversationMemoryForIntersession,
  selectPostResumeHistory
} = require('../lib/intersession-memory-source');

const accountEditedAt = '2026-08-31T10:00:00.000Z';

const staleResolution = resolveConversationMemoryForIntersession({
  accountMemoryUpdatedAt: accountEditedAt,
  conversationMemory: 'Contexte stable:\n- Information retiree dans Mon compte',
  conversationMemoryBaseUpdatedAt: '2026-08-30T10:00:00.000Z'
});
assert.strictEqual(staleResolution.memory, '');
assert.strictEqual(
  staleResolution.reason,
  'conversation_memory_precedes_account_source'
);

const unversionedResolution = resolveConversationMemoryForIntersession({
  accountMemoryUpdatedAt: accountEditedAt,
  conversationMemory: 'Contexte stable:\n- Ancien snapshot',
  conversationMemoryBaseUpdatedAt: null
});
assert.strictEqual(unversionedResolution.memory, '');
assert.strictEqual(
  unversionedResolution.reason,
  'conversation_memory_unversioned'
);

const resumedResolution = resolveConversationMemoryForIntersession({
  accountMemoryUpdatedAt: accountEditedAt,
  conversationMemory: 'Contexte stable:\n- Nouveau fait stable apres reprise',
  conversationMemoryBaseUpdatedAt: accountEditedAt
});
assert.match(resumedResolution.memory, /Nouveau fait stable apres reprise/);
assert.strictEqual(resumedResolution.reason, 'conversation_session_memory');

const history = [
  { role: 'user', content: 'Ancien echange' },
  { role: 'assistant', content: 'Ancienne reponse' },
  { role: 'user', content: 'Nouveau fait stable apres reprise' },
  { role: 'assistant', content: 'Nouvelle reponse' }
];
assert.deepStrictEqual(selectPostResumeHistory(history, 2), history.slice(2));
assert.deepStrictEqual(selectPostResumeHistory(history, 99), []);

console.log('intersession memory source harness: ok');