'use strict';

const assert = require('node:assert/strict');
const { createAnalyzers } = require('../lib/analyzers');
const {
  createInformationRequestAnalyzer
} = require('../lib/information-routing');

const ANALYSIS_MODEL = 'mistral-small-latest';
const prompts = {
  ANALYZE_INFO: 'PROMPT_INFO_REQUEST',
  ANALYZE_INFO_SIGNAL: 'PROMPT_INFO_SIGNAL'
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

function createInfoSignalAnalyzer(mistralTransport) {
  let openAiCalls = 0;
  const analyzers = createAnalyzers({
    client: {
      chat: {
        completions: {
          async create() {
            openAiCalls += 1;
            throw new Error('OpenAI must not be called by information routing');
          }
        }
      }
    },
    MODEL_IDS: { analysis: 'openai-analysis', generation: 'openai-generation' },
    mistralTransport,
    MISTRAL_MODEL_IDS: { analysis: ANALYSIS_MODEL },
    isExplicitAppFeatureRequest: (message = '') =>
      message === 'Comment fonctionne cette app ?',
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

async function run() {
  const requestTransport = createFakeTransport([
    '{"isInfoRequest":true}',
    '{"isInfoRequest":false}',
    'not-json',
    new Error('provider unavailable')
  ]);
  const analyzeInfoRequest = createInformationRequestAnalyzer({
    mistralTransport: requestTransport,
    modelId: ANALYSIS_MODEL,
    trimInfoAnalysisHistory: (history = []) => history.slice(-1)
  });

  assert.deepEqual(
    await analyzeInfoRequest('Comment fonctionne la mémoire ?', [], prompts),
    { isInfoRequest: true, source: 'llm' }
  );
  assert.deepEqual(await analyzeInfoRequest('Je marche.', [], prompts), {
    isInfoRequest: false,
    source: 'llm'
  });
  assert.deepEqual(await analyzeInfoRequest('Ambigu', [], prompts), {
    isInfoRequest: false,
    source: 'llm_fallback'
  });
  assert.deepEqual(await analyzeInfoRequest('Indisponible', [], prompts), {
    isInfoRequest: false,
    source: 'llm_fallback'
  });
  assert.equal(requestTransport.requests[0].model, ANALYSIS_MODEL);
  assert.equal(requestTransport.requests[0].messages[0].content, prompts.ANALYZE_INFO);

  const signalTransport = createFakeTransport([
    JSON.stringify({
      detectedState: 'info_psychoeducation',
      psychoeducationType: 'anxiete',
      infoContextFlags: ['general']
    }),
    'not-json',
    new Error('provider unavailable')
  ]);
  const { analyzers, getOpenAiCalls } = createInfoSignalAnalyzer(signalTransport);

  assert.deepEqual(
    await analyzers.analyzeInfoSignal('Comment fonctionne l’anxiété ?', [], prompts),
    {
      detectedState: 'info_psychoeducation',
      psychoeducationType: 'anxiete',
      infoContextFlags: ['general'],
      source: 'llm'
    }
  );
  for (const message of ['Ambigu', 'Indisponible']) {
    assert.deepEqual(await analyzers.analyzeInfoSignal(message, [], prompts), {
      detectedState: 'info_features',
      psychoeducationType: null,
      infoContextFlags: [],
      source: 'llm_fallback'
    });
  }
  assert.equal(signalTransport.requests[0].model, ANALYSIS_MODEL);
  assert.equal(signalTransport.requests[0].messages[0].content, prompts.ANALYZE_INFO_SIGNAL);

  const callsBeforeGuard = signalTransport.requests.length;
  assert.equal(
    (await analyzers.analyzeInfoSignal('Comment fonctionne cette app ?', [], prompts)).source,
    'deterministic_app_features'
  );
  assert.equal(signalTransport.requests.length, callsBeforeGuard);
  assert.equal(getOpenAiCalls(), 0);

  console.log('information-routing-mistral-harness: ok');
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
