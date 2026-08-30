'use strict';

const assert = require('node:assert/strict');
const { createAnalyzers } = require('../lib/analyzers');

const SECURITY_MODEL = 'mistral-medium-latest';
const prompts = { ANALYZE_IMMINENT_MAJOR_HARM_RISK: 'PROMPT_MAJOR_HARM_RISK' };

function result(overrides = {}) {
  return {
    harmRiskLevel: 'H0',
    imminenceBand: 'none',
    targetsPeople: false,
    isSelfDefenseClaimed: false,
    needsImmediateSafetyFrame: false,
    ...overrides
  };
}

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

function createRiskAnalyzer(mistralTransport) {
  let openAiCalls = 0;
  const analyzers = createAnalyzers({
    client: {
      chat: {
        completions: {
          async create() {
            openAiCalls += 1;
            throw new Error('OpenAI must not be called by major harm detection');
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
    trimSuicideAnalysisHistory: (history = []) => history
  });
  return { analyzers, getOpenAiCalls: () => openAiCalls };
}

async function run() {
  const safe = result();
  const vagueThreat = result({
    harmRiskLevel: 'H1',
    imminenceBand: 'short_term',
    targetsPeople: true,
    needsImmediateSafetyFrame: true
  });
  const immediatePlan = result({
    harmRiskLevel: 'H2',
    imminenceBand: 'immediate',
    targetsPeople: true,
    needsImmediateSafetyFrame: true
  });
  const capability = result({
    harmRiskLevel: 'H2',
    imminenceBand: 'capability_opportunity',
    targetsPeople: true,
    needsImmediateSafetyFrame: true
  });
  const selfDefense = result({
    harmRiskLevel: 'H1',
    imminenceBand: 'short_term',
    targetsPeople: true,
    isSelfDefenseClaimed: true,
    needsImmediateSafetyFrame: true
  });
  const transport = createFakeTransport([
    JSON.stringify(safe),
    JSON.stringify(safe),
    JSON.stringify(vagueThreat),
    JSON.stringify(vagueThreat),
    JSON.stringify(immediatePlan),
    JSON.stringify(capability),
    JSON.stringify(selfDefense),
    JSON.stringify(safe),
    'not-json',
    'not-json',
    new Error('provider unavailable'),
    JSON.stringify({ harmRiskLevel: 'UNKNOWN', imminenceBand: 'none' }),
    JSON.stringify({ ...immediatePlan, needsImmediateSafetyFrame: false })
  ]);
  const { analyzers, getOpenAiCalls } = createRiskAnalyzer(transport);
  const analyze = (message) =>
    analyzers.analyzeImminentMajorHarmRisk(message, [], prompts);

  assert.deepEqual(await analyze('Je suis contrarié, mais sans danger.'), safe);
  assert.deepEqual(await analyze('Je suis très en colère contre lui.'), safe);
  assert.deepEqual(await analyze('Il va payer un jour.'), vagueThreat);
  assert.deepEqual(await analyze('Je veux frapper cette personne.'), vagueThreat);
  assert.deepEqual(await analyze('Je vais le tuer maintenant.'), immediatePlan);
  assert.deepEqual(
    await analyze("Je veux le tuer, j'ai un couteau."),
    capability
  );
  assert.deepEqual(
    await analyze('Je veux le frapper pour me défendre.'),
    selfDefense
  );
  assert.deepEqual(
    await analyze('Dans mon roman, le personnage dit : je vais le tuer.'),
    safe
  );

  assert.deepEqual(
    await analyze('Je vais le frapper demain.'),
    result({
      harmRiskLevel: 'H1',
      imminenceBand: 'short_term',
      targetsPeople: true,
      needsImmediateSafetyFrame: true
    })
  );
  assert.deepEqual(await analyze('Texte sans menace explicite.'), safe);
  assert.deepEqual(
    await analyze('Je vais le tuer tout de suite.'),
    immediatePlan
  );
  assert.deepEqual(
    await analyze("Je veux le tuer, j'ai un fusil."),
    capability
  );

  const forcedFrame = await analyze('Plan immédiat fourni par le modèle.');
  assert.equal(forcedFrame.harmRiskLevel, 'H2');
  assert.equal(forcedFrame.needsImmediateSafetyFrame, true);

  assert.equal(transport.requests.length, 13);
  for (const request of transport.requests) {
    assert.equal(request.model, SECURITY_MODEL);
    assert.equal(
      request.messages[0].content,
      prompts.ANALYZE_IMMINENT_MAJOR_HARM_RISK
    );
  }
  assert.equal(getOpenAiCalls(), 0);

  console.log('major-harm-risk-mistral-harness: ok');
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
