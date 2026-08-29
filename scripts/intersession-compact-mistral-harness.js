'use strict';

const assert = require('assert');
const {
  runIntersessionCompactAttempt
} = require('../lib/intersession-compact');

function extractItems(raw = '') {
  try {
    const parsed = JSON.parse(String(raw || ''));
    return Array.isArray(parsed.items) ? parsed.items : null;
  } catch {
    return null;
  }
}

async function main() {
  let request = null;
  const result = await runIntersessionCompactAttempt({
    mistralTransport: {
      async complete(value) {
        request = value;
        return {
          content: '{"items":["Vit a Lyon","Travaille dans le soin"]}',
          finishReason: 'stop',
          usage: { promptTokens: 20, completionTokens: 8, totalTokens: 28 },
          raw: { model: 'mistral-small-latest' }
        };
      }
    },
    modelId: 'mistral-small-latest',
    systemPrompt: 'Compacte la memoire en JSON.',
    memorySource: 'Vit a Lyon. Travaille dans le soin.',
    extractItems
  });
  assert.strictEqual(request.model, 'mistral-small-latest');
  assert.strictEqual(request.maxTokens, 500);
  assert.match(request.messages[0].content, /Compacte la memoire/);
  assert.match(request.messages[1].content, /MEMOIRE_INTERSESSION_SOURCE/);
  assert.match(request.messages[1].content, /Vit a Lyon/);
  assert.deepStrictEqual(result.items, [
    'Vit a Lyon',
    'Travaille dans le soin'
  ]);
  assert.strictEqual(result.finishReason, 'stop');
  assert.strictEqual(result.model, 'mistral-small-latest');

  await assert.rejects(
    () =>
      runIntersessionCompactAttempt({
        mistralTransport: {
          async complete() {
            return {
              content: 'sortie invalide',
              finishReason: 'stop',
              raw: { model: 'mistral-small-latest' }
            };
          }
        },
        modelId: 'mistral-small-latest',
        systemPrompt: 'Compacte la memoire en JSON.',
        memorySource: 'Contexte factuel',
        extractItems
      }),
    /intersession_compact_invalid_items/
  );

  await assert.rejects(
    () =>
      runIntersessionCompactAttempt({
        mistralTransport: {
          async complete() {
            return {
              content: '',
              finishReason: 'stop',
              raw: { model: 'mistral-small-latest' }
            };
          }
        },
        modelId: 'mistral-small-latest',
        systemPrompt: 'Compacte la memoire en JSON.',
        memorySource: 'Contexte factuel',
        extractItems
      }),
    /intersession_compact_empty_output/
  );

  console.log('intersession compact Mistral harness: ok');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
