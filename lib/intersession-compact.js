'use strict';

async function runIntersessionCompactAttempt({
  mistralTransport,
  modelId,
  systemPrompt,
  memorySource = '',
  extractItems,
  timeoutMs = 10000
}) {
  const source = String(memorySource || '').trim();
  const userPrompt = `
[MEMOIRE_INTERSESSION_SOURCE]
${source || '(vide)'}

[CONTRAT]
Reponds strictement en JSON: {"items": ["..."]}
`;

  let timeoutHandle = null;
  const requestPromise = mistralTransport.complete({
    model: modelId,
    maxTokens: 500,
    messages: [
      { role: 'system', content: String(systemPrompt || '').trim() },
      { role: 'user', content: userPrompt }
    ]
  });
  const timeoutPromise = new Promise((_, reject) => {
    timeoutHandle = setTimeout(
      () => {
        reject(new Error(`intersession_compact_timeout_${timeoutMs}ms`));
      },
      Math.max(1000, timeoutMs)
    );
  });

  try {
    const response = await Promise.race([requestPromise, timeoutPromise]);
    const raw = String(response?.content || '').trim();
    const items = extractItems(raw);

    if (!raw) {
      throw new Error('intersession_compact_empty_output');
    }
    if (!Array.isArray(items)) {
      throw new Error('intersession_compact_invalid_items');
    }

    return {
      ok: true,
      items,
      raw,
      finishReason:
        typeof response?.finishReason === 'string'
          ? response.finishReason
          : null,
      model:
        typeof response?.raw?.model === 'string'
          ? response.raw.model
          : null
    };
  } finally {
    if (timeoutHandle) clearTimeout(timeoutHandle);
  }
}

module.exports = { runIntersessionCompactAttempt };
