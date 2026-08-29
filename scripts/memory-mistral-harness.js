'use strict';

const assert = require('assert');
const { createMemoryHelpers } = require('../lib/memory');

function createHelpers({ mistralTransport }) {
  return createMemoryHelpers({
    mistralTransport,
    MISTRAL_MODEL_IDS: { memory: 'mistral-medium-latest' },
    normalizeIntersessionMemory: (value) => String(value || ''),
    normalizeMemory: (value) => String(value || '')
  });
}

async function main() {
  const memoryRequests = [];
  const helpers = createHelpers({
    mistralTransport: {
      async complete(request) {
        memoryRequests.push(request);
        const userPayload = String(request.messages?.[1]?.content || '');
        const content = userPayload.includes('Max 2 items')
          ? '{"items":["Tension au travail"]}'
          : '{"items":["Vit a Lyon"]}';
        return {
          content,
          finishReason: 'stop',
          usage: { promptTokens: 20, completionTokens: 5, totalTokens: 25 },
          raw: {
            id: `memory-${memoryRequests.length}`,
            model: 'mistral-medium-latest',
            choices: [{ finishReason: 'stop', message: { content } }]
          }
        };
      }
    }
  });

  const updated = await helpers.updateMemory(
    'Contexte stable:\n- Aime marcher\n\nMouvements en cours:\n-',
    [{ role: 'user', content: 'Je vis a Lyon et le travail est tendu.' }]
  );
  assert.strictEqual(memoryRequests.length, 2);
  assert(memoryRequests.every((request) => request.model === 'mistral-medium-latest'));
  assert(memoryRequests.every((request) => request.maxTokens === 1200));
  assert.match(updated.memoryText, /Aime marcher/);
  assert.match(updated.memoryText, /Vit a Lyon/);
  assert.match(updated.memoryText, /Tension au travail/);
  assert.strictEqual(updated.source, 'split_prompts_v1');
  assert.strictEqual(updated.llmMeta.steps.length, 2);
  assert(
    updated.llmMeta.steps.every(
      (step) =>
        step.model === 'mistral-medium-latest' &&
        step.usedFallbackModel === false &&
        step.finishReason === 'stop'
    )
  );

  const invalidRequests = [];
  const invalidHelpers = createHelpers({
    mistralTransport: {
      async complete(request) {
        invalidRequests.push(request);
        return {
          content: 'sortie invalide',
          finishReason: 'stop',
          usage: null,
          raw: { model: 'mistral-medium-latest', choices: [] }
        };
      }
    }
  });
  const invalid = await invalidHelpers.updateMemory(
    'Contexte stable:\n- Contexte deja connu\n\nMouvements en cours:\n-',
    [{ role: 'user', content: 'Message neutre' }]
  );
  assert.strictEqual(invalidRequests.length, 2);
  assert.match(invalid.memoryText, /Contexte deja connu/);
  assert.match(invalid.memoryText, /Mouvements en cours:\n-/);

  console.log('structured memory Mistral harness: ok');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
