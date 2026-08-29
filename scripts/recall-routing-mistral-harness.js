'use strict';

const assert = require('node:assert/strict');
const { createAnalyzers } = require('../lib/analyzers');

const ANALYSIS_MODEL = 'mistral-small-latest';
const prompts = { ANALYZE_RECALL: 'PROMPT_ANALYZE_RECALL' };

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

function createRecallAnalyzer(mistralTransport) {
  let openAiCalls = 0;
  const analyzers = createAnalyzers({
    client: {
      chat: {
        completions: {
          async create() {
            openAiCalls += 1;
            throw new Error('OpenAI must not be called by recall routing');
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

function recallInput(message) {
  return {
    message,
    recentHistory: [{ role: 'assistant', content: 'Contexte récent.' }],
    memory: 'Contexte résumé.',
    intersessionMemory: 'Contexte intersession.',
    promptRegistry: prompts
  };
}

async function run() {
  const shortTermRaw = JSON.stringify({
    isRecallAttempt: true,
    calledMemory: 'shortTermMemory'
  });
  const longTermRaw = JSON.stringify({
    isRecallAttempt: true,
    calledMemory: 'longTermMemory'
  });
  const transport = createFakeTransport([
    shortTermRaw,
    longTermRaw,
    'not-json',
    new Error('provider unavailable')
  ]);
  const { analyzers, getOpenAiCalls } = createRecallAnalyzer(transport);

  const shortTerm = await analyzers.analyzeRecallRouting(
    recallInput('Tu te souviens de ce que je viens de dire ?')
  );
  assert.equal(shortTerm.isRecallAttempt, true);
  assert.equal(shortTerm.calledMemory, 'shortTermMemory');
  assert.equal(shortTerm.isLongTermMemoryRecall, false);
  assert.equal(shortTerm.rawLlmOutput, shortTermRaw);
  assert.equal(shortTerm.source, 'llm');

  const longTerm = await analyzers.analyzeRecallRouting(
    recallInput('Rappelle-toi de ce que je t’avais dit auparavant.')
  );
  assert.equal(longTerm.isRecallAttempt, true);
  assert.equal(longTerm.calledMemory, 'longTermMemory');
  assert.equal(longTerm.isLongTermMemoryRecall, true);
  assert.equal(longTerm.rawLlmOutput, longTermRaw);

  const noRecall = await analyzers.analyzeRecallRouting(
    recallInput('Je parle simplement de ma journée.')
  );
  assert.equal(noRecall.isRecallAttempt, false);
  assert.equal(noRecall.calledMemory, 'none');
  assert.equal(noRecall.source, 'deterministic_no_signal');
  assert.equal(transport.requests.length, 2);

  for (const message of [
    'Tu te souviens de cette sortie invalide ?',
    'Rappelle-toi malgré la panne.'
  ]) {
    const fallback = await analyzers.analyzeRecallRouting(recallInput(message));
    assert.equal(fallback.isRecallAttempt, false);
    assert.equal(fallback.calledMemory, 'none');
    assert.equal(fallback.isLongTermMemoryRecall, false);
    assert.equal(fallback.rawLlmOutput, null);
    assert.equal(fallback.source, 'llm_fallback');
  }

  assert.equal(transport.requests.length, 4);
  for (const request of transport.requests) {
    assert.equal(request.model, ANALYSIS_MODEL);
    assert.equal(request.messages[0].content, prompts.ANALYZE_RECALL);
  }
  assert.equal(getOpenAiCalls(), 0);

  console.log('recall-routing-mistral-harness: ok');
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
