'use strict';

const assert = require('assert');
const { createWriter } = require('../lib/writer');

function buildPostureDecision() {
  return {
    conversationState: 'exploration_open',
    intent: 'Accompagner sans imposer',
    allowed: [],
    forbidden: [],
    style: {},
    writerIntentHints: [],
    relancePolicy: 'none'
  };
}

function createHarnessWriter(mistralTransport) {
  return createWriter({
    mistralTransport,
    MISTRAL_MODEL_IDS: { generation: 'mistral-medium-latest' },
    normalizeMemory: (value) => String(value || '')
  });
}

async function main() {
  let classicRequest = null;
  const classicWriter = createHarnessWriter({
    async complete(request) {
      classicRequest = request;
      return {
        content: '  Reponse principale  ',
        usage: { promptTokens: 12, completionTokens: 3, totalTokens: 15 }
      };
    },
    async stream() {
      throw new Error('unexpected stream call');
    }
  });
  const classic = await classicWriter.generateReply({
    message: 'Message neutre',
    history: [],
    memory: '',
    postureDecision: buildPostureDecision()
  });
  assert.strictEqual(classic.reply, 'Reponse principale');
  assert.deepStrictEqual(classic.usage, {
    promptTokens: 12,
    completionTokens: 3,
    totalTokens: 15
  });
  assert.strictEqual(classicRequest.model, 'mistral-medium-latest');
  assert.strictEqual(classicRequest.topP, 1);
  assert.strictEqual(classicRequest.presencePenalty, 0.3);
  assert.strictEqual(classicRequest.frequencyPenalty, 0.15);
  assert.strictEqual(classicRequest.messages.at(-1).content, 'Message neutre');

  let n1Request = null;
  const n1Writer = createHarnessWriter({
    async complete(request) {
      n1Request = request;
      return { content: 'Question de clarification N1', usage: null };
    },
    async stream() {
      throw new Error('unexpected stream call');
    }
  });
  const n1Decision = {
    ...buildPostureDecision(),
    conversationState: 'n1_crisis'
  };
  const n1Result = await n1Writer.generateReply({
    message: 'Je voudrais disparaître.',
    history: [],
    memory: '',
    postureDecision: n1Decision,
    promptRegistry: {
      N1_RESPONSE_LLM: 'CONTRAT_N1_TEST'
    }
  });
  assert.strictEqual(n1Result.reply, 'Question de clarification N1');
  assert.strictEqual(n1Request.model, 'mistral-medium-latest');
  assert(
    n1Request.messages.some((message) =>
      String(message.content || '').includes('CONTRAT_N1_TEST')
    )
  );

  let streamRequest = null;
  let streamOptions = null;
  const emittedTokens = [];
  const streamWriter = createHarnessWriter({
    async complete() {
      throw new Error('unexpected classic call');
    },
    async stream(request, options) {
      streamRequest = request;
      streamOptions = options;
      await options.onToken('Reponse ');
      await options.onToken('streamée');
      return {
        content: 'Reponse streamée',
        usage: { promptTokens: 10, completionTokens: 4, totalTokens: 14 }
      };
    }
  });
  const streamed = await streamWriter.generateReply({
    message: 'Message neutre',
    history: [],
    memory: '',
    postureDecision: buildPostureDecision(),
    onTokenCallback: (token) => emittedTokens.push(token)
  });
  assert.strictEqual(streamed.reply, 'Reponse streamée');
  assert.deepStrictEqual(emittedTokens, ['Reponse ', 'streamée']);
  assert.strictEqual(streamRequest.model, 'mistral-medium-latest');
  assert.strictEqual(streamOptions.reportUsage, false);
  assert.strictEqual(streamed.usage.totalTokens, 14);

  const failingWriter = createHarnessWriter({
    async complete() {
      throw new Error('mistral unavailable');
    },
    async stream() {
      throw new Error('mistral unavailable');
    }
  });
  await assert.rejects(
    () =>
      failingWriter.generateReply({
        message: 'Message neutre',
        history: [],
        memory: '',
        postureDecision: buildPostureDecision()
      }),
    /mistral unavailable/
  );
  await assert.rejects(
    () =>
      failingWriter.generateReply({
        message: 'Message neutre',
        history: [],
        memory: '',
        postureDecision: buildPostureDecision(),
        onTokenCallback: () => {}
      }),
    /mistral unavailable/
  );

  console.log('writer Mistral harness: ok');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
