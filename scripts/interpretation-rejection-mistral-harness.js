'use strict';

const assert = require('node:assert/strict');
const { createAnalyzers } = require('../lib/analyzers');

const ANALYSIS_MODEL = 'mistral-small-latest';
const prompts = {
  ANALYZE_INTERPRETATION_REJECTION: 'PROMPT_INTERPRETATION_REJECTION'
};

function createFakeTransport(responses = []) {
  const requests = [];
  return {
    requests,
    async complete(request) {
      requests.push(request);
      const response = responses.shift();
      if (response instanceof Error) throw response;
      return { content: response };
    }
  };
}

function createInterpretationAnalyzer(mistralTransport) {
  let openAiCalls = 0;
  const analyzers = createAnalyzers({
    client: {
      chat: {
        completions: {
          async create() {
            openAiCalls += 1;
            throw new Error('OpenAI must not be called by interpretation rejection');
          }
        }
      }
    },
    MODEL_IDS: { analysis: 'openai-analysis', generation: 'openai-generation' },
    mistralTransport,
    MISTRAL_MODEL_IDS: { analysis: ANALYSIS_MODEL },
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

function input(message) {
  return {
    message,
    history: [{ role: 'assistant', content: 'Une interprétation précédente.' }],
    memory: 'Contexte résumé.',
    promptRegistry: prompts
  };
}

async function run() {
  const transport = createFakeTransport([
    JSON.stringify({
      isInterpretationRejection: true,
      rejectsUnderlyingPhenomenon: false,
      relationalFrictionSignal: 'mild'
    }),
    JSON.stringify({
      isInterpretationRejection: true,
      rejectsUnderlyingPhenomenon: true,
      relationalFrictionSignal: 'strong'
    }),
    JSON.stringify({
      isInterpretationRejection: false,
      rejectsUnderlyingPhenomenon: false,
      relationalFrictionSignal: 'none'
    }),
    'not-json',
    new Error('provider unavailable')
  ]);
  const { analyzers, getOpenAiCalls } =
    createInterpretationAnalyzer(transport);

  assert.deepEqual(
    await analyzers.analyzeInterpretationRejection(
      input("Ce n'est pas ça, mais ce que je ressens existe bien.")
    ),
    {
      isInterpretationRejection: true,
      rejectsUnderlyingPhenomenon: false,
      relationalFrictionSignal: 'mild'
    }
  );
  assert.deepEqual(
    await analyzers.analyzeInterpretationRejection(
      input("Non, ce n'est pas ça et je ne ressens rien de tel.")
    ),
    {
      isInterpretationRejection: true,
      rejectsUnderlyingPhenomenon: true,
      relationalFrictionSignal: 'strong'
    }
  );
  assert.deepEqual(
    await analyzers.analyzeInterpretationRejection(
      input("Je ne suis pas totalement d'accord avec le détail.")
    ),
    {
      isInterpretationRejection: false,
      rejectsUnderlyingPhenomenon: false,
      relationalFrictionSignal: 'none'
    }
  );

  const fallback = {
    isInterpretationRejection: false,
    rejectsUnderlyingPhenomenon: false,
    relationalFrictionSignal: 'none'
  };
  assert.deepEqual(
    await analyzers.analyzeInterpretationRejection(input('Sortie invalide.')),
    fallback
  );
  assert.deepEqual(
    await analyzers.analyzeInterpretationRejection(
      input('Fournisseur indisponible.')
    ),
    fallback
  );

  assert.equal(transport.requests.length, 5);
  for (const request of transport.requests) {
    assert.equal(request.model, ANALYSIS_MODEL);
    assert.equal(
      request.messages[0].content,
      prompts.ANALYZE_INTERPRETATION_REJECTION
    );
  }
  assert.equal(getOpenAiCalls(), 0);

  console.log('interpretation-rejection-mistral-harness: ok');
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
