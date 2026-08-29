'use strict';

const assert = require('node:assert/strict');
const { createAnalyzers } = require('../lib/analyzers');

const GENERATION_MODEL = 'mistral-medium-latest';
const prompts = {
  IMMINENT_MAJOR_HARM_RESPONSE_LLM: 'PROMPT_MAJOR_HARM_RESPONSE'
};

function createHarnessAnalyzers(mistralTransport) {
  let openAiCalls = 0;
  const analyzers = createAnalyzers({
    client: {
      chat: {
        completions: {
          async create() {
            openAiCalls += 1;
            throw new Error('OpenAI must not be called by major harm response');
          }
        }
      }
    },
    MODEL_IDS: { analysis: 'openai-analysis', generation: 'openai-generation' },
    mistralTransport,
    MISTRAL_MODEL_IDS: {
      analysis: 'mistral-small-latest',
      generation: GENERATION_MODEL
    },
    isExplicitAppFeatureRequest: () => false,
    llmInfoAnalysis: async () => ({ isInfoRequest: false, source: 'unused' }),
    normalizeMemory: (value) => String(value || ''),
    normalizeSessionFlags: (value) => value || {},
    shouldForceExplorationForSituatedImpasse: () => false,
    trimHistory: (history = []) => history,
    trimInfoAnalysisHistory: (history = []) => history,
    trimRecallAnalysisHistory: (history = []) => history,
    trimSuicideAnalysisHistory: (history = []) => history
  });
  return { analyzers, getOpenAiCalls: () => openAiCalls };
}

function history() {
  return Array.from({ length: 6 }, (_, index) => ({
    role: index % 2 === 0 ? 'user' : 'assistant',
    content: `tour-${index + 1}`
  }));
}

async function run() {
  let nominalRequest = null;
  let nominalOptions = null;
  const nominalTokens = [];
  const nominal = createHarnessAnalyzers({
    async complete() {
      throw new Error('non-stream path must not be used');
    },
    async stream(request, options) {
      nominalRequest = request;
      nominalOptions = options;
      await options.onToken("Je ne peux pas t'aider ");
      await options.onToken('à préparer cette action.');
      return {
        content: "Je ne peux pas t'aider à préparer cette action.",
        usage: { promptTokens: 10, completionTokens: 8, totalTokens: 18 }
      };
    }
  });
  const nominalReply = await nominal.analyzers.imminentMajorHarmResponseLLM(
    'Message dangereux.',
    history(),
    prompts,
    (token) => nominalTokens.push(token)
  );
  assert.equal(
    nominalReply,
    "Je ne peux pas t'aider à préparer cette action."
  );
  assert.deepEqual(nominalTokens, [
    "Je ne peux pas t'aider ",
    'à préparer cette action.'
  ]);
  assert.equal(nominalRequest.model, GENERATION_MODEL);
  assert.equal(nominalRequest.messages[0].content, prompts.IMMINENT_MAJOR_HARM_RESPONSE_LLM);
  assert.deepEqual(
    nominalRequest.messages.slice(1, -1).map((item) => item.content),
    ['tour-3', 'tour-4', 'tour-5', 'tour-6']
  );
  assert.equal(nominalOptions.reportUsage, false);
  assert.equal(nominal.getOpenAiCalls(), 0);

  const withoutCallback = createHarnessAnalyzers({
    async stream(request, options) {
      await options.onToken('Refus sans callback.');
      return { content: 'Refus sans callback.', usage: null };
    }
  });
  assert.equal(
    await withoutCallback.analyzers.imminentMajorHarmResponseLLM(
      'Message dangereux.', [], prompts
    ),
    'Refus sans callback.'
  );

  const fallback = nominal.analyzers.imminentMajorHarmFallback();
  const empty = createHarnessAnalyzers({
    async stream() {
      return { content: '', usage: null };
    }
  });
  assert.equal(
    await empty.analyzers.imminentMajorHarmResponseLLM(
      'Message dangereux.', [], prompts
    ),
    fallback
  );

  const beforeTokenError = createHarnessAnalyzers({
    async stream() {
      throw new Error('provider unavailable before token');
    }
  });
  assert.equal(
    await beforeTokenError.analyzers.imminentMajorHarmResponseLLM(
      'Message dangereux.', [], prompts
    ),
    fallback
  );

  const partialTokens = [];
  const afterTokenError = createHarnessAnalyzers({
    async stream(request, options) {
      await options.onToken("Je ne peux pas t'aider.");
      throw new Error('stream interrupted after token');
    }
  });
  const partialReply =
    await afterTokenError.analyzers.imminentMajorHarmResponseLLM(
      'Message dangereux.',
      [],
      prompts,
      (token) => partialTokens.push(token)
    );
  assert.equal(partialReply, "Je ne peux pas t'aider.");
  assert.deepEqual(partialTokens, ["Je ne peux pas t'aider."]);
  assert.equal(partialReply.includes(fallback), false);

  console.log('major-harm-response-mistral-harness: ok');
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
