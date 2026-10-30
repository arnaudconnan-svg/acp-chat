'use strict';

const assert = require('assert');
const { Mistral } = require('@mistralai/mistralai');
const { HTTPClient } = require('@mistralai/mistralai/lib/http.js');
const {
  createMistralTransport,
  normalizeCompletion,
  normalizeStreamChunk
} = require('../lib/mistral-transport');

async function verifyLarge4WireCompatibility() {
  const requests = [];
  const thinking = {
    type: 'thinking',
    thinking: [{ type: 'text', text: 'Internal trace' }]
  };
  // Exercise the installed SDK's actual request serialization and response parsing
  // without network access, credentials, Firebase or conversation persistence.
  const client = new Mistral({
    apiKey: 'synthetic-unused',
    httpClient: new HTTPClient({
      async fetcher(request) {
        const body = JSON.parse(await request.text());
        requests.push(body);
        const base = { id: 'synthetic', created: 1, model: body.model };
        const usage = {
          prompt_tokens: 8,
          completion_tokens: 12,
          total_tokens: 20
        };
        if (body.stream) {
          const deltas = [
            { content: [thinking] },
            { content: [thinking, { type: 'text', text: 'Bonjour' }] },
            { content: ' !' }
          ];
          const events = deltas.map((delta, index) => ({
            ...base,
            object: 'chat.completion.chunk',
            choices: [
              { index: 0, delta, finish_reason: index === 2 ? 'stop' : null }
            ],
            ...(index === 2 ? { usage } : {})
          }));
          return new Response(
            events
              .map((event) => `data: ${JSON.stringify(event)}\n\n`)
              .join('') + 'data: [DONE]\n\n',
            { headers: { 'content-type': 'text/event-stream' } }
          );
        }
        return Response.json({
          ...base,
          object: 'chat.completion',
          choices: [
            {
              index: 0,
              message: {
                role: 'assistant',
                content: [thinking, { type: 'text', text: '{"ok":true}' }]
              },
              finish_reason: 'stop'
            }
          ],
          usage
        });
      }
    })
  });
  const transport = createMistralTransport({ client, maxRetries: 0 });
  const request = {
    model: 'mistral-large-4-0',
    messages: [{ role: 'user', content: 'Synthetic JSON compatibility check' }],
    responseFormat: { type: 'json_object' },
    temperature: 0.1,
    maxTokens: 1024
  };
  const completed = await transport.complete(request);
  assert.deepStrictEqual(JSON.parse(completed.content), { ok: true });
  assert.strictEqual(completed.usage.totalTokens, 20);
  assert.strictEqual(
    request.reasoningEffort,
    undefined,
    'caller request remains unchanged'
  );
  assert.strictEqual(requests[0].reasoning_effort, 'low');
  assert.strictEqual(requests[0].model, 'mistral-large-4-0');
  assert.deepStrictEqual(requests[0].response_format, { type: 'json_object' });
  assert.strictEqual(requests[0].max_tokens, 1024);
  assert.strictEqual(requests[0].temperature, 0.1);

  const tokens = [];
  const streamed = await transport.stream(
    { model: 'mistral-large-4', messages: request.messages },
    { onToken: (token) => tokens.push(token) }
  );
  assert.strictEqual(requests[1].reasoning_effort, 'low');
  assert.deepStrictEqual(tokens, ['Bonjour', ' !']);
  assert.strictEqual(streamed.content, 'Bonjour !');
  assert.strictEqual(streamed.usage.totalTokens, 20);
  assert.strictEqual(streamed.finishReason, 'stop');

  await transport.complete({ ...request, reasoningEffort: 'medium' });
  assert.strictEqual(requests[2].reasoning_effort, 'medium');
  await transport.complete({ ...request, model: 'mistral-small-latest' });
  assert.strictEqual(requests[3].reasoning_effort, undefined);
  await transport.complete({ ...request, model: 'mistral-medium-latest' });
  assert.strictEqual(
    requests[4].reasoning_effort,
    undefined,
    'rollback model remains unchanged'
  );
}

async function main() {
  await verifyLarge4WireCompatibility();
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
