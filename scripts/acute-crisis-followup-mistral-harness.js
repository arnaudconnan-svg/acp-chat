'use strict';

const assert = require('node:assert/strict');
const { createAnalyzers } = require('../lib/analyzers');

const GENERATION_MODEL = 'mistral-medium-latest';
const FOLLOWUP_PROMPT = [
  'TYPE={{TURN_TYPE_LABEL}}',
  'INSTRUCTIONS={{TURN_TYPE_INSTRUCTIONS}}',
  'URGENCE={{EMERGENCY_BLOCK}}',
  'META={{META_INFO_BLOCK}}'
].join('\n');

function createFakeTransport(responses = []) {
  const requests = [];
  return {
    requests,
    async complete(request) {
      requests.push(request);
      const response = responses.shift();
      if (response instanceof Error) throw response;
      return { content: response, usage: null };
    },
    async stream() {
      throw new Error('followup path must remain non-streaming');
    }
  };
}

function createCrisisAnalyzers(mistralTransport) {
  let openAiCalls = 0;
  const analyzers = createAnalyzers({
    client: {
      chat: {
        completions: {
          async create() {
            openAiCalls += 1;
            throw new Error('OpenAI must not be called by N2 followup');
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

function followupInput(turnType, overrides = {}) {
  return {
    message: `Message ${turnType}`,
    history: Array.from({ length: 6 }, (_, index) => ({
      role: index % 2 === 0 ? 'user' : 'assistant',
      content: `tour-${index + 1}`
    })),
    turnType,
    includeNumbers: false,
    emergencyText: '112 ou 3114',
    promptRegistry: { N2_FOLLOWUP_LLM: FOLLOWUP_PROMPT },
    isMetaPurposeQuestion: false,
    ...overrides
  };
}

async function run() {
  const categories = [
    'n2_refusal',
    'n2_hostile',
    'n2_isolation',
    'n2_overflow',
    'n2_neutral'
  ];
  const validResponses = categories.map((category) => `Réponse ${category}`);
  const transport = createFakeTransport([
    ...validResponses,
    'Réponse méta',
    '',
    'x'.repeat(401),
    new Error('provider unavailable')
  ]);
  const { analyzers, getOpenAiCalls } = createCrisisAnalyzers(transport);

  for (const [index, category] of categories.entries()) {
    const includeNumbers = category === 'n2_neutral';
    assert.equal(
      await analyzers.acuteCrisisFollowupResponseLLM(
        followupInput(category, { includeNumbers })
      ),
      validResponses[index]
    );
  }

  const categoryLabels = [
    "refus d'appeler",
    'colere ou rejet du bot',
    'isolement ou desespoir profond',
    'debordement emotionnel',
    'neutre'
  ];
  categories.forEach((category, index) => {
    const request = transport.requests[index];
    assert.equal(request.model, GENERATION_MODEL);
    assert.match(request.messages[0].content, new RegExp(categoryLabels[index]));
    assert.deepEqual(
      request.messages.slice(1, -1).map((item) => item.content),
      ['tour-3', 'tour-4', 'tour-5', 'tour-6']
    );
  });
  assert.match(transport.requests[0].messages[0].content, /ne pas repeter/i);
  assert.match(transport.requests[4].messages[0].content, /112 ou 3114/);

  assert.equal(
    await analyzers.acuteCrisisFollowupResponseLLM(
      followupInput('n2_neutral', { isMetaPurposeQuestion: true })
    ),
    'Réponse méta'
  );
  assert.match(
    transport.requests[5].messages[0].content,
    /question meta sur ton role/i
  );

  const fallback = analyzers.acuteCrisisFollowupResponse();
  for (const message of ['vide', 'trop longue', 'indisponible']) {
    assert.equal(
      await analyzers.acuteCrisisFollowupResponseLLM(
        followupInput('n2_neutral', { message })
      ),
      fallback
    );
  }

  assert.equal(analyzers.classifyN2TurnType("Je ne veux pas appeler"), 'n2_refusal');
  assert.equal(analyzers.classifyN2TurnType('Laisse-moi tranquille'), 'n2_hostile');
  assert.equal(analyzers.classifyN2TurnType('Je suis seul sans aucun soutien'), 'n2_isolation');
  assert.equal(analyzers.classifyN2TurnType("Je pleure, je n'en peux plus"), 'n2_overflow');
  assert.equal(analyzers.classifyN2TurnType('Je vous entends.'), 'n2_neutral');
  assert.equal(getOpenAiCalls(), 0);

  console.log('acute-crisis-followup-mistral-harness: ok');
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
