'use strict';

const assert = require('node:assert/strict');
const { createAnalyzers } = require('../lib/analyzers');

const ANALYSIS_MODEL = 'mistral-small-latest';
const prompts = {
  ANALYZE_EXPLORATION_CALIBRATION: 'PROMPT_EXPLORATION_CALIBRATION',
  ANALYZE_EXPLORATION_SIGNAL: 'PROMPT_EXPLORATION_SIGNAL'
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

function createExplorationAnalyzers(mistralTransport) {
  let openAiCalls = 0;
  const analyzers = createAnalyzers({
    client: {
      chat: {
        completions: {
          async create() {
            openAiCalls += 1;
            throw new Error('OpenAI must not be called by exploration tests');
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

async function run() {
  const transport = createFakeTransport([
    JSON.stringify({ isExploration: true, confidence: 'high', everydayConcreteShare: true, lowContextOpening: false }),
    JSON.stringify({ isExploration: false, confidence: 'medium', everydayConcreteShare: false, lowContextOpening: true }),
    'not-json',
    new Error('provider unavailable'),
    JSON.stringify({ calibrationLevel: 1, explorationSignal: 'interpretation' }),
    JSON.stringify({ calibrationLevel: 4, explorationSignal: 'phenomenological_follow' }),
    'not-json',
    new Error('provider unavailable')
  ]);
  const { analyzers, getOpenAiCalls } = createExplorationAnalyzers(transport);

  assert.deepEqual(
    await analyzers.analyzeExplorationSignal('Je remarque que je recommence toujours pareil.', [], prompts),
    { isExploration: true, confidence: 'high', everydayConcreteShare: true, lowContextOpening: false, source: 'llm' }
  );
  assert.deepEqual(
    await analyzers.analyzeExplorationSignal('Il pleut.', [], prompts),
    { isExploration: false, confidence: 'medium', everydayConcreteShare: false, lowContextOpening: true, source: 'llm' }
  );
  for (const message of ['Sortie invalide', 'Fournisseur indisponible']) {
    assert.deepEqual(
      await analyzers.analyzeExplorationSignal(message, [], prompts),
      { isExploration: false, confidence: 'low', everydayConcreteShare: false, lowContextOpening: false, source: 'llm_error' }
    );
  }

  const calibrationInput = {
    message: 'Je voudrais comprendre ce qui se répète.',
    history: [],
    memory: 'Contexte factuel.',
    explorationDirectivityLevel: 2,
    explorationRelanceWindow: [false, true],
    promptRegistry: prompts
  };
  assert.deepEqual(await analyzers.analyzeExplorationCalibration(calibrationInput), {
    calibrationLevel: 1,
    explorationSignal: 'interpretation'
  });
  assert.deepEqual(await analyzers.analyzeExplorationCalibration(calibrationInput), {
    calibrationLevel: 4,
    explorationSignal: 'phenomenological_follow'
  });
  for (let index = 0; index < 2; index += 1) {
    assert.deepEqual(await analyzers.analyzeExplorationCalibration(calibrationInput), {
      calibrationLevel: 2,
      explorationSignal: 'interpretation'
    });
  }

  assert.equal(transport.requests.length, 8);
  for (const request of transport.requests) assert.equal(request.model, ANALYSIS_MODEL);
  assert.equal(transport.requests[0].messages[0].content, prompts.ANALYZE_EXPLORATION_SIGNAL);
  assert.equal(transport.requests[4].messages[0].content, prompts.ANALYZE_EXPLORATION_CALIBRATION);
  assert.equal(getOpenAiCalls(), 0);

  console.log('exploration-mistral-harness: ok');
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
