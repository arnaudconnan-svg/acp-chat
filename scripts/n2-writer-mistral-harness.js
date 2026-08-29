'use strict';

const assert = require('node:assert/strict');
const { buildResponseDebugMeta } = require('../lib/debugmeta');
const { createWriter } = require('../lib/writer');

const GENERATION_MODEL = 'mistral-medium-latest';

function n2Decision() {
  return {
    conversationState: 'n2_crisis',
    detectedState: 'n2_crisis',
    finalDirectivityLevel: 0,
    finalExplorationSignal: 'interpretation',
    intent: 'orienter vers les ressources de crise',
    forbidden: ['relance', 'open_question', 'exploration_hypothesis', 'reflect'],
    toneConstraint: 'contained',
    relancePolicy: 'forbidden',
    confidenceSignal: 1,
    relationalAdjustmentActive: false,
    interpretationRejectionModeActive: false,
    needsSoberReadjustment: false,
    humanFieldGuardActive: false,
    formalAddress: false
  };
}

function promptRegistry(emergencyText) {
  return {
    N2_RESPONSE_LLM: `CONTRAT_N2\nRESSOURCES=${emergencyText}`
  };
}

function createN2Writer(mistralTransport) {
  return createWriter({
    mistralTransport,
    MISTRAL_MODEL_IDS: { generation: GENERATION_MODEL },
    normalizeMemory: (value) => String(value || '')
  });
}

async function generateWithFallback(writer, input, fallback) {
  try {
    const result = await writer.generateReply(input);
    return {
      reply: String(result.reply || '').trim() || fallback,
      usage: result.usage || null
    };
  } catch {
    return { reply: fallback, usage: null };
  }
}

async function run() {
  const fallback = 'FALLBACK_N2_DETERMINISTE';
  const requests = [];
  const tokens = [];
  const crisisWriter = createN2Writer({
    async complete() {
      throw new Error('N2 runtime should stream when callback is present');
    },
    async stream(request, options) {
      requests.push(request);
      await options.onToken('Réponse ');
      await options.onToken('N2');
      return {
        content: 'Réponse N2',
        usage: { promptTokens: 20, completionTokens: 4, totalTokens: 24 }
      };
    }
  });

  const french = await generateWithFallback(
    crisisWriter,
    {
      message: 'Message N2',
      history: [],
      memory: '',
      postureDecision: n2Decision(),
      promptRegistry: promptRegistry('112 et 3114'),
      onTokenCallback: (token) => tokens.push(token)
    },
    fallback
  );
  assert.equal(french.reply, 'Réponse N2');
  assert.deepEqual(tokens, ['Réponse ', 'N2']);
  assert.equal(requests[0].model, GENERATION_MODEL);
  const frenchSystem = requests[0].messages[0].content;
  assert.match(frenchSystem, /112 et 3114/);
  assert.match(frenchSystem, /Politique de relance \(arbitree\) : forbidden/);
  assert.match(frenchSystem, /open_question/);
  assert.match(frenchSystem, /exploration_hypothesis/);
  assert.match(frenchSystem, /n2_crisis/);

  const localizedRequests = [];
  const localizedWriter = createN2Writer({
    async stream(request) {
      localizedRequests.push(request);
      return { content: 'Réponse localisée', usage: null };
    }
  });
  assert.equal(
    (
      await generateWithFallback(
        localizedWriter,
        {
          message: 'Message N2 localisé',
          history: [],
          memory: '',
          postureDecision: n2Decision(),
          promptRegistry: promptRegistry('911 et ressource locale'),
          onTokenCallback: () => {}
        },
        fallback
      )
    ).reply,
    'Réponse localisée'
  );
  assert.match(localizedRequests[0].messages[0].content, /911 et ressource locale/);

  const emptyWriter = createN2Writer({
    async stream() {
      return { content: '', usage: null };
    }
  });
  assert.equal(
    (
      await generateWithFallback(
        emptyWriter,
        {
          message: 'Message N2',
          history: [],
          memory: '',
          postureDecision: n2Decision(),
          promptRegistry: promptRegistry('112 et 3114'),
          onTokenCallback: () => {}
        },
        fallback
      )
    ).reply,
    fallback
  );

  const failingWriter = createN2Writer({
    async stream() {
      throw new Error('provider unavailable before token');
    }
  });
  assert.equal(
    (
      await generateWithFallback(
        failingWriter,
        {
          message: 'Message N2',
          history: [],
          memory: '',
          postureDecision: n2Decision(),
          promptRegistry: promptRegistry('112 et 3114'),
          onTokenCallback: () => {}
        },
        fallback
      )
    ).reply,
    fallback
  );

  const debug = buildResponseDebugMeta({
    memory: 'Mémoire précédente',
    suicideLevel: 'N2',
    conversationState: 'n2_crisis',
    emergencyNumbersIncluded: true,
    promptRegistry: {}
  });
  assert(debug.topChips.includes('URGENCE : risque suicidaire'));
  assert.equal(debug.conversationState, 'n2_crisis');
  assert.equal(debug.emergencyNumbersIncluded, true);

  let normalCalls = 0;
  const normalWriter = createN2Writer({
    async complete(request) {
      normalCalls += 1;
      return { content: 'Réponse normale inchangée', usage: null, request };
    }
  });
  assert.equal(
    (
      await normalWriter.generateReply({
        message: 'Message normal',
        history: [],
        memory: '',
        postureDecision: {
          ...n2Decision(),
          conversationState: 'exploration_open',
          detectedState: 'exploration_open',
          relancePolicy: 'none',
          forbidden: []
        }
      })
    ).reply,
    'Réponse normale inchangée'
  );
  assert.equal(normalCalls, 1);

  console.log('n2-writer-mistral-harness: ok');
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
