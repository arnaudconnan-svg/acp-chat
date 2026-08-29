'use strict';

const assert = require('assert');
const {
  createMistralTransport,
  normalizeCompletion,
  normalizeStreamChunk
} = require('../lib/mistral-transport');

async function main() {
  const rawCompletion = {
    choices: [{ message: { content: 'Bonjour' }, finishReason: 'stop' }],
    usage: { promptTokens: 3, completionTokens: 2, totalTokens: 5 }
  };
  const normalized = normalizeCompletion(rawCompletion);
  assert.strictEqual(normalized.content, 'Bonjour');
  assert.strictEqual(normalized.finishReason, 'stop');
  assert.deepStrictEqual(normalized.usage, {
    promptTokens: 3,
    completionTokens: 2,
    totalTokens: 5
  });
  assert.strictEqual(normalized.raw, rawCompletion);
  assert.strictEqual(
    normalizeStreamChunk({
      data: { choices: [{ delta: { content: 'Bon' } }] }
    }).content,
    'Bon'
  );

  let attempts = 0;
  let receivedOptions = null;
  const usageEvents = [];
  const fakeClient = {
    chat: {
      async complete(_request, options) {
        attempts += 1;
        receivedOptions = options;
        if (attempts === 1) {
          throw Object.assign(new Error('busy'), { status: 429 });
        }
        return {
          choices: [{ message: { content: 'Titre neutre' } }],
          usage: { promptTokens: 4, completionTokens: 2, totalTokens: 6 }
        };
      },
      async stream() {
        return (async function* streamEvents() {
          yield { data: { choices: [{ delta: { content: 'Titre ' } }] } };
          yield {
            data: {
              choices: [{ delta: { content: 'neutre' }, finishReason: 'stop' }],
              usage: { promptTokens: 4, completionTokens: 2, totalTokens: 6 }
            }
          };
        })();
      }
    }
  };
  const transport = createMistralTransport({
    client: fakeClient,
    timeoutMs: 1234,
    sleep: async () => {},
    onUsage: (usage) => usageEvents.push(usage)
  });

  const completion = await transport.complete({
    model: 'fake-model',
    messages: []
  });
  assert.strictEqual(completion.content, 'Titre neutre');
  assert.strictEqual(attempts, 2);
  assert.strictEqual(receivedOptions.timeoutMs, 1234);

  const streamedTokens = [];
  const streamed = await transport.stream(
    { model: 'fake-model', messages: [] },
    { onToken: (token) => streamedTokens.push(token) }
  );
  assert.strictEqual(streamed.content, 'Titre neutre');
  assert.deepStrictEqual(streamedTokens, ['Titre ', 'neutre']);
  assert.strictEqual(usageEvents.length, 2);

  await transport.stream(
    { model: 'fake-model', messages: [] },
    { reportUsage: false }
  );
  assert.strictEqual(usageEvents.length, 2);

  const missing = createMistralTransport();
  await assert.rejects(() => missing.complete({}), /MISTRAL_API_KEY/);

  console.log('mistral transport harness: ok');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
