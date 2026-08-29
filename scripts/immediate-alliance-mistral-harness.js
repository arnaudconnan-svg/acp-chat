'use strict';

const assert = require('node:assert/strict');
const { createAnalyzers } = require('../lib/analyzers');

const ANALYSIS_MODEL = 'mistral-small-latest';
const prompts = {
  ANALYZE_RELATIONAL_ADJUSTMENT: 'PROMPT_RELATIONAL_ADJUSTMENT',
  ANALYZE_ALLIANCE_RUPTURE: 'PROMPT_ALLIANCE_RUPTURE'
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

function createImmediateAllianceAnalyzers(mistralTransport) {
  let openAiCalls = 0;
  const analyzers = createAnalyzers({
    client: {
      chat: {
        completions: {
          async create() {
            openAiCalls += 1;
            throw new Error('OpenAI must not be called by immediate alliance');
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
    '{"needsRelationalAdjustment":true}',
    '{"needsRelationalAdjustment":false}',
    'not-json',
    new Error('provider unavailable'),
    '{"allianceSignal":"good"}',
    '{"allianceSignal":"fragile"}',
    '{"allianceSignal":"good"}',
    'not-json',
    new Error('provider unavailable')
  ]);
  const { analyzers, getOpenAiCalls } =
    createImmediateAllianceAnalyzers(transport);

  assert.equal(
    (
      await analyzers.analyzeRelationalAdjustmentNeed(
        'Je raconte ma journée.', [], '', false, prompts
      )
    ).source,
    'deterministic_no_trigger'
  );
  assert.equal(
    (
      await analyzers.analyzeRelationalAdjustmentNeed(
        "Je m'en veux.", [], '', true, prompts
      )
    ).source,
    'isContact_guard'
  );
  assert.equal(transport.requests.length, 0);

  const adjustment = await analyzers.analyzeRelationalAdjustmentNeed(
    "Tu ne m'aides pas.", [], 'Mémoire.', false, prompts
  );
  assert.deepEqual(adjustment, {
    needsRelationalAdjustment: true,
    llmTriggered: true,
    source: 'llm'
  });
  assert.equal(
    (
      await analyzers.analyzeRelationalAdjustmentNeed(
        "Je n'ai pas compris ta question.", [], '', false, prompts
      )
    ).needsRelationalAdjustment,
    false
  );
  for (const message of ["C'est nul.", 'Tu te trompes.']) {
    assert.deepEqual(
      await analyzers.analyzeRelationalAdjustmentNeed(
        message, [], '', false, prompts
      ),
      {
        needsRelationalAdjustment: false,
        llmTriggered: true,
        source: 'llm_parse_error'
      }
    );
  }

  assert.deepEqual(await analyzers.analyzeAllianceRupture('Merci.', [], prompts), {
    allianceSignal: 'good',
    explicitRelationalFriction: false,
    llmTriggered: true,
    source: 'llm'
  });
  assert.equal(
    (
      await analyzers.analyzeAllianceRupture(
        "En fait, c'est plutôt une autre chose.", [], prompts
      )
    ).allianceSignal,
    'fragile'
  );
  assert.equal(
    (
      await analyzers.analyzeAllianceRupture(
        "Tu ne m'aides pas.", [], prompts
      )
    ).allianceSignal,
    'rupture'
  );
  assert.equal(
    (await analyzers.analyzeAllianceRupture('Message neutre.', [], prompts))
      .allianceSignal,
    'good'
  );
  const unavailableAlliance = await analyzers.analyzeAllianceRupture(
    'Tu te trompes.', [], prompts
  );
  assert.equal(unavailableAlliance.allianceSignal, 'fragile');
  assert.equal(unavailableAlliance.source, 'llm_fallback');

  assert.equal(transport.requests.length, 9);
  for (const request of transport.requests) assert.equal(request.model, ANALYSIS_MODEL);
  for (const request of transport.requests.slice(0, 4)) {
    assert.equal(request.messages[0].content, prompts.ANALYZE_RELATIONAL_ADJUSTMENT);
  }
  for (const request of transport.requests.slice(4)) {
    assert.equal(request.messages[0].content, prompts.ANALYZE_ALLIANCE_RUPTURE);
  }
  assert.equal(getOpenAiCalls(), 0);

  console.log('immediate-alliance-mistral-harness: ok');
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
