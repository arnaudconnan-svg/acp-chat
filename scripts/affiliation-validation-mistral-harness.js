'use strict';

const assert = require('assert');
const {
  createAffiliationShortValidationAnalyzer
} = require('../lib/affiliation-validation');

function createAnalyzer(mistralTransport) {
  return createAffiliationShortValidationAnalyzer({
    mistralTransport,
    modelId: 'mistral-small-latest',
    hasShortAffiliationMarker: (message) =>
      /\bexact(?:ement)?\b|\bc['’ ]est\s+ca\b/i.test(String(message || '')),
    trimInfoAnalysisHistory: (history) =>
      Array.isArray(history) ? history.slice(-6) : []
  });
}

async function main() {
  let deterministicCalls = 0;
  const deterministicAnalyzer = createAnalyzer({
    async complete() {
      deterministicCalls += 1;
      throw new Error('deterministic guard must bypass Mistral');
    }
  });
  const noMarker = await deterministicAnalyzer('Je poursuis mon idee.', []);
  const leadingMarker = await deterministicAnalyzer('Exactement.', []);
  assert.deepStrictEqual(noMarker, {
    shortValidationConfirmed: true,
    source: 'deterministic_no_short_marker'
  });
  assert.deepStrictEqual(leadingMarker, {
    shortValidationConfirmed: true,
    source: 'deterministic_leading_marker'
  });
  assert.strictEqual(deterministicCalls, 0);

  let mistralRequest = null;
  const mistralAnalyzer = createAnalyzer({
    async complete(request) {
      mistralRequest = request;
      return {
        content: '{"shortValidationConfirmed": false}',
        finishReason: 'stop',
        usage: { promptTokens: 12, completionTokens: 3, totalTokens: 15 },
        raw: { model: 'mistral-small-latest' }
      };
    }
  });
  const reviewed = await mistralAnalyzer(
    "Je dirais exactement l'inverse.",
    [{ role: 'assistant', content: 'Tu sembles etre d’accord.' }]
  );
  assert.deepStrictEqual(reviewed, {
    shortValidationConfirmed: false,
    source: 'llm'
  });
  assert.strictEqual(mistralRequest.model, 'mistral-small-latest');
  assert.strictEqual(mistralRequest.maxTokens, 60);
  assert.match(mistralRequest.messages[0].content, /marqueur lexical court/);
  assert.match(mistralRequest.messages[1].content, /exactement l'inverse/);

  const invalidAnalyzer = createAnalyzer({
    async complete() {
      return { content: 'sortie invalide' };
    }
  });
  assert.deepStrictEqual(
    await invalidAnalyzer("Je dirais exactement l'inverse.", []),
    { shortValidationConfirmed: false, source: 'llm_fallback' }
  );

  const unavailableAnalyzer = createAnalyzer({
    async complete() {
      throw new Error('mistral unavailable');
    }
  });
  assert.deepStrictEqual(
    await unavailableAnalyzer("Je dirais exactement l'inverse.", []),
    { shortValidationConfirmed: false, source: 'llm_fallback' }
  );

  console.log('affiliation validation Mistral harness: ok');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
