'use strict';

const assert = require('node:assert/strict');
const { createAnalyzers } = require('../lib/analyzers');

const ANALYSIS_MODEL = 'mistral-small-latest';
const prompts = {
  ANALYZE_DISCHARGE: 'PROMPT_ANALYZE_DISCHARGE',
  ANALYZE_CONTACT: 'PROMPT_ANALYZE_CONTACT'
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

function createContactDischargeAnalyzers(mistralTransport) {
  let openAiCalls = 0;
  const analyzers = createAnalyzers({
    client: {
      chat: {
        completions: {
          async create() {
            openAiCalls += 1;
            throw new Error('OpenAI must not be called by contact/discharge');
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
    JSON.stringify({ isDischarge: true, dischargeSignal: 'regulated' }),
    JSON.stringify({
      isDischarge: true,
      dischargeSignal: 'dysregulated',
      aggressiveDischargeDirectedToBot: true
    }),
    'not-json',
    new Error('provider unavailable'),
    JSON.stringify({
      isContact: true,
      selfCriticismLevel: 'high',
      insightMoment: true
    }),
    JSON.stringify({ isContact: false }),
    'not-json',
    new Error('provider unavailable')
  ]);
  const { analyzers, getOpenAiCalls } =
    createContactDischargeAnalyzers(transport);

  const calm = await analyzers.analyzeDischargeState(
    'Je raconte ma journée.',
    [],
    { wasDischarge: false },
    prompts
  );
  assert.equal(calm.source, 'deterministic_no_signal');
  assert.equal(transport.requests.length, 0);

  const regulated = await analyzers.analyzeDischargeState(
    'Je craque.', [], { wasDischarge: false }, prompts
  );
  assert.equal(regulated.detectedState, 'discharge_regulated');
  const dysregulated = await analyzers.analyzeDischargeState(
    "J'EXPLOSE!!", [], { wasDischarge: false }, prompts
  );
  assert.equal(dysregulated.detectedState, 'discharge_dysregulated');
  assert.equal(dysregulated.aggressiveDischargeDirectedToBot, true);

  for (const message of ['Je pleure.', 'Je panique.']) {
    assert.deepEqual(
      await analyzers.analyzeDischargeState(
        message, [], { wasDischarge: false }, prompts
      ),
      {
        isDischarge: false,
        detectedState: null,
        aggressiveDischargeDirectedToBot: false
      }
    );
  }

  const noContact = await analyzers.analyzeContactSignal(
    'Le train arrive à midi.', [], prompts
  );
  assert.equal(noContact.source, 'deterministic_no_signal');
  const deterministicContact = await analyzers.analyzeContactSignal(
    "Je m'en veux tellement.", [], prompts
  );
  assert.equal(deterministicContact.source, 'deterministic_contact');
  assert.equal(transport.requests.length, 4);

  assert.deepEqual(
    await analyzers.analyzeContactSignal('Je tourne en rond.', [], prompts),
    {
      isContact: true,
      contactSignal: 'insight',
      selfCriticismLevel: 'high',
      insightMoment: true
    }
  );
  assert.deepEqual(
    await analyzers.analyzeContactSignal('Rien ne bouge.', [], prompts),
    {
      isContact: false,
      contactSignal: null,
      selfCriticismLevel: 'low',
      insightMoment: false
    }
  );
  for (const message of ['Je me sabote.', 'Ma réaction me gêne.']) {
    assert.deepEqual(await analyzers.analyzeContactSignal(message, [], prompts), {
      isContact: false,
      contactSignal: null,
      selfCriticismLevel: 'low',
      insightMoment: false
    });
  }

  assert.equal(transport.requests.length, 8);
  for (const request of transport.requests) assert.equal(request.model, ANALYSIS_MODEL);
  for (const request of transport.requests.slice(0, 4)) {
    assert.equal(request.messages[0].content, prompts.ANALYZE_DISCHARGE);
  }
  for (const request of transport.requests.slice(4)) {
    assert.equal(request.messages[0].content, prompts.ANALYZE_CONTACT);
  }
  assert.equal(getOpenAiCalls(), 0);

  console.log('contact-discharge-mistral-harness: ok');
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
