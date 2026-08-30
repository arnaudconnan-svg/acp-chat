'use strict';

const assert = require('node:assert/strict');
const { createAnalyzers } = require('../lib/analyzers');

const SECURITY_MODEL = 'mistral-medium-latest';
const prompts = {
  ANALYZE_SUICIDE_RISK: 'PROMPT_SUICIDE acute={{acuteCrisis}}'
};

function response(overrides = {}) {
  return {
    suicideLevel: 'N0',
    needsClarification: false,
    isQuote: false,
    idiomaticDeathExpression: false,
    crisisResolved: false,
    ...overrides
  };
}

function createFakeTransport(responses = []) {
  const requests = [];
  return {
    requests,
    async complete(request) {
      requests.push(request);
      const value = responses.shift();
      if (value instanceof Error) throw value;
      return { content: value };
    }
  };
}

function createSuicideAnalyzer(mistralTransport) {
  let openAiCalls = 0;
  const analyzers = createAnalyzers({
    client: {
      chat: {
        completions: {
          async create() {
            openAiCalls += 1;
            throw new Error('OpenAI must not be called by suicide detection');
          }
        }
      }
    },
    MODEL_IDS: { analysis: 'openai-analysis', generation: 'openai-generation' },
    mistralTransport,
    MISTRAL_MODEL_IDS: {
      analysis: 'mistral-small-latest',
      generation: SECURITY_MODEL
    },
    isExplicitAppFeatureRequest: () => false,
    llmInfoAnalysis: async () => ({ isInfoRequest: false, source: 'unused' }),
    normalizeMemory: (value) => String(value || ''),
    normalizeSessionFlags: (value) => value || {},
    shouldForceExplorationForSituatedImpasse: () => false,
    trimHistory: (history = []) => history,
    trimInfoAnalysisHistory: (history = []) => history,
    trimRecallAnalysisHistory: (history = []) => history,
    trimSuicideAnalysisHistory: (history = []) => history.slice(-4)
  });
  return { analyzers, getOpenAiCalls: () => openAiCalls };
}

async function run() {
  const transport = createFakeTransport([
    JSON.stringify(response()),
    JSON.stringify(response({ suicideLevel: 'N2' })),
    JSON.stringify(response({ isQuote: true })),
    JSON.stringify(response()),
    JSON.stringify(response({ suicideLevel: 'N1', needsClarification: true })),
    JSON.stringify(response({ suicideLevel: 'N2' })),
    JSON.stringify(response({ suicideLevel: 'N2' })),
    JSON.stringify(response()),
    JSON.stringify(response({ crisisResolved: false })),
    JSON.stringify(response({ crisisResolved: false })),
    'not-json',
    'not-json',
    new Error('provider unavailable'),
    JSON.stringify(response({ suicideLevel: 'UNKNOWN' })),
    JSON.stringify(response({ suicideLevel: 'N2' }))
  ]);
  const { analyzers, getOpenAiCalls } = createSuicideAnalyzer(transport);
  const analyze = (message, flags = {}) =>
    analyzers.analyzeSuicideRisk(message, [], flags, prompts);

  assert.deepEqual(await analyze('Je lis un livre aujourd’hui.'), {
    ...response(),
    crisisResolvedExplicit: false
  });

  const idiom = await analyze('Ce boulot me tue.');
  assert.equal(idiom.suicideLevel, 'N0');
  assert.equal(idiom.idiomaticDeathExpression, true);
  assert.equal(idiom.needsClarification, false);

  const citation = await analyze('Il a écrit : « je veux mourir ».');
  assert.equal(citation.suicideLevel, 'N0');
  assert.equal(citation.isQuote, true);

  const explicit = await analyze('Je veux mourir.');
  assert.equal(explicit.suicideLevel, 'N1');

  const ambiguous = await analyze('Je voudrais juste disparaître.');
  assert.equal(ambiguous.suicideLevel, 'N1');
  assert.equal(ambiguous.needsClarification, true);

  assert.equal((await analyze('Je veux me suicider.')).suicideLevel, 'N2');
  assert.equal(
    (await analyze("Je vais me tuer, j'ai préparé le moyen.")).suicideLevel,
    'N2'
  );

  const active = await analyze('Je ne sais plus quoi dire.', {
    acuteCrisis: true
  });
  assert.equal(active.crisisResolved, false);
  assert.match(transport.requests[7].messages[0].content, /acute=oui/);

  const resolved = await analyze("C'était un test, je vais bien.", {
    acuteCrisis: true
  });
  assert.equal(resolved.crisisResolved, true);
  assert.equal(resolved.crisisResolvedExplicit, true);

  const implicitResolution = await analyze('Ça semble un peu plus calme.', {
    acuteCrisis: true
  });
  assert.equal(implicitResolution.crisisResolved, false);
  assert.equal(implicitResolution.crisisResolvedExplicit, false);

  const invalidExplicit = await analyze("J'ai envie de mourir.");
  assert.equal(invalidExplicit.suicideLevel, 'N1');
  assert.equal(invalidExplicit.needsClarification, true);

  assert.equal((await analyze('Message neutre invalide.')).suicideLevel, 'N0');

  const unavailableActive = await analyze('Toujours là.', {
    acuteCrisis: true
  });
  assert.equal(unavailableActive.suicideLevel, 'N0');
  assert.equal(unavailableActive.crisisResolved, false);

  const unknownExplicit = await analyze('Je veux mourir.');
  assert.equal(unknownExplicit.suicideLevel, 'N1');
  assert.equal(unknownExplicit.needsClarification, true);

  const priority = await analyze(
    'Comment marche cette app ? Mais surtout je veux me suicider.'
  );
  assert.equal(priority.suicideLevel, 'N2');

  assert.equal(transport.requests.length, 15);
  for (const request of transport.requests) {
    assert.equal(request.model, SECURITY_MODEL);
  }
  assert.equal(getOpenAiCalls(), 0);

  console.log('suicide-risk-mistral-harness: ok');
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
