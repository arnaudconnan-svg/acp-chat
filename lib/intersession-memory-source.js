'use strict';

function parseTimestamp(value) {
  const parsed = Date.parse(String(value || ''));
  return Number.isFinite(parsed) ? parsed : null;
}

function resolveConversationMemoryForIntersession({
  accountMemoryUpdatedAt,
  conversationMemory,
  conversationMemoryBaseUpdatedAt
} = {}) {
  const memory = String(conversationMemory || '').trim();
  if (!memory) {
    return { memory: '', reason: 'conversation_unavailable' };
  }

  const conversationBaseMs = parseTimestamp(conversationMemoryBaseUpdatedAt);
  if (conversationBaseMs === null) {
    return { memory: '', reason: 'conversation_memory_unversioned' };
  }

  const accountUpdatedMs = parseTimestamp(accountMemoryUpdatedAt);
  if (accountUpdatedMs !== null && conversationBaseMs < accountUpdatedMs) {
    return { memory: '', reason: 'conversation_memory_precedes_account_source' };
  }

  return {
    memory: memory.slice(0, 8000),
    reason: 'conversation_session_memory'
  };
}

function selectPostResumeHistory(recentHistory, resumeHistoryCount) {
  const history = Array.isArray(recentHistory) ? recentHistory : [];
  const startIndex = Math.min(
    Math.max(0, Number(resumeHistoryCount) || 0),
    history.length
  );
  return history.slice(startIndex);
}

module.exports = {
  resolveConversationMemoryForIntersession,
  selectPostResumeHistory
};