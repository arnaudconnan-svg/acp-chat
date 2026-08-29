'use strict';

const assert = require('node:assert/strict');
const { createAnalyzers } = require('../lib/analyzers');

const ANALYSIS_MODEL = 'mistral-small-latest';
const prompts = { ANALYZE_DEPENDENCY_RISK: 'PROMPT_DEPENDENCY_RISK' };
const fallback = {
  isolationSignal: 'absent',
  isolationCounterSignal: 'absent',
  attachmentSignal: 'absent',
  attachmentCounterSignal: 'absent',
  contextIsHyperbolicDischarge: false
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

function createDependencyAnalyzer(mistralTransport) {
  let openAiCalls = 0;
  const analyzers = createAnalyzers({
    client: {
      chat: {
        completions: {
          async create() {
            openAiCalls += 1;
            throw new Error('OpenAI must not be called by dependency analysis');
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
  return [
    message,
    [
      { role: 'user', content: 'Je me suis beaucoup isolé récemment.' },
      { role: 'assistant', content: 'Tu décris moins de liens autour de toi.' }
    ],
    'Contexte intersession : la personne mentionne aussi un proche disponible.',
    prompts
  ];
}

async function run() {
  const isolationAndAttachment = {
    isolationSignal: 'strong',
    isolationCounterSignal: 'absent',
    attachmentSignal: 'present',
    attachmentCounterSignal: 'absent',
    contextIsHyperbolicDischarge: false
  };
  const healthyCounterSignals = {
    isolationSignal: 'absent',
    isolationCounterSignal: 'strong',
    attachmentSignal: 'absent',
    attachmentCounterSignal: 'present',
    contextIsHyperbolicDischarge: false
  };
  const hyperbolicDischarge = {
    isolationSignal: 'present',
    isolationCounterSignal: 'absent',
    attachmentSignal: 'absent',
    attachmentCounterSignal: 'absent',
    contextIsHyperbolicDischarge: true
  };
  const transport = createFakeTransport([
    JSON.stringify(isolationAndAttachment),
    JSON.stringify(healthyCounterSignals),
    JSON.stringify(hyperbolicDischarge),
    JSON.stringify({
      isolationSignal: 'unknown',
      isolationCounterSignal: null,
      attachmentSignal: 4,
      attachmentCounterSignal: false,
      contextIsHyperbolicDischarge: false
    }),
    'not-json',
    new Error('provider unavailable')
  ]);
  const { analyzers, getOpenAiCalls } = createDependencyAnalyzer(transport);

  assert.deepEqual(
    await analyzers.analyzeDependencyRisk(...input('Je ne vois plus personne.')),
    isolationAndAttachment
  );
  assert.deepEqual(
    await analyzers.analyzeDependencyRisk(
      ...input('J’ai revu mes amis et je peux aussi parler à ma sœur.')
    ),
    healthyCounterSignals
  );
  assert.deepEqual(
    await analyzers.analyzeDependencyRisk(
      ...input('Vous êtes la seule personne au monde qui me comprend !')
    ),
    hyperbolicDischarge
  );
  assert.deepEqual(
    await analyzers.analyzeDependencyRisk(...input('Catégories inconnues.')),
    fallback
  );
  assert.deepEqual(
    await analyzers.analyzeDependencyRisk(...input('Sortie invalide.')),
    fallback
  );
  assert.deepEqual(
    await analyzers.analyzeDependencyRisk(...input('Fournisseur indisponible.')),
    fallback
  );

  assert.equal(transport.requests.length, 6);
  for (const request of transport.requests) {
    assert.equal(request.model, ANALYSIS_MODEL);
    assert.equal(request.messages[0].content, prompts.ANALYZE_DEPENDENCY_RISK);
    assert.match(request.messages[1].content, /Historique recent/);
    assert.match(request.messages[1].content, /Memoire inter-session/);
  }
  assert.equal(getOpenAiCalls(), 0);

  console.log('dependency-risk-mistral-harness: ok');
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
