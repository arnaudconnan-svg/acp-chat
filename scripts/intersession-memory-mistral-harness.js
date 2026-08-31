'use strict';

const assert = require('assert');
const {
  createMemoryHelpers,
  normalizeIntersessionMemorySource
} = require('../lib/memory');

function createHelpers(mistralTransport) {
  return createMemoryHelpers({
    mistralTransport,
    MISTRAL_MODEL_IDS: { memory: 'mistral-medium-latest' },
    normalizeIntersessionMemory: (value) => String(value || ''),
    normalizeMemory: (value) => String(value || '')
  });
}

async function main() {
  const visibleSource = Array.from(
    { length: 12 },
    (_, index) => `- Repere visible ${index + 1}: ${'x'.repeat(120)}`
  ).join('\n');
  const runtimeSource = normalizeIntersessionMemorySource(
    `\n\n${visibleSource}\n\n`
  );
  assert.strictEqual(runtimeSource, visibleSource);
  assert(runtimeSource.length > 1200);
  assert(runtimeSource.length <= 6000);

  let factualRequest = null;
  const factualHelpers = createHelpers({
    async complete(request) {
      factualRequest = request;
      return {
        content:
          '{"items":["Vit a Lyon et travaille dans le soin.","Cherche un meilleur equilibre professionnel."]}',
        finishReason: 'stop',
        usage: { promptTokens: 30, completionTokens: 12, totalTokens: 42 },
        raw: { model: 'mistral-medium-latest' }
      };
    }
  });
  const factualSummary = await factualHelpers.updateIntersessionMemory(
    'Vit a Lyon.',
    [
      'Contexte stable:',
      '- Vit a Lyon',
      '- Travaille dans le soin',
      '',
      'Mouvements en cours:',
      '- Cherche un meilleur equilibre professionnel'
    ].join('\n')
  );
  assert.strictEqual(factualRequest.model, 'mistral-medium-latest');
  assert.strictEqual(factualRequest.maxTokens, 2500);
  assert.match(factualRequest.messages[0].content, /memoire inter-session/i);
  assert.match(factualRequest.messages[1].content, /Travaille dans le soin/);
  assert.match(factualRequest.messages[0].content, /FORMAT DE SORTIE STRICT/);
  assert.match(factualSummary, /vit a Lyon/i);
  assert.match(factualSummary, /travaille dans le soin/i);
  assert.match(factualSummary, /equilibre professionnel/i);

  const previousSummary = 'Vit a Lyon et travaille dans le soin.';
  const leakHelpers = createHelpers({
    async complete() {
      return {
        content:
          'Conversation :\nUtilisateur : voici mon message brut\nAssistant : voici la reponse brute',
        finishReason: 'stop',
        usage: null,
        raw: { model: 'mistral-medium-latest' }
      };
    }
  });
  const leakResult = await leakHelpers.updateIntersessionMemory(
    previousSummary,
    'Contexte stable:\n- Nouvelle donnee'
  );
  assert.strictEqual(leakResult, previousSummary);
  assert.doesNotMatch(leakResult, /Utilisateur :|Assistant :/i);

  const interpretiveHelpers = createHelpers({
    async complete() {
      return {
        content: '{"items":["Il semble chercher un meilleur equilibre."]}',
        finishReason: 'stop',
        usage: null,
        raw: { model: 'mistral-medium-latest' }
      };
    }
  });
  const interpretiveResult = await interpretiveHelpers.updateIntersessionMemory(
    previousSummary,
    'Contexte stable:\n- Nouvelle donnee'
  );
  assert.strictEqual(interpretiveResult, previousSummary);

  const longItems = Array.from(
    { length: 12 },
    (_, index) => `Repere ${index + 1}: ${'x'.repeat(120)}`
  );
  const verboseHelpers = createHelpers({
    async complete() {
      return {
        content: JSON.stringify({ items: longItems }),
        finishReason: 'stop',
        usage: null,
        raw: { model: 'mistral-medium-latest' }
      };
    }
  });
  const verboseResult = await verboseHelpers.updateIntersessionMemory(
    previousSummary,
    'Contexte stable:\n- Nouvelle donnee'
  );
  assert.match(verboseResult, /Repere 1:/);
  assert.match(verboseResult, /Repere 12:/);
  assert(verboseResult.length > 1200);
  assert(verboseResult.length <= 6000);

  const emptyHelpers = createHelpers({
    async complete() {
      return {
        content: '```text\n```',
        finishReason: 'stop',
        usage: null,
        raw: { model: 'mistral-medium-latest' }
      };
    }
  });
  const emptyResult = await emptyHelpers.updateIntersessionMemory(
    previousSummary,
    'Contexte stable:\n- Nouvelle donnee'
  );
  assert.strictEqual(emptyResult, previousSummary);

  console.log('intersession memory Mistral harness: ok');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
